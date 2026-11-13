import type { FastifyInstance } from 'fastify';
import { agentBaseName, DEFAULT_LEAD_NAME } from '@shared/agents';
import {
  BUDGET_DEFAULT_USD,
  type BudgetResponse,
  type HistoryRange,
  type RankingResponse,
  type RankingRow,
  type TaskRow,
  type TasksResponse,
} from '@shared/contract';
import { TREND_WORKDAYS } from '../config';
import type { Db } from '../db/connection';
import { toBreakdown, TOKEN_SUM_SQL, ZERO_SUM, type TokenSumRow } from '../db/tokens';
import { agentRoleOf, cacheRatio, DiscardedWork, discardReason } from '../state/costs';
import { iso, startOfLocalDay } from '../state/office';
import { RoomNotes } from '../state/roomNotes';
import { Settings } from '../state/settings';
import { LeadWork } from '../ingest/leadWork';

export const TASKS_PAGE = 50;
const RANGES: readonly HistoryRange[] = ['today', 'week', 'month', 'all'];
// anos desde 1970: con 0000-0099, new Date(y, ...) cae en 1900-1999 y el mes saldria sin sus cuatro cifras
const MONTH_RE = /^(19[7-9]\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(19[7-9]\d|[2-9]\d{3})-(0[1-9]|1[0-2])-(\d{2})$/;
/** tope de los montos que escribe el usuario (ajuste y presupuesto) */
const MAX_AMOUNT_USD = 1_000_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM' (hora local) */
function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function rangeStart(range: HistoryRange, now: number): number {
  const d = new Date(now);
  switch (range) {
    case 'today':
      return startOfLocalDay(now);
    case 'week':
      // hoy + los 6 dias anteriores (hora local)
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - 6);
      return d.getTime();
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'all':
      return 0;
  }
}

function encodeTaskCursor(endedAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ e: endedAt, i: id })).toString('base64url');
}

function decodeTaskCursor(cursor: string): { e: number; i: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { e?: unknown; i?: unknown };
    return typeof v.e === 'number' && typeof v.i === 'string' ? { e: v.e, i: v.i } : null;
  } catch {
    return null;
  }
}

interface TaskDbRow {
  id: string;
  session_id: string;
  kind: string;
  agent_type: string;
  title: string;
  started_at: number;
  ended_at: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  unpriced_tokens: number;
  project: string;
  /** nombre automatico de la sala (registro o /rename); '' si no tiene */
  room: string;
  model: string | null;
  role: string | null;
  notif_status: string | null;
  wf_end: string | null;
  wf_retried: number;
  interrupted: number;
}

export interface TaskFilters {
  q?: string;
  project?: string;
  /** sessionId */
  room?: string;
  kind?: 'lead' | 'subagent';
  /** ok | bad (cualquier final que no sea ok) | un TaskOutcome */
  outcome?: 'ok' | 'bad' | 'failed' | 'killed' | 'stopped' | 'retry' | 'interrupted';
  minUsd?: number;
  range?: HistoryRange;
}

/**
 * tareas con su sala, su modelo y como terminaron. Subagente: su ultimo aviso de fin, o el journal de su
 * flujo (fallo o reintento). Lead: si el usuario corto ese turno.
 */
const TASK_VIEW = `
  SELECT * FROM (
    SELECT t.id, t.session_id, t.kind, t.agent_type, t.title, t.started_at, t.ended_at, t.input, t.output,
           t.cache_read, t.cache_write, t.cost_usd, t.unpriced_tokens,
           COALESCE(s.project_name, s.project_dir, '') AS project,
           COALESCE(s.registry_name, s.custom_title, '') AS room,
           a.model, a.role,
           CASE WHEN t.kind = 'lead' THEN NULL ELSE
             (SELECT n.status FROM notifications n WHERE n.task_id = t.agent_id ORDER BY n.ts DESC LIMIT 1) END AS notif_status,
           w.end_status AS wf_end,
           CASE WHEN w.agent_id IS NULL THEN 0 ELSE EXISTS (
             SELECT 1 FROM workflow_agents w2 WHERE w2.run_id = w.run_id AND w2.key = w.key AND w2.seq > w.seq) END AS wf_retried,
           CASE WHEN t.kind = 'lead' THEN EXISTS (
             SELECT 1 FROM session_events e WHERE e.session_id = t.session_id AND e.agent_id = t.session_id
               AND e.kind = 'interrupt' AND e.ts >= t.started_at AND e.ts <= t.ended_at + 2000) ELSE 0 END AS interrupted
    FROM tasks t
    LEFT JOIN sessions s ON s.session_id = t.session_id
    LEFT JOIN agents a ON a.agent_id = t.agent_id
    LEFT JOIN workflow_agents w ON w.agent_id = t.agent_id)`;

const BAD_SQL = `(COALESCE(notif_status, '') IN ('failed', 'killed', 'stopped') OR COALESCE(wf_end, '') IN ('superseded', 'failed') OR wf_retried = 1 OR interrupted = 1)`;

export class HistoryService {
  private readonly sumBetween;
  private readonly hiddenBetween;
  private readonly projectsBetween;
  private readonly byAgentUsage;
  private readonly byAgentTasks;
  private readonly byProjectUsage;
  private readonly byProjectTasks;
  private readonly settings: Settings;
  private readonly leadWork: LeadWork;
  private readonly roomNotes: RoomNotes;
  private readonly discarded: DiscardedWork;

  constructor(private readonly db: Db) {
    this.settings = new Settings(db);
    this.discarded = new DiscardedWork(db);
    this.roomNotes = new RoomNotes(db);
    this.leadWork = new LeadWork(db);
    this.sumBetween = db.prepare<[number, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ? AND ts < ?`,
    );
    this.hiddenBetween = db.prepare<[number, number], { cost: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE ts >= ? AND ts < ? AND message_id LIKE 'cs:%'`,
    );
    this.projectsBetween = db.prepare<[number, number], { project: string; cost: number }>(`
      SELECT COALESCE(s.project_name, s.project_dir, '(sin proyecto)') AS project, COALESCE(SUM(u.cost_usd), 0) AS cost
      FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id
      WHERE u.ts >= ? AND u.ts < ? GROUP BY project ORDER BY cost DESC, project`);
    // las columnas de tokens solo existen en usage: TOKEN_SUM_SQL no es ambiguo en estos JOIN
    this.byAgentUsage = db.prepare<[number], TokenSumRow & { key: string }>(`
      SELECT COALESCE(a.look_type, a.agent_type, 'general-purpose') AS key, ${TOKEN_SUM_SQL}
      FROM usage u LEFT JOIN agents a ON a.agent_id = u.agent_id
      WHERE u.ts >= ? GROUP BY key`);
    this.byAgentTasks = db.prepare<[number], { key: string; n: number }>(
      `SELECT agent_type AS key, COUNT(*) AS n FROM tasks WHERE ended_at >= ? GROUP BY agent_type`,
    );
    const projectExpr = `COALESCE(s.project_name, s.project_dir, '(sin proyecto)')`;
    this.byProjectUsage = db.prepare<[number], TokenSumRow & { key: string }>(`
      SELECT ${projectExpr} AS key, ${TOKEN_SUM_SQL}
      FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id
      WHERE u.ts >= ? GROUP BY key`);
    this.byProjectTasks = db.prepare<[number], { key: string; n: number }>(`
      SELECT ${projectExpr} AS key, COUNT(*) AS n
      FROM tasks t LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE t.ended_at >= ? GROUP BY key`);
  }

  budget(month: string | undefined, now: number): BudgetResponse {
    const today = new Date(now);
    let year = today.getFullYear();
    let monthIndex = today.getMonth();
    const m = month ? MONTH_RE.exec(month) : null;
    if (m) {
      year = Number(m[1]);
      monthIndex = Number(m[2]) - 1;
    }
    const start = new Date(year, monthIndex, 1).getTime();
    const end = new Date(year, monthIndex + 1, 1).getTime();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    // dia de hoy dentro del mes pedido: 0 en un mes futuro, daysInMonth + 1 en uno pasado
    let todayDay: number;
    if (now >= end) todayDay = daysInMonth + 1;
    else if (now < start) todayDay = 0;
    else todayDay = today.getDate();
    const elapsedDays = Math.min(todayDay, daysInMonth);

    const monthKey = `${year}-${pad2(monthIndex + 1)}`;
    // ajuste al gasto real: lo anterior al ajuste no suma; el monto ajustado cae en el dia del ajuste
    const b = this.settings.baseline(monthKey);
    const baseline = b && b.since >= start && b.since < end ? b : null;
    const from = baseline ? baseline.since : start;

    const daily: BudgetResponse['daily'] = [];
    /** gasto de cada dia sin el monto del ajuste (la tendencia no debe ver ese salto); null antes del ajuste */
    const usageByDay: Array<number | null> = [];
    for (let day = 1; day <= elapsedDays; day++) {
      const d0 = new Date(year, monthIndex, day).getTime();
      const d1 = new Date(year, monthIndex, day + 1).getTime();
      const usage = d1 > from ? (this.sumBetween.get(Math.max(d0, from), d1)?.cost ?? 0) : null;
      let cost = usage ?? 0;
      if (baseline && baseline.since >= d0 && baseline.since < d1) cost += baseline.amountUsd;
      daily.push({ date: localDate(new Date(d0)), costUsd: cost });
      usageByDay.push(usage);
    }
    const total = this.sumBetween.get(from, end) ?? ZERO_SUM;
    const spentUsd = (baseline?.amountUsd ?? 0) + total.cost;

    const custom = this.settings.budgetUsd();
    const budgetUsd = custom ?? BUDGET_DEFAULT_USD;
    const daysOff = this.settings.daysOff().filter((d) => d.startsWith(`${monthKey}-`));
    const off = new Set(daysOff);
    const workdays: number[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const weekday = new Date(year, monthIndex, day).getDay();
      if (weekday !== 0 && weekday !== 6 && !off.has(`${monthKey}-${pad2(day)}`)) workdays.push(day);
    }
    const elapsed = workdays.filter((d) => d <= todayDay);
    const remaining = workdays.filter((d) => d >= todayDay).length;
    const after = workdays.filter((d) => d > todayDay).length;
    const burnRateUsd = elapsed.length > 0 ? spentUsd / elapsed.length : null;
    const trendDays = elapsed
      .map((d) => usageByDay[d - 1])
      .filter((c): c is number => c !== null && c !== undefined)
      .slice(-TREND_WORKDAYS);
    // al comenzar el mes faltan laborales: se completan con los ultimos del mes anterior, salvo que un
    // ajuste de este mes deje fuera todo lo previo
    if (todayDay > 0 && !baseline && trendDays.length < TREND_WORKDAYS) {
      trendDays.unshift(...this.lastWorkdaysUsage(year, monthIndex - 1, TREND_WORKDAYS - trendDays.length));
    }

    const trend5dUsd = trendDays.length > 0 ? trendDays.reduce((a, c) => a + c, 0) / trendDays.length : null;
    const isCurrent = todayDay >= 1 && todayDay <= daysInMonth;

    // dia en que el acumulado paso el presupuesto
    let crossedDate: string | null = null;
    let acc = 0;
    for (const d of daily) {
      acc += d.costUsd;
      if (acc > budgetUsd) {
        crossedDate = d.date;
        break;
      }
    }
    // al ritmo actual (tendencia de 5 dias o promedio del mes), el dia laboral en que se acaba lo que queda
    let runOutDate: string | null = null;
    const pace = trend5dUsd ?? burnRateUsd;
    if (isCurrent && crossedDate === null && pace !== null && pace > 0) {
      let left = budgetUsd - spentUsd;
      for (const day of workdays) {
        if (day <= todayDay) continue;
        left -= pace;
        if (left <= 0) {
          runOutDate = `${monthKey}-${pad2(day)}`;
          break;
        }
      }
    }

    // ultimos 60 minutos, en saltos de 5: el valor no cambia en cada lectura si no hubo gasto nuevo
    const STEP = 5 * 60_000;
    const hourEnd = Math.floor(now / STEP) * STEP + STEP;
    const burnPerHourUsd = isCurrent ? (this.sumBetween.get(hourEnd - 60 * 60_000, hourEnd)?.cost ?? 0) : 0;

    // semana en curso (lunes a domingo) recortada al mes
    let week: BudgetResponse['week'];
    if (isCurrent) {
      const mondayOffset = (today.getDay() + 6) % 7;
      const monday = Math.max(1, todayDay - mondayOffset);
      const sunday = Math.min(daysInMonth, todayDay - mondayOffset + 6);
      const w0 = Math.max(new Date(year, monthIndex, monday).getTime(), from);
      const w1 = new Date(year, monthIndex, sunday + 1).getTime();
      const inWeek = workdays.filter((d) => d >= monday && d <= sunday).length;
      week = {
        from: `${monthKey}-${pad2(monday)}`,
        spentUsd: w1 > w0 ? (this.sumBetween.get(w0, w1)?.cost ?? 0) : 0,
        targetUsd: workdays.length > 0 ? (budgetUsd * inWeek) / workdays.length : 0,
      };
    }

    const caps = this.settings.projectBudgets();
    const projects: NonNullable<BudgetResponse['projects']> = this.projectsBetween
      .all(from, end)
      .map((r) => ({ project: r.project, spentUsd: r.cost, capUsd: caps.get(r.project) ?? null }));
    for (const [project, capUsd] of caps) {
      if (!projects.some((r) => r.project === project)) projects.push({ project, spentUsd: 0, capUsd });
    }

    return {
      month: monthKey,
      budgetUsd,
      spentUsd,
      projectedUsd: burnRateUsd === null ? spentUsd : spentUsd + burnRateUsd * after,
      daily,
      unpricedTokens: total.unpriced,
      ...(baseline ? { baseline: { amountUsd: baseline.amountUsd, since: iso(baseline.since) } } : {}),
      budgetSource: custom === null ? 'default' : 'custom',
      daysOff,
      workdays: { total: workdays.length, elapsed: elapsed.length, remaining },
      burnRateUsd,
      trend5dUsd,
      recommendedPerDayUsd: remaining > 0 ? Math.max(0, budgetUsd - spentUsd) / remaining : null,
      cachePct: cacheRatio(total),
      discardedUsd: this.discarded.between(from, end).costUsd,
      estimatedUsd: total.estimated,
      hiddenUsd: this.hiddenBetween.get(from, end)?.cost ?? 0,
      todayUsd: isCurrent ? (usageByDay[todayDay - 1] ?? 0) : 0,
      burnPerHourUsd,
      runOutDate,
      crossedDate,
      ...(week ? { week } : {}),
      projects,
    };
  }

  /** tope mensual de un proyecto; null lo quita */
  setProjectBudget(project: string, amountUsd: number | null): void {
    this.settings.setProjectBudget(project, amountUsd);
  }

  /**
   * gasto de los ultimos `n` laborales del mes (con sus dias libres), del mas viejo al mas nuevo. Si ese
   * mes se ajusto, no entra nada anterior al ajuste y el dia del ajuste cuenta sin su monto.
   */
  private lastWorkdaysUsage(year: number, monthIndex: number, n: number): number[] {
    const first = new Date(year, monthIndex, 1);
    const y = first.getFullYear();
    const mi = first.getMonth();
    const key = `${y}-${pad2(mi + 1)}`;
    const off = new Set(this.settings.daysOff().filter((d) => d.startsWith(`${key}-`)));
    const since = this.settings.baseline(key)?.since ?? null;
    const out: number[] = [];
    for (let day = new Date(y, mi + 1, 0).getDate(); day >= 1 && out.length < n; day--) {
      const weekday = new Date(y, mi, day).getDay();
      if (weekday === 0 || weekday === 6 || off.has(`${key}-${pad2(day)}`)) continue;
      const d0 = new Date(y, mi, day).getTime();
      const d1 = new Date(y, mi, day + 1).getTime();
      if (since !== null && d1 <= since) break;
      out.unshift(this.sumBetween.get(since !== null ? Math.max(d0, since) : d0, d1)?.cost ?? 0);
    }
    return out;
  }

  /** monto mensual que fija el usuario (vale para todos los meses) */
  setBudgetAmount(amountUsd: number): void {
    this.settings.setBudgetUsd(amountUsd);
  }

  clearBudgetAmount(): void {
    this.settings.clearBudgetUsd();
  }

  /** marca o desmarca un dia libre entre semana ('YYYY-MM-DD') */
  setDayOff(date: string, off: boolean): void {
    const days = this.settings.daysOff().filter((d) => d !== date);
    if (off) days.push(date);
    this.settings.setDaysOff(days);
  }

  /** ajusta el mes actual al gasto real que dice el usuario; desde ahora se suma lo nuevo. Los otros meses no cambian */
  setBaseline(amountUsd: number, now: number): void {
    this.settings.setBaseline({ month: monthOf(now), amountUsd, since: now });
  }

  /** quita solo el ajuste del mes actual */
  clearBaseline(now: number): void {
    this.settings.clearBaseline(monthOf(now));
  }

  /** nombre que eligio el usuario para el lead, o el de por defecto */
  private leadName(): string {
    return this.settings.leadName() ?? DEFAULT_LEAD_NAME;
  }

  ranking(range: HistoryRange, now: number): RankingResponse {
    const from = rangeStart(range, now);
    const leadName = this.leadName();
    const byAgent = mergeRanking(this.byAgentUsage.all(from), this.byAgentTasks.all(from), (key) =>
      key === 'lead' ? `${leadName} (principal)` : agentBaseName(key),
    );
    const byProject = mergeRanking(this.byProjectUsage.all(from), this.byProjectTasks.all(from), (key) => key);
    return { range, byAgent, byProject };
  }

  tasks(cursor: string | undefined, filters: TaskFilters = {}, now: number = Date.now()): TasksResponse | null {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const q = filters.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(title LIKE ? ESCAPE '\\' OR agent_type LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR room LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (filters.project) {
      where.push(`project = ?`);
      params.push(filters.project);
    }
    if (filters.room) {
      where.push(`session_id = ?`);
      params.push(filters.room);
    }
    if (filters.kind) {
      where.push(`kind = ?`);
      params.push(filters.kind);
    }
    if (filters.minUsd !== undefined) {
      where.push(`cost_usd >= ?`);
      params.push(filters.minUsd);
    }
    if (filters.range && filters.range !== 'all') {
      where.push(`ended_at >= ?`);
      params.push(rangeStart(filters.range, now));
    }
    if (filters.outcome) {
      if (filters.outcome === 'ok') where.push(`NOT ${BAD_SQL}`);
      else if (filters.outcome === 'bad') where.push(BAD_SQL);
      else if (filters.outcome === 'interrupted') where.push(`interrupted = 1`);
      else if (filters.outcome === 'retry') where.push(`(wf_end = 'superseded' OR wf_retried = 1) AND COALESCE(notif_status, '') NOT IN ('failed', 'killed', 'stopped')`);
      else if (filters.outcome === 'failed') where.push(`(notif_status = 'failed' OR (wf_end = 'failed' AND COALESCE(notif_status, '') NOT IN ('killed', 'stopped')))`);
      else where.push(`notif_status = '${filters.outcome === 'killed' ? 'killed' : 'stopped'}'`);
    }
    const filtered = where.length > 0;
    const filterSql = filtered ? where.join(' AND ') : '1 = 1';

    let pageSql = filterSql;
    const pageParams = [...params];
    if (cursor) {
      const c = decodeTaskCursor(cursor);
      if (!c) return null;
      pageSql += ` AND (ended_at < ? OR (ended_at = ? AND id < ?))`;
      pageParams.push(c.e, c.e, c.i);
    }
    const rows = this.db
      .prepare<Array<string | number>, TaskDbRow>(`${TASK_VIEW} WHERE ${pageSql} ORDER BY ended_at DESC, id DESC LIMIT ?`)
      .all(...pageParams, TASKS_PAGE + 1);
    const hasMore = rows.length > TASKS_PAGE;
    const page = rows.slice(0, TASKS_PAGE);
    const leadName = this.leadName();
    const items: TaskRow[] = page.map((r) => {
      const projectName = r.project;
      const kind: TaskRow['kind'] = r.kind === 'lead' ? 'lead' : 'subagent';
      const discard = kind === 'subagent' ? discardReason(r.notif_status, r.wf_end, r.wf_retried) : null;
      return {
        id: r.id,
        roomId: r.session_id,
        roomTitle: this.roomNotes.name(r.session_id) ?? (r.room || projectName),
        projectName,
        kind,
        agentType: r.agent_type,
        displayName: kind === 'lead' ? leadName : agentBaseName(r.agent_type),
        // el lead nunca muestra el texto de su prompt: la etiqueta dice lo que se hizo en ese turno
        title: kind === 'lead' ? this.leadWork.describe(r.session_id, r.started_at, r.ended_at) : r.title,
        startedAt: iso(r.started_at),
        endedAt: iso(r.ended_at),
        durationMs: Math.max(0, r.ended_at - r.started_at),
        tokens: toBreakdown({
          input: r.input,
          output: r.output,
          cache_read: r.cache_read,
          cache_write: r.cache_write,
          cost: r.cost_usd,
          unpriced: r.unpriced_tokens,
          estimated: 0,
        }),
        costUsd: r.unpriced_tokens > 0 ? null : r.cost_usd,
        outcome: discard ?? (r.interrupted === 1 ? 'interrupted' : 'ok'),
        model: r.model,
        role: agentRoleOf(r.kind, r.role, r.agent_type),
      };
    });
    const last = page[page.length - 1];
    const res: TasksResponse = { items, nextCursor: hasMore && last ? encodeTaskCursor(last.ended_at, last.id) : null };
    if (filtered) {
      const sum = this.db
        .prepare<Array<string | number>, { n: number; cost: number }>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM (${TASK_VIEW}) WHERE ${filterSql}`,
        )
        .get(...params);
      res.summary = { count: sum?.n ?? 0, costUsd: sum?.cost ?? 0 };
    }
    return res;
  }
}

function mergeRanking(
  usage: ReadonlyArray<TokenSumRow & { key: string }>,
  tasks: ReadonlyArray<{ key: string; n: number }>,
  label: (key: string) => string,
): RankingRow[] {
  const rows = new Map<string, RankingRow>();
  for (const u of usage) {
    rows.set(u.key, { key: u.key, label: label(u.key), tokens: toBreakdown(u), costUsd: u.cost, tasks: 0 });
  }
  for (const t of tasks) {
    const row = rows.get(t.key) ?? { key: t.key, label: label(t.key), tokens: toBreakdown(undefined), costUsd: 0, tasks: 0 };
    row.tasks = t.n;
    rows.set(t.key, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total);
}

export function registerHistoryRoutes(
  app: FastifyInstance,
  history: HistoryService,
  now: () => number,
  /** un ajuste del presupuesto cambio: el estado vivo y las alertas se recalculan */
  changed: () => void = () => {},
): void {
  app.get<{ Querystring: { month?: string } }>('/api/history/budget', async (req, reply) => {
    const month = req.query.month;
    if (month !== undefined && !MONTH_RE.test(month)) {
      return reply.code(400).send({ error: 'month debe ser YYYY-MM' });
    }
    return history.budget(month, now());
  });

  app.put<{ Body: { amountUsd?: unknown } }>('/api/budget/baseline', async (req, reply) => {
    const amount = req.body?.amountUsd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT_USD) {
      return reply.code(400).send({ error: 'amountUsd debe ser un numero entre 0 y 1.000.000' });
    }
    history.setBaseline(Math.round(amount * 100) / 100, now());
    changed();
    return history.budget(undefined, now());
  });

  app.delete('/api/budget/baseline', async () => {
    history.clearBaseline(now());
    changed();
    return history.budget(undefined, now());
  });

  app.put<{ Body: { amountUsd?: unknown } }>('/api/budget/amount', async (req, reply) => {
    const amount = req.body?.amountUsd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_USD) {
      return reply.code(400).send({ error: 'amountUsd debe ser un numero mayor que 0 y hasta 1.000.000' });
    }
    const cents = Math.round(amount * 100) / 100;
    if (cents <= 0) return reply.code(400).send({ error: 'amountUsd debe ser de al menos 0,01' });
    history.setBudgetAmount(cents);
    changed();
    return history.budget(undefined, now());
  });

  app.delete('/api/budget/amount', async () => {
    history.clearBudgetAmount();
    changed();
    return history.budget(undefined, now());
  });

  app.put<{ Body: { date?: unknown; off?: unknown } }>('/api/budget/days-off', async (req, reply) => {
    const date = req.body?.date;
    const off = req.body?.off;
    const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
    if (typeof date !== 'string' || !m || typeof off !== 'boolean') {
      return reply.code(400).send({ error: 'se espera {date: YYYY-MM-DD, off: boolean}' });
    }
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getDate() !== Number(m[3])) return reply.code(400).send({ error: 'date no es una fecha real' });
    if (off && (d.getDay() === 0 || d.getDay() === 6)) {
      return reply.code(400).send({ error: 'solo se marcan dias libres de lunes a viernes' });
    }
    history.setDayOff(date, off);
    changed();
    return history.budget(date.slice(0, 7), now());
  });

  app.put<{ Body: { project?: unknown; amountUsd?: unknown } }>('/api/budget/projects', async (req, reply) => {
    const project = req.body?.project;
    const amount = req.body?.amountUsd;
    if (typeof project !== 'string' || project.trim() === '' || project.length > 200) {
      return reply.code(400).send({ error: 'falta el proyecto' });
    }
    if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_USD)) {
      return reply.code(400).send({ error: 'amountUsd debe ser un numero mayor que 0, o null para quitar el tope' });
    }
    history.setProjectBudget(project, amount === null ? null : Math.round(amount * 100) / 100);
    changed();
    return history.budget(undefined, now());
  });

  app.get<{ Querystring: { range?: string } }>('/api/history/ranking', async (req, reply) => {
    const range = (req.query.range ?? 'month') as HistoryRange;
    if (!RANGES.includes(range)) return reply.code(400).send({ error: 'range debe ser today|week|month|all' });
    return history.ranking(range, now());
  });

  app.get<{
    Querystring: {
      cursor?: string;
      q?: string;
      project?: string;
      room?: string;
      kind?: string;
      outcome?: string;
      minUsd?: string;
      range?: string;
    };
  }>('/api/history/tasks', async (req, reply) => {
    const { q, project, room, kind, outcome, minUsd, range } = req.query;
    const filters: TaskFilters = {};
    if (q) filters.q = q.slice(0, 200);
    if (project) filters.project = project.slice(0, 200);
    if (room) filters.room = room.slice(0, 200);
    if (kind) {
      if (kind !== 'lead' && kind !== 'subagent') return reply.code(400).send({ error: 'kind debe ser lead o subagent' });
      filters.kind = kind;
    }
    if (outcome) {
      if (!TASK_OUTCOMES.includes(outcome as NonNullable<TaskFilters['outcome']>)) {
        return reply.code(400).send({ error: `outcome debe ser ${TASK_OUTCOMES.join('|')}` });
      }
      filters.outcome = outcome as NonNullable<TaskFilters['outcome']>;
    }
    if (minUsd) {
      const n = Number(minUsd);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: 'minUsd debe ser un numero' });
      filters.minUsd = n;
    }
    if (range) {
      if (!RANGES.includes(range as HistoryRange)) return reply.code(400).send({ error: 'range debe ser today|week|month|all' });
      filters.range = range as HistoryRange;
    }
    const res = history.tasks(req.query.cursor || undefined, filters, now());
    if (!res) return reply.code(400).send({ error: 'cursor invalido' });
    return res;
  });
}

const TASK_OUTCOMES: ReadonlyArray<NonNullable<TaskFilters['outcome']>> = [
  'ok',
  'bad',
  'failed',
  'killed',
  'stopped',
  'retry',
  'interrupted',
];
