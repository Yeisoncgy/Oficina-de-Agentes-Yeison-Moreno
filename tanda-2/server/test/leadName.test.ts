import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanLeadName, DEFAULT_LEAD_NAME } from '@shared/agents';
import { LEAD_NAME_MAX, type LeadNameResponse, type OfficeSnapshot, type RankingResponse, type TasksResponse } from '@shared/contract';
import { LEAD_PERSONA, PERSONA_BY_TYPE, personaName } from '@shared/personas';
import { buildApp, type AppContext } from '../src/app';
import { Settings } from '../src/state/settings';
import { loadFixture, SESSION_ID } from './helpers';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

/** DB :memory: nueva con el fixture: nadie eligio nombre todavia */
async function fresh(): Promise<{ ctx: AppContext; app: FastifyInstance }> {
  const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
  const app = buildApp(ctx);
  apps.push(app);
  return { ctx, app };
}

async function snapshot(app: FastifyInstance): Promise<OfficeSnapshot> {
  return (await app.inject({ method: 'GET', url: '/api/office' })).json() as OfficeSnapshot;
}

function putName(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'PUT', url: '/api/settings/lead-name', payload: payload as Record<string, unknown> });
}

describe('cleanLeadName', () => {
  it('sin texto o vacio = null', () => {
    for (const raw of [undefined, null, 42, true, {}, ['Ana'], '', '   ', '\n\t ', '\u0000​']) {
      expect(cleanLeadName(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('una linea: quita caracteres de control y de formato, junta espacios y recorta', () => {
    expect(cleanLeadName('  Ana   \t María \n ')).toBe('Ana María');
    expect(cleanLeadName('An\u0000a\u0007')).toBe('Ana');
    expect(cleanLeadName('‮Ana​ Ruiz')).toBe('Ana Ruiz');
  });

  it('corta en LEAD_NAME_MAX sin dejar un espacio al final ni partir un caracter', () => {
    expect(cleanLeadName('x'.repeat(LEAD_NAME_MAX + 10))).toBe('x'.repeat(LEAD_NAME_MAX));
    expect(cleanLeadName(`${'a'.repeat(LEAD_NAME_MAX - 1)} bcd`)).toBe('a'.repeat(LEAD_NAME_MAX - 1));
    const emoji = cleanLeadName('\u{1F41D}'.repeat(LEAD_NAME_MAX + 1)) ?? '';
    expect(Array.from(emoji)).toHaveLength(LEAD_NAME_MAX);
    expect(emoji.endsWith('\u{1F41D}')).toBe(true);
  });
});

describe('persona del lead', () => {
  it('es la del tipo lead y se llama como el nombre por defecto', () => {
    expect(LEAD_PERSONA).toBe('lead');
    expect(PERSONA_BY_TYPE.lead).toBe(LEAD_PERSONA);
    expect(personaName(LEAD_PERSONA)).toBe(DEFAULT_LEAD_NAME);
  });
});

describe('nombre del lead configurable', () => {
  it('DB nueva: sin nombre, el snapshot trae leadName null y el lead usa el de por defecto', async () => {
    const { ctx, app } = await fresh();
    expect(new Settings(ctx.db).leadName()).toBeNull();
    const get = await app.inject({ method: 'GET', url: '/api/settings/lead-name' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ name: null } satisfies LeadNameResponse);
    const snap = await snapshot(app);
    expect(snap.leadName).toBeNull();
    expect(snap.leadRoomId).toBe(SESSION_ID);
    expect(snap.rooms[0]?.lead).toMatchObject({ displayName: DEFAULT_LEAD_NAME, persona: LEAD_PERSONA });
  });

  it('un valor guardado que queda vacio al limpiarlo cuenta como sin nombre', async () => {
    const { ctx } = await fresh();
    new Settings(ctx.db).setLeadName(' \u0000 ');
    expect(new Settings(ctx.db).leadName()).toBeNull();
    expect(ctx.office.build().leadName).toBeNull();
  });

  it('PUT invalido (no texto, vacio, solo espacios, sin name) = 400 y no guarda', async () => {
    const { ctx, app } = await fresh();
    const changed = vi.spyOn(ctx.hub, 'broadcastIfChanged');
    for (const payload of [{ name: 42 }, { name: null }, { name: '' }, { name: '    ' }, {}]) {
      const res = await putName(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error: 'Escribe un nombre' });
    }
    expect(changed).not.toHaveBeenCalled();
    expect(new Settings(ctx.db).leadName()).toBeNull();
    expect((await snapshot(app)).leadName).toBeNull();
  });

  it('PUT valido recorta, junta espacios y corta en LEAD_NAME_MAX', async () => {
    const { ctx, app } = await fresh();
    const changed = vi.spyOn(ctx.hub, 'broadcastIfChanged');
    const res = await putName(app, { name: '   Ana \t\n  María   ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Ana María' } satisfies LeadNameResponse);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'GET', url: '/api/settings/lead-name' })).json()).toEqual({ name: 'Ana María' });

    const long = await putName(app, { name: `  ${'Z'.repeat(LEAD_NAME_MAX + 8)}  ` });
    expect(long.statusCode).toBe(200);
    expect((long.json() as LeadNameResponse).name).toBe('Z'.repeat(LEAD_NAME_MAX));
    expect(new Settings(ctx.db).leadName()).toBe('Z'.repeat(LEAD_NAME_MAX));
  });

  it('despues del PUT el snapshot, el ranking y las tareas usan el nombre nuevo', async () => {
    const { app } = await fresh();
    expect((await putName(app, { name: 'Ana' })).statusCode).toBe(200);

    const snap = await snapshot(app);
    expect(snap.leadName).toBe('Ana');
    expect(snap.rooms[0]?.lead).toMatchObject({ kind: 'lead', displayName: 'Ana', persona: LEAD_PERSONA });

    const ranking = (await app.inject({ method: 'GET', url: '/api/history/ranking?range=all' })).json() as RankingResponse;
    expect(ranking.byAgent.find((r) => r.key === 'lead')?.label).toBe('Ana (principal)');
    // los demas no cambian de nombre
    expect(ranking.byAgent.find((r) => r.key === 'Explore')?.label).toBe('Elena');

    const tasks = (await app.inject({ method: 'GET', url: '/api/history/tasks' })).json() as TasksResponse;
    const leadRows = tasks.items.filter((t) => t.kind === 'lead');
    expect(leadRows.length).toBeGreaterThan(0);
    for (const t of leadRows) expect(t.displayName).toBe('Ana');
    expect(tasks.items.filter((t) => t.kind === 'subagent').map((t) => t.displayName)).not.toContain('Ana');
  });
});
