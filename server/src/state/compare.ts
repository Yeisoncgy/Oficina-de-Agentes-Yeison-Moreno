import type {
  AgentRole,
  CompareResponse,
  CompareRow,
  CompareSummary,
  HabitsResponse,
  HistoryRange,
  ModelFamily,
} from '@shared/contract';
import type { Db } from '../db/connection';
import { modelFamily } from '../ingest/pricing';
import { agentRoleOf, discardReason } from './costs';
import { percentile } from './simulator';

/** lo que se usa de HabitsService (server/src/habits/service.ts); estructural para no depender del orden */
export interface HabitFindings {
  findings(range: HabitsResponse['range']): HabitsResponse;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

interface TaskDbRow {
  id: string;
  kind: string;
  agent_id: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  /** tokens sin precio: su costo no se conoce y la tarea queda fuera de los montos */
  unpriced_tokens: number;
  role: string | null;
  agent_type: string;
  model: string | null;
  notif_status: string | null;
  wf_end: string | null;
  wf_retried: number;
}

interface ActionRow {
  tool: string;
  target: string | null;
  is_error: number;
  denied: string | null;
  cmd_class: string | null;
}

interface RunDbRow {
  launched_at: number | null;
  end_signal: number | null;
  first_start: number | null;
  last_end: number | null;
  working: number;
  agents: number;
  cost: number;
  /** llamadas de sus agentes sin precio */
  unpriced: number;
}

/** lo que aporta una tarea (turno del lead o subagente) a su fila y al resumen con/sin skill */
interface TaskStats {
  family: ModelFamily;
  role: AgentRole;
  completed: boolean;
  /** sin tokens sin precio; si no, su costo no entra en costUsd, discardedUsd ni en los promedios de costo */
  priced: boolean;
  costUsd: number;
  durationMs: number;
  tokens: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  filesChanged: number;
  errors: number;
  retries: number;
  testRuns: number;
  testPassed: number;
  discardedUsd: number;
  usedSkill: boolean;
}

type Acc = Omit<TaskStats, 'family' | 'role' | 'completed' | 'priced' | 'usedSkill'> & {
  tasks: number;
  completed: number;
  /** completadas con precio completo: el divisor del costo por completada */
  pricedCompleted: number;
  unpricedTasks: number;
};

function emptyAcc(): Acc {
  return {
    tasks: 0,
    completed: 0,
    pricedCompleted: 0,
    unpricedTasks: 0,
    costUsd: 0,
    durationMs: 0,
    tokens: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    filesChanged: 0,
    errors: 0,
    retries: 0,
    testRuns: 0,
    testPassed: 0,
    discardedUsd: 0,
  };
}

function add(acc: Acc, s: TaskStats): void {
  acc.tasks++;
  if (s.completed) acc.completed++;
  if (s.completed && s.priced) acc.pricedCompleted++;
  if (!s.priced) acc.unpricedTasks++;
  acc.costUsd += s.costUsd;
  acc.durationMs += s.durationMs;
  acc.tokens += s.tokens;
  acc.input += s.input;
  acc.cacheRead += s.cacheRead;
  acc.cacheWrite += s.cacheWrite;
  acc.filesChanged += s.filesChanged;
  acc.errors += s.errors;
  acc.retries += s.retries;
  acc.testRuns += s.testRuns;
  acc.testPassed += s.testPassed;
  acc.discardedUsd += s.discardedUsd;
}

function cachePctOf(acc: Acc): number | null {
  const den = acc.input + acc.cacheRead + acc.cacheWrite;
  return den > 0 ? acc.cacheRead / den : null;
}

/** costo de las tareas con precio / sus completadas; null si no hay completadas con precio completo */
function costPerCompleted(acc: Acc): number | null {
  return acc.pricedCompleted > 0 ? acc.costUsd / acc.pricedCompleted : null;
}

function summaryOf(acc: Acc): CompareSummary {
  return {
    tasks: acc.tasks,
    costPerCompletedUsd: costPerCompleted(acc),
    avgDurationMs: acc.tasks > 0 ? acc.durationMs / acc.tasks : null,
    errors: acc.errors,
    cachePct: cachePctOf(acc),
  };
}

/**
 * GET /api/history/compare: eficiencia por configuracion (familia de modelo x rol), no "que agente es
 * mejor". Tarea = turno del lead o vida de un subagente, terminadas en el periodo.
 */
export class CompareService {
  private readonly tasks;
  private readonly leadModel;
  private readonly actions;
  private readonly events;
  private readonly runs;

  constructor(
    db: Db,
    private readonly habits: HabitFindings,
  ) {
    this.tasks = db.prepare<[number], TaskDbRow>(`
      SELECT t.id, t.kind, t.agent_id, t.session_id, t.started_at, t.ended_at, t.input, t.output, t.cache_read,
             t.cache_write, t.cost_usd, t.unpriced_tokens, a.role, t.agent_type, a.model,
             (SELECT n.status FROM notifications n WHERE n.task_id = t.agent_id ORDER BY n.ts DESC LIMIT 1) AS notif_status,
             w.end_status AS wf_end,
             EXISTS (SELECT 1 FROM workflow_agents w2
                     WHERE w2.run_id = w.run_id AND w2.key = w.key AND w2.seq > w.seq) AS wf_retried
      FROM tasks t
      LEFT JOIN agents a ON a.agent_id = t.agent_id
      LEFT JOIN workflow_agents w ON w.agent_id = t.agent_id
      WHERE t.ended_at >= ?
      ORDER BY t.ended_at, t.id`);
    // el lead puede cambiar de modelo entre turnos: cuenta el que mas tokens uso en el turno
    this.leadModel = db.prepare<[string, number, number], { model: string }>(`
      SELECT model FROM usage WHERE agent_id = ? AND ts >= ? AND ts <= ?
      GROUP BY model ORDER BY SUM(input + output + cache_read + cache_write_5m + cache_write_1h) DESC, model LIMIT 1`);
    this.actions = db.prepare<[string, number, number], ActionRow>(`
      SELECT tool, target, is_error, denied, cmd_class FROM actions
      WHERE agent_id = ? AND started_at >= ? AND started_at <= ?
      ORDER BY started_at, tool_use_id`);
    this.events = db.prepare<[string, number, number, string], { kind: string }>(`
      SELECT kind FROM session_events
      WHERE session_id = ? AND ts >= ? AND ts <= ? AND agent_id = ? AND kind IN ('interrupt', 'skill')
      GROUP BY kind`);
    this.runs = db.prepare<[], RunDbRow>(`
      SELECT r.launched_at,
             COALESCE((SELECT MIN(n.ts) FROM notifications n WHERE n.task_id = r.task_id), r.final_at) AS end_signal,
             (SELECT MIN(COALESCE(a.started_at, a.last_activity_at)) FROM workflow_agents w
              JOIN agents a ON a.agent_id = w.agent_id WHERE w.run_id = r.run_id) AS first_start,
             (SELECT MAX(a.ended_at) FROM workflow_agents w
              JOIN agents a ON a.agent_id = w.agent_id WHERE w.run_id = r.run_id) AS last_end,
             (SELECT COUNT(*) FROM workflow_agents w
              JOIN agents a ON a.agent_id = w.agent_id WHERE w.run_id = r.run_id AND a.ended_at IS NULL) AS working,
             (SELECT COUNT(*) FROM workflow_agents w WHERE w.run_id = r.run_id) AS agents,
             (SELECT TOTAL(u.cost_usd) FROM workflow_agents w
              JOIN usage u ON u.agent_id = w.agent_id WHERE w.run_id = r.run_id) AS cost,
             (SELECT COUNT(*) FROM workflow_agents w
              JOIN usage u ON u.agent_id = w.agent_id WHERE w.run_id = r.run_id AND u.cost_usd IS NULL) AS unpriced
      FROM workflow_runs r`);
  }

  /** `from` = inicio del rango (rangeStart en routes/history.ts) */
  compare(range: Exclude<HistoryRange, 'today'>, from: number): CompareResponse {
    const rows = new Map<string, { family: ModelFamily; role: AgentRole; acc: Acc }>();
    const withSkill = emptyAcc();
    const withoutSkill = emptyAcc();
    for (const t of this.tasks.all(from)) {
      const s = this.stats(t);
      const key = `${s.family}:${s.role}`;
      const row = rows.get(key) ?? { family: s.family, role: s.role, acc: emptyAcc() };
      add(row.acc, s);
      rows.set(key, row);
      add(s.usedSkill ? withSkill : withoutSkill, s);
    }

    const out: CompareRow[] = [...rows].map(([key, { family, role, acc }]) => ({
      key,
      family,
      role,
      tasks: acc.tasks,
      completed: acc.completed,
      costUsd: acc.costUsd,
      unpricedTasks: acc.unpricedTasks,
      costPerCompletedUsd: costPerCompleted(acc),
      filesChanged: acc.filesChanged,
      tokensPerFileChanged: acc.filesChanged > 0 ? acc.tokens / acc.filesChanged : null,
      avgDurationMs: acc.tasks > 0 ? acc.durationMs / acc.tasks : null,
      errors: acc.errors,
      retries: acc.retries,
      testRuns: acc.testRuns,
      testPassPct: acc.testRuns > 0 ? acc.testPassed / acc.testRuns : null,
      cachePct: cachePctOf(acc),
      discardedUsd: acc.discardedUsd,
    }));
    out.sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));

    return {
      range,
      rows: out,
      skill: { with: summaryOf(withSkill), without: summaryOf(withoutSkill) },
      workflows: this.workflows(from),
      // los habitos no tienen ventana 'all': el ahorro posible de 'all' es el del mes
      potentialSavingsUsd: this.habits.findings(range === 'all' ? 'month' : range).totalSavingsUsd,
    };
  }

  private stats(t: TaskDbRow): TaskStats {
    const lead = t.kind === 'lead';
    const model = lead ? (this.leadModel.get(t.agent_id, t.started_at, t.ended_at)?.model ?? t.model) : t.model;
    const actions = this.actions.all(t.agent_id, t.started_at, t.ended_at);
    const events = new Set(this.events.all(t.session_id, t.started_at, t.ended_at, t.agent_id).map((e) => e.kind));

    const files = new Set<string>();
    let errors = 0;
    let retries = 0;
    let testRuns = 0;
    let testPassed = 0;
    let usedSkill = events.has('skill');
    let prev: ActionRow | null = null;
    for (const a of actions) {
      const failed = a.is_error === 1 && a.denied === null;
      if (failed) errors++;
      if (a.is_error === 0 && a.target && EDIT_TOOLS.has(a.tool)) files.add(a.target);
      // un test que el usuario rechazo no corrio: ni pasa ni falla
      if (a.cmd_class === 'test' && a.denied === null) {
        testRuns++;
        if (a.is_error === 0) testPassed++;
      }
      if (a.tool === 'Skill') usedSkill = true;
      // repetir la misma herramienta justo despues de que fallo
      if (prev && prev.is_error === 1 && prev.denied === null && prev.tool === a.tool) retries++;
      prev = a;
    }
    const finalError = prev !== null && prev.is_error === 1 && prev.denied === null;

    const discarded = lead ? null : discardReason(t.notif_status, t.wf_end, t.wf_retried);
    if (discarded === 'retry') retries++;
    const failedEnd = discarded !== null || t.wf_end === 'failed';
    // tasks.cost_usd solo suma lo que tiene precio: con tokens sin precio seria un monto a medias
    const priced = t.unpriced_tokens === 0;

    return {
      family: modelFamily(model),
      role: agentRoleOf(t.kind, t.role, t.agent_type),
      completed: !events.has('interrupt') && !finalError && !failedEnd,
      priced,
      costUsd: priced ? t.cost_usd : 0,
      durationMs: Math.max(0, t.ended_at - t.started_at),
      tokens: t.input + t.output + t.cache_read + t.cache_write,
      input: t.input,
      cacheRead: t.cache_read,
      cacheWrite: t.cache_write,
      filesChanged: files.size,
      errors,
      retries,
      testRuns,
      testPassed,
      discardedUsd: discarded !== null && priced ? t.cost_usd : 0,
      usedSkill,
    };
  }

  /**
   * corridas terminadas en el periodo (con senal de fin, o sin agentes trabajando). Las que usaron algun
   * modelo sin precio cuentan en corridas y duracion, no en los montos
   */
  private workflows(from: number): CompareResponse['workflows'] {
    const costs: number[] = [];
    let runs = 0;
    let durationSum = 0;
    let durationN = 0;
    for (const r of this.runs.all()) {
      const end = r.end_signal ?? (r.working === 0 && r.agents > 0 ? r.last_end : null);
      if (end === null || end < from) continue;
      runs++;
      if (r.unpriced === 0) costs.push(r.cost);
      const start = r.launched_at ?? r.first_start;
      if (start !== null) {
        durationSum += Math.max(0, end - start);
        durationN++;
      }
    }
    costs.sort((a, b) => a - b);
    return {
      runs,
      avgDurationMs: durationN > 0 ? durationSum / durationN : null,
      avgCostUsd: costs.length > 0 ? costs.reduce((a, c) => a + c, 0) / costs.length : null,
      p50CostUsd: costs.length > 0 ? percentile(costs, 0.5) : null,
    };
  }
}
