import type { WorkflowAgentRef, WorkflowForecast, WorkflowPhase, WorkflowRun, WorkflowStatus } from '@shared/contract';
import { assignPersonas, PERSONA_BY_TYPE, personaName } from '@shared/personas';
import { roleOrNull } from '../ingest/roleStore';
import { MAX_WORKFLOWS_PER_ROOM, TIMING } from '../config';
import type { Db } from '../db/connection';
import { strictCost, toBreakdown, TOKEN_SUM_SQL, ZERO_SUM, type TokenSumRow } from '../db/tokens';

interface RunRow {
  run_id: string;
  tool_name: string | null;
  meta_name: string | null;
  meta_description: string | null;
  meta_phases: string | null;
  launched_at: number | null;
  final_status: string | null;
  final_at: number | null;
  journal_mtime: number | null;
  notif_at: number | null;
  notif_status: string | null;
  has_working: number;
  agents_last: number | null;
}

interface RunAgentRow {
  agent_id: string;
  label: string | null;
  phase: string | null;
  end_status: string | null;
  agent_type: string;
  look_type: string | null;
  role: string | null;
  model: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  ended_at: number | null;
}

/** task-notification y <runId>.json -> estado de la corrida */
const RUN_STATUS: Record<string, WorkflowStatus> = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function phaseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.length > 0) : [];
  } catch {
    return [];
  }
}

function addSum(acc: TokenSumRow, s: TokenSumRow): void {
  acc.input += s.input;
  acc.output += s.output;
  acc.cache_read += s.cache_read;
  acc.cache_write += s.cache_write;
  acc.cost += s.cost;
  acc.unpriced += s.unpriced;
}

/** estima el costo final de una corrida en curso (state/forecast.ts) */
export interface RunForecaster {
  forecast(run: WorkflowRun): WorkflowForecast | null;
}

/** corridas del tool Workflow de una sesion para el snapshot */
export class WorkflowRuns {
  private readonly runs;
  private readonly agents;
  private readonly sumAgent;
  private readonly dismissed;
  /** sin el, las corridas en curso no traen pronostico */
  private forecaster: RunForecaster | null = null;

  constructor(db: Db) {
    this.dismissed = db.prepare<[], { run_id: string }>(`SELECT run_id FROM dismissed_runs`);
    this.runs = db.prepare<[string], RunRow>(`
      SELECT r.run_id, r.tool_name, r.meta_name, r.meta_description, r.meta_phases, r.launched_at,
             r.final_status, r.final_at, f.mtime_ms AS journal_mtime, n.ts AS notif_at, n.status AS notif_status,
             EXISTS (SELECT 1 FROM workflow_agents w JOIN agents a ON a.agent_id = w.agent_id
                     WHERE w.run_id = r.run_id AND a.ended_at IS NULL) AS has_working,
             (SELECT MAX(COALESCE(a.ended_at, a.last_activity_at)) FROM workflow_agents w
              JOIN agents a ON a.agent_id = w.agent_id WHERE w.run_id = r.run_id) AS agents_last
      FROM workflow_runs r
      LEFT JOIN file_offsets f ON f.path_key = r.journal_key
      LEFT JOIN notifications n ON n.rowid = (
        SELECT n2.rowid FROM notifications n2 WHERE n2.task_id = r.task_id ORDER BY n2.ts LIMIT 1)
      WHERE r.session_id = ?`);
    this.agents = db.prepare<[string], RunAgentRow>(`
      SELECT w.agent_id, w.label, w.phase, w.end_status, a.agent_type, a.look_type, a.role, a.model, a.started_at,
             a.last_activity_at, a.ended_at
      FROM workflow_agents w JOIN agents a ON a.agent_id = w.agent_id
      WHERE w.run_id = ?
      ORDER BY w.seq IS NULL, w.seq, COALESCE(a.started_at, 0), w.agent_id`);
    this.sumAgent = db.prepare<[string], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ?`);
  }

  setForecaster(f: RunForecaster | null): void {
    this.forecaster = f;
  }

  /**
   * activas + terminadas desde `midnight` que el usuario no quito de la lista; activas primero, luego la que
   * termino mas tarde. Una quitada que vuelve a correr reaparece.
   */
  forSession(
    sessionId: string,
    now: number,
    midnight: number,
    names: ReadonlyMap<string, { name: string; persona?: string }>,
  ): WorkflowRun[] {
    const built: Array<{ run: WorkflowRun; order: number }> = [];
    let dismissed: Set<string> | null = null;
    for (const r of this.runs.all(sessionId)) {
      const last = Math.max(r.journal_mtime ?? 0, r.notif_at ?? 0, r.final_at ?? 0, r.agents_last ?? 0, r.launched_at ?? 0);
      if (r.has_working === 0 && last < midnight) continue;
      const b = this.build(r, now, names);
      if (b.run.status !== 'running') {
        dismissed ??= new Set(this.dismissed.all().map((d) => d.run_id));
        if (dismissed.has(r.run_id)) continue;
      }
      if (b.run.status === 'running' || (b.endMs !== null && b.endMs >= midnight)) built.push({ run: b.run, order: b.endMs ?? b.startMs });
    }
    built.sort(
      (a, b) => Number(b.run.status === 'running') - Number(a.run.status === 'running') || b.order - a.order,
    );
    return built.slice(0, MAX_WORKFLOWS_PER_ROOM).map((b) => b.run);
  }

  private build(
    r: RunRow,
    now: number,
    names: ReadonlyMap<string, { name: string; persona?: string }>,
  ): { run: WorkflowRun; startMs: number; endMs: number | null } {
    const rows = this.agents.all(r.run_id);
    const typeOf = (a: RunAgentRow) =>
      a.look_type ?? (a.agent_type === 'workflow-subagent' ? 'general-purpose' : a.agent_type);
    // cada agente de la corrida es una persona distinta: los que estan (o estuvieron) en la oficina
    // conservan la suya; los demas toman una libre
    const known = new Map<string, string>();
    for (const a of rows) {
      const p = names.get(a.agent_id)?.persona;
      if (p) known.set(a.agent_id, p);
    }
    const runPersonas = assignPersonas(known, rows.map((a) => ({ id: a.agent_id, type: typeOf(a) })));
    const total: TokenSumRow = { ...ZERO_SUM };
    let firstStart: number | null = null;
    let lastEnd: number | null = null;
    const agents: WorkflowAgentRef[] = [];
    for (const a of rows) {
      const sum = this.sumAgent.get(a.agent_id) ?? ZERO_SUM;
      addSum(total, sum);
      const start = a.started_at ?? a.last_activity_at;
      if (start !== null && (firstStart === null || start < firstStart)) firstStart = start;
      if (a.ended_at !== null && (lastEnd === null || a.ended_at > lastEnd)) lastEnd = a.ended_at;
      const failed = a.end_status === 'failed' || a.end_status === 'superseded';
      const type = typeOf(a);
      const persona = runPersonas.get(a.agent_id) ?? PERSONA_BY_TYPE[type] ?? 'gael';
      const role = roleOrNull(a.role);
      agents.push({
        agentId: a.agent_id,
        label: a.label ?? '',
        phase: a.phase,
        displayName: personaName(persona),
        agentType: type,
        ...(role ? { role } : {}),
        persona,
        status: a.ended_at === null ? 'working' : failed ? 'failed' : 'done',
        model: a.model,
        tokens: toBreakdown(sum),
        costUsd: strictCost(sum),
        startedAt: iso(start ?? r.launched_at ?? now),
        endedAt: a.ended_at !== null ? iso(a.ended_at) : null,
      });
    }

    const titles = phaseList(r.meta_phases);
    for (const a of rows) if (a.phase && !titles.includes(a.phase)) titles.push(a.phase);
    const phases: WorkflowPhase[] = titles.map((title) => {
      const list = agents.filter((a) => a.phase === title);
      let status: WorkflowPhase['status'] = 'pending';
      if (list.some((a) => a.status === 'working')) status = 'running';
      else if (list.length > 0) status = list.every((a) => a.status === 'failed') ? 'failed' : 'done';
      return { title, status, agentsStarted: list.length, agentsDone: list.filter((a) => a.status !== 'working').length };
    });

    const allFailed = agents.length > 0 && agents.every((a) => a.status === 'failed');
    let status: WorkflowStatus;
    let endMs: number | null;
    if (r.notif_status !== null && r.notif_at !== null) {
      status = RUN_STATUS[r.notif_status] ?? 'done';
      endMs = r.notif_at;
    } else if (r.final_status !== null) {
      status = RUN_STATUS[r.final_status] ?? 'done';
      endMs = r.final_at ?? lastEnd ?? r.journal_mtime ?? now;
    } else {
      // sin senal de fin: en curso mientras haya agentes trabajando o el journal se mueva
      const quietSince = r.journal_mtime ?? r.launched_at;
      const recent = quietSince !== null && now - quietSince < TIMING.workflowQuietMs;
      if (agents.some((a) => a.status === 'working') || recent) {
        status = 'running';
        endMs = null;
      } else {
        status = allFailed ? 'failed' : 'done';
        endMs = lastEnd ?? quietSince ?? now;
      }
    }
    const startMs = r.launched_at ?? firstStart ?? r.journal_mtime ?? now;

    const run: WorkflowRun = {
      runId: r.run_id,
      name: r.meta_name ?? r.tool_name ?? r.run_id,
      description: r.meta_description ?? '',
      status,
      startedAt: iso(startMs),
      endedAt: endMs !== null ? iso(endMs) : null,
      phases,
      agents,
      tokens: toBreakdown(total),
      costUsd: strictCost(total),
    };
    // sin precio de algun agente no hay monto que pronosticar
    if (status === 'running' && run.costUsd !== null && this.forecaster) run.forecast = this.forecaster.forecast(run);
    return { run, startMs, endMs };
  }
}
