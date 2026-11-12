import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, runBackfill } from '../src/app';
import { openDb } from '../src/db/connection';
import { classifyPath, pathKey } from '../src/ingest/paths';
import { line, TempHome } from './helpers';

const SID = '22222222-3333-4444-8555-666666666666';
const PROJECT = 'C--demo-incremental-falso';
const LEAD_REL = `projects/${PROJECT}/${SID}.jsonl`;

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

const base = { sessionId: SID, cwd: 'C:\\demo\\incremental-falso', isSidechain: false };
const assistantLine = (output: number, stop: string | null, ts: string, uuid: string) =>
  line({
    ...base,
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      id: 'msg_X',
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'respuesta falsa' }],
      stop_reason: stop,
      usage: { input_tokens: 7, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
    },
  });

describe('lectura incremental con linea parcial', () => {
  it('guarda la linea parcial sin avanzar el offset y la completa en la siguiente lectura', async () => {
    home = new TempHome();
    const prompt = line({ ...base, type: 'user', uuid: 'p1', timestamp: '2026-02-01T09:00:00.000Z', message: { role: 'user', content: 'Prompt incremental falso' } });
    const first = assistantLine(5, null, '2026-02-01T09:00:01.000Z', 'a1');
    const second = assistantLine(60, 'end_turn', '2026-02-01T09:00:02.000Z', 'a2');
    const turnEnd = line({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 2000, uuid: 's1', timestamp: '2026-02-01T09:00:03.000Z' });
    const cut = Math.floor(second.length / 2);
    const leadPath = home.write(LEAD_REL, prompt + first + second.slice(0, cut));

    const now = Date.parse('2026-02-01T09:00:10.000Z');
    const ctx = createContext({ db: openDb(':memory:'), claudeHome: home.root, now: () => now, log: () => {} });
    await runBackfill(ctx);

    const offset = () =>
      (ctx.db.prepare(`SELECT byte_offset FROM file_offsets WHERE path_key = ?`).get(pathKey(leadPath)) as { byte_offset: number })
        .byte_offset;
    const output = () => (ctx.db.prepare(`SELECT output FROM usage WHERE message_id = 'msg_X'`).get() as { output: number }).output;

    expect(offset()).toBe(Buffer.byteLength(prompt + first));
    expect(output()).toBe(5);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });

    home.append(LEAD_REL, second.slice(cut) + turnEnd);
    const target = classifyPath(home.root, leadPath);
    expect(target?.kind).toBe('lead');
    if (target) ctx.queue.enqueue(target);
    await ctx.queue.idle();

    expect(offset()).toBe(fs.statSync(leadPath).size);
    expect(output()).toBe(60);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage`).get()).toEqual({ n: 1 });
    const task = ctx.db.prepare(`SELECT title, output FROM tasks WHERE kind = 'lead'`).get();
    expect(task).toEqual({ title: 'Prompt incremental falso', output: 60 });
    ctx.db.close();
  });

  it('respaldo: subagente con end_turn, sin acciones abiertas y archivo quieto > 90 s', async () => {
    home = new TempHome();
    const real = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    home.write(
      LEAD_REL,
      line({ ...base, type: 'user', uuid: 'p1', timestamp: iso(real - 120_000), message: { role: 'user', content: 'Prompt falso' } }),
    );
    const subRel = `projects/${PROJECT}/${SID}/subagents/agent-afallback00000001.jsonl`;
    home.write(
      subRel,
      line({ ...base, isSidechain: true, agentId: 'afallback00000001', type: 'user', uuid: 's1', timestamp: iso(real - 60_000), message: { role: 'user', content: 'tarea falsa' } }) +
        line({
          ...base,
          isSidechain: true,
          agentId: 'afallback00000001',
          type: 'assistant',
          uuid: 's2',
          timestamp: iso(real - 50_000),
          message: { id: 'msg_F', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'fin falso' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }),
    );
    // el archivo se escribio "ahora": 100 s despues ya esta quieto; la sesion sigue viva (actividad < 10 min)
    let now = real + 10_000;
    const ctx = createContext({ db: openDb(':memory:'), claudeHome: home.root, now: () => now, log: () => {} });
    await runBackfill(ctx);
    const state = () => ctx.db.prepare(`SELECT ended_at, end_reason FROM agents WHERE agent_id = 'afallback00000001'`).get();
    expect(state()).toEqual({ ended_at: null, end_reason: null });

    now = real + 100_000;
    ctx.settle();
    expect(state()).toEqual({ ended_at: real - 50_000, end_reason: 'fallback' });
    ctx.db.close();
  });

  it('skill por /comando: la linea meta llega en otra lectura y el evento igual se guarda', async () => {
    home = new TempHome();
    const prompt = line({ ...base, type: 'user', uuid: 'p1', timestamp: '2026-02-01T09:00:00.000Z', message: { role: 'user', content: 'Prompt falso' } });
    const command = line({
      ...base,
      type: 'user',
      uuid: 'u-cmd',
      timestamp: '2026-02-01T09:00:01.000Z',
      message: { role: 'user', content: '<command-message>skill-falsa</command-message>\n<command-name>/skill-falsa</command-name>' },
    });
    const meta = line({
      ...base,
      type: 'user',
      uuid: 'u-meta',
      timestamp: '2026-02-01T09:00:01.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'contenido falso de la skill' }] },
    });
    const cut = Math.floor(meta.length / 2);
    const leadPath = home.write(LEAD_REL, prompt + command + meta.slice(0, cut));
    const now = Date.parse('2026-02-01T09:00:10.000Z');
    const ctx = createContext({ db: openDb(':memory:'), claudeHome: home.root, now: () => now, log: () => {} });
    await runBackfill(ctx);
    const skills = () => ctx.db.prepare(`SELECT id, kind FROM session_events WHERE kind = 'skill'`).all();
    expect(skills()).toEqual([]);

    home.append(LEAD_REL, meta.slice(cut));
    const target = classifyPath(home.root, leadPath);
    if (target) ctx.queue.enqueue(target);
    await ctx.queue.idle();
    expect(skills()).toEqual([{ id: 'u-cmd:skill', kind: 'skill' }]);
    ctx.db.close();
  });
});
