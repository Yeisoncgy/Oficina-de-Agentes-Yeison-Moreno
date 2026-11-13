import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { TranscriptEntry, TranscriptResponse } from '@shared/contract';
import type { Db } from '../db/connection';
import { actionLabel, inputSummary, truncate } from '../ingest/labels';
import { parseTs } from '../ingest/parser';
import { isInside, pathKey, projectsDir, SAFE_ID } from '../ingest/paths';
import { extractPrompt } from '../ingest/prompt';
import { readNewLines } from '../ingest/reader';
import { iso } from '../state/office';

export const TRANSCRIPT_PAGE = 150;
const TEXT_MAX = 4000;
const CACHE_MAX = 8;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

interface ParseState {
  entries: TranscriptEntry[];
  toolNames: Map<string, string>;
  seen: Set<string>;
  lastTs: string;
  lineNo: number;
}

function newState(): ParseState {
  return { entries: [], toolNames: new Map(), seen: new Set(), lastTs: new Date(0).toISOString(), lineNo: 0 };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[imagen]');
  }
  return parts.join('\n');
}

function push(state: ParseState, entry: TranscriptEntry): void {
  if (state.seen.has(entry.id)) return;
  state.seen.add(entry.id);
  state.entries.push(entry);
}

/** convierte lineas del transcript en entradas legibles (omite thinking) */
export function parseTranscriptLines(lines: readonly string[], state: ParseState): void {
  for (const raw of lines) {
    state.lineNo++;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const o = parsed;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const tsMs = parseTs(o.timestamp);
    const timestamp = tsMs !== null ? iso(tsMs) : state.lastTs;
    state.lastTs = timestamp;
    const baseId = typeof o.uuid === 'string' && o.uuid ? o.uuid : `l${state.lineNo}`;
    const msg = isRecord(o.message) ? o.message : null;
    const content = msg?.content;

    if (o.type === 'assistant') {
      if (typeof content === 'string' && content.trim()) {
        push(state, { id: baseId, timestamp, kind: 'text', text: truncate(content.trim(), TEXT_MAX) });
        continue;
      }
      if (!Array.isArray(content)) continue;
      content.forEach((b, i) => {
        if (!isRecord(b)) return;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          push(state, { id: `${baseId}:${i}`, timestamp, kind: 'text', text: truncate(b.text.trim(), TEXT_MAX) });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const label = actionLabel(b.name, b.input);
          const summary = inputSummary(b.input);
          if (typeof b.id === 'string') state.toolNames.set(b.id, b.name);
          push(state, {
            id: `${baseId}:${i}`,
            timestamp,
            kind: 'tool_use',
            text: truncate(summary ? `${label} · ${summary}` : label, TEXT_MAX),
            toolName: b.name,
          });
        }
      });
      continue;
    }

    const prompt = extractPrompt(o);
    if (prompt) {
      push(state, { id: baseId, timestamp, kind: 'prompt', text: truncate(prompt.text, TEXT_MAX) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    content.forEach((b, i) => {
      if (!isRecord(b) || b.type !== 'tool_result') return;
      const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      const entry: TranscriptEntry = {
        id: `${baseId}:${i}`,
        timestamp,
        kind: 'tool_result',
        text: truncate(resultText(b.content).trim(), TEXT_MAX),
        isError: b.is_error === true,
      };
      const toolName = state.toolNames.get(toolUseId);
      if (toolName) entry.toolName = toolName;
      push(state, entry);
    });
  }
}

interface CacheEntry {
  offset: number;
  size: number;
  mtimeMs: number;
  state: ParseState;
}

export function encodeCursor(end: number): string {
  return Buffer.from(JSON.stringify({ e: end })).toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { e?: unknown };
    return typeof v.e === 'number' && Number.isInteger(v.e) && v.e >= 0 ? v.e : null;
  } catch {
    return null;
  }
}

export function paginate(entries: readonly TranscriptEntry[], end: number): { entries: TranscriptEntry[]; nextCursor: string | null } {
  const stop = Math.min(Math.max(0, end), entries.length);
  const start = Math.max(0, stop - TRANSCRIPT_PAGE);
  return { entries: entries.slice(start, stop), nextCursor: start > 0 ? encodeCursor(start) : null };
}

/** parseo de transcripts con cache por (ruta, size, mtime); si el archivo crecio lee solo lo nuevo */
export class TranscriptService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<TranscriptEntry[] | null>>();
  private readonly findPath;

  constructor(
    db: Db,
    private readonly claudeHome: string,
  ) {
    this.findPath = db.prepare<[string], { transcript_path: string | null }>(
      `SELECT transcript_path FROM agents WHERE agent_id = ?`,
    );
  }

  /** ruta validada del transcript de un agente, o un error http */
  resolve(agentId: string): { path: string } | { status: number; message: string } {
    if (!SAFE_ID.test(agentId)) return { status: 400, message: 'id invalido' };
    const row = this.findPath.get(agentId);
    if (!row?.transcript_path) return { status: 404, message: 'agente sin transcript' };
    if (!isInside(projectsDir(this.claudeHome), row.transcript_path)) return { status: 400, message: 'ruta fuera de projects' };
    return { path: row.transcript_path };
  }

  /** dos pedidos simultaneos del mismo archivo comparten la misma lectura */
  load(filePath: string): Promise<TranscriptEntry[] | null> {
    const key = pathKey(filePath);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.loadNow(filePath, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async loadNow(filePath: string, key: string): Promise<TranscriptEntry[] | null> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    let c = this.cache.get(key);
    if (c && c.size === stat.size && c.mtimeMs === Math.floor(stat.mtimeMs)) {
      this.touch(key, c);
      return c.state.entries;
    }
    if (!c || stat.size < c.offset) c = { offset: 0, size: 0, mtimeMs: 0, state: newState() };
    const entry = c;
    const res = await readNewLines(filePath, entry.offset, (lines) => parseTranscriptLines(lines, entry.state));
    if (!res) return null;
    entry.offset = res.endOffset;
    entry.size = res.size;
    entry.mtimeMs = res.mtimeMs;
    this.touch(key, entry);
    return entry.state.entries;
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export function registerTranscriptRoutes(app: FastifyInstance, service: TranscriptService): void {
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/api/agents/:id/transcript',
    async (req, reply) => {
      const resolved = service.resolve(req.params.id);
      if ('status' in resolved) return reply.code(resolved.status).send({ error: resolved.message });
      let end: number | undefined;
      if (req.query.cursor) {
        const decoded = decodeCursor(req.query.cursor);
        if (decoded === null) return reply.code(400).send({ error: 'cursor invalido' });
        end = decoded;
      }
      const entries = await service.load(resolved.path);
      if (!entries) return reply.code(404).send({ error: 'transcript no disponible' });
      const page = paginate(entries, end ?? entries.length);
      const body: TranscriptResponse = { agentId: req.params.id, entries: page.entries, nextCursor: page.nextCursor };
      return body;
    },
  );
}
