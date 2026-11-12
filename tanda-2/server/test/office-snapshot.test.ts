import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection';
import { OfficeBuilder } from '../src/state/office';
import { SessionRegistry, type RegistryEntry } from '../src/state/sessions';

/** hora local del 4 de mayo de 2026 */
const NOW = new Date(2026, 4, 4, 15).getTime();
const MIN = 60_000;
const S = 'sesion-oficina';
const CWD = 'C:\\demo';

let seq = 0;

function setup(lastActivity: number) {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (session_id, cwd, project_name, last_activity_at, last_prompt_at) VALUES (?, ?, 'demo', ?, ?)`,
  ).run(S, CWD, lastActivity, lastActivity - 5 * MIN);
  db.prepare(
    `INSERT INTO agents (agent_id, session_id, kind, agent_type, started_at, last_activity_at) VALUES (?, ?, 'lead', 'lead', ?, ?)`,
  ).run(S, S, lastActivity - 5 * MIN, lastActivity);
  let now = NOW;
  const registry = new SessionRegistry('sin-claude-home', db);
  const builder = new OfficeBuilder(db, registry, () => now);
  return { db, registry, builder, tick: (ms: number) => (now += ms) };
}

function entry(sessionId: string, updatedAtMs: number | null): RegistryEntry {
  return { sessionId, pid: 1, cwd: CWD, name: null, status: 'idle', updatedAtMs, startedAtMs: null };
}

function action(db: Db, agentId: string, tool: string, ts: number, end: number | null, cmdClass: string | null = null): void {
  db.prepare(
    `INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, ended_at, cmd_class)
     VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
  ).run(`tu-${++seq}`, agentId, S, tool, ts, end, cmdClass);
}

function generalist(db: Db, id: string, start: number, end: number | null): void {
  db.prepare(
    `INSERT INTO agents (agent_id, session_id, kind, agent_type, description, started_at, last_activity_at, ended_at, role, look_type)
     VALUES (?, ?, 'subagent', 'general-purpose', 'tarea', ?, ?, ?, 'generalist', 'general-purpose')`,
  ).run(id, S, start, end ?? start, end);
}

describe('snapshot de la oficina', () => {
  it('pregunta sin respuesta: el lead espera en la puerta con la sesion abierta; cerrada, va a dormir', () => {
    const last = NOW - 15 * MIN;
    const { db, registry, builder } = setup(last);
    action(db, S, 'AskUserQuestion', last, null);
    registry.entries = new Map([[S, entry(S, last)]]);
    expect(builder.build().rooms[0]?.lead.place).toBe('door');

    registry.entries = new Map();
    const lead = builder.build().rooms[0]?.lead;
    expect(lead?.status).toBe('idle');
    expect(lead?.place).toBe('sleep');
  });

  it('un generalist sube a tester aunque su ultima accion no sea un comando, o aunque ya haya terminado', () => {
    const { db, registry, builder } = setup(NOW - MIN);
    registry.entries = new Map([[S, entry(S, NOW - MIN)]]);
    generalist(db, 'g-trabaja', NOW - 10 * MIN, null);
    generalist(db, 'g-termino', NOW - 10 * MIN, NOW - 10_000);
    for (const id of ['g-trabaja', 'g-termino']) {
      for (let i = 0; i < 4; i++) action(db, id, 'Bash', NOW - (9 - i) * MIN, NOW - (9 - i) * MIN + 1000, 'test');
    }
    // los comandos ya cerraron: su accion mas reciente es un Read abierto
    action(db, 'g-trabaja', 'Read', NOW - 2 * MIN, null);

    const subs = Object.fromEntries((builder.build().rooms[0]?.subagents ?? []).map((a) => [a.id, a]));
    expect(subs['g-trabaja']).toMatchObject({ role: 'tester', agentType: 'tester', status: 'working', place: 'lab' });
    expect(subs['g-termino']).toMatchObject({ role: 'tester', agentType: 'tester', status: 'done' });
  });

  it('un subagente y una sesion todavia sin horas propias no cambian el snapshot en cada tick', () => {
    const { db, registry, builder, tick } = setup(NOW - MIN);
    // subagente creado por su meta, antes de la primera linea de su transcript
    db.prepare(
      `INSERT INTO agents (agent_id, session_id, kind, agent_type, description) VALUES ('recien', ?, 'subagent', 'general-purpose', 'tarea')`,
    ).run(S);
    // sesion abierta por el mtime de su transcript, sin actividad ni horas en el registro
    db.prepare(`INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES ('k-sin-horas', 'x', 0, 0, ?)`).run(
      NOW - MIN,
    );
    db.prepare(`INSERT INTO sessions (session_id, cwd, project_name, transcript_key) VALUES ('sin-horas', ?, 'otra', 'k-sin-horas')`).run(
      CWD,
    );
    registry.entries = new Map([
      [S, entry(S, NOW - MIN)],
      ['sin-horas', entry('sin-horas', null)],
    ]);

    const first = builder.build();
    const recien = first.rooms.find((r) => r.id === S)?.subagents.find((a) => a.id === 'recien');
    expect(recien?.task?.startedAt).toBe(new Date(NOW).toISOString());
    expect(first.rooms.find((r) => r.id === 'sin-horas')?.lastActivityAt).toBe(new Date(NOW).toISOString());

    tick(1000);
    const second = builder.build();
    expect(JSON.stringify({ ...second, generatedAt: '' })).toBe(JSON.stringify({ ...first, generatedAt: '' }));
  });
});
