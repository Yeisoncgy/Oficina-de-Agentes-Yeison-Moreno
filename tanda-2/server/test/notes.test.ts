import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OfficeRoom, OfficeSnapshot, RoomNote, TasksResponse } from '@shared/contract';
import { buildApp, type AppContext } from '../src/app';
import { migrate, openDb } from '../src/db/connection';
import { cleanNoteText, cleanRoomName, notesKeyOf, projectKeyOf } from '../src/state/roomNotes';
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

async function room(): Promise<OfficeRoom> {
  const res = await app.inject({ method: 'GET', url: '/api/office' });
  const r = (res.json() as OfficeSnapshot).rooms[0];
  if (!r) throw new Error('el fixture no tiene salas');
  return r;
}

describe('llave y limpieza', () => {
  it('la misma carpeta escrita distinto da la misma llave', () => {
    expect(projectKeyOf('c:\\Demo\\Proyecto\\', 's1')).toBe(projectKeyOf('C:/demo/proyecto', 's2'));
    expect(projectKeyOf('', 's1')).toBe('session:s1');
  });

  it('las notas son de cada sala: dos sesiones de la misma carpeta no las comparten', () => {
    expect(notesKeyOf('s1')).not.toBe(notesKeyOf('s2'));
    ctx.roomNotes.add(notesKeyOf('sesion-a'), 'Solo de A', 1);
    expect(ctx.roomNotes.notes(notesKeyOf('sesion-a')).map((n) => n.text)).toEqual(['Solo de A']);
    expect(ctx.roomNotes.notes(notesKeyOf('sesion-b'))).toEqual([]);
    for (const n of ctx.roomNotes.notes(notesKeyOf('sesion-a'))) ctx.roomNotes.remove(n.id);
  });

  it('el nombre queda en una linea y la nota conserva sus lineas', () => {
    expect(cleanRoomName('  Proyecto \n Finanzas   ERP ')).toBe('Proyecto Finanzas ERP');
    expect(cleanRoomName('   ')).toBeNull();
    expect(cleanNoteText('uno\r\ndos  ')).toBe('uno\ndos');
    expect(cleanNoteText(' \n ')).toBeNull();
  });
});

describe('nombre propio de la sala', () => {
  it('reemplaza el titulo, conserva el automatico y vuelve con null', async () => {
    const before = await room();
    expect(before.customName).toBeNull();
    expect(before.title).toBe(before.autoTitle);
    expect(before.notes).toEqual([]);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/rooms/${before.id}/name`,
      payload: { name: ' Proyecto Finanzas ERP ' },
    });
    expect(put.statusCode).toBe(200);
    const named = await room();
    expect(named).toMatchObject({ title: 'Proyecto Finanzas ERP', customName: 'Proyecto Finanzas ERP', autoTitle: before.autoTitle });

    const tasks = (await app.inject({ method: 'GET', url: '/api/history/tasks' })).json() as TasksResponse;
    expect(tasks.items.every((t) => t.roomTitle === 'Proyecto Finanzas ERP')).toBe(true);

    await app.inject({ method: 'PUT', url: `/api/rooms/${before.id}/name`, payload: { name: '' } });
    expect(await room()).toMatchObject({ title: before.autoTitle, customName: null });
  });

  it('es de cada sala: otra sesion de la misma carpeta no lo hereda', () => {
    ctx.roomNotes.setName('sesion-a', 'Sala A', 1);
    ctx.roomNotes.setName('sesion-b', 'Sala B', 1);
    expect(ctx.roomNotes.name('sesion-a')).toBe('Sala A');
    expect(ctx.roomNotes.name('sesion-b')).toBe('Sala B');
    expect(ctx.roomNotes.name('sesion-c')).toBeNull();
    ctx.roomNotes.setName('sesion-a', null, 2);
    ctx.roomNotes.setName('sesion-b', null, 2);
  });

  it('rechaza pedidos mal formados', async () => {
    const badName = await app.inject({ method: 'PUT', url: '/api/rooms/x/name', payload: { name: 3 } });
    expect(badName.statusCode).toBe(400);
  });
});

describe('migracion v9', () => {
  it('cada sesion conocida hereda el nombre que tenia su carpeta', () => {
    const db = openDb(':memory:');
    db.pragma('user_version = 8');
    db.prepare(`INSERT INTO room_names (project_key, name, updated_at) VALUES (?, 'Mi proyecto', 5)`).run(
      projectKeyOf('C:\\demo\\proyecto', 'x'),
    );
    const session = db.prepare(`INSERT INTO sessions (session_id, cwd) VALUES (?, ?)`);
    session.run('s1', 'c:\\Demo\\Proyecto\\');
    session.run('s2', 'C:\\demo\\proyecto');
    session.run('s3', 'C:\\demo\\otro');
    migrate(db);
    expect(db.prepare(`SELECT session_id, name FROM session_names ORDER BY session_id`).all()).toEqual([
      { session_id: 's1', name: 'Mi proyecto' },
      { session_id: 's2', name: 'Mi proyecto' },
    ]);
    db.close();
  });
});

describe('migracion v11', () => {
  it('cada nota de carpeta pasa a la sesion mas reciente de esa carpeta, una sola vez', () => {
    const db = openDb(':memory:');
    db.pragma('user_version = 10');
    const session = db.prepare(`INSERT INTO sessions (session_id, cwd, last_activity_at) VALUES (?, ?, ?)`);
    session.run('vieja', 'c:\\Demo\\Proyecto\\', 100);
    session.run('nueva', 'C:\\demo\\proyecto', 200);
    session.run('otra', 'C:\\demo\\otro', 300);
    const note = db.prepare(
      `INSERT INTO room_notes (id, project_key, text, done, created_at, updated_at) VALUES (?, ?, 'x', 0, 1, 1)`,
    );
    note.run('n1', projectKeyOf('C:\\demo\\proyecto', 'x'));
    note.run('n2', projectKeyOf('C:\\sin\\sesiones', 'x'));
    note.run('n3', notesKeyOf('otra'));
    migrate(db);
    expect(db.prepare(`SELECT id, project_key FROM room_notes ORDER BY id`).all()).toEqual([
      { id: 'n1', project_key: 'session:nueva' },
      { id: 'n2', project_key: projectKeyOf('C:\\sin\\sesiones', 'x') },
      { id: 'n3', project_key: 'session:otra' },
    ]);
    db.close();
  });
});

describe('archivar salas', () => {
  it('sale de la oficina, queda en archivadas y se restaura', async () => {
    const r = await room();
    const put = await app.inject({ method: 'PUT', url: `/api/rooms/${r.id}/archived`, payload: { archived: true } });
    expect(put.statusCode).toBe(200);
    const snap = (await app.inject({ method: 'GET', url: '/api/office' })).json() as OfficeSnapshot;
    expect(snap.rooms).toEqual([]);
    expect(snap.leadRoomId).toBeNull();
    expect(snap.archivedRooms).toEqual([
      { id: r.id, title: r.title, projectName: r.projectName, open: r.open, archivedAt: '2026-01-15T10:11:00.000Z' },
    ]);

    await app.inject({ method: 'PUT', url: `/api/rooms/${r.id}/archived`, payload: { archived: false } });
    const back = (await app.inject({ method: 'GET', url: '/api/office' })).json() as OfficeSnapshot;
    expect(back.rooms.map((x) => x.id)).toEqual([r.id]);
    expect(back.archivedRooms).toEqual([]);
  });

  it('vuelve sola si el chat tuvo actividad despues de archivarla', async () => {
    const r = await room();
    ctx.roomNotes.setArchived(r.id, true, Date.parse(r.lastActivityAt) - 60_000);
    const snap = (await app.inject({ method: 'GET', url: '/api/office' })).json() as OfficeSnapshot;
    expect(snap.rooms.map((x) => x.id)).toEqual([r.id]);
    ctx.roomNotes.setArchived(r.id, false, 0);
  });

  it('rechaza pedidos mal formados', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/rooms/x/archived', payload: { archived: 'si' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('notas de la sala', () => {
  it('agrega, marca, edita y borra', async () => {
    const { projectKey } = await room();
    const a = (await app.inject({ method: 'POST', url: '/api/notes', payload: { projectKey, text: 'Cambiar el filtro' } }))
      .json() as RoomNote;
    const b = (await app.inject({ method: 'POST', url: '/api/notes', payload: { projectKey, text: 'Otro pendiente' } }))
      .json() as RoomNote;
    expect((await room()).notes?.map((n) => n.text)).toEqual(['Cambiar el filtro', 'Otro pendiente']);

    const done = await app.inject({ method: 'PATCH', url: `/api/notes/${a.id}`, payload: { done: true } });
    expect(done.json()).toMatchObject({ id: a.id, done: true, text: 'Cambiar el filtro' });
    const edited = await app.inject({ method: 'PATCH', url: `/api/notes/${b.id}`, payload: { text: 'Otro pendiente, editado' } });
    expect(edited.json()).toMatchObject({ done: false, text: 'Otro pendiente, editado' });

    const cleared = await app.inject({ method: 'DELETE', url: `/api/notes?projectKey=${encodeURIComponent(projectKey ?? '')}&done=1` });
    expect(cleared.json()).toEqual({ removed: 1 });
    expect((await room()).notes?.map((n) => n.id)).toEqual([b.id]);

    expect((await app.inject({ method: 'DELETE', url: `/api/notes/${b.id}` })).statusCode).toBe(200);
    expect((await room()).notes).toEqual([]);
  });

  it('rechaza notas vacias y notas que no existen', async () => {
    const { projectKey } = await room();
    expect((await app.inject({ method: 'POST', url: '/api/notes', payload: { projectKey, text: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/notes/nada', payload: { done: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/notes/nada', payload: { done: 'si' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/notes/nada' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/notes?projectKey=x` })).statusCode).toBe(400);
  });

  it('pasa todas las notas de una sala a otra y vuelve', async () => {
    const { projectKey } = await room();
    const key = projectKey ?? '';
    await app.inject({ method: 'POST', url: '/api/notes', payload: { projectKey: key, text: 'Nota que va a otra sala' } });
    const away = await app.inject({ method: 'POST', url: '/api/notes/move', payload: { from: key, to: 'session:otra' } });
    expect(away.json()).toEqual({ moved: 1 });
    expect((await room()).notes).toEqual([]);
    expect(ctx.roomNotes.notes('session:otra').map((n) => n.text)).toEqual(['Nota que va a otra sala']);

    await app.inject({ method: 'POST', url: '/api/notes/move', payload: { from: 'session:otra', to: key } });
    const back = (await room()).notes ?? [];
    expect(back.map((n) => n.text)).toEqual(['Nota que va a otra sala']);
    await app.inject({ method: 'DELETE', url: `/api/notes/${back[0]?.id ?? ''}` });

    expect((await app.inject({ method: 'POST', url: '/api/notes/move', payload: { from: key } })).statusCode).toBe(400);
  });
});

describe('orden de la lista', () => {
  it('rechaza pedidos mal formados y con una sola sala no cambia nada', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/rooms/order', payload: { ids: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/rooms/order', payload: { ids: [3] } })).statusCode).toBe(400);
    const { id } = await room();
    const res = await app.inject({ method: 'PUT', url: '/api/rooms/order', payload: { ids: [id] } });
    expect(res.json()).toEqual({ moved: false });
  });
});
