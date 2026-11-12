import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import type { BudgetResponse, OfficeSnapshot, RankingResponse, TasksResponse, TranscriptEntry, TranscriptResponse } from '@shared/contract';
import { buildApp } from '../src/app';
import { paginate, TRANSCRIPT_PAGE } from '../src/routes/transcript';
import { BUILDER_ID, EXPLORE_ID, loadFixture, SESSION_ID } from './helpers';

let app: FastifyInstance;
let now: number;

beforeAll(async () => {
  const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
  now = ctx.now();
  app = buildApp(ctx);
});

afterAll(async () => {
  await app.close();
});

describe('API', () => {
  it('GET /api/office y /api/health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/office' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as OfficeSnapshot).rooms).toHaveLength(1);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ ok: true, backfill: 'listo' });
  });

  it('GET /api/history/budget', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history/budget?month=2026-01' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BudgetResponse;
    const today = new Date(now);
    expect(body.month).toBe('2026-01');
    expect(body.budgetUsd).toBe(500);
    expect(body.spentUsd).toBeGreaterThan(0);
    expect(body.daily).toHaveLength(today.getDate());
    expect(body.daily.reduce((a, d) => a + d.costUsd, 0)).toBeCloseTo(body.spentUsd, 12);
    // proyeccion por dia laboral: gastado + ritmo x laborales que faltan despues de hoy
    const workdays = body.workdays;
    expect(workdays).toBeDefined();
    const todayIsWorkday = today.getDay() !== 0 && today.getDay() !== 6;
    const afterToday = (workdays?.remaining ?? 0) - (todayIsWorkday ? 1 : 0);
    expect(body.burnRateUsd).toBeCloseTo(body.spentUsd / (workdays?.elapsed ?? 1), 12);
    expect(body.projectedUsd).toBeCloseTo(body.spentUsd + (body.burnRateUsd ?? 0) * afterToday, 9);
    expect(body.unpricedTokens).toBe(0);
    const bad = await app.inject({ method: 'GET', url: '/api/history/budget?month=2026-13' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/history/ranking', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history/ranking?range=all' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RankingResponse;
    const byKey = Object.fromEntries(body.byAgent.map((r) => [r.key, r]));
    expect(byKey.lead?.label).toBe(`${DEFAULT_LEAD_NAME} (principal)`);
    expect(byKey.lead?.tasks).toBe(1);
    expect(byKey.Explore).toMatchObject({ label: 'Elena', tasks: 1 });
    expect(byKey['tr-builder']).toMatchObject({ label: 'Bruno', tasks: 1 });
    expect(body.byProject).toHaveLength(1);
    expect(body.byProject[0]).toMatchObject({ key: 'proyecto-falso', tasks: 3 });
    const bad = await app.inject({ method: 'GET', url: '/api/history/ranking?range=siglo' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/history/tasks ordenado por fin desc', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history/tasks' });
    const body = res.json() as TasksResponse;
    expect(body.items.map((t) => t.id)).toEqual([`${SESSION_ID}:u-p1`, EXPLORE_ID, BUILDER_ID]);
    expect(body.items[0]).toMatchObject({
      kind: 'lead',
      displayName: DEFAULT_LEAD_NAME,
      roomTitle: 'Sesion demo falsa',
      projectName: 'proyecto-falso',
      durationMs: 176_000,
    });
    expect(body.nextCursor).toBeNull();
    const bad = await app.inject({ method: 'GET', url: '/api/history/tasks?cursor=noesvalido' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/agents/:id/transcript', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${SESSION_ID}/transcript` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TranscriptResponse;
    const kinds = body.entries.map((e) => e.kind);
    expect(kinds).toEqual(['prompt', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text', 'prompt', 'tool_use']);
    expect(body.entries[0]?.text).toBe('Arregla el boton de prueba del demo\nsegunda linea del prompt falso');
    expect(body.entries[1]).toMatchObject({ toolName: 'Read', text: 'Leyendo app.ts · C:\\demo\\proyecto-falso\\src\\app.ts' });
    expect(body.entries[2]).toMatchObject({ toolName: 'Read', isError: false, text: 'contenido falso del archivo' });
    expect(body.entries[8]?.text).toBe('Segunda tarea de prueba');
    expect(JSON.stringify(body)).not.toContain('pensamiento falso');
    expect(body.nextCursor).toBeNull();

    const sub = await app.inject({ method: 'GET', url: `/api/agents/${EXPLORE_ID}/transcript` });
    expect((sub.json() as TranscriptResponse).entries.map((e) => e.kind)).toEqual(['prompt', 'tool_use', 'tool_result', 'text']);

    expect((await app.inject({ method: 'GET', url: '/api/agents/no%20valido/transcript' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/agents/desconocido/transcript' })).statusCode).toBe(404);
  });
});

describe('paginate', () => {
  it('pagina desde el final en orden cronologico', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 400 }, (_, i) => ({
      id: String(i),
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'text',
      text: `entrada ${i}`,
    }));
    const p1 = paginate(entries, entries.length);
    expect(p1.entries).toHaveLength(TRANSCRIPT_PAGE);
    expect(p1.entries[0]?.id).toBe('250');
    expect(p1.entries.at(-1)?.id).toBe('399');
    expect(p1.nextCursor).not.toBeNull();
    const p3 = paginate(entries, 100);
    expect(p3.entries.map((e) => e.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(p3.nextCursor).toBeNull();
  });
});
