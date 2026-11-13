import type { AgentRole, CostRow, CostsResponse, DiscardedRow, HistoryRange } from '@shared/contract';
import type { Db } from '../db/connection';
import { strictCost, toBreakdown, TOKEN_SUM_SQL, ZERO_SUM, type TokenSumRow } from '../db/tokens';
import { roleOfAgentType } from '../ingest/roles';
import { roleOrNull } from '../ingest/roleStore';
import { RoomNotes } from './roomNotes';

/** orden de los roles en las tablas: el lead primero */
export const ROLE_ORDER: readonly AgentRole[] = [
  'orchestrator',
  'explorer',
  'builder',
  'reviewer',
  'tester',
  'security',
  'planner',
  'docs',
  'generalist',
];

export const ROLE_LABEL: Readonly<Record<AgentRole, string>> = {
  orchestrator: 'Orquestador',
  explorer: 'Investigación',
  builder: 'Desarrollo',
  reviewer: 'Revisión',
  tester: 'Pruebas',
  security: 'Seguridad',
  planner: 'Planificación',
  docs: 'Documentación',
  generalist: 'General',
};

/**
 * Rol de primer nivel de un agente: el lead es el orquestador; un subagente usa agents.role y, mientras
 * no este clasificado, el rol que fija su tipo (o general).
 */
export function agentRoleOf(kind: string | null, role: string | null, agentType: string | null): AgentRole {
  if (kind === 'lead') return 'orchestrator';
  return roleOrNull(role) ?? roleOfAgentType(agentType ?? '') ?? 'generalist';
}

/**
 * Por que se descarto el trabajo de un subagente, o null si no se descarto: su ultima task-notification
 * (failed/killed/stopped) o, en un agente de workflow, un reintento que lo reemplazo o su fallo en el
 * journal (no reciben task-notification propia).
 */
export function discardReason(
  notifStatus: string | null,
  wfEnd: string | null,
  wfRetried: number | null,
): DiscardedRow['reason'] | null {
  if (notifStatus === 'failed' || notifStatus === 'killed' || notifStatus === 'stopped') return notifStatus;
  if (wfEnd === 'superseded' || wfRetried === 1) return 'retry';
  if (wfEnd === 'failed') return 'failed';
  return null;
}

export function addSum(acc: TokenSumRow, s: TokenSumRow): void {
  acc.input += s.input;
  acc.output += s.output;
  acc.cache_read += s.cache_read;
  acc.cache_write += s.cache_write;
  acc.cost += s.cost;
  acc.unpriced += s.unpriced;
  acc.estimated += s.estimated;
}

/** cache_read / (input + cache_read + cache_write); null sin tokens de entrada */
export function cacheRatio(s: Pick<TokenSumRow, 'input' | 'cache_read' | 'cache_write'>): number | null {
  const den = s.input + s.cache_read + s.cache_write;
  return den > 0 ? s.cache_read / den : null;
}

/** "claude-opus-5-5-20260101" -> "Opus 5.5"; un id que no sigue el patron se muestra tal cual */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(model);
  if (!m?.[1] || !m[2]) return model;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

interface SessionTitleRow {
  session_id: string;
  project_name: string | null;
  project_dir: string | null;
  registry_name: string | null;
  custom_title: string | null;
}

interface DiscardedDbRow extends SessionTitleRow {
  agent_id: string;
  agent_type: string;
  look_type: string | null;
  role: string | null;
  end_at: number | null;
  notif_status: string | null;
  wf_end: string | null;
  wf_retried: number;
}

export type DiscardedSummary = CostsResponse['discarded'];

/**
 * Trabajo descartado: subagentes que terminaron failed/killed/stopped (su task-notification o, en un
 * workflow, el journal) e intentos de workflow reemplazados por un reintento (superseded o no-ultimos de
 * su key). Solo suma el uso que cae en la ventana pedida, como los totales con los que se compara.
 */
export class DiscardedWork {
  private readonly list;
  private readonly sumAgent;
  private readonly roomNotes: RoomNotes;

  constructor(db: Db) {
    this.roomNotes = new RoomNotes(db);
    this.list = db.prepare<[number, number], DiscardedDbRow>(`
      SELECT * FROM (
        SELECT a.agent_id, a.session_id, a.agent_type, a.look_type, a.role,
               COALESCE(a.ended_at, a.last_activity_at) AS end_at,
               (SELECT n.status FROM notifications n WHERE n.task_id = a.agent_id ORDER BY n.ts DESC LIMIT 1) AS notif_status,
               w.end_status AS wf_end,
               EXISTS (SELECT 1 FROM workflow_agents w2
                       WHERE w2.run_id = w.run_id AND w2.key = w.key AND w2.seq > w.seq) AS wf_retried,
               s.project_name, s.project_dir, s.registry_name, s.custom_title
        FROM agents a
        LEFT JOIN workflow_agents w ON w.agent_id = a.agent_id
        LEFT JOIN sessions s ON s.session_id = a.session_id
        WHERE a.kind = 'subagent'
          AND COALESCE(a.ended_at, a.last_activity_at) >= ? AND COALESCE(a.ended_at, a.last_activity_at) < ?)
      WHERE notif_status IN ('failed', 'killed', 'stopped') OR wf_end IN ('superseded', 'failed') OR wf_retried = 1
      ORDER BY end_at DESC, agent_id`);
    this.sumAgent = db.prepare<[string, number, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ? AND ts >= ? AND ts < ?`,
    );
  }

  /** agentes descartados cuyo fin cae en [from, to), con su uso dentro de [from, to) */
  between(from: number, to: number): DiscardedSummary {
    const total: TokenSumRow = { ...ZERO_SUM };
    const items: DiscardedRow[] = this.list.all(from, to).map((r) => {
      const sum = this.sumAgent.get(r.agent_id, from, to) ?? ZERO_SUM;
      addSum(total, sum);
      // el WHERE ya dejo solo descartados: el null no ocurre
      const reason = discardReason(r.notif_status, r.wf_end, r.wf_retried) ?? 'retry';
      return {
        agentId: r.agent_id,
        agentType: r.look_type ?? r.agent_type,
        role: agentRoleOf('subagent', r.role, r.look_type ?? r.agent_type),
        roomTitle: this.roomTitle(r),
        projectName: r.project_name ?? r.project_dir ?? '',
        reason,
        tokens: toBreakdown(sum),
        costUsd: strictCost(sum),
        endedAt: r.end_at !== null ? new Date(r.end_at).toISOString() : null,
      };
    });
    return { costUsd: total.cost, tokens: toBreakdown(total), count: items.length, items };
  }

  private roomTitle(r: SessionTitleRow): string {
    return this.roomNotes.name(r.session_id) ?? r.registry_name ?? r.custom_title ?? r.project_name ?? r.project_dir ?? '';
  }
}

type KeyedSum = TokenSumRow & { key: string };

/** filas de costo con su % de cache; las tareas se cuentan aparte (una fila puede no tener tareas) */
function costRows(
  usage: readonly KeyedSum[],
  tasks: ReadonlyArray<{ key: string; n: number }>,
  label: (key: string) => string,
): CostRow[] {
  const rows = new Map<string, CostRow>();
  const blank = (key: string): CostRow => ({
    key,
    label: label(key),
    tokens: toBreakdown(undefined),
    costUsd: 0,
    unpricedTokens: 0,
    cachePct: null,
    tasks: 0,
  });
  for (const u of usage) {
    rows.set(u.key, {
      ...blank(u.key),
      tokens: toBreakdown(u),
      costUsd: u.cost,
      unpricedTokens: u.unpriced,
      cachePct: cacheRatio(u),
    });
  }
  for (const t of tasks) {
    const row = rows.get(t.key) ?? blank(t.key);
    row.tasks += t.n;
    rows.set(t.key, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total || a.key.localeCompare(b.key),
  );
}

function addTo(acc: Map<string, KeyedSum>, key: string, s: TokenSumRow): void {
  const cur = acc.get(key) ?? { ...ZERO_SUM, key };
  addSum(cur, s);
  acc.set(key, cur);
}

interface RoleSumRow extends TokenSumRow {
  kind: string | null;
  role: string | null;
  agent_type: string | null;
}

/** GET /api/history/costs: por modelo, proyecto y rol, con el trabajo descartado del periodo */
export class CostsService {
  private readonly total;
  private readonly byModelUsage;
  private readonly byModelTasks;
  private readonly byProjectUsage;
  private readonly byProjectTasks;
  private readonly byRoleUsage;
  private readonly byRoleTasks;
  private readonly discarded: DiscardedWork;

  constructor(db: Db) {
    this.discarded = new DiscardedWork(db);
    this.total = db.prepare<[number], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ?`);
    this.byModelUsage = db.prepare<[number], KeyedSum>(
      `SELECT model AS key, ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ? GROUP BY model`,
    );
    // tareas que usaron el modelo: uso del mismo agente dentro de la ventana de la tarea
    this.byModelTasks = db.prepare<[number], { key: string; n: number }>(`
      SELECT u.model AS key, COUNT(DISTINCT t.id) AS n
      FROM tasks t JOIN usage u ON u.agent_id = t.agent_id AND u.ts >= t.started_at AND u.ts <= t.ended_at
      WHERE t.ended_at >= ? GROUP BY u.model`);
    const projectExpr = `COALESCE(s.project_name, s.project_dir, '(sin proyecto)')`;
    this.byProjectUsage = db.prepare<[number], KeyedSum>(`
      SELECT ${projectExpr} AS key, ${TOKEN_SUM_SQL}
      FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id
      WHERE u.ts >= ? GROUP BY key`);
    this.byProjectTasks = db.prepare<[number], { key: string; n: number }>(`
      SELECT ${projectExpr} AS key, COUNT(*) AS n
      FROM tasks t LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE t.ended_at >= ? GROUP BY key`);
    // las columnas de tokens solo existen en usage: TOKEN_SUM_SQL no es ambiguo con agents
    this.byRoleUsage = db.prepare<[number], RoleSumRow>(`
      SELECT a.kind, a.role, COALESCE(a.look_type, a.agent_type) AS agent_type, ${TOKEN_SUM_SQL}
      FROM usage u LEFT JOIN agents a ON a.agent_id = u.agent_id
      WHERE u.ts >= ? GROUP BY a.kind, a.role, COALESCE(a.look_type, a.agent_type)`);
    this.byRoleTasks = db.prepare<[number], { kind: string; role: string | null; agent_type: string; n: number }>(`
      SELECT t.kind, a.role, t.agent_type, COUNT(*) AS n
      FROM tasks t LEFT JOIN agents a ON a.agent_id = t.agent_id
      WHERE t.ended_at >= ? GROUP BY t.kind, a.role, t.agent_type`);
  }

  /** `from` = inicio del rango (rangeStart en routes/history.ts) */
  costs(range: HistoryRange, from: number): CostsResponse {
    const total = this.total.get(from) ?? ZERO_SUM;

    const roleUsage = new Map<string, KeyedSum>();
    for (const r of this.byRoleUsage.all(from)) addTo(roleUsage, agentRoleOf(r.kind, r.role, r.agent_type), r);
    const roleTasks = new Map<string, number>();
    for (const t of this.byRoleTasks.all(from)) {
      const key = agentRoleOf(t.kind, t.role, t.agent_type);
      roleTasks.set(key, (roleTasks.get(key) ?? 0) + t.n);
    }
    const roleLabels = new Map<string, string>(ROLE_ORDER.map((r) => [r, ROLE_LABEL[r]]));

    return {
      range,
      totals: {
        tokens: toBreakdown(total),
        costUsd: total.cost,
        cachePct: cacheRatio(total),
        unpricedTokens: total.unpriced,
        estimatedUsd: total.estimated,
      },
      byModel: costRows(this.byModelUsage.all(from), this.byModelTasks.all(from), modelLabel),
      byProject: costRows(this.byProjectUsage.all(from), this.byProjectTasks.all(from), (key) => key),
      byRole: costRows(
        [...roleUsage.values()],
        [...roleTasks].map(([key, n]) => ({ key, n })),
        (key) => roleLabels.get(key) ?? key,
      ),
      discarded: this.discarded.between(from, Number.MAX_SAFE_INTEGER),
    };
  }
}
