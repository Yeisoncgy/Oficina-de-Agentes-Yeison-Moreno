import fs from 'node:fs';
import { agentBaseName, DEFAULT_LEAD_NAME } from '@shared/agents';
import type {
  AgentActionRow,
  AgentActionsResponse,
  AgentRole,
  BudgetResponse,
  HabitsResponse,
  HistoryRange,
  IngestHealth,
  MonthSummary,
  MonthsResponse,
  PriceRates,
  ReconcileResponse,
  ReconcileRow,
  ReportResponse,
  RoomFileRow,
  RoomFilesResponse,
  SessionRow,
  SessionsResponse,
  TokenTypeCost,
  ToolCostRow,
  WhatIfResponse,
  WhatIfRow,
} from '@shared/contract';
import type { Db } from '../db/connection';
import { toBreakdown, TOKEN_SUM_SQL, ZERO_SUM, type TokenSumRow } from '../db/tokens';
import { baseName } from '../ingest/labels';
import { baseModelId, resolvePrice, tablePrices, type Price } from '../ingest/pricing';
import { agentRoleOf, DiscardedWork, modelLabel, ROLE_ORDER } from './costs';
import { RoomNotes } from './roomNotes';
import { Settings } from './settings';

const EDIT_TOOLS = `('Edit', 'Write', 'NotebookEdit', 'MultiEdit')`;
/** umbral del unico tramo largo de la tabla (ingest/pricing.ts): las llamadas se agrupan a un lado y otro */
const LONG_ABOVE = 100_000;
const ACTIONS_PAGE = 100;
const FILES_MAX = 150;
const SESSIONS_MAX = 200;
const RECONCILE_MAX = 50;
const TOOLS_MAX = 12;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : iso(ms);
}

function flat(p: Price): PriceRates {
  return { input: p.input, output: p.output, cacheWrite5m: p.cacheWrite5m, cacheWrite1h: p.cacheWrite1h, cacheRead: p.cacheRead };
}

interface TypeRow {
  model: string;
  speed: string | null;
  long: number;
  i: number;
  o: number;
  cr: number;
  w5: number;
  w1: number;
  cost: number;
}

const RUN_STATUS_TEXT: Readonly<Record<string, string>> = {
  completed: 'terminado',
  failed: 'falló',
  killed: 'detenido',
  stopped: 'detenido',
};

/** proporcion de precios tipica cuando el modelo no tiene tarifa: salida x5, cache escrita x1,25, leida x0,1 */
const FALLBACK: PriceRates = { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };

/**
 * Reparte el costo por tipo de token. Cada grupo (modelo, velocidad, tramo) se reparte con sus tarifas y se
 * ajusta a su costo guardado, asi la suma siempre es el costo real del periodo.
 */
export function splitByTokenType(rows: readonly TypeRow[]): TokenTypeCost {
  const out: TokenTypeCost = { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 };
  for (const r of rows) {
    if (!(r.cost > 0)) continue;
    const base = resolvePrice(r.model)?.price ?? null;
    const p: PriceRates = base ? (r.long === 1 && base.long && base.longAbove === LONG_ABOVE ? base.long : base) : FALLBACK;
    const parts = [r.i * p.input, r.o * p.output, r.cr * p.cacheRead, r.w5 * p.cacheWrite5m + r.w1 * p.cacheWrite1h];
    const sum = parts.reduce((a, c) => a + c, 0);
    if (!(sum > 0)) {
      out.outputUsd += r.cost;
      continue;
    }
    const k = r.cost / sum;
    out.inputUsd += (parts[0] ?? 0) * k;
    out.outputUsd += (parts[1] ?? 0) * k;
    out.cacheReadUsd += (parts[2] ?? 0) * k;
    out.cacheWriteUsd += (parts[3] ?? 0) * k;
  }
  return out;
}

/** herramientas de un mismo servidor MCP juntas: "mcp__supabase__execute_sql" -> "MCP supabase" */
export function toolGroup(tool: string): string {
  const m = /^mcp__(.+?)__/.exec(tool);
  return m?.[1] ? `MCP ${m[1]}` : tool;
}

export interface ExtrasDeps {
  db: Db;
  clock: () => number;
  /** HistoryService.budget */
  budget: (month: string | undefined, now: number) => BudgetResponse;
  isOpen: (sessionId: string, now: number) => boolean;
  /** nombre de la persona que la oficina le dio al agente */
  personaName: (agentId: string) => string | null;
  /** HabitsService.findings */
  habits: (range: HabitsResponse['range']) => HabitsResponse;
}

interface SessionTitle {
  session_id: string;
  project_name: string | null;
  project_dir: string | null;
  registry_name: string | null;
  custom_title: string | null;
}

/** consultas de solo lectura de los paneles nuevos: todo sale de lo que ya esta en la base */
export class Extras {
  private readonly db: Db;
  private readonly roomNotes: RoomNotes;
  private readonly settings: Settings;
  private readonly discarded: DiscardedWork;
  private readonly typeRows;
  private readonly toolRows;
  private readonly sumBetween;

  constructor(private readonly deps: ExtrasDeps) {
    this.db = deps.db;
    this.roomNotes = new RoomNotes(deps.db);
    this.settings = new Settings(deps.db);
    this.discarded = new DiscardedWork(deps.db);
    this.typeRows = this.db.prepare<[number, number], TypeRow>(`
      SELECT model, speed, (input + cache_read + cache_write_5m + cache_write_1h) > ${LONG_ABOVE} AS long,
             SUM(input) AS i, SUM(output) AS o, SUM(cache_read) AS cr, SUM(cache_write_5m) AS w5,
             SUM(cache_write_1h) AS w1, COALESCE(SUM(cost_usd), 0) AS cost
      FROM usage WHERE ts >= ? AND ts < ? GROUP BY model, speed, long`);
    this.toolRows = this.db.prepare<[number, number], { tool: string; calls: number; errors: number; chars: number }>(`
      SELECT tool, COUNT(*) AS calls, COALESCE(SUM(is_error), 0) AS errors, COALESCE(SUM(result_chars), 0) AS chars
      FROM actions WHERE started_at >= ? AND started_at < ? GROUP BY tool`);
    this.sumBetween = this.db.prepare<[number, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ? AND ts < ?`,
    );
  }

  private title(r: SessionTitle): string {
    return this.roomNotes.name(r.session_id) ?? r.registry_name ?? r.custom_title ?? r.project_name ?? r.project_dir ?? '';
  }

  tokenTypes(from: number, to: number = Number.MAX_SAFE_INTEGER): TokenTypeCost {
    return splitByTokenType(this.typeRows.all(from, to));
  }

  tools(from: number, to: number = Number.MAX_SAFE_INTEGER, max = TOOLS_MAX): ToolCostRow[] {
    const groups = new Map<string, ToolCostRow>();
    for (const r of this.toolRows.all(from, to)) {
      const key = toolGroup(r.tool);
      const g = groups.get(key) ?? { tool: key, calls: 0, errors: 0, resultChars: 0, estTokens: 0 };
      g.calls += r.calls;
      g.errors += r.errors;
      g.resultChars += r.chars;
      groups.set(key, g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, estTokens: Math.ceil(g.resultChars / 4) }))
      .sort((a, b) => b.resultChars - a.resultChars || b.calls - a.calls || a.tool.localeCompare(b.tool))
      .slice(0, max);
  }

  hiddenUsd(from: number, to: number = Number.MAX_SAFE_INTEGER): number {
    return (
      this.db
        .prepare<[number, number], { cost: number }>(
          `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE ts >= ? AND ts < ? AND message_id LIKE 'cs:%'`,
        )
        .get(from, to)?.cost ?? 0
    );
  }

  /**
   * lo que calculo Claude Code por sesion contra lo leido de los transcripts. Su cost-state cubre desde que el
   * proceso abrio la sesion (startTime) hasta la linea: solo se compara el uso de esa misma ventana.
   */
  reconcile(): ReconcileResponse {
    const rows = this.db
      .prepare<
        [],
        SessionTitle & { cost_state_usd: number; cost_state_json: string | null; ours: number; hidden: number }
      >(`
        SELECT s.session_id, s.project_name, s.project_dir, s.registry_name, s.custom_title, s.cost_state_usd,
               s.cost_state_json,
               COALESCE((SELECT SUM(u.cost_usd) FROM usage u WHERE u.session_id = s.session_id
                         AND u.message_id NOT LIKE 'cs:%'
                         AND u.ts >= COALESCE(json_extract(s.cost_state_json, '$.startTime'), 0)
                         AND u.ts <= COALESCE(json_extract(s.cost_state_json, '$.at'), 9e15)), 0) AS ours,
               COALESCE((SELECT SUM(u.cost_usd) FROM usage u WHERE u.session_id = s.session_id
                         AND u.message_id LIKE 'cs:%'), 0) AS hidden
        FROM sessions s WHERE s.cost_state_usd IS NOT NULL`)
      .all();
    const total = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sessions`).get()?.n ?? 0;
    const out: ReconcileRow[] = rows.map((r) => {
      let at: number | null = null;
      try {
        const v = JSON.parse(r.cost_state_json ?? 'null') as { at?: unknown } | null;
        if (v && typeof v.at === 'number') at = v.at;
      } catch {
        // sin hora
      }
      return {
        sessionId: r.session_id,
        title: this.title(r),
        projectName: r.project_name ?? r.project_dir ?? '',
        oursUsd: r.ours,
        hiddenUsd: r.hidden,
        claudeUsd: r.cost_state_usd,
        diffUsd: r.cost_state_usd - (r.ours + r.hidden),
        at: isoOrNull(at),
      };
    });
    const sum = (f: (r: ReconcileRow) => number): number => out.reduce((a, r) => a + f(r), 0);
    return {
      sessions: out.length,
      sessionsTotal: total,
      oursUsd: sum((r) => r.oursUsd),
      hiddenUsd: sum((r) => r.hiddenUsd),
      claudeUsd: sum((r) => r.claudeUsd),
      diffUsd: sum((r) => r.diffUsd),
      rows: out.sort((a, b) => Math.abs(b.diffUsd) - Math.abs(a.diffUsd)).slice(0, RECONCILE_MAX),
    };
  }

  /** un resumen por cada mes con datos, del mas reciente al mas viejo */
  months(): MonthsResponse {
    const now = this.deps.clock();
    const range = this.db.prepare<[], { mn: number | null; mx: number | null }>(`SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM usage`).get();
    if (!range || range.mn === null || range.mx === null) return { months: [] };
    const months: MonthSummary[] = [];
    const first = new Date(range.mn);
    const last = new Date(Math.max(range.mx, now));
    const counts = this.db.prepare<[number, number], { sessions: number; agents: number }>(`
      SELECT COUNT(DISTINCT u.session_id) AS sessions,
             COUNT(DISTINCT CASE WHEN a.kind = 'subagent' THEN u.agent_id END) AS agents
      FROM usage u LEFT JOIN agents a ON a.agent_id = u.agent_id WHERE u.ts >= ? AND u.ts < ?`);
    const wf = this.db.prepare<[number, number], { cost: number }>(`
      SELECT COALESCE(SUM(u.cost_usd), 0) AS cost FROM usage u
      JOIN workflow_agents w ON w.agent_id = u.agent_id WHERE u.ts >= ? AND u.ts < ?`);
    const topProject = this.db.prepare<[number, number], { name: string; cost: number }>(`
      SELECT COALESCE(s.project_name, s.project_dir, '(sin proyecto)') AS name, COALESCE(SUM(u.cost_usd), 0) AS cost
      FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id
      WHERE u.ts >= ? AND u.ts < ? GROUP BY name ORDER BY cost DESC LIMIT 1`);
    const topModel = this.db.prepare<[number, number], { name: string; cost: number }>(`
      SELECT model AS name, COALESCE(SUM(cost_usd), 0) AS cost FROM usage
      WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY cost DESC LIMIT 1`);
    for (let y = last.getFullYear(), m = last.getMonth(); y > first.getFullYear() || (y === first.getFullYear() && m >= first.getMonth()); ) {
      const start = new Date(y, m, 1).getTime();
      const end = new Date(y, m + 1, 1).getTime();
      const key = `${y}-${String(m + 1).padStart(2, '0')}`;
      const sum = this.sumBetween.get(start, end) ?? ZERO_SUM;
      const tokens = toBreakdown(sum).total;
      if (tokens > 0 || months.length === 0) {
        const b = this.deps.budget(key, now);
        const c = counts.get(start, end);
        const p = topProject.get(start, end);
        const mo = topModel.get(start, end);
        months.push({
          month: key,
          spentUsd: b.spentUsd,
          budgetUsd: b.budgetUsd,
          tokens,
          sessions: c?.sessions ?? 0,
          subagents: c?.agents ?? 0,
          workflowUsd: wf.get(start, end)?.cost ?? 0,
          discardedUsd: this.discarded.between(start, end).costUsd,
          estimatedUsd: sum.estimated,
          topProject: p && p.cost > 0 ? { name: p.name, costUsd: p.cost } : null,
          topModel: mo && mo.cost > 0 ? { name: modelLabel(baseModelId(mo.name)), costUsd: mo.cost } : null,
          byTokenType: this.tokenTypes(start, end),
        });
      }
      m--;
      if (m < 0) {
        m = 11;
        y--;
      }
    }
    return { months };
  }

  /** todas las sesiones con gasto en el rango, no solo las que caben en la oficina */
  sessions(range: HistoryRange, from: number): SessionsResponse {
    const now = this.deps.clock();
    const rows = this.db
      .prepare<
        [number],
        SessionTitle & {
          last_activity_at: number | null;
          cost_state_json: string | null;
          started_at: number | null;
          cost: number;
          unpriced: number;
          tokens: number;
          subagents: number;
          workflows: number;
          turns: number;
        }
      >(`
        SELECT s.session_id, s.project_name, s.project_dir, s.registry_name, s.custom_title, s.last_activity_at,
               s.cost_state_json,
               (SELECT a.started_at FROM agents a WHERE a.agent_id = s.session_id) AS started_at,
               u.cost, u.unpriced, u.tokens,
               (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.session_id AND a.kind = 'subagent') AS subagents,
               (SELECT COUNT(*) FROM workflow_runs r WHERE r.session_id = s.session_id) AS workflows,
               (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.session_id AND t.kind = 'lead') AS turns
        FROM sessions s JOIN (
          SELECT session_id, COALESCE(SUM(cost_usd), 0) AS cost,
                 COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN input + output + cache_read + cache_write_5m + cache_write_1h ELSE 0 END), 0) AS unpriced,
                 SUM(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens
          FROM usage WHERE ts >= ? GROUP BY session_id) u ON u.session_id = s.session_id
        ORDER BY u.cost DESC, u.tokens DESC, s.session_id`)
      .all(from);
    const out: SessionRow[] = rows.slice(0, SESSIONS_MAX).map((r) => {
      let linesAdded: number | null = null;
      let linesRemoved: number | null = null;
      try {
        const v = JSON.parse(r.cost_state_json ?? 'null') as { linesAdded?: unknown; linesRemoved?: unknown } | null;
        if (v && typeof v.linesAdded === 'number') linesAdded = v.linesAdded;
        if (v && typeof v.linesRemoved === 'number') linesRemoved = v.linesRemoved;
      } catch {
        // sin datos
      }
      return {
        id: r.session_id,
        title: this.title(r),
        projectName: r.project_name ?? r.project_dir ?? '',
        startedAt: isoOrNull(r.started_at),
        lastActivityAt: isoOrNull(r.last_activity_at),
        open: this.deps.isOpen(r.session_id, now),
        costUsd: r.cost,
        unpricedTokens: r.unpriced,
        tokens: r.tokens,
        subagents: r.subagents,
        workflows: r.workflows,
        turns: r.turns,
        linesAdded,
        linesRemoved,
      };
    });
    return { range, rows: out, total: rows.length };
  }

  /** acciones de un agente, las mas recientes primero; null si el cursor no sirve */
  actions(agentId: string, cursor: string | undefined): AgentActionsResponse | null {
    let after: { s: number; i: string } | null = null;
    if (cursor) {
      try {
        const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; i?: unknown };
        if (typeof v.s !== 'number' || typeof v.i !== 'string') return null;
        after = { s: v.s, i: v.i };
      } catch {
        return null;
      }
    }
    interface Row {
      tool_use_id: string;
      tool: string;
      label: string;
      started_at: number;
      ended_at: number | null;
      is_error: number;
      denied: string | null;
      result_chars: number | null;
    }
    const cols = `tool_use_id, tool, label, started_at, ended_at, is_error, denied, result_chars`;
    const rows = after
      ? this.db
          .prepare<[string, number, number, string, number], Row>(
            `SELECT ${cols} FROM actions WHERE agent_id = ? AND (started_at < ? OR (started_at = ? AND tool_use_id < ?))
             ORDER BY started_at DESC, tool_use_id DESC LIMIT ?`,
          )
          .all(agentId, after.s, after.s, after.i, ACTIONS_PAGE + 1)
      : this.db
          .prepare<[string, number], Row>(
            `SELECT ${cols} FROM actions WHERE agent_id = ? ORDER BY started_at DESC, tool_use_id DESC LIMIT ?`,
          )
          .all(agentId, ACTIONS_PAGE + 1);
    const page = rows.slice(0, ACTIONS_PAGE);
    const items: AgentActionRow[] = page.map((r) => ({
      id: r.tool_use_id,
      tool: r.tool,
      label: r.label,
      startedAt: iso(r.started_at),
      endedAt: isoOrNull(r.ended_at),
      durationMs: r.ended_at !== null ? Math.max(0, r.ended_at - r.started_at) : null,
      isError: r.is_error === 1,
      denied: r.denied,
      resultChars: r.result_chars,
    }));
    const s = this.db
      .prepare<[string], { actions: number; errors: number; denied: number; files: number; chars: number }>(`
        SELECT COUNT(*) AS actions, COALESCE(SUM(is_error), 0) AS errors, COALESCE(SUM(denied IS NOT NULL), 0) AS denied,
               COUNT(DISTINCT CASE WHEN tool IN ${EDIT_TOOLS} AND is_error = 0 THEN target END) AS files,
               COALESCE(SUM(result_chars), 0) AS chars
        FROM actions WHERE agent_id = ?`)
      .get(agentId);
    const last = page[page.length - 1];
    return {
      agentId,
      items,
      nextCursor:
        rows.length > ACTIONS_PAGE && last
          ? Buffer.from(JSON.stringify({ s: last.started_at, i: last.tool_use_id })).toString('base64url')
          : null,
      summary: {
        actions: s?.actions ?? 0,
        errors: s?.errors ?? 0,
        denied: s?.denied ?? 0,
        filesEdited: s?.files ?? 0,
        resultChars: s?.chars ?? 0,
      },
    };
  }

  /** archivos que tocaron los agentes de una sala; conflicto = dos o mas lo editaron */
  files(sessionId: string): RoomFilesResponse {
    const rows = this.db
      .prepare<
        [string],
        { target: string; agent_id: string; kind: string | null; agent_type: string | null; edits: number; reads: number; last: number }
      >(`
        SELECT x.target, x.agent_id, a.kind, COALESCE(a.look_type, a.agent_type) AS agent_type,
               SUM(x.tool IN ${EDIT_TOOLS}) AS edits, SUM(x.tool = 'Read') AS reads, MAX(x.started_at) AS last
        FROM actions x LEFT JOIN agents a ON a.agent_id = x.agent_id
        WHERE x.session_id = ? AND x.target IS NOT NULL AND x.is_error = 0
          AND x.tool IN ('Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Read')
        GROUP BY x.target, x.agent_id`)
      .all(sessionId);
    const leadName = this.settings.leadName() ?? DEFAULT_LEAD_NAME;
    const byPath = new Map<string, RoomFileRow & { lastMs: number }>();
    for (const r of rows) {
      const f =
        byPath.get(r.target) ??
        ({ path: r.target, name: baseName(r.target), edits: 0, reads: 0, agents: [], conflict: false, lastAt: '', lastMs: 0 } as RoomFileRow & {
          lastMs: number;
        });
      const lead = r.kind === 'lead';
      f.edits += r.edits;
      f.reads += r.reads;
      f.lastMs = Math.max(f.lastMs, r.last);
      f.agents.push({
        id: r.agent_id,
        name: lead ? leadName : (this.deps.personaName(r.agent_id) ?? agentBaseName(r.agent_type ?? 'general-purpose')),
        lead,
        edits: r.edits,
        reads: r.reads,
      });
      byPath.set(r.target, f);
    }
    const all = [...byPath.values()].map(({ lastMs, ...f }) => ({
      ...f,
      conflict: f.agents.filter((a) => a.edits > 0).length >= 2,
      lastAt: iso(lastMs),
      agents: f.agents.sort((a, b) => b.edits - a.edits || b.reads - a.reads || a.name.localeCompare(b.name)),
    }));
    all.sort(
      (a, b) =>
        Number(b.conflict) - Number(a.conflict) ||
        Number(b.edits > 0) - Number(a.edits > 0) ||
        b.edits - a.edits ||
        b.reads - a.reads ||
        a.path.localeCompare(b.path),
    );
    return {
      roomId: sessionId,
      files: all.slice(0, FILES_MAX),
      edited: all.filter((f) => f.edits > 0).length,
      conflicts: all.filter((f) => f.conflict).length,
    };
  }

  /** consumo por rol y modelo, para recotizarlo con otra mezcla de modelos */
  whatIf(range: WhatIfResponse['range'], from: number): WhatIfResponse {
    const rows = this.db
      .prepare<
        [number],
        { kind: string | null; role: string | null; agent_type: string | null; model: string; i: number; o: number; cr: number; w5: number; w1: number; cost: number }
      >(`
        SELECT a.kind, a.role, COALESCE(a.look_type, a.agent_type) AS agent_type, u.model,
               SUM(u.input) AS i, SUM(u.output) AS o, SUM(u.cache_read) AS cr, SUM(u.cache_write_5m) AS w5,
               SUM(u.cache_write_1h) AS w1, COALESCE(SUM(u.cost_usd), 0) AS cost
        FROM usage u LEFT JOIN agents a ON a.agent_id = u.agent_id
        WHERE u.ts >= ? AND u.message_id NOT LIKE 'cs:%'
        GROUP BY a.kind, a.role, agent_type, u.model`)
      .all(from);
    const merged = new Map<string, WhatIfRow>();
    for (const r of rows) {
      const role: AgentRole = agentRoleOf(r.kind, r.role, r.agent_type);
      const model = baseModelId(r.model);
      const key = `${role}:${model}`;
      const cur = merged.get(key) ?? {
        role,
        model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        costUsd: 0,
      };
      cur.tokens.input += r.i;
      cur.tokens.output += r.o;
      cur.tokens.cacheRead += r.cr;
      cur.tokens.cacheWrite5m += r.w5;
      cur.tokens.cacheWrite1h += r.w1;
      cur.costUsd += r.cost;
      merged.set(key, cur);
    }
    const out = [...merged.values()].sort(
      (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.costUsd - a.costUsd || a.model.localeCompare(b.model),
    );
    const models = tablePrices()
      .map(([model, price]) => ({ model, price: flat(price) }))
      .sort((a, b) => b.price.input - a.price.input || b.price.output - a.price.output || a.model.localeCompare(b.model));
    return { range, rows: out, models };
  }

  /** lo mas caro del periodo y lo que se puede ahorrar, tambien como texto para copiar */
  report(range: ReportResponse['range']): ReportResponse {
    const now = this.deps.clock();
    const d = new Date(now);
    let from: number;
    let prevFrom: number;
    if (range === 'week') {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - 6);
      from = d.getTime();
      const p = new Date(from);
      p.setDate(p.getDate() - 7);
      prevFrom = p.getTime();
    } else {
      from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      prevFrom = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    }
    const spent = this.sumBetween.get(from, Number.MAX_SAFE_INTEGER) ?? ZERO_SUM;
    const prev = this.sumBetween.get(prevFrom, from) ?? ZERO_SUM;
    const month = this.deps.budget(undefined, now);
    const topSessions = this.sessions(range, from)
      .rows.slice(0, 5)
      .map((s) => ({ title: s.title, projectName: s.projectName, costUsd: s.costUsd }));
    const topWorkflows = this.db
      .prepare<[number], SessionTitle & { name: string; status: string | null; agents: number; cost: number }>(`
        SELECT r.session_id, s.project_name, s.project_dir, s.registry_name, s.custom_title,
               COALESCE(r.meta_name, r.tool_name, r.run_id) AS name,
               COALESCE((SELECT n.status FROM notifications n WHERE n.task_id = r.task_id ORDER BY n.ts LIMIT 1), r.final_status) AS status,
               COUNT(DISTINCT w.agent_id) AS agents, COALESCE(SUM(u.cost_usd), 0) AS cost
        FROM workflow_runs r
        JOIN workflow_agents w ON w.run_id = r.run_id
        JOIN usage u ON u.agent_id = w.agent_id AND u.ts >= ?
        LEFT JOIN sessions s ON s.session_id = r.session_id
        GROUP BY r.run_id ORDER BY cost DESC LIMIT 5`)
      .all(from)
      .map((r) => ({
        name: r.name,
        roomTitle: this.title(r),
        status: RUN_STATUS_TEXT[r.status ?? ''] ?? 'en curso',
        agents: r.agents,
        costUsd: r.cost,
      }));
    const habits = this.deps.habits(range);
    const topHabits = [...habits.findings]
      .filter((f) => (f.savingsUsd ?? 0) > 0)
      .sort((a, b) => (b.savingsUsd ?? 0) - (a.savingsUsd ?? 0))
      .slice(0, 5)
      .map((f) => ({ title: f.title, roomTitle: f.roomTitle, recommendation: f.recommendation, savingsUsd: f.savingsUsd }));
    const byTokenType = this.tokenTypes(from);
    const discardedUsd = this.discarded.between(from, Number.MAX_SAFE_INTEGER).costUsd;
    const topTools = this.tools(from, Number.MAX_SAFE_INTEGER, 5);

    const fmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const usd = (n: number): string => `$${fmt.format(n)}`;
    const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : '0 %');
    const day = (ms: number): string => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(ms));
    const lines: string[] = [];
    lines.push(`Informe de Colmena · ${range === 'week' ? 'últimos 7 días' : 'mes en curso'} (${day(from)} a ${day(now)})`);
    lines.push('');
    lines.push(`Gastado en el periodo: ${usd(spent.cost)} (periodo anterior: ${usd(prev.cost)}).`);
    lines.push(`Mes: ${usd(month.spentUsd)} de ${usd(month.budgetUsd)} (${pct(month.spentUsd, month.budgetUsd)}).`);
    lines.push(
      `En qué se fue: releer contexto ${pct(byTokenType.cacheReadUsd, spent.cost)}, escribir contexto ${pct(byTokenType.cacheWriteUsd, spent.cost)}, respuestas ${pct(byTokenType.outputUsd, spent.cost)}, entrada ${pct(byTokenType.inputUsd, spent.cost)}.`,
    );
    if (discardedUsd > 0) lines.push(`Trabajo descartado (fallos, detenidos y reintentos): ${usd(discardedUsd)}.`);
    if (topSessions.length > 0) {
      lines.push('', 'Sesiones más caras:');
      topSessions.forEach((s, i) => lines.push(`${i + 1}. ${s.title}${s.projectName && s.projectName !== s.title ? ` (${s.projectName})` : ''}: ${usd(s.costUsd)}`));
    }
    if (topWorkflows.length > 0) {
      lines.push('', 'Flujos más caros:');
      topWorkflows.forEach((w, i) => lines.push(`${i + 1}. ${w.name} · ${w.agents} agentes · ${w.status}: ${usd(w.costUsd)}`));
    }
    if (topHabits.length > 0) {
      lines.push('', `Fugas con más ahorro posible (total estimado ${usd(habits.totalSavingsUsd)}):`);
      topHabits.forEach((h, i) => lines.push(`${i + 1}. ${h.title} (${h.roomTitle}): ~${usd(h.savingsUsd ?? 0)}. ${h.recommendation}`));
    }
    if (topTools.length > 0) {
      lines.push('', 'Lo que más llena el contexto:');
      const count = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
      topTools.forEach((t, i) =>
        lines.push(`${i + 1}. ${t.tool}: ${count.format(t.calls)} llamadas, ~${count.format(Math.round(t.estTokens / 1000))} mil tokens de resultados`),
      );
    }
    lines.push('', 'Valores equivalentes a la API, calculados en local por Colmena.');

    return {
      range,
      from: iso(from),
      to: iso(now),
      spentUsd: spent.cost,
      prevSpentUsd: prev.cost,
      budgetUsd: month.budgetUsd,
      monthSpentUsd: month.spentUsd,
      byTokenType,
      discardedUsd,
      potentialSavingsUsd: habits.totalSavingsUsd,
      topSessions,
      topWorkflows,
      topHabits,
      topTools,
      text: lines.join('\n'),
    };
  }

  /** estado de la lectura de transcripts */
  health(live: {
    backfill: IngestHealth['backfill'];
    filesTotal: number;
    filesDone: number;
    pending: number;
    stats: { lines: number; badJson: number; lastLineAt: number | null; unknown: ReadonlyMap<string, number> };
    startedAt: number;
    canShutdown: boolean;
  }): IngestHealth {
    const u = this.db
      .prepare<[], { n: number; mn: number | null; mx: number | null }>(`SELECT COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx FROM usage`)
      .get();
    const files = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM file_offsets`).get()?.n ?? 0;
    let dbBytes: number | null = null;
    try {
      if (this.db.name && this.db.name !== ':memory:') dbBytes = fs.statSync(this.db.name).size;
    } catch {
      // sin archivo
    }
    return {
      backfill: live.backfill,
      filesTotal: live.filesTotal,
      filesDone: live.filesDone,
      pending: live.pending,
      linesRead: live.stats.lines,
      badLines: live.stats.badJson,
      unknownTypes: [...live.stats.unknown]
        .map(([type, count]) => ({ type: type || '(sin tipo)', count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      lastLineAt: isoOrNull(live.stats.lastLineAt),
      filesTracked: files,
      usageRows: u?.n ?? 0,
      firstUsageAt: isoOrNull(u?.mn),
      lastUsageAt: isoOrNull(u?.mx),
      dbBytes,
      uptimeMs: Math.max(0, this.deps.clock() - live.startedAt),
      canShutdown: live.canShutdown,
    };
  }
}
