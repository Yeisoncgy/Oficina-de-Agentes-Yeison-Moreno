import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { BudgetResponse, TasksResponse } from '@shared/contract';
import { buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/connection';
import { leadWorkTitle } from '../src/ingest/leadWork';
import { HistoryService, registerHistoryRoutes } from '../src/routes/history';
import { loadFixture } from './helpers';

/** hora local: el presupuesto cuenta dias en la zona de la maquina */
function local(month: number, day: number, hour = 12): number {
  return new Date(2026, month - 1, day, hour).getTime();
}

let seq = 0;
function usage(db: Db, ts: number, costUsd: number, agentId = 'sesion-1'): void {
  db.prepare(
    `INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m,
                        cache_write_1h, speed, cost_usd)
     VALUES (?, ?, 'sesion-1', ?, 'claude-opus-5-5', 100, 10, 300, 100, 0, NULL, ?)`,
  ).run(`msg-${++seq}`, agentId, ts, costUsd);
}

/**
 * Marzo de 2026: el 1 es domingo. Laborales: 2-6, 9-13, 16-20, 23-27, 30-31 (22). Hoy = miercoles 11.
 * Gasto: 10 (lun 2), 20 (mar 3), 5 (sab 7), 5 (lun 9), 15 (mar 10), 30 (mie 11) = 85.
 */
function marchDb(): Db {
  const db = openDb(':memory:');
  usage(db, local(3, 2), 10);
  usage(db, local(3, 3), 20);
  usage(db, local(3, 7), 5);
  usage(db, local(3, 9), 5);
  usage(db, local(3, 10, 10), 15);
  usage(db, local(3, 11, 9), 30);
  return db;
}

const TODAY = local(3, 11, 15);

describe('presupuesto por dia laboral', () => {
  it('cuenta L-V, burn, tendencia de 5 dias, recomendado y proyeccion tras hoy', () => {
    const b = new HistoryService(marchDb()).budget(undefined, TODAY);
    expect(b.month).toBe('2026-03');
    expect(b.spentUsd).toBe(85);
    expect(b.budgetUsd).toBe(500);
    expect(b.budgetSource).toBe('default');
    expect(b.daysOff).toEqual([]);
    // hoy es laboral: esta en elapsed y en remaining
    expect(b.workdays).toEqual({ total: 22, elapsed: 8, remaining: 15 });
    expect(b.burnRateUsd).toBeCloseTo(85 / 8, 12);
    // ultimos 5 laborales: jue 5, vie 6, lun 9, mar 10, mie 11 (el sabado no entra)
    expect(b.trend5dUsd).toBeCloseTo((0 + 0 + 5 + 15 + 30) / 5, 12);
    expect(b.recommendedPerDayUsd).toBeCloseTo((500 - 85) / 15, 12);
    // 14 laborales despues de hoy
    expect(b.projectedUsd).toBeCloseTo(85 + (85 / 8) * 14, 12);
    expect(b.cachePct).toBeCloseTo(300 / 500, 12);
    expect(b.discardedUsd).toBe(0);
    // daily sigue siendo por dia calendario, hasta hoy
    expect(b.daily).toHaveLength(11);
    expect(b.daily.reduce((a, d) => a + d.costUsd, 0)).toBeCloseTo(85, 12);
  });

  it('un dia libre sale de los laborales y del promedio', () => {
    const history = new HistoryService(marchDb());
    history.setDayOff('2026-03-09', true);
    const b = history.budget(undefined, TODAY);
    expect(b.daysOff).toEqual(['2026-03-09']);
    expect(b.workdays).toEqual({ total: 21, elapsed: 7, remaining: 15 });
    expect(b.burnRateUsd).toBeCloseTo(85 / 7, 12);
    expect(b.projectedUsd).toBeCloseTo(85 + 170, 9);
    // sin el lunes 9: mie 4, jue 5, vie 6, mar 10, mie 11
    expect(b.trend5dUsd).toBeCloseTo((0 + 0 + 0 + 15 + 30) / 5, 12);

    // un dia libre de otro mes no cuenta en este
    history.setDayOff('2026-04-06', true);
    expect(history.budget(undefined, TODAY).daysOff).toEqual(['2026-03-09']);
    history.setDayOff('2026-03-09', false);
    expect(history.budget(undefined, TODAY).workdays?.total).toBe(22);
  });

  it('hoy sabado no esta ni en elapsed ni en remaining', () => {
    const b = new HistoryService(marchDb()).budget(undefined, local(3, 14, 10));
    expect(b.workdays).toEqual({ total: 22, elapsed: 10, remaining: 12 });
    expect(b.projectedUsd).toBeCloseTo(85 + (85 / 10) * 12, 12);
  });

  it('mes pasado: remaining 0 y sin recomendado; mes futuro: elapsed 0 y proyeccion = gastado', () => {
    const history = new HistoryService(marchDb());
    const feb = history.budget('2026-02', TODAY);
    expect(feb.workdays).toEqual({ total: 20, elapsed: 20, remaining: 0 });
    expect(feb.recommendedPerDayUsd).toBeNull();
    expect(feb.burnRateUsd).toBe(0);
    expect(feb.projectedUsd).toBe(0);
    expect(feb.cachePct).toBeNull();

    const apr = history.budget('2026-04', TODAY);
    expect(apr.workdays).toEqual({ total: 22, elapsed: 0, remaining: 22 });
    expect(apr.burnRateUsd).toBeNull();
    expect(apr.trend5dUsd).toBeNull();
    expect(apr.projectedUsd).toBe(0);
    expect(apr.recommendedPerDayUsd).toBeCloseTo(500 / 22, 12);
  });

  it('con el ajuste al gasto real la tendencia no ve el salto del monto ajustado', () => {
    const history = new HistoryService(marchDb());
    history.setBaseline(100, local(3, 10, 12));
    const b = history.budget(undefined, TODAY);
    // lo de antes del ajuste (incluido el 10 a las 10:00) no suma
    expect(b.spentUsd).toBe(130);
    expect(b.daily.find((d) => d.date === '2026-03-10')?.costUsd).toBe(100);
    // solo el martes 10 (despues del ajuste: 0) y el miercoles 11 (30)
    expect(b.trend5dUsd).toBeCloseTo(15, 12);
    expect(b.burnRateUsd).toBeCloseTo(130 / 8, 12);
  });

  it('suma el trabajo descartado del mes', () => {
    const db = marchDb();
    db.prepare(
      `INSERT INTO agents (agent_id, session_id, kind, agent_type, started_at, ended_at)
       VALUES ('agente-fallo', 'sesion-1', 'subagent', 'general-purpose', ?, ?)`,
    ).run(local(3, 11, 8), local(3, 11, 9));
    db.prepare(`INSERT INTO notifications (task_id, ts, session_id, status) VALUES ('agente-fallo', ?, 'sesion-1', 'failed')`).run(
      local(3, 11, 9),
    );
    usage(db, local(3, 11, 8), 7, 'agente-fallo');
    const b = new HistoryService(db).budget(undefined, TODAY);
    expect(b.discardedUsd).toBe(7);
    expect(b.spentUsd).toBe(92);
  });

  it('el descartado solo suma el uso del agente que cae dentro del mes', () => {
    const db = marchDb();
    db.prepare(
      `INSERT INTO agents (agent_id, session_id, kind, agent_type, started_at, ended_at)
       VALUES ('agente-borde', 'sesion-1', 'subagent', 'general-purpose', ?, ?)`,
    ).run(local(2, 28, 23), local(3, 2, 2));
    db.prepare(`INSERT INTO notifications (task_id, ts, session_id, status) VALUES ('agente-borde', ?, 'sesion-1', 'failed')`).run(
      local(3, 2, 2),
    );
    usage(db, local(2, 28, 23), 4, 'agente-borde');
    usage(db, local(3, 2, 1), 3, 'agente-borde');
    const b = new HistoryService(db).budget(undefined, TODAY);
    // lo de febrero no esta en spentUsd, asi que tampoco en el descartado
    expect(b.spentUsd).toBe(88);
    expect(b.discardedUsd).toBe(3);
  });

  it('al comenzar el mes la tendencia completa los 5 laborales con los ultimos del mes anterior', () => {
    const db = marchDb();
    usage(db, local(3, 27), 2);
    usage(db, local(3, 30), 8);
    usage(db, local(3, 31), 12);
    usage(db, local(4, 1, 9), 5);
    const history = new HistoryService(db);
    const apr1 = local(4, 1, 15);
    // miercoles 1 de abril: jue 26, vie 27, lun 30 y mar 31 de marzo + hoy
    expect(history.budget(undefined, apr1).trend5dUsd).toBeCloseTo((0 + 2 + 8 + 12 + 5) / 5, 12);
    // los dias libres del mes anterior tambien se saltan: entra el miercoles 25
    history.setDayOff('2026-03-27', true);
    expect(history.budget(undefined, apr1).trend5dUsd).toBeCloseTo((0 + 0 + 8 + 12 + 5) / 5, 12);
    // lo anterior al ajuste de marzo no entra: solo lun 30 (desde las 9), mar 31 y hoy
    history.setBaseline(1000, local(3, 30, 9));
    expect(history.budget(undefined, apr1).trend5dUsd).toBeCloseTo((8 + 12 + 5) / 3, 12);
    // con un ajuste en abril no se toma nada de marzo
    history.setBaseline(0, local(4, 1, 8));
    expect(history.budget(undefined, apr1).trend5dUsd).toBeCloseTo(5, 12);
  });
});

describe('ajustes por mes', () => {
  it('ajustar un mes no borra el del anterior y quitarlo solo quita el del mes actual', () => {
    const db = marchDb();
    usage(db, local(2, 10), 40);
    usage(db, local(2, 20), 6);
    const history = new HistoryService(db);
    history.setBaseline(50, local(2, 15));
    history.setBaseline(100, local(3, 10, 12));
    const feb = history.budget('2026-02', TODAY);
    expect(feb.baseline).toEqual({ amountUsd: 50, since: new Date(local(2, 15)).toISOString() });
    expect(feb.spentUsd).toBe(56);
    expect(history.budget(undefined, TODAY).spentUsd).toBe(130);

    history.clearBaseline(TODAY);
    expect(history.budget(undefined, TODAY).baseline).toBeUndefined();
    expect(history.budget(undefined, TODAY).spentUsd).toBe(85);
    expect(history.budget('2026-02', TODAY).spentUsd).toBe(56);
  });

  it('el ajuste guardado con la clave vieja se sigue leyendo y pasa al mapa sin perderse', () => {
    const db = marchDb();
    usage(db, local(2, 20), 6);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('budget_baseline', ?)`).run(
      JSON.stringify({ month: '2026-02', amountUsd: 50, since: local(2, 15) }),
    );
    const history = new HistoryService(db);
    expect(history.budget('2026-02', TODAY).spentUsd).toBe(56);
    history.setBaseline(100, local(3, 10, 12));
    expect(history.budget('2026-02', TODAY).spentUsd).toBe(56);
    expect(history.budget(undefined, TODAY).spentUsd).toBe(130);
    expect(db.prepare(`SELECT key FROM settings WHERE key LIKE 'budget_baseline%' ORDER BY key`).all()).toEqual([
      { key: 'budget_baselines' },
    ]);
  });
});

describe('rutas del presupuesto', () => {
  function app(): ReturnType<typeof Fastify> {
    const a = Fastify({ logger: false });
    registerHistoryRoutes(a, new HistoryService(marchDb()), () => TODAY);
    return a;
  }

  it('monto propio con PUT y vuelta al de por defecto con DELETE', async () => {
    const a = app();
    const put = await a.inject({ method: 'PUT', url: '/api/budget/amount', payload: { amountUsd: 300.456 } });
    expect(put.statusCode).toBe(200);
    const custom = put.json() as BudgetResponse;
    expect(custom).toMatchObject({ budgetUsd: 300.46, budgetSource: 'custom' });
    expect(custom.recommendedPerDayUsd).toBeCloseTo((300.46 - 85) / 15, 9);
    expect(((await a.inject({ method: 'GET', url: '/api/history/budget' })).json() as BudgetResponse).budgetUsd).toBe(300.46);

    for (const amountUsd of [0, -5, 'x', 2_000_000, Number.NaN, 0.001]) {
      const bad = await a.inject({ method: 'PUT', url: '/api/budget/amount', payload: { amountUsd } });
      expect(bad.statusCode).toBe(400);
    }

    const del = (await a.inject({ method: 'DELETE', url: '/api/budget/amount' })).json() as BudgetResponse;
    expect(del).toMatchObject({ budgetUsd: 500, budgetSource: 'default' });
    await a.close();
  });

  it('el mes pedido es YYYY-MM desde 1970', async () => {
    const a = app();
    for (const month of ['0026-03', '1969-12', '2026-13', '26-03']) {
      expect((await a.inject({ method: 'GET', url: `/api/history/budget?month=${month}` })).statusCode).toBe(400);
    }
    const ok = await a.inject({ method: 'GET', url: '/api/history/budget?month=1970-01' });
    expect((ok.json() as BudgetResponse).month).toBe('1970-01');
    await a.close();
  });

  it('dias libres: valida la fecha y devuelve el mes de esa fecha', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/api/budget/days-off', payload: { date: '2026-04-06', off: true } });
    expect(res.statusCode).toBe(200);
    const apr = res.json() as BudgetResponse;
    expect(apr.month).toBe('2026-04');
    expect(apr.daysOff).toEqual(['2026-04-06']);
    expect(apr.workdays?.total).toBe(21);

    const bad = [
      { date: '2026-02-30', off: true },
      { date: '2026-3-10', off: true },
      { date: '2026-03-10', off: 'si' },
      { date: 20260310, off: true },
      // sabado: los fines de semana ya no son laborales
      { date: '2026-03-07', off: true },
      // anos que new Date llevaria a 1900-1999
      { date: '0026-03-10', off: true },
      { date: '1969-12-01', off: true },
    ];
    for (const payload of bad) {
      expect((await a.inject({ method: 'PUT', url: '/api/budget/days-off', payload })).statusCode).toBe(400);
    }

    const back = (
      await a.inject({ method: 'PUT', url: '/api/budget/days-off', payload: { date: '2026-04-06', off: false } })
    ).json() as BudgetResponse;
    expect(back.daysOff).toEqual([]);
    await a.close();
  });
});

describe('presupuesto ajustado al gasto real', () => {
  it('desde el ajuste se suma lo nuevo y lo anterior deja de contar; se puede quitar', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    const app = buildApp(ctx);
    const auto = (await app.inject({ method: 'GET', url: '/api/history/budget' })).json() as BudgetResponse;
    expect(auto.baseline).toBeUndefined();
    expect(auto.spentUsd).toBeGreaterThan(0);

    const put = await app.inject({ method: 'PUT', url: '/api/budget/baseline', payload: { amountUsd: 256 } });
    expect(put.statusCode).toBe(200);
    const adjusted = (await app.inject({ method: 'GET', url: '/api/history/budget' })).json() as BudgetResponse;
    // el gasto de antes del ajuste ya no suma: queda exactamente el monto real
    expect(adjusted.spentUsd).toBe(256);
    expect(adjusted.baseline).toEqual({ amountUsd: 256, since: '2026-01-15T10:11:00.000Z' });
    expect(adjusted.daily.at(-1)?.costUsd).toBe(256);

    expect((await app.inject({ method: 'PUT', url: '/api/budget/baseline', payload: { amountUsd: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/budget/baseline', payload: { amountUsd: 'x' } })).statusCode).toBe(400);

    const del = (await app.inject({ method: 'DELETE', url: '/api/budget/baseline' })).json() as BudgetResponse;
    expect(del.baseline).toBeUndefined();
    expect(del.spentUsd).toBe(auto.spentUsd);
    await app.close();
  });
});

describe('tareas del lead: etiqueta de lo que se hizo, nunca el prompt', () => {
  it('el historial no muestra el texto de los prompts', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    const app = buildApp(ctx);
    const tasks = (await app.inject({ method: 'GET', url: '/api/history/tasks' })).json() as TasksResponse;
    const lead = tasks.items.filter((t) => t.kind === 'lead');
    expect(lead.length).toBeGreaterThan(0);
    for (const t of lead) expect(t.title).not.toMatch(/tarea de prueba/i);
    await app.close();
  });

  it('elige la etiqueta segun las acciones del turno', () => {
    const cwd = 'C:\\Proyecto';
    expect(
      leadWorkTitle([{ tool: 'Edit', n: 3 }], [{ tool: 'Edit', target: 'C:\\Proyecto\\server\\src\\office.ts', n: 3, last: 1 }], cwd),
    ).toBe('Construyendo backend · office.ts');
    expect(leadWorkTitle([{ tool: 'Workflow', n: 1 }, { tool: 'Read', n: 2 }], [], cwd)).toBe('Orquestando un flujo de agentes');
    expect(leadWorkTitle([{ tool: 'Agent', n: 3 }], [], cwd)).toBe('Coordinando 3 agentes');
    expect(leadWorkTitle([{ tool: 'Bash', n: 2 }], [], cwd)).toBe('Ejecutando comandos');
    expect(leadWorkTitle([], [], cwd)).toBe('Respondiendo una consulta');
  });
});
