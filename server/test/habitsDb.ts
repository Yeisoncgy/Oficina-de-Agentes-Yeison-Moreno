import { openDb, type Db } from '../src/db/connection';
import { costUsd } from '../src/ingest/pricing';

/** mediodia local fijo: nada de las pruebas cruza la medianoche */
export const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5';

/**
 * DB :memory: con las migraciones reales. Si la v13 (ingesta de senales) todavia no esta en connection.ts,
 * crea aqui sus columnas y la tabla session_events con las mismas guardas, sin tocar connection.ts.
 */
export function habitsDb(): Db {
  const db = openDb(':memory:');
  const has = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
  const add = (table: string, col: string, type: string): void => {
    if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  add('actions', 'input_hash', 'TEXT');
  add('actions', 'cmd_class', 'TEXT');
  add('actions', 'read_partial', 'INTEGER');
  add('actions', 'result_chars', 'INTEGER');
  add('actions', 'result_lines', 'INTEGER');
  add('actions', 'result_hash', 'TEXT');
  add('actions', 'denied', 'TEXT');
  add('sessions', 'git_branch', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, data TEXT
    );
    CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS session_events_kind ON session_events(kind, ts);
  `);
  return db;
}

interface ActionOpts {
  target: string | null;
  endedAt: number | null;
  isError: boolean;
  denied: string | null;
  inputHash: string | null;
  cmdClass: string | null;
  readPartial: number | null;
  resultChars: number | null;
  resultLines: number | null;
  resultHash: string | null;
}

interface UsageOpts {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** filas minimas escritas a mano (solo lo que cada prueba necesita) */
export class Seed {
  private n = 0;

  constructor(readonly db: Db) {}

  private next(prefix: string): string {
    this.n++;
    return `${prefix}-${String(this.n).padStart(6, '0')}`;
  }

  session(
    id: string,
    o: Partial<{
      cwd: string;
      projectName: string;
      lastActivityAt: number;
      turnOpen: boolean;
      lastPromptAt: number;
      lastPromptTitle: string;
      registryName: string;
    }> = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, cwd, project_name, last_activity_at, turn_open, last_prompt_at,
                               last_prompt_title, registry_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.cwd ?? 'C:\\proyectos\\demo',
        o.projectName ?? 'demo',
        o.lastActivityAt ?? NOW - MIN,
        o.turnOpen ? 1 : 0,
        o.lastPromptAt ?? null,
        o.lastPromptTitle ?? null,
        o.registryName ?? null,
      );
    this.agent(id, id, { kind: 'lead', agentType: 'lead', startedAt: NOW - 60 * MIN, lastActivityAt: o.lastActivityAt ?? NOW - MIN });
  }

  agent(
    id: string,
    sessionId: string,
    o: Partial<{
      kind: 'lead' | 'subagent';
      agentType: string;
      role: string;
      model: string;
      startedAt: number;
      lastActivityAt: number;
      endedAt: number | null;
    }> = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, session_id, kind, agent_type, role, model, started_at, last_activity_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET model = excluded.model`,
      )
      .run(
        id,
        sessionId,
        o.kind ?? 'subagent',
        o.agentType ?? 'general-purpose',
        o.role ?? null,
        o.model ?? OPUS,
        o.startedAt ?? NOW - 30 * MIN,
        o.lastActivityAt ?? NOW - MIN,
        o.endedAt === undefined ? null : o.endedAt,
      );
  }

  usage(agentId: string, sessionId: string, ts: number, o: Partial<UsageOpts> = {}): void {
    const model = o.model ?? OPUS;
    const t = {
      input: o.input ?? 100,
      output: o.output ?? 200,
      cacheRead: o.cacheRead ?? 20_000,
      cacheWrite5m: o.cacheWrite5m ?? 1_000,
      cacheWrite1h: o.cacheWrite1h ?? 0,
    };
    this.db
      .prepare(
        `INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m,
                            cache_write_1h, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.next('msg'), agentId, sessionId, ts, model, t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, costUsd(model, t));
  }

  /** llamada con un costo exacto (tokens de salida del modelo que den ese monto) */
  spend(agentId: string, sessionId: string, ts: number, usd: number, model = OPUS): void {
    this.db
      .prepare(
        `INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m,
                            cache_write_1h, cost_usd)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
      )
      .run(this.next('msg'), agentId, sessionId, ts, model, usd);
  }

  action(agentId: string, sessionId: string, tool: string, ts: number, o: Partial<ActionOpts> = {}): string {
    const id = this.next('tu');
    this.db
      .prepare(
        `INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, ended_at, is_error, target,
                              input_hash, cmd_class, read_partial, result_chars, result_lines, result_hash, denied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agentId,
        sessionId,
        tool,
        tool,
        ts,
        o.endedAt === undefined ? ts + 1_000 : o.endedAt,
        o.isError ? 1 : 0,
        o.target ?? null,
        o.inputHash === undefined ? id : o.inputHash,
        o.cmdClass ?? null,
        o.readPartial ?? null,
        o.resultChars ?? null,
        o.resultLines ?? null,
        o.resultHash ?? null,
        o.denied ?? null,
      );
    return id;
  }

  event(sessionId: string, agentId: string, ts: number, kind: string, data: unknown = null): void {
    this.db
      .prepare(`INSERT INTO session_events (id, session_id, agent_id, ts, kind, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(this.next('ev'), sessionId, agentId, ts, kind, data === null ? null : JSON.stringify(data));
  }

  /** turno cerrado del lead (tabla tasks) */
  turn(sessionId: string, start: number, end: number, title = 'Respondiendo una consulta'): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, agent_id, kind, agent_type, title, started_at, ended_at)
         VALUES (?, ?, ?, 'lead', 'lead', ?, ?, ?)`,
      )
      .run(`${sessionId}:${this.next('turn')}`, sessionId, sessionId, title, start, end);
  }

  /** tarea de un subagente terminado (muestras de agent_cost) */
  subagentTask(sessionId: string, endedAt: number, costUsd: number): void {
    const id = this.next('task');
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, agent_id, kind, agent_type, title, started_at, ended_at, cost_usd)
         VALUES (?, ?, ?, 'subagent', 'Explore', 'Explorando', ?, ?, ?)`,
      )
      .run(id, sessionId, id, endedAt - MIN, endedAt, costUsd);
  }

  launch(sessionId: string, parentId: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO launches (tool_use_id, session_id, parent_agent_id, subagent_type, started_at)
         VALUES (?, ?, ?, 'Explore', ?)`,
      )
      .run(this.next('launch'), sessionId, parentId, ts);
  }

  notification(taskId: string, sessionId: string, ts: number, status: string): void {
    this.db
      .prepare(`INSERT INTO notifications (task_id, ts, session_id, status) VALUES (?, ?, ?, ?)`)
      .run(taskId, ts, sessionId, status);
  }

  run(runId: string, sessionId: string, o: Partial<{ name: string; finalStatus: string }> = {}): void {
    this.db
      .prepare(`INSERT INTO workflow_runs (run_id, session_id, meta_name, launched_at, final_status) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, sessionId, o.name ?? 'flujo-prueba', NOW - 20 * MIN, o.finalStatus ?? null);
  }

  runAgent(agentId: string, runId: string, sessionId: string, o: Partial<{ key: string; seq: number; endStatus: string }> = {}): void {
    this.db
      .prepare(`INSERT INTO workflow_agents (agent_id, run_id, session_id, key, seq, end_status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(agentId, runId, sessionId, o.key ?? null, o.seq ?? null, o.endStatus ?? null);
  }
}
