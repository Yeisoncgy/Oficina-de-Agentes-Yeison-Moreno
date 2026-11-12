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
import { cacheRatio, DiscardedWork } from '../state/costs';
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
  project_name: string | null;
  project_dir: string | null;
  registry_name: string | null;
  custom_title: string | null;
  cwd: string | null;
}

export class HistoryService {
  private readonly sumBetween;
  private readonly byAgentUsage;
  private readonly byAgentTasks;
  private readonly byProjectUsage;
  private readonly byProjectTasks;
  private readonly tasksFirst;
  private readonly tasksAfter;
  private readonly settings: Settings;
  private readonly leadWork: LeadWork;
  private readonly roomNotes: RoomNotes;
  private readonly discarded: DiscardedWork;

  constructor(db: Db) {
    this.settings = new Settings(db);
    this.discarded = new DiscardedWork(db);
    this.roomNotes = new RoomNotes(db);
    this.leadWork = new LeadWork(db);
    this.sumBetween = db.prepare<[number, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ? AND ts < ?`,
    );
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
    const taskSelect = `
      SELECT t.id, t.session_id, t.kind, t.agent_type, t.title, t.started_at, t.ended_at, t.input, t.output,
             t.cache_read, t.cache_write, t.cost_usd, t.unpriced_tokens,
             s.project_name, s.project_dir, s.registry_name, s.custom_title, s.cwd
      FROM tasks t LEFT JOIN sessions s ON s.session_id = t.session_id`;
    this.tasksFirst = db.prepare<[number], TaskDbRow>(`${taskSelect} ORDER BY t.ended_at DESC, t.id DESC LIMIT ?`);
    this.tasksAfter = db.prepare<[number, number, string, number], TaskDbRow>(`
      ${taskSelect}
      WHERE t.ended_at < ? OR (t.ended_at = ? AND t.id < ?)
      ORDER BY t.ended_at DESC, t.id DESC LIMIT ?`);
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
      trend5dUsd: trendDays.length > 0 ? trendDays.reduce((a, c) => a + c, 0) / trendDays.length : null,
      recommendedPerDayUsd: remaining > 0 ? Math.max(0, budgetUsd - spentUsd) / remaining : null,
      cachePct: cacheRatio(total),
      discardedUsd: this.discarded.between(from, end).costUsd,
    };
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

  tasks(cursor: string | undefined): TasksResponse | null {
    let rows: TaskDbRow[];
    if (cursor) {
      const c = decodeTaskCursor(cursor);
      if (!c) return null;
      rows = this.tasksAfter.all(c.e, c.e, c.i, TASKS_PAGE + 1);
    } else {
      rows = this.tasksFirst.all(TASKS_PAGE + 1);
    }
    const hasMore = rows.length > TASKS_PAGE;
    const page = rows.slice(0, TASKS_PAGE);
    const leadName = this.leadName();
    const items: TaskRow[] = page.map((r) => {
      const projectName = r.project_name ?? r.project_dir ?? '';
      const kind: TaskRow['kind'] = r.kind === 'lead' ? 'lead' : 'subagent';
      return {
        id: r.id,
        roomId: r.session_id,
        roomTitle:
          this.roomNotes.name(r.session_id) ?? r.registry_name ?? r.custom_title ?? projectName,
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
        }),
        costUsd: r.unpriced_tokens > 0 ? null : r.cost_usd,
      };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeTaskCursor(last.ended_at, last.id) : null };
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

export function registerHistoryRoutes(app: FastifyInstance, history: HistoryService, now: () => number): void {
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
    return history.budget(undefined, now());
  });

  app.delete('/api/budget/baseline', async () => {
    history.clearBaseline(now());
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
    return history.budget(undefined, now());
  });

  app.delete('/api/budget/amount', async () => {
    history.clearBudgetAmount();
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
    return history.budget(date.slice(0, 7), now());
  });

  app.get<{ Querystring: { range?: string } }>('/api/history/ranking', async (req, reply) => {
    const range = (req.query.range ?? 'month') as HistoryRange;
    if (!RANGES.includes(range)) return reply.code(400).send({ error: 'range debe ser today|week|month|all' });
    return history.ranking(range, now());
  });

  app.get<{ Querystring: { cursor?: string } }>('/api/history/tasks', async (req, reply) => {
    const res = history.tasks(req.query.cursor || undefined);
    if (!res) return reply.code(400).send({ error: 'cursor invalido' });
    return res;
  });
}
