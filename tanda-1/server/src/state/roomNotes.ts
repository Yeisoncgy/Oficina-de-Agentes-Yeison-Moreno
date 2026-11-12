import { randomUUID } from 'node:crypto';
import { NOTE_TEXT_MAX, ROOM_NAME_MAX, type RoomNote } from '@shared/contract';
import type { Db } from '../db/connection';

// office.ts importa este modulo: se evita el ciclo repitiendo iso()
const iso = (ms: number): string => new Date(ms).toISOString();

interface NoteRow {
  id: string;
  project_key: string;
  text: string;
  done: number;
  created_at: number;
  updated_at: number;
}

/**
 * Llave del proyecto de una sala. La misma carpeta llega como "c:\x" o "C:\x\" segun quien la escribio,
 * asi que se normaliza; sin cwd la llave es la propia sesion. Solo la usan las migraciones v9 y v11.
 */
export function projectKeyOf(cwd: string, sessionId: string): string {
  const k = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return k ? `dir:${k}` : `session:${sessionId}`;
}

/** llave de las notas: cada sala (sesion) tiene las suyas, aunque otra sala sea de la misma carpeta */
export function notesKeyOf(sessionId: string): string {
  return `session:${sessionId}`;
}

/** una sola linea, sin espacios de sobra; null si queda vacio */
export function cleanRoomName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
  return name || null;
}

/** conserva los saltos de linea (una nota puede ser una lista); null si queda vacia */
export function cleanNoteText(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_TEXT_MAX);
  return text || null;
}

function toNote(r: NoteRow): RoomNote {
  return { id: r.id, text: r.text, done: r.done === 1, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}

/**
 * Nombre propio, notas y archivo de cada sala: lo que el usuario escribe a mano en la DB
 * (no se reconstruye)
 */
export class RoomNotes {
  private readonly getName;
  private readonly putName;
  private readonly delName;
  private readonly byProject;
  private readonly byId;
  private readonly insert;
  private readonly patch;
  private readonly delNote;
  private readonly delDone;
  private readonly moveAll;
  private readonly allArchived;
  private readonly putArchived;
  private readonly delArchived;
  private readonly putDeleted;
  private readonly putDismissed;

  constructor(db: Db) {
    this.putDismissed = db.prepare<[string, number]>(
      `INSERT INTO dismissed_runs (run_id, dismissed_at) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING`,
    );
    this.allArchived = db.prepare<[], { session_id: string; archived_at: number; deleted: number }>(
      `SELECT session_id, archived_at, deleted FROM archived_rooms`,
    );
    this.putArchived = db.prepare<[string, number]>(
      `INSERT INTO archived_rooms (session_id, archived_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET archived_at = excluded.archived_at`,
    );
    this.delArchived = db.prepare<[string]>(`DELETE FROM archived_rooms WHERE session_id = ?`);
    this.putDeleted = db.prepare<[string, number]>(
      `INSERT INTO archived_rooms (session_id, archived_at, deleted) VALUES (?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET deleted = 1`,
    );
    this.getName = db.prepare<[string], { name: string }>(`SELECT name FROM session_names WHERE session_id = ?`);
    this.putName = db.prepare<[string, string, number]>(
      `INSERT INTO session_names (session_id, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    );
    this.delName = db.prepare<[string]>(`DELETE FROM session_names WHERE session_id = ?`);
    this.byProject = db.prepare<[string], NoteRow>(
      `SELECT * FROM room_notes WHERE project_key = ? ORDER BY created_at, rowid`,
    );
    this.byId = db.prepare<[string], NoteRow>(`SELECT * FROM room_notes WHERE id = ?`);
    this.insert = db.prepare<[string, string, string, number, number]>(
      `INSERT INTO room_notes (id, project_key, text, done, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
    );
    this.patch = db.prepare<[string, number, number, string]>(
      `UPDATE room_notes SET text = ?, done = ?, updated_at = ? WHERE id = ?`,
    );
    this.delNote = db.prepare<[string]>(`DELETE FROM room_notes WHERE id = ?`);
    this.delDone = db.prepare<[string]>(`DELETE FROM room_notes WHERE project_key = ? AND done = 1`);
    this.moveAll = db.prepare<[string, string]>(`UPDATE room_notes SET project_key = ? WHERE project_key = ?`);
  }

  /** pasa todas las notas de una sala a otra (p.ej. las que la v11 dejo en la sala equivocada) */
  moveNotes(fromKey: string, toKey: string): number {
    if (fromKey === toKey) return 0;
    return this.moveAll.run(toKey, fromKey).changes;
  }

  /** nombre propio de una sala (por sesion: cada sala de la misma carpeta tiene el suyo) */
  name(sessionId: string): string | null {
    return this.getName.get(sessionId)?.name ?? null;
  }

  /** null = vuelve al nombre automatico */
  setName(sessionId: string, name: string | null, now: number): void {
    if (name === null) this.delName.run(sessionId);
    else this.putName.run(sessionId, name, now);
  }

  notes(projectKey: string): RoomNote[] {
    return this.byProject.all(projectKey).map(toNote);
  }

  add(projectKey: string, text: string, now: number): RoomNote {
    const id = randomUUID();
    this.insert.run(id, projectKey, text, now, now);
    return { id, text, done: false, createdAt: iso(now), updatedAt: iso(now) };
  }

  /** null si la nota no existe */
  update(id: string, change: { text?: string; done?: boolean }, now: number): RoomNote | null {
    const row = this.byId.get(id);
    if (!row) return null;
    const text = change.text ?? row.text;
    const done = change.done ?? row.done === 1;
    this.patch.run(text, done ? 1 : 0, now, id);
    return toNote({ ...row, text, done: done ? 1 : 0, updated_at: now });
  }

  remove(id: string): boolean {
    return this.delNote.run(id).changes > 0;
  }

  removeDone(projectKey: string): number {
    return this.delDone.run(projectKey).changes;
  }

  /** sessionId -> cuando se archivo (epoch ms) y si se elimino para siempre */
  archived(): Map<string, { at: number; deleted: boolean }> {
    return new Map(this.allArchived.all().map((r) => [r.session_id, { at: r.archived_at, deleted: r.deleted === 1 }]));
  }

  /**
   * La sala no vuelve a la oficina nunca, ni con actividad nueva de su chat. No toca ~/.claude ni el
   * historial: el chat sigue existiendo en Claude Code y su costo sigue contando en el presupuesto.
   */
  deleteForever(sessionId: string, now: number): void {
    this.putDeleted.run(sessionId, now);
  }

  setArchived(sessionId: string, archived: boolean, now: number): void {
    if (archived) this.putArchived.run(sessionId, now);
    else this.delArchived.run(sessionId);
  }

  /** el flujo sale de la sala de control (WorkflowRuns lo filtra); no toca ~/.claude ni el presupuesto */
  dismissRun(runId: string, now: number): void {
    this.putDismissed.run(runId, now);
  }
}
