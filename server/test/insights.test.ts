import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type {
  CompareResponse,
  CostsResponse,
  HabitsResponse,
  RuleId,
  SimulatorResponse,
  WorkflowAgentRef,
  WorkflowRun,
} from '@shared/contract';
import { openDb, type Db } from '../src/db/connection';
import { HistoryService, rangeStart } from '../src/routes/history';
import { registerInsightsRoutes } from '../src/routes/insights';
import { CompareService } from '../src/state/compare';
import { CostsService, modelLabel } from '../src/state/costs';
import { runRiskOf, WorkflowForecaster } from '../src/state/forecast';
import { CostBaselines, percentile, SimulatorService } from '../src/state/simulator';
import { WorkflowRuns } from '../src/state/workflows';

/** hora local del 11 de marzo de 2026 (miercoles) */
function at(hour: number, minute = 0): number {
  return new Date(2026, 2, 11, hour, minute).getTime();
}

const NOW = at(15);
const S = 'sesion-a';
const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
/** modelo sin precio en la tabla */
const MYSTERY = 'claude-misterio-9';

let seq = 0;
const next = (p: string) => `${p}-${++seq}`;

function session(db: Db, id: string, project: string): void {
  db.prepare(`INSERT INTO sessions (session_id, cwd, project_name, last_activity_at) VALUES (?, ?, ?, ?)`).run(
    id,
    `C:\\${project}`,
    project,
    NOW,
  );
}

function agent(
  db: Db,
  a: { id: string; kind?: string; type: string; role?: string | null; model: string; start: number; end: number | null },
): void {
  db.prepare(
    `INSERT INTO agents (agent_id, session_id, kind, agent_type, role, model, started_at, last_activity_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.id, S, a.kind ?? 'subagent', a.type, a.role ?? null, a.model, a.start, a.end ?? a.start, a.end);
}

/** una llamada: 1000 de input, 3000 de cache read, 1000 de cache write (cache 60 %); costo null = sin precio */
function usage(db: Db, agentId: string, model: string, ts: number, costUsd: number | null): void {
  db.prepare(
    `INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m,
                        cache_write_1h, speed, cost_usd)
     VALUES (?, ?, ?, ?, ?, 1000, 500, 3000, 1000, 0, NULL, ?)`,
  ).run(next('msg'), agentId, S, ts, model, costUsd);
}

function task(
  db: Db,
  t: { id: string; agentId: string; kind: string; type: string; start: number; end: number; cost: number; unpriced?: number },
): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, agent_id, kind, agent_type, title, started_at, ended_at, input, output,
                        cache_read, cache_write, cost_usd, unpriced_tokens)
     VALUES (?, ?, ?, ?, ?, 'tarea', ?, ?, 1000, 500, 3000, 1000, ?, ?)`,
  ).run(t.id, S, t.agentId, t.kind, t.type, t.start, t.end, t.cost, t.unpriced ?? 0);
}

function action(
  db: Db,
  agentId: string,
  ts: number,
  tool: string,
  opts: { target?: string; error?: boolean; denied?: string; cmd?: string } = {},
): void {
  db.prepare(
    `INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, ended_at, is_error, target,
                          cmd_class, denied)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(next('tu'), agentId, S, tool, ts, ts, opts.error ? 1 : 0, opts.target ?? null, opts.cmd ?? null, opts.denied ?? null);
}

function event(db: Db, agentId: string, ts: number, kind: string): void {
  db.prepare(`INSERT INTO session_events (id, session_id, agent_id, ts, kind, data) VALUES (?, ?, ?, ?, ?, NULL)`).run(
    next('ev'),
    S,
    agentId,
    ts,
    kind,
  );
}

function notification(db: Db, taskId: string, ts: number, status: string): void {
  db.prepare(`INSERT INTO notifications (task_id, ts, session_id, status) VALUES (?, ?, ?, ?)`).run(taskId, ts, S, status);
}

/**
 * Una sala con:
 * - lead en Fable: turno 1 (10:00-10:30) edita a.ts dos veces y b.ts, un test falla y se repite y pasa, usa
 *   una skill; turno 2 (11:00-11:10) interrumpido. Costo 3 y 1.
 * - subagentes de Desarrollo en Opus: a1 (1, completed, edita d.ts), a2 (2, failed), a3 (3, completed).
 * - flujo R1 en Sonnet (Investigacion): W1 reemplazado por el reintento W2 (0.4 y 0.6).
 */
function seeded(): Db {
  const db = openDb(':memory:');
  session(db, S, 'proyecto-a');
  agent(db, { id: S, kind: 'lead', type: 'lead', model: FABLE, start: at(9), end: null });

  usage(db, S, FABLE, at(10, 5), 3);
  task(db, { id: `${S}:p1`, agentId: S, kind: 'lead', type: 'lead', start: at(10), end: at(10, 30), cost: 3 });
  action(db, S, at(10, 1), 'Edit', { target: 'C:\\proyecto-a\\a.ts' });
  action(db, S, at(10, 2), 'Edit', { target: 'C:\\proyecto-a\\a.ts' });
  action(db, S, at(10, 3), 'Write', { target: 'C:\\proyecto-a\\b.ts' });
  action(db, S, at(10, 4), 'Edit', { target: 'C:\\proyecto-a\\c.ts', error: true, denied: 'user-rejected' });
  action(db, S, at(10, 5), 'Bash', { cmd: 'test', error: true });
  action(db, S, at(10, 6), 'Bash', { cmd: 'test' });
  action(db, S, at(10, 7), 'Skill');

  usage(db, S, FABLE, at(11, 2), 1);
  task(db, { id: `${S}:p2`, agentId: S, kind: 'lead', type: 'lead', start: at(11), end: at(11, 10), cost: 1 });
  action(db, S, at(11, 1), 'Read', { target: 'C:\\proyecto-a\\a.ts' });
  event(db, S, at(11, 5), 'interrupt');

  const subs: Array<[string, number, string]> = [
    ['a1', 1, 'completed'],
    ['a2', 2, 'failed'],
    ['a3', 3, 'completed'],
  ];
  for (const [id, cost, status] of subs) {
    agent(db, { id, type: 'tr-builder', role: 'builder', model: OPUS, start: at(12), end: at(12, 30) });
    usage(db, id, OPUS, at(12, 10), cost);
    task(db, { id, agentId: id, kind: 'subagent', type: 'tr-builder', start: at(12), end: at(12, 30), cost });
    notification(db, id, at(12, 30), status);
  }
  action(db, 'a1', at(12, 5), 'Edit', { target: 'C:\\proyecto-a\\d.ts' });

  db.prepare(
    `INSERT INTO workflow_runs (run_id, session_id, task_id, launched_at, final_status, final_at)
     VALUES ('wf_r1', ?, 'wt1', ?, 'completed', ?)`,
  ).run(S, at(13), at(14));
  const wf: Array<[string, number, number, string]> = [
    ['w1', 0.4, 1, 'superseded'],
    ['w2', 0.6, 2, 'result'],
  ];
  for (const [id, cost, n, end] of wf) {
    agent(db, { id, type: 'Explore', role: 'explorer', model: SONNET, start: at(13), end: at(13, 30) });
    usage(db, id, SONNET, at(13, 10), cost);
    task(db, { id, agentId: id, kind: 'subagent', type: 'Explore', start: at(13), end: at(13, 30), cost });
    db.prepare(
      `INSERT INTO workflow_agents (agent_id, run_id, session_id, key, label, phase, seq, end_status)
       VALUES (?, 'wf_r1', ?, 'explorar', 'Explorar', 'Exploracion', ?, ?)`,
    ).run(id, S, n, end);
  }
  return db;
}

const rules = (workflowCost: number | null) => ({
  value: (id: RuleId) => (id === 'workflow_cost' ? workflowCost : 1),
});

function fakeHabits(savings: number, calls: string[] = []) {
  return {
    findings(range: HabitsResponse['range']): HabitsResponse {
      calls.push(range);
      return { range, generatedAt: new Date(NOW).toISOString(), findings: [], byKind: [], totalSavingsUsd: savings };
    },
  };
}

describe('costos por modelo, proyecto y rol', () => {
  it('agrupa el uso y cuenta el trabajo descartado', () => {
    const res: CostsResponse = new CostsService(seeded()).costs('month', rangeStart('month', NOW));
    expect(res.totals.costUsd).toBeCloseTo(3 + 1 + 1 + 2 + 3 + 0.4 + 0.6, 12);
    expect(res.totals.cachePct).toBeCloseTo(0.6, 12);

    expect(res.byModel.map((r) => [r.key, r.label])).toEqual([
      [OPUS, 'Opus 5.5'],
      [FABLE, 'Fable 5.1'],
      [SONNET, 'Sonnet 5'],
    ]);
    expect(res.byModel.find((r) => r.key === FABLE)).toMatchObject({ costUsd: 4, tasks: 2, cachePct: 0.6 });
    expect(res.byModel.find((r) => r.key === OPUS)?.tasks).toBe(3);

    expect(res.byProject).toHaveLength(1);
    expect(res.byProject[0]).toMatchObject({ key: 'proyecto-a', tasks: 7 });

    const byRole = Object.fromEntries(res.byRole.map((r) => [r.key, r]));
    expect(byRole.orchestrator).toMatchObject({ label: 'Orquestador', costUsd: 4, tasks: 2 });
    expect(byRole.builder).toMatchObject({ label: 'Desarrollo', costUsd: 6, tasks: 3 });
    expect(byRole.explorer).toMatchObject({ label: 'Investigación', tasks: 2 });
    expect(byRole.explorer?.costUsd).toBeCloseTo(1, 12);

    expect(res.discarded.count).toBe(2);
    expect(res.discarded.costUsd).toBeCloseTo(2.4, 12);
    const reasons = Object.fromEntries(res.discarded.items.map((d) => [d.agentId, d]));
    expect(reasons.a2).toMatchObject({ reason: 'failed', role: 'builder', agentType: 'tr-builder', costUsd: 2 });
    expect(reasons.w1).toMatchObject({ reason: 'retry', role: 'explorer', projectName: 'proyecto-a' });
    expect(reasons.w2).toBeUndefined();
  });

  it('los tokens sin precio van aparte: no suman al costo y cada fila los cuenta', () => {
    const db = seeded();
    agent(db, { id: 'm1', type: 'tr-builder', role: 'builder', model: MYSTERY, start: at(14), end: at(14, 30) });
    usage(db, 'm1', MYSTERY, at(14, 10), null);
    const res = new CostsService(db).costs('month', rangeStart('month', NOW));
    // 1000 + 500 + 3000 + 1000 por llamada
    expect(res.totals.unpricedTokens).toBe(5500);
    expect(res.totals.costUsd).toBeCloseTo(11, 12);
    expect(res.byModel.find((r) => r.key === MYSTERY)).toMatchObject({ costUsd: 0, unpricedTokens: 5500 });
    expect(res.byModel.find((r) => r.key === OPUS)?.unpricedTokens).toBe(0);
    // Desarrollo mezcla Opus con precio y el modelo sin precio: costo parcial, marcado por la fila
    const builder = res.byRole.find((r) => r.key === 'builder');
    expect(builder?.unpricedTokens).toBe(5500);
    expect(builder?.costUsd).toBeCloseTo(6, 12);
    expect(res.byProject[0]?.unpricedTokens).toBe(5500);
  });

  it('el rango deja fuera lo anterior', () => {
    const res = new CostsService(seeded()).costs('today', at(12) + 24 * 3600_000);
    expect(res.totals.costUsd).toBe(0);
    expect(res.byModel).toEqual([]);
    expect(res.discarded.count).toBe(0);
  });

  it('etiqueta del modelo', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6');
    expect(modelLabel('<synthetic>')).toBe('<synthetic>');
  });
});

describe('comparador por configuracion', () => {
  it('familia x rol con completadas, archivos, errores, reintentos, tests y skill', () => {
    const calls: string[] = [];
    const res: CompareResponse = new CompareService(seeded(), fakeHabits(12.5, calls)).compare(
      'month',
      rangeStart('month', NOW),
    );
    const rows = Object.fromEntries(res.rows.map((r) => [r.key, r]));

    expect(rows['fable:orchestrator']).toMatchObject({
      family: 'fable',
      role: 'orchestrator',
      tasks: 2,
      // el turno 2 fue interrumpido
      completed: 1,
      costUsd: 4,
      costPerCompletedUsd: 4,
      // a.ts y b.ts; el Edit rechazado de c.ts no cuenta
      filesChanged: 2,
      // el rechazo del usuario no es error
      errors: 1,
      retries: 1,
      testRuns: 2,
      testPassPct: 0.5,
      discardedUsd: 0,
    });
    expect(rows['fable:orchestrator']?.avgDurationMs).toBe((30 + 10) * 60_000 / 2);
    expect(rows['fable:orchestrator']?.tokensPerFileChanged).toBe((5500 * 2) / 2);
    expect(rows['fable:orchestrator']?.cachePct).toBeCloseTo(0.6, 12);

    expect(rows['opus:builder']).toMatchObject({ tasks: 3, completed: 2, costUsd: 6, filesChanged: 1, discardedUsd: 2 });
    expect(rows['opus:builder']?.costPerCompletedUsd).toBe(3);
    expect(rows['opus:builder']?.testPassPct).toBeNull();

    expect(rows['sonnet:explorer']).toMatchObject({ tasks: 2, completed: 1, retries: 1 });
    expect(rows['sonnet:explorer']?.discardedUsd).toBeCloseTo(0.4, 12);

    expect(res.skill.with).toMatchObject({ tasks: 1, errors: 1, costPerCompletedUsd: 3 });
    expect(res.skill.without.tasks).toBe(6);

    expect(res.workflows.runs).toBe(1);
    expect(res.workflows.avgCostUsd).toBeCloseTo(1, 12);
    expect(res.workflows.p50CostUsd).toBeCloseTo(1, 12);
    expect(res.workflows.avgDurationMs).toBe(3600_000);

    expect(res.potentialSavingsUsd).toBe(12.5);
    expect(calls).toEqual(['month']);
  });

  it('las tareas y corridas con tokens sin precio quedan fuera de los montos; un test rechazado no es corrida', () => {
    const db = seeded();
    // a4: Desarrollo en Opus, completada, con parte sin precio: su costo a medias no entra
    agent(db, { id: 'a4', type: 'tr-builder', role: 'builder', model: OPUS, start: at(12), end: at(12, 30) });
    task(db, { id: 'a4', agentId: 'a4', kind: 'subagent', type: 'tr-builder', start: at(12), end: at(12, 30), cost: 0.5, unpriced: 800 });
    notification(db, 'a4', at(12, 30), 'completed');
    action(db, 'a4', at(12, 6), 'Bash', { cmd: 'test', error: true, denied: 'user-rejected' });
    // corrida R2 con un agente sin precio: cuenta como corrida y en la duracion, no en los montos
    db.prepare(
      `INSERT INTO workflow_runs (run_id, session_id, task_id, launched_at, final_status, final_at)
       VALUES ('wf_r2', ?, 'wt2', ?, 'completed', ?)`,
    ).run(S, at(14), at(14, 30));
    agent(db, { id: 'w9', type: 'Explore', role: 'explorer', model: MYSTERY, start: at(14), end: at(14, 20) });
    usage(db, 'w9', MYSTERY, at(14, 10), null);
    db.prepare(
      `INSERT INTO workflow_agents (agent_id, run_id, session_id, key, label, phase, seq, end_status)
       VALUES ('w9', 'wf_r2', ?, 'k', 'k', 'Fase', 1, 'result')`,
    ).run(S);

    const res = new CompareService(db, fakeHabits(0)).compare('month', rangeStart('month', NOW));
    // costo 1 + 2 + 3 de las con precio / 2 completadas con precio (a1 y a3)
    expect(res.rows.find((r) => r.key === 'opus:builder')).toMatchObject({
      tasks: 4,
      completed: 3,
      costUsd: 6,
      unpricedTasks: 1,
      costPerCompletedUsd: 3,
      errors: 0,
      testRuns: 0,
      testPassPct: null,
      discardedUsd: 2,
    });
    expect(res.rows.find((r) => r.key === 'fable:orchestrator')?.unpricedTasks).toBe(0);
    // sin skill: 1 + 1 + 2 + 3 + 0.4 + 0.6 / a1, a3 y w2
    expect(res.skill.without.tasks).toBe(7);
    expect(res.skill.without.costPerCompletedUsd).toBeCloseTo(8 / 3, 12);

    expect(res.workflows.runs).toBe(2);
    expect(res.workflows.avgCostUsd).toBeCloseTo(1, 12);
    expect(res.workflows.p50CostUsd).toBeCloseTo(1, 12);
    expect(res.workflows.avgDurationMs).toBe((60 + 30) * 60_000 / 2);
  });

  it('sin tareas completadas con precio completo el costo por completada es null', () => {
    const db = openDb(':memory:');
    session(db, S, 'proyecto-a');
    agent(db, { id: 'u1', type: 'tr-builder', role: 'builder', model: MYSTERY, start: at(12), end: at(12, 30) });
    task(db, { id: 'u1', agentId: 'u1', kind: 'subagent', type: 'tr-builder', start: at(12), end: at(12, 30), cost: 0, unpriced: 5500 });
    const res = new CompareService(db, fakeHabits(0)).compare('month', rangeStart('month', NOW));
    expect(res.rows).toEqual([expect.objectContaining({ key: 'other:builder', completed: 1, costUsd: 0, unpricedTasks: 1, costPerCompletedUsd: null })]);
    expect(res.skill.without.costPerCompletedUsd).toBeNull();
  });

  it("la skill tambien se ve por session_events; 'all' pide los habitos del mes", () => {
    const db = seeded();
    event(db, S, at(11, 3), 'skill');
    const calls: string[] = [];
    const res = new CompareService(db, fakeHabits(0, calls)).compare('all', 0);
    expect(res.skill.with.tasks).toBe(2);
    expect(calls).toEqual(['month']);
  });
});

describe('simulador: costo por agente terminado', () => {
  it('p25/p50/p75 por rol x familia, null con menos de 3 muestras', () => {
    const db = seeded();
    const baselines = new CostBaselines(db, () => NOW);
    const sim: SimulatorResponse = new SimulatorService(baselines, new HistoryService(db), rules(2), () => NOW).simulator();
    expect(sim.windowDays).toBe(30);
    expect(sim.rows).toEqual([
      { role: 'explorer', family: 'sonnet', samples: 2, p25Usd: null, p50Usd: null, p75Usd: null },
      { role: 'builder', family: 'opus', samples: 3, p25Usd: 1.5, p50Usd: 2, p75Usd: 2.5 },
    ]);
    expect(sim.availableUsd).toBeCloseTo(500 - 11, 12);
    expect(sim.workflowBudgetUsd).toBe(2);
    // general: 0.4, 0.6, 1, 2, 3
    expect(baselines.general()).toEqual({ samples: 5, p25Usd: 0.6, p50Usd: 1, p75Usd: 2 });
  });

  it('la cache se renueva cuando cambian las tareas de la ventana', () => {
    const db = seeded();
    const baselines = new CostBaselines(db, () => NOW);
    expect(baselines.of('explorer', 'sonnet')).toBeNull();
    agent(db, { id: 'w3', type: 'Explore', role: 'explorer', model: SONNET, start: at(14), end: at(14, 30) });
    task(db, { id: 'w3', agentId: 'w3', kind: 'subagent', type: 'Explore', start: at(14), end: at(14, 30), cost: 0.8 });
    expect(baselines.of('explorer', 'sonnet')).toMatchObject({ samples: 3, p50Usd: 0.6 });
  });

  it('la cache tambien se renueva cuando se reclasifica el rol o cambia el modelo de sus agentes', () => {
    const db = seeded();
    const baselines = new CostBaselines(db, () => NOW);
    expect(baselines.of('builder', 'opus')).toMatchObject({ samples: 3 });
    db.prepare(`UPDATE agents SET role = 'tester' WHERE agent_id IN ('a1', 'a2', 'a3')`).run();
    expect(baselines.of('builder', 'opus')).toBeNull();
    expect(baselines.of('tester', 'opus')).toMatchObject({ samples: 3, p50Usd: 2 });
    db.prepare(`UPDATE agents SET model = ? WHERE agent_id IN ('a1', 'a2', 'a3')`).run(SONNET);
    expect(baselines.of('tester', 'opus')).toBeNull();
    expect(baselines.of('tester', 'sonnet')).toMatchObject({ samples: 3 });
  });

  it('las tareas de hace mas de 30 dias no entran', () => {
    const db = seeded();
    const later = new Date(2026, 3, 11, 12).getTime();
    expect(new CostBaselines(db, () => later).rows()).toEqual([]);
  });

  it('percentil con interpolacion lineal', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.75)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});

function ref(p: Partial<WorkflowAgentRef> & Pick<WorkflowAgentRef, 'agentId' | 'status'>): WorkflowAgentRef {
  return {
    label: p.agentId,
    phase: null,
    displayName: p.agentId,
    agentType: 'general-purpose',
    model: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
    startedAt: new Date(NOW).toISOString(),
    endedAt: null,
    ...p,
  };
}

function runInFlight(): WorkflowRun {
  return {
    runId: 'wf_vivo',
    name: 'vivo',
    description: '',
    status: 'running',
    startedAt: new Date(NOW).toISOString(),
    endedAt: null,
    phases: [
      { title: 'Explorar', status: 'done', agentsStarted: 2, agentsDone: 2 },
      { title: 'Construir', status: 'running', agentsStarted: 2, agentsDone: 0 },
      { title: 'Revisar', status: 'pending', agentsStarted: 0, agentsDone: 0 },
    ],
    agents: [
      ref({ agentId: 'x1', status: 'done', role: 'explorer', model: SONNET, costUsd: 0.3 }),
      ref({ agentId: 'x2', status: 'failed', role: 'explorer', model: SONNET, costUsd: 0.2 }),
      ref({ agentId: 'b1', status: 'working', role: 'builder', model: OPUS, costUsd: 0.5 }),
      // Planificacion en Haiku no tiene historico: va con la mediana general
      ref({ agentId: 'p1', status: 'working', role: 'planner', model: 'claude-haiku-4-5', costUsd: 0.1 }),
    ],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 1.1,
  };
}

describe('pronostico de una corrida en vuelo', () => {
  it('gastado + lo que falta por agente trabajando + fases pendientes', () => {
    const db = seeded();
    const f = new WorkflowForecaster({ db, clock: () => NOW, rules: rules(2) });
    const forecast = f.forecast(runInFlight());
    // gastado 1.1 · b1: 2 - 0.5 .. 2.5 - 0.5 · p1: 1 - 0.1 (mediana general) · Revisar: 2 agentes x 0.6 .. 2
    expect(forecast).toEqual({ lowUsd: 4.7, highUsd: 8, budgetUsd: 2, risk: 'high', unknownAgents: 1 });
    // determinista: mismo estado, mismo JSON
    expect(JSON.stringify(f.forecast(runInFlight()))).toBe(JSON.stringify(forecast));
  });

  it('riesgo contra el tope de la corrida: por encima alto, por encima del 70 % medio, si no bajo', () => {
    expect(runRiskOf(8, null)).toBeNull();
    expect(runRiskOf(2.01, 2)).toBe('high');
    expect(runRiskOf(2, 2)).toBe('medium');
    expect(runRiskOf(1.5, 2)).toBe('medium');
    expect(runRiskOf(1.3, 2)).toBe('low');
    // un pronostico de 8 contra un tope de 10 es medio (con los umbrales del mes salia alto)
    const f = new WorkflowForecaster({ db: seeded(), clock: () => NOW, rules: rules(10) });
    expect(f.forecast(runInFlight())).toMatchObject({ highUsd: 8, budgetUsd: 10, risk: 'medium' });
    const roomy = new WorkflowForecaster({ db: seeded(), clock: () => NOW, rules: rules(20) });
    expect(roomy.forecast(runInFlight())?.risk).toBe('low');
  });

  it('con un agente sin precio no hay pronostico (no se estima sobre un monto a medias)', () => {
    const f = new WorkflowForecaster({ db: seeded(), clock: () => NOW, rules: rules(2) });
    const run = runInFlight();
    run.agents = run.agents.map((a) => (a.agentId === 'p1' ? { ...a, costUsd: null } : a));
    run.costUsd = null;
    expect(f.forecast(run)).toBeNull();
  });

  it('WorkflowRuns no lo pide para una corrida con uso sin precio', () => {
    const db = seeded();
    db.prepare(`INSERT INTO workflow_runs (run_id, session_id, launched_at) VALUES ('wf_sin_precio', ?, ?)`).run(S, at(14, 50));
    agent(db, { id: 'v2', type: 'Explore', role: 'explorer', model: MYSTERY, start: at(14, 50), end: null });
    usage(db, 'v2', MYSTERY, at(14, 55), null);
    db.prepare(
      `INSERT INTO workflow_agents (agent_id, run_id, session_id, key, label, phase, seq) VALUES ('v2', 'wf_sin_precio', ?, 'k', 'k', 'Fase', 1)`,
    ).run(S);

    const seen: string[] = [];
    const runs = new WorkflowRuns(db);
    runs.setForecaster({
      forecast: (run) => {
        seen.push(run.runId);
        return { lowUsd: 1, highUsd: 2, budgetUsd: null, risk: null, unknownAgents: 0 };
      },
    });
    const run = runs.forSession(S, NOW, at(0), new Map()).find((r) => r.runId === 'wf_sin_precio');
    expect(run?.status).toBe('running');
    expect(run?.costUsd).toBeNull();
    expect(run && 'forecast' in run).toBe(false);
    expect(seen).toEqual([]);
  });

  it('sin presupuesto por workflow no hay riesgo; sin historial no hay pronostico', () => {
    const f = new WorkflowForecaster({ db: seeded(), clock: () => NOW, rules: rules(null) });
    expect(f.forecast(runInFlight())).toMatchObject({ budgetUsd: null, risk: null });
    const empty = new WorkflowForecaster({ db: openDb(':memory:'), clock: () => NOW, rules: rules(2) });
    expect(empty.forecast(runInFlight())).toBeNull();
  });

  it('WorkflowRuns lo pide solo para las corridas en curso', () => {
    const db = seeded();
    db.prepare(`INSERT INTO workflow_runs (run_id, session_id, launched_at) VALUES ('wf_vivo', ?, ?)`).run(S, at(14, 50));
    agent(db, { id: 'v1', type: 'Explore', role: 'explorer', model: SONNET, start: at(14, 50), end: null });
    db.prepare(
      `INSERT INTO workflow_agents (agent_id, run_id, session_id, key, label, phase, seq) VALUES ('v1', 'wf_vivo', ?, 'k', 'k', 'Fase', 1)`,
    ).run(S);

    const seen: string[] = [];
    const runs = new WorkflowRuns(db);
    runs.setForecaster({
      forecast: (run) => {
        seen.push(run.runId);
        return { lowUsd: 1, highUsd: 2, budgetUsd: null, risk: null, unknownAgents: 0 };
      },
    });
    const list = runs.forSession(S, NOW, at(0), new Map());
    const byId = Object.fromEntries(list.map((r) => [r.runId, r]));
    expect(byId.wf_vivo?.status).toBe('running');
    expect(byId.wf_vivo?.forecast).toMatchObject({ lowUsd: 1, highUsd: 2 });
    expect(byId.wf_r1?.status).toBe('done');
    expect(byId.wf_r1 && 'forecast' in byId.wf_r1).toBe(false);
    expect(seen).toEqual(['wf_vivo']);
  });
});

describe('rutas de costos, comparador y simulador', () => {
  it('responden y validan el rango', async () => {
    const db = seeded();
    const app = Fastify({ logger: false });
    registerInsightsRoutes(app, {
      db,
      clock: () => NOW,
      rules: rules(2),
      habits: fakeHabits(3),
      budget: new HistoryService(db),
    });

    const costs = await app.inject({ method: 'GET', url: '/api/history/costs?range=week' });
    expect(costs.statusCode).toBe(200);
    expect((costs.json() as CostsResponse).range).toBe('week');
    expect((await app.inject({ method: 'GET', url: '/api/history/costs' })).json()).toMatchObject({ range: 'month' });
    expect((await app.inject({ method: 'GET', url: '/api/history/costs?range=siglo' })).statusCode).toBe(400);

    const compare = await app.inject({ method: 'GET', url: '/api/history/compare?range=all' });
    expect(compare.statusCode).toBe(200);
    expect((compare.json() as CompareResponse).potentialSavingsUsd).toBe(3);
    expect((await app.inject({ method: 'GET', url: '/api/history/compare?range=today' })).statusCode).toBe(400);

    const sim = await app.inject({ method: 'GET', url: '/api/history/simulator' });
    expect(sim.statusCode).toBe(200);
    expect((sim.json() as SimulatorResponse).workflowBudgetUsd).toBe(2);
    await app.close();
  });
});
