import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentActionsResponse,
  BudgetResponse,
  BudgetStatus,
  CostsResponse,
  IngestHealth,
  MonthsResponse,
  PricesResponse,
  ReconcileResponse,
  ReportResponse,
  RoomFilesResponse,
  RulesResponse,
  SessionsResponse,
  TasksResponse,
  WhatIfResponse,
} from '@shared/contract';
import { TODO_KEY } from '@shared/contract';
import { buildApp, createContext, runBackfill } from '../src/app';
import { openDb, type Db } from '../src/db/connection';
import { budgetCapOf } from '../src/habits/rules';
import { setPriceBook } from '../src/ingest/pricing';
import { HistoryService } from '../src/routes/history';
import { thresholdOf, toStatus } from '../src/state/budgetWatch';
import { splitByTokenType, toolGroup } from '../src/state/extras';
import { Settings } from '../src/state/settings';
import { budgetNotice, Watchdog } from '../src/state/watchdog';
import { BUILDER_ID, line, loadFixture, SESSION_ID, TempHome } from './helpers';

afterEach(() => {
  // los precios del usuario y los aprendidos viven en el modulo: cada prueba empieza sin ninguno
  setPriceBook(new Map(), new Map());
});

function local(month: number, day: number, hour = 12): number {
  return new Date(2026, month - 1, day, hour).getTime();
}

let seq = 0;
function usage(db: Db, ts: number, costUsd: number, session = 'sesion-1'): void {
  db.prepare(
    `INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m,
                        cache_write_1h, speed, cost_usd)
     VALUES (?, ?, ?, ?, 'claude-opus-5-5', 100, 10, 300, 100, 0, NULL, ?)`,
  ).run(`x-${++seq}`, session, session, ts, costUsd);
}

describe('ritmo y agotamiento del presupuesto', () => {
  // marzo de 2026: el 1 es domingo; hoy = miercoles 11. Laborales que faltan despues de hoy: 12, 13, 16...
  it('dice el dia en que se acaba al ritmo de los ultimos dias', () => {
    const db = openDb(':memory:');
    for (const day of [2, 3, 4, 5, 6, 9, 10, 11]) usage(db, local(3, day), 50);
    const b = new HistoryService(db).budget(undefined, local(3, 11, 18));
    expect(b.spentUsd).toBe(400);
    expect(b.crossedDate).toBeNull();
    // quedan 100 a 50 por dia: se acaba el segundo laboral que viene (viernes 13)
    expect(b.runOutDate).toBe('2026-03-13');
    expect(b.todayUsd).toBe(50);
    expect(b.week).toMatchObject({ from: '2026-03-09', spentUsd: 150 });
    // 5 laborales de 22 en la semana del 9 al 15
    expect(b.week?.targetUsd).toBeCloseTo((500 * 5) / 22, 6);
    expect(toStatus(b)).toMatchObject({ threshold: 75, projectedOver: true, dayOver: true });
  });

  it('con el tope ya pasado dice que dia se cruzo y no promete fecha', () => {
    const db = openDb(':memory:');
    usage(db, local(3, 2), 200);
    usage(db, local(3, 3), 350);
    const b = new HistoryService(db).budget(undefined, local(3, 11, 18));
    expect(b.crossedDate).toBe('2026-03-03');
    expect(b.runOutDate).toBeNull();
    const status = toStatus(b);
    expect(status).toMatchObject({ threshold: 100, projectedOver: false, dayOver: false, crossedDate: '2026-03-03' });
    expect(budgetNotice(status).title).toContain('pasaste el presupuesto');
  });

  it('con poco gasto alcanza para el mes', () => {
    const db = openDb(':memory:');
    usage(db, local(3, 10), 5);
    const b = new HistoryService(db).budget(undefined, local(3, 11, 18));
    expect(b.runOutDate).toBeNull();
    expect(toStatus(b)).toMatchObject({ threshold: 0, projectedOver: false });
  });

  it('umbrales 50, 75, 90 y 100', () => {
    expect([0.49, 0.5, 0.749, 0.75, 0.9, 0.999, 1, 3].map(thresholdOf)).toEqual([0, 50, 50, 75, 90, 90, 100, 100]);
  });

  it('tope por proyecto: sale con su gasto y marca al que lo pasa', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO sessions (session_id, project_name) VALUES ('s-a', 'alfa'), ('s-b', 'beta')`).run();
    usage(db, local(3, 10), 30, 's-a');
    usage(db, local(3, 10), 8, 's-b');
    const history = new HistoryService(db);
    history.setProjectBudget('alfa', 20);
    history.setProjectBudget('gamma', 15);
    const b = history.budget(undefined, local(3, 11));
    expect(b.projects).toEqual([
      { project: 'alfa', spentUsd: 30, capUsd: 20 },
      { project: 'beta', spentUsd: 8, capUsd: null },
      { project: 'gamma', spentUsd: 0, capUsd: 15 },
    ]);
    expect(toStatus(b).projectsOver).toEqual([{ project: 'alfa', spentUsd: 30, capUsd: 20 }]);
    history.setProjectBudget('alfa', null);
    expect(toStatus(history.budget(undefined, local(3, 11))).projectsOver).toEqual([]);
  });
});

describe('topes de las reglas segun el presupuesto', () => {
  it('sesion = recomendado por dia, flujo = 25 % y agente = 10 % de lo que queda', () => {
    const caps = { remainingUsd: 200, perDayUsd: 25 };
    expect(budgetCapOf('session_day_cost', caps)).toBe(25);
    expect(budgetCapOf('workflow_cost', caps)).toBe(50);
    expect(budgetCapOf('agent_cost', caps)).toBe(20);
    expect(budgetCapOf('loop_repeats', caps)).toBeNull();
    expect(budgetCapOf('session_day_cost', { remainingUsd: 40, perDayUsd: null })).toBe(40);
    expect(budgetCapOf('agent_cost', null)).toBeNull();
  });
});

function status(patch: Partial<BudgetStatus>): BudgetStatus {
  return {
    month: '2026-03',
    budgetUsd: 500,
    spentUsd: 100,
    projectedUsd: 200,
    usedRatio: 0.2,
    threshold: 0,
    projectedOver: false,
    todayUsd: 5,
    perDayUsd: 20,
    dayOver: false,
    burnPerHourUsd: 1,
    runOutDate: null,
    crossedDate: null,
    estimatedUsd: 0,
    projectsOver: [],
    ...patch,
  };
}

describe('avisos del sistema', () => {
  function setup(first: BudgetStatus) {
    const db = openDb(':memory:');
    const settings = new Settings(db);
    const sent: string[] = [];
    const state = { budget: first, clients: 1 };
    const dog = new Watchdog({
      settings,
      budget: () => state.budget,
      snapshot: () => ({ generatedAt: '', leadRoomId: null, rooms: [], today: { costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      clients: () => state.clients,
      notifier: { notify: (title) => sent.push(title) },
      clock: () => local(3, 11),
    });
    return { dog, sent, state, settings };
  }

  it('avisa una vez por umbral y lo recuerda entre arranques', () => {
    const { dog, sent, state, settings } = setup(status({ threshold: 50, usedRatio: 0.5, spentUsd: 250 }));
    dog.check();
    dog.check();
    expect(sent).toEqual(['Colmena: presupuesto al 50 %']);
    expect(settings.budgetNotified()).toMatchObject({ month: '2026-03', threshold: 50 });
    state.budget = status({ threshold: 100, usedRatio: 1.2, spentUsd: 600 });
    dog.check();
    dog.check();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('pasaste el presupuesto del mes');
  });

  it('proyeccion, dia y proyecto avisan una sola vez; apagado no avisa', () => {
    const over = status({ projectedOver: true, dayOver: true, projectsOver: [{ project: 'alfa', spentUsd: 30, capUsd: 20 }] });
    const { dog, sent, settings } = setup(over);
    dog.check();
    dog.check();
    expect(sent).toEqual([
      'Colmena: a este ritmo pasas el presupuesto',
      'Colmena: hoy ya pasaste el gasto recomendado',
      'Colmena: alfa paso su tope del mes',
    ]);
    const off = setup(over);
    off.settings.setSystem({ notifyDesktop: false });
    off.dog.check();
    expect(off.sent).toEqual([]);
    expect(settings.system()).toEqual({ notifyDesktop: true, keepAlive: false });
  });
});

describe('reparto por tipo de token y herramientas', () => {
  it('reparte con las tarifas del modelo y la suma es el costo guardado', () => {
    // opus 5.5: 4 / 20 / 5 / 8 / 0,20 por millon
    const split = splitByTokenType([
      { model: 'claude-opus-5-5', speed: null, long: 0, i: 1_000_000, o: 1_000_000, cr: 10_000_000, w5: 1_000_000, w1: 0, cost: 31 },
    ]);
    expect(split.inputUsd).toBeCloseTo(4, 9);
    expect(split.outputUsd).toBeCloseTo(20, 9);
    expect(split.cacheReadUsd).toBeCloseTo(2, 9);
    expect(split.cacheWriteUsd).toBeCloseTo(5, 9);
    // un modelo sin tarifa no pierde su costo: se reparte con la proporcion tipica
    const unknown = splitByTokenType([{ model: 'otro', speed: null, long: 0, i: 100, o: 0, cr: 0, w5: 0, w1: 0, cost: 7 }]);
    expect(unknown.inputUsd).toBeCloseTo(7, 9);
  });

  it('junta las herramientas de un mismo servidor MCP', () => {
    expect(toolGroup('mcp__supabase__execute_sql')).toBe('MCP supabase');
    expect(toolGroup('Bash')).toBe('Bash');
  });
});

describe('precio aprendido, gasto oculto y recotizacion', () => {
  const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  function assistant(id: string, model: string, ts: string): string {
    return line({
      type: 'assistant',
      uuid: `uuid-${id}`,
      timestamp: ts,
      sessionId: SESSION,
      message: {
        id,
        model,
        role: 'assistant',
        content: [{ type: 'text', text: 'respuesta falsa' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  async function setup(extra = '') {
    const home = new TempHome();
    home.write(
      `projects/C--demo-precios/${SESSION}.jsonl`,
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: SESSION,
        cwd: 'C:\\demo\\precios',
        message: { role: 'user', content: 'pedido falso' },
      }) +
        assistant('msg_nuevo', 'claude-fable-5-2', '2026-01-15T10:00:05.000Z') +
        extra,
    );
    const now = Date.parse('2026-01-15T10:30:00.000Z');
    const ctx = createContext({ db: openDb(':memory:'), claudeHome: home.root, now: () => now, log: () => {} });
    await runBackfill(ctx);
    return { ctx, home };
  }

  const costOf = (db: Db, id: string) =>
    db.prepare<[string], { cost_usd: number | null; cost_est: number }>(`SELECT cost_usd, cost_est FROM usage WHERE message_id = ?`).get(id);

  it('sin precio en la tabla usa el de su familia, marcado como estimado', async () => {
    const { ctx, home } = await setup();
    try {
      // fable 5.1 (el mas nuevo de la familia): 10 de entrada + 50 de salida
      expect(costOf(ctx.db, 'msg_nuevo')).toEqual({ cost_usd: 60, cost_est: 1 });
      const b = ctx.history.budget('2026-01', ctx.now());
      expect(b.unpricedTokens).toBe(0);
      expect(b.estimatedUsd).toBe(60);
    } finally {
      home.cleanup();
    }
  });

  it('aprende el precio del cost-state, suma el gasto que no esta en el transcript y recotiza', async () => {
    const costState = line({
      type: 'cost-state',
      sessionId: SESSION,
      totalCostUSD: 25,
      startTime: Date.parse('2026-01-15T10:00:00.000Z'),
      hasUnknownModelCost: false,
      totalLinesAdded: 12,
      totalLinesRemoved: 3,
      modelUsage: {
        // 1 M de entrada + 1 M de salida a precio de opus 5.5 (4 + 20)
        'claude-fable-5-2': { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 24 },
        'claude-haiku-5-5': { inputTokens: 5_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1 },
      },
    });
    const { ctx, home } = await setup(costState);
    try {
      expect(costOf(ctx.db, 'msg_nuevo')).toEqual({ cost_usd: 24, cost_est: 1 });
      expect(costOf(ctx.db, `cs:${SESSION}:claude-haiku-5-5`)).toEqual({ cost_usd: 1, cost_est: 0 });
      // el modelo que si esta en el transcript no se duplica como oculto
      expect(costOf(ctx.db, `cs:${SESSION}:claude-fable-5-2`)).toBeUndefined();

      const app = buildApp(ctx);
      const prices = (await app.inject({ method: 'GET', url: '/api/prices' })).json<PricesResponse>();
      expect(prices.rows.find((r) => r.model === 'claude-fable-5-2')).toMatchObject({ source: 'learned', priceOf: 'claude-opus-5-5', costUsd: 24 });
      expect(prices.rows.find((r) => r.model === 'claude-haiku-5-5')).toMatchObject({ costUsd: 1 });

      const budget = (await app.inject({ method: 'GET', url: '/api/history/budget?month=2026-01' })).json<BudgetResponse>();
      expect(budget.spentUsd).toBe(25);
      expect(budget.estimatedUsd).toBe(24);
      expect(budget.hiddenUsd).toBe(1);

      const rec = (await app.inject({ method: 'GET', url: '/api/history/reconcile' })).json<ReconcileResponse>();
      expect(rec).toMatchObject({ sessions: 1, oursUsd: 24, hiddenUsd: 1, claudeUsd: 25 });
      expect(rec.diffUsd).toBeCloseTo(0, 9);

      const sessions = (await app.inject({ method: 'GET', url: '/api/history/sessions?range=all' })).json<SessionsResponse>();
      expect(sessions.rows[0]).toMatchObject({ id: SESSION, costUsd: 25, linesAdded: 12, linesRemoved: 3 });

      // el usuario fija el precio: se recotiza desde la base, sin releer nada, y deja de ser estimado
      const put = await app.inject({
        method: 'PUT',
        url: '/api/prices/claude-fable-5-2',
        payload: { input: 1, output: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      });
      expect(put.statusCode).toBe(200);
      expect(costOf(ctx.db, 'msg_nuevo')).toEqual({ cost_usd: 3, cost_est: 0 });
      expect(put.json<PricesResponse>().rows.find((r) => r.model === 'claude-fable-5-2')).toMatchObject({ source: 'custom', costUsd: 3 });
      const task = ctx.db.prepare<[], { cost_usd: number }>(`SELECT cost_usd FROM tasks WHERE kind = 'lead'`).get();
      expect(task?.cost_usd).toBe(3);

      const del = await app.inject({ method: 'DELETE', url: '/api/prices/claude-fable-5-2' });
      expect(del.json<PricesResponse>().rows.find((r) => r.model === 'claude-fable-5-2')).toMatchObject({ source: 'learned', costUsd: 24 });
      expect((await app.inject({ method: 'PUT', url: '/api/prices/claude-fable-5-2', payload: { input: -1 } })).statusCode).toBe(400);
      await app.close();
    } finally {
      home.cleanup();
    }
  });
});

describe('rutas nuevas sobre el fixture', () => {
  it('responden con la forma del contrato', async () => {
    const ctx = await loadFixture();
    const app = buildApp(ctx);
    const get = async <T>(url: string): Promise<T> => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      return res.json<T>();
    };

    const office = await get<{ budget?: BudgetStatus; rooms: Array<{ lead: { context?: { tokens: number } | null } }> }>('/api/office');
    expect(office.budget).toMatchObject({ month: '2026-01', budgetUsd: 500, threshold: 0 });
    expect(office.rooms[0]?.lead.context?.tokens).toBeGreaterThan(0);

    const costs = await get<CostsResponse>('/api/history/costs?range=all');
    const t = costs.byTokenType;
    expect(t).toBeDefined();
    expect((t?.inputUsd ?? 0) + (t?.outputUsd ?? 0) + (t?.cacheReadUsd ?? 0) + (t?.cacheWriteUsd ?? 0)).toBeCloseTo(costs.totals.costUsd, 9);
    expect(costs.byTool?.length).toBeGreaterThan(0);

    const months = await get<MonthsResponse>('/api/history/months');
    expect(months.months[0]).toMatchObject({ month: '2026-01', budgetUsd: 500 });
    expect(months.months[0]?.spentUsd).toBeCloseTo(costs.totals.costUsd, 9);

    const sessions = await get<SessionsResponse>('/api/history/sessions?range=all');
    expect(sessions.rows.map((s) => s.id)).toContain(SESSION_ID);

    const whatIf = await get<WhatIfResponse>('/api/history/whatif?range=all');
    expect(whatIf.rows.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(costs.totals.costUsd, 9);
    expect(whatIf.models.map((m) => m.model)).toContain('claude-haiku-5-5');

    const report = await get<ReportResponse>('/api/history/report?range=month');
    expect(report.text).toContain('Informe de Colmena');
    expect(report.spentUsd).toBeCloseTo(costs.totals.costUsd, 9);

    // el agente del fixture que mas herramientas uso
    const busiest = ctx.db
      .prepare<[], { agent_id: string; n: number }>(`SELECT agent_id, COUNT(*) AS n FROM actions GROUP BY agent_id ORDER BY n DESC LIMIT 1`)
      .get();
    expect(busiest).toBeDefined();
    const actions = await get<AgentActionsResponse>(`/api/agents/${busiest?.agent_id ?? ''}/actions`);
    expect(actions.items).toHaveLength(busiest?.n ?? -1);
    expect(actions.summary.actions).toBe(actions.items.length);
    expect((await get<AgentActionsResponse>(`/api/agents/${BUILDER_ID}/actions`)).nextCursor).toBeNull();

    const files = await get<RoomFilesResponse>(`/api/rooms/${SESSION_ID}/files`);
    expect(files.roomId).toBe(SESSION_ID);
    expect(files.edited).toBe(files.files.filter((f) => f.edits > 0).length);

    const health = await get<IngestHealth>('/api/health/ingest');
    expect(health).toMatchObject({ backfill: 'listo', pending: 0, canShutdown: false });
    expect(health.usageRows).toBeGreaterThan(0);
    expect(health.linesRead).toBeGreaterThan(0);
    // el fixture solo trae tipos de linea que el lector conoce
    expect(health.unknownTypes).toEqual([]);

    const all = await get<TasksResponse>('/api/history/tasks');
    expect(all.summary).toBeUndefined();
    expect(all.items.every((x) => x.outcome !== undefined)).toBe(true);
    const leads = await get<TasksResponse>(`/api/history/tasks?kind=lead&room=${SESSION_ID}`);
    expect(leads.items.every((x) => x.kind === 'lead')).toBe(true);
    expect(leads.summary?.count).toBe(leads.items.length);
    const none = await get<TasksResponse>('/api/history/tasks?q=no-existe-esta-tarea');
    expect(none).toMatchObject({ items: [], summary: { count: 0, costUsd: 0 } });
    expect((await app.inject({ method: 'GET', url: '/api/history/tasks?outcome=raro' })).statusCode).toBe(400);

    const rules = await get<RulesResponse>('/api/rules');
    expect(rules).toMatchObject({ notifyDesktop: true, keepAlive: false });
    const sys = await app.inject({ method: 'PUT', url: '/api/settings/system', payload: { keepAlive: true } });
    expect(sys.json<RulesResponse>().keepAlive).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/shutdown' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/agents/..%2Fx/actions' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('pendientes generales', () => {
  it('una sola lista para toda la herramienta: sale en el snapshot y no es de ninguna sala', async () => {
    const ctx = await loadFixture();
    const app = buildApp(ctx);
    const office = async () =>
      (await app.inject({ method: 'GET', url: '/api/office' })).json<{
        todos?: Array<{ id: string; text: string; done: boolean }>;
        rooms: Array<{ notes?: unknown[] }>;
      }>();
    expect((await office()).todos).toEqual([]);

    const add = (text: string) => app.inject({ method: 'POST', url: '/api/notes', payload: { projectKey: TODO_KEY, text } });
    const first = (await add('  llamar al proveedor  ')).json<{ id: string }>();
    await add('revisar el presupuesto');
    expect((await add('   ')).statusCode).toBe(400);

    let snap = await office();
    expect(snap.todos?.map((t) => [t.text, t.done])).toEqual([
      ['llamar al proveedor', false],
      ['revisar el presupuesto', false],
    ]);
    // las notas de las salas no se mezclan con los pendientes
    expect(snap.rooms.every((r) => (r.notes ?? []).length === 0)).toBe(true);

    await app.inject({ method: 'PATCH', url: `/api/notes/${first.id}`, payload: { done: true } });
    snap = await office();
    expect(snap.todos?.find((t) => t.id === first.id)?.done).toBe(true);

    const cleared = await app.inject({ method: 'DELETE', url: `/api/notes?projectKey=${encodeURIComponent(TODO_KEY)}&done=1` });
    expect(cleared.json()).toEqual({ removed: 1 });
    expect((await office()).todos?.map((t) => t.text)).toEqual(['revisar el presupuesto']);
    await app.close();
  });
});
