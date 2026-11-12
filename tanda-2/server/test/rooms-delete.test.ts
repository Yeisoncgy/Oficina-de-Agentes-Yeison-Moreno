import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OfficeSnapshot, TasksResponse } from '@shared/contract';
import { buildApp, type AppContext } from '../src/app';
import { loadFixture } from './helpers';

let app: FastifyInstance;
let ctx: AppContext;

beforeAll(async () => {
  ctx = await loadFixture('2026-01-15T10:11:00.000Z');
  app = buildApp(ctx);
});

afterAll(async () => {
  await app.close();
});

async function snapshot(): Promise<OfficeSnapshot> {
  return (await app.inject({ method: 'GET', url: '/api/office' })).json() as OfficeSnapshot;
}

describe('eliminar una sala para siempre', () => {
  it('sale de la oficina y de archivadas, y no vuelve ni con actividad nueva', async () => {
    const r = (await snapshot()).rooms[0];
    if (!r) throw new Error('el fixture no tiene salas');
    const tasksBefore = (await app.inject({ method: 'GET', url: '/api/history/tasks' })).json() as TasksResponse;

    await app.inject({ method: 'PUT', url: `/api/rooms/${r.id}/archived`, payload: { archived: true } });
    const del = await app.inject({ method: 'DELETE', url: `/api/rooms/${r.id}` });
    expect(del.statusCode).toBe(200);

    const after = await snapshot();
    expect(after.rooms).toEqual([]);
    expect(after.archivedRooms).toEqual([]);

    // archivarla de nuevo con fecha vieja (como si el chat hubiera trabajado despues) no la trae de vuelta
    ctx.roomNotes.setArchived(r.id, true, 0);
    expect((await snapshot()).rooms).toEqual([]);

    // el historial no se toca: el costo sigue contando
    const tasksAfter = (await app.inject({ method: 'GET', url: '/api/history/tasks' })).json() as TasksResponse;
    expect(tasksAfter.items.map((t) => t.id)).toEqual(tasksBefore.items.map((t) => t.id));
  });
});
