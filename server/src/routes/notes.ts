import type { FastifyInstance } from 'fastify';
import { cleanNoteText, cleanRoomName, type RoomNotes } from '../state/roomNotes';

const KEY_MAX = 2048;

function validKey(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= KEY_MAX;
}

/** nombre propio, notas y archivo de las salas; cada cambio sale enseguida en el snapshot */
export function registerNotesRoutes(
  app: FastifyInstance,
  deps: {
    notes: RoomNotes;
    office: { reorderRooms: (ids: readonly string[]) => boolean };
    now: () => number;
    changed: () => void;
  },
): void {
  const { notes, office, now, changed } = deps;

  // orden de la lista = lugar en el mapa: las salas arrastradas intercambian sus celdas
  app.put<{ Body: { ids?: unknown } }>('/api/rooms/order', async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 64 || !ids.every(validKey)) {
      return reply.code(400).send({ error: 'ids debe ser una lista de ids de sala' });
    }
    const moved = office.reorderRooms(ids);
    if (moved) changed();
    return { moved };
  });

  app.put<{ Params: { id: string }; Body: { name?: unknown } }>('/api/rooms/:id/name', async (req, reply) => {
    const name = req.body?.name;
    if (!validKey(req.params.id)) return reply.code(400).send({ error: 'id invalido' });
    if (name !== null && name !== undefined && typeof name !== 'string') {
      return reply.code(400).send({ error: 'name debe ser texto o null' });
    }
    const clean = typeof name === 'string' ? cleanRoomName(name) : null;
    notes.setName(req.params.id, clean, now());
    changed();
    return { id: req.params.id, name: clean };
  });

  app.put<{ Params: { id: string }; Body: { archived?: unknown } }>('/api/rooms/:id/archived', async (req, reply) => {
    const archived = req.body?.archived;
    if (!validKey(req.params.id)) return reply.code(400).send({ error: 'id invalido' });
    if (typeof archived !== 'boolean') return reply.code(400).send({ error: 'archived debe ser booleano' });
    notes.setArchived(req.params.id, archived, now());
    changed();
    return { id: req.params.id, archived };
  });

  // saca la sala de la herramienta para siempre; el chat de Claude Code y el historial no se tocan
  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    if (!validKey(req.params.id)) return reply.code(400).send({ error: 'id invalido' });
    notes.deleteForever(req.params.id, now());
    changed();
    return { id: req.params.id, deleted: true };
  });

  // quita un flujo terminado de la sala de control; si vuelve a correr, reaparece
  app.delete<{ Params: { runId: string } }>('/api/workflows/:runId', async (req, reply) => {
    if (!validKey(req.params.runId)) return reply.code(400).send({ error: 'runId invalido' });
    notes.dismissRun(req.params.runId, now());
    changed();
    return { runId: req.params.runId, dismissed: true };
  });

  app.post<{ Body: { projectKey?: unknown; text?: unknown } }>('/api/notes', async (req, reply) => {
    const { projectKey, text } = req.body ?? {};
    if (!validKey(projectKey)) return reply.code(400).send({ error: 'projectKey invalido' });
    const clean = typeof text === 'string' ? cleanNoteText(text) : null;
    if (!clean) return reply.code(400).send({ error: 'la nota no puede ir vacia' });
    const note = notes.add(projectKey, clean, now());
    changed();
    return reply.code(201).send(note);
  });

  app.post<{ Body: { from?: unknown; to?: unknown } }>('/api/notes/move', async (req, reply) => {
    const { from, to } = req.body ?? {};
    if (!validKey(from) || !validKey(to)) return reply.code(400).send({ error: 'from y to deben ser llaves de sala' });
    const moved = notes.moveNotes(from, to);
    if (moved > 0) changed();
    return { moved };
  });

  app.patch<{ Params: { id: string }; Body: { text?: unknown; done?: unknown } }>('/api/notes/:id', async (req, reply) => {
    const { text, done } = req.body ?? {};
    if (done !== undefined && typeof done !== 'boolean') return reply.code(400).send({ error: 'done debe ser booleano' });
    let cleanText: string | undefined;
    if (text !== undefined) {
      cleanText = typeof text === 'string' ? (cleanNoteText(text) ?? undefined) : undefined;
      if (cleanText === undefined) return reply.code(400).send({ error: 'la nota no puede ir vacia' });
    }
    const note = notes.update(req.params.id, { text: cleanText, done }, now());
    if (!note) return reply.code(404).send({ error: 'la nota no existe' });
    changed();
    return note;
  });

  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    if (!notes.remove(req.params.id)) return reply.code(404).send({ error: 'la nota no existe' });
    changed();
    return { ok: true };
  });

  app.delete<{ Querystring: { projectKey?: string; done?: string } }>('/api/notes', async (req, reply) => {
    const { projectKey, done } = req.query;
    if (!validKey(projectKey)) return reply.code(400).send({ error: 'projectKey invalido' });
    if (done !== '1') return reply.code(400).send({ error: 'solo se borran en bloque las hechas (done=1)' });
    const removed = notes.removeDone(projectKey);
    if (removed > 0) changed();
    return { removed };
  });
}
