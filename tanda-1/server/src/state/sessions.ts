import fs from 'node:fs';
import path from 'node:path';
import { TIMING } from '../config';
import type { Db } from '../db/connection';
import { SAFE_ID, sessionsDir } from '../ingest/paths';
import { parseTs } from '../ingest/parser';

/** CLAUDE_HOME/sessions/<pid>.json: una sesion de Claude Code abierta */
export interface RegistryEntry {
  sessionId: string;
  pid: number | null;
  cwd: string | null;
  name: string | null;
  status: string | null;
  updatedAtMs: number | null;
  startedAtMs: number | null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function toMs(v: unknown): number | null {
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return parseTs(Number(v));
  return parseTs(v);
}

export async function readRegistry(claudeHome: string): Promise<Map<string, RegistryEntry>> {
  const dir = sessionsDir(claudeHome);
  const out = new Map<string, RegistryEntry>();
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let data: unknown;
    try {
      data = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const o = data as Record<string, unknown>;
    const sessionId = text(o.sessionId);
    if (!sessionId || !SAFE_ID.test(sessionId)) continue;
    const entry: RegistryEntry = {
      sessionId,
      pid: typeof o.pid === 'number' ? o.pid : null,
      cwd: text(o.cwd),
      name: text(o.name),
      status: text(o.status),
      updatedAtMs: toMs(o.updatedAt) ?? toMs(o.statusUpdatedAt),
      startedAtMs: toMs(o.startedAt),
    };
    const prev = out.get(sessionId);
    if (!prev || (entry.updatedAtMs ?? 0) > (prev.updatedAtMs ?? 0)) out.set(sessionId, entry);
  }
  return out;
}

/** abierta = existe su registro, salvo que updatedAt y el mtime del transcript tengan ambos mas de 24 h */
export function isRegistryOpen(entry: RegistryEntry, transcriptMtime: number | null, now: number): boolean {
  const updatedOld = entry.updatedAtMs === null || now - entry.updatedAtMs > TIMING.staleRegistryMs;
  const transcriptOld = transcriptMtime === null || now - transcriptMtime > TIMING.staleRegistryMs;
  return !(updatedOld && transcriptOld);
}

export class SessionRegistry {
  entries = new Map<string, RegistryEntry>();
  private key = '';
  private readonly mtimeOf;
  private readonly saveName;

  constructor(
    private readonly claudeHome: string,
    db: Db,
  ) {
    this.mtimeOf = db.prepare<[string], { mtime_ms: number | null }>(
      `SELECT f.mtime_ms FROM sessions s JOIN file_offsets f ON f.path_key = s.transcript_key WHERE s.session_id = ?`,
    );
    this.saveName = db.prepare<[string, string, string]>(
      `UPDATE sessions SET registry_name = ? WHERE session_id = ? AND (registry_name IS NULL OR registry_name <> ?)`,
    );
  }

  /** relee el directorio; true si algo cambio */
  async refresh(): Promise<boolean> {
    const next = await readRegistry(this.claudeHome);
    const key = JSON.stringify([...next.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)));
    const changed = key !== this.key;
    this.entries = next;
    this.key = key;
    this.syncNames();
    return changed;
  }

  /** guarda el nombre en la DB para que el historial lo conserve cuando la sesion se cierre */
  syncNames(): void {
    for (const e of this.entries.values()) {
      if (e.name) this.saveName.run(e.name, e.sessionId, e.name);
    }
  }

  transcriptMtime(sessionId: string): number | null {
    return this.mtimeOf.get(sessionId)?.mtime_ms ?? null;
  }

  isOpen(sessionId: string, now: number): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return isRegistryOpen(entry, this.transcriptMtime(sessionId), now);
  }

  openIds(now: number): Set<string> {
    const out = new Set<string>();
    for (const id of this.entries.keys()) if (this.isOpen(id, now)) out.add(id);
    return out;
  }

  /** abiertas con el lead trabajando (status busy), el mismo criterio que usa la oficina */
  busyIds(now: number): Set<string> {
    const out = new Set<string>();
    for (const [id, e] of this.entries) if (e.status === 'busy' && this.isOpen(id, now)) out.add(id);
    return out;
  }
}
