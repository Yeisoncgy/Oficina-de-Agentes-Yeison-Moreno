import type { OfficeRoom, RoomNote } from '@shared/contract';
import { ApiError } from './api';

// Nombre propio y notas de las salas. Lo que se ve sale del snapshot (SSE): el server lo reenvia en
// cuanto cambia, asi que aqui no hay cache que invalidar.

async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sin conexión con el servidor');
  }
  if (!response.ok) throw new ApiError(response.status, `El servidor respondió ${response.status}`);
  return (await response.json()) as T;
}

/** name null o '' = volver al nombre automatico */
export function renameRoom(roomId: string, name: string | null): Promise<{ name: string | null }> {
  return send('PUT', `/api/rooms/${encodeURIComponent(roomId)}/name`, { name });
}

/** archivada sale de la oficina; vuelve sola si su chat tiene actividad despues */
export function setRoomArchived(roomId: string, archived: boolean): Promise<{ archived: boolean }> {
  return send('PUT', `/api/rooms/${encodeURIComponent(roomId)}/archived`, { archived });
}

/** fuera de la herramienta para siempre; el chat en Claude Code y el historial no se tocan */
export function deleteRoomForever(roomId: string): Promise<{ deleted: boolean }> {
  return send('DELETE', `/api/rooms/${encodeURIComponent(roomId)}`);
}

/** saca un flujo terminado de la sala de control; si vuelve a correr, reaparece */
export function dismissRun(runId: string): Promise<{ dismissed: boolean }> {
  return send('DELETE', `/api/workflows/${encodeURIComponent(runId)}`);
}

/** orden nuevo de la lista; las salas intercambian sus lugares del mapa */
export function reorderRooms(ids: readonly string[]): Promise<{ moved: boolean }> {
  return send('PUT', '/api/rooms/order', { ids });
}

/** la lista va por lugar fijo en el mapa, no por actividad: no salta mientras las salas trabajan */
export function roomsBySlot<T extends Pick<OfficeRoom, 'id' | 'slot'>>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER));
}

/** pasa todas las notas de una sala a otra */
export function moveNotes(from: string, to: string): Promise<{ moved: number }> {
  return send('POST', '/api/notes/move', { from, to });
}

export function addNote(projectKey: string, text: string): Promise<RoomNote> {
  return send('POST', '/api/notes', { projectKey, text });
}

export function updateNote(id: string, change: { text?: string; done?: boolean }): Promise<RoomNote> {
  return send('PATCH', `/api/notes/${encodeURIComponent(id)}`, change);
}

export function deleteNote(id: string): Promise<{ ok: boolean }> {
  return send('DELETE', `/api/notes/${encodeURIComponent(id)}`);
}

export function deleteDoneNotes(projectKey: string): Promise<{ removed: number }> {
  return send('DELETE', `/api/notes?projectKey=${encodeURIComponent(projectKey)}&done=1`);
}

export function pendingNotes(room: Pick<OfficeRoom, 'notes'>): RoomNote[] {
  return (room.notes ?? []).filter((n) => !n.done);
}

/**
 * Texto para pegar en el chat de Claude Code: dice de que proyecto son y numera los pendientes. Una
 * nota de varias lineas conserva sus lineas, sangradas bajo su numero.
 */
export function notesPrompt(room: Pick<OfficeRoom, 'title' | 'cwd' | 'notes'>): string {
  const pending = pendingNotes(room);
  const where = room.cwd ? ` (${room.cwd})` : '';
  const items = pending.map((n, i) => {
    const [first = '', ...rest] = n.text.split('\n');
    return [`${i + 1}. ${first}`, ...rest.map((line) => (line ? `   ${line}` : ''))].join('\n');
  });
  return [`Pendientes del proyecto "${room.title}"${where}:`, '', ...items].join('\n');
}
