import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { notesKeyOf, projectKeyOf } from '../state/roomNotes';

export type Db = Database.Database;

// Casi todo lo que hay en la DB se reconstruye desde ~/.claude: una migracion que cambie la forma de
// interpretar los transcripts puede borrar datos derivados y reiniciar file_offsets. Lo que escribe
// el usuario (settings, room_names, session_names, room_notes, archived_rooms, dismissed_runs, dismissed_alerts) no se
// reconstruye: ninguna migracion lo borra. session_events (v13) es derivado: sale de los transcripts.
const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_offsets (
        path_key    TEXT PRIMARY KEY,
        path        TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id        TEXT PRIMARY KEY,
        project_dir       TEXT,
        cwd               TEXT,
        project_name      TEXT,
        transcript_path   TEXT,
        transcript_key    TEXT,
        registry_name     TEXT,
        custom_title      TEXT,
        last_activity_at  INTEGER,
        last_prompt_at    INTEGER,
        last_prompt_uuid  TEXT,
        last_prompt_title TEXT,
        turn_open         INTEGER NOT NULL DEFAULT 0,
        last_turn_end_at  INTEGER,
        cost_state_usd    REAL,
        cost_state_json   TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(last_activity_at);

      CREATE TABLE IF NOT EXISTS agents (
        agent_id         TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        kind             TEXT NOT NULL,
        agent_type       TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        meta_seen        INTEGER NOT NULL DEFAULT 0,
        tool_use_id      TEXT,
        is_async         INTEGER NOT NULL DEFAULT 0,
        transcript_path  TEXT,
        transcript_key   TEXT,
        model            TEXT,
        started_at       INTEGER,
        last_activity_at INTEGER,
        last_msg_id      TEXT,
        last_stop        TEXT,
        ended_at         INTEGER,
        end_reason       TEXT,
        task_dirty       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id, kind);
      CREATE INDEX IF NOT EXISTS agents_tool_use ON agents(tool_use_id);
      CREATE INDEX IF NOT EXISTS agents_open ON agents(kind, ended_at);

      CREATE TABLE IF NOT EXISTS usage (
        message_id     TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        ts             INTEGER NOT NULL,
        model          TEXT NOT NULL,
        input          INTEGER NOT NULL,
        output         INTEGER NOT NULL,
        cache_read     INTEGER NOT NULL,
        cache_write_5m INTEGER NOT NULL,
        cache_write_1h INTEGER NOT NULL,
        speed          TEXT,
        cost_usd       REAL
      );
      CREATE INDEX IF NOT EXISTS usage_agent_ts ON usage(agent_id, ts);
      CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

      CREATE TABLE IF NOT EXISTS actions (
        tool_use_id TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        tool        TEXT NOT NULL,
        label       TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        is_error    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS actions_agent ON actions(agent_id, started_at);

      CREATE TABLE IF NOT EXISTS launches (
        tool_use_id     TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        parent_agent_id TEXT NOT NULL,
        subagent_type   TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        started_at      INTEGER NOT NULL,
        result_at       INTEGER,
        is_async        INTEGER NOT NULL DEFAULT 0,
        result_agent_id TEXT,
        is_error        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS launches_result_agent ON launches(result_agent_id);

      CREATE TABLE IF NOT EXISTS notifications (
        task_id    TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        status     TEXT NOT NULL,
        PRIMARY KEY (task_id, ts)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        kind            TEXT NOT NULL,
        agent_type      TEXT NOT NULL,
        title           TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER NOT NULL,
        input           INTEGER NOT NULL DEFAULT 0,
        output          INTEGER NOT NULL DEFAULT 0,
        cache_read      INTEGER NOT NULL DEFAULT 0,
        cache_write     INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL NOT NULL DEFAULT 0,
        unpriced_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tasks_ended ON tasks(ended_at, id);
      CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id);
    `);
  },
  // v2: tool Workflow. Sus archivos nunca se habian leido: no hay datos viejos que reparar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id           TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        task_id          TEXT,
        tool_use_id      TEXT,
        tool_name        TEXT,
        script_path      TEXT,
        meta_name        TEXT,
        meta_description TEXT,
        meta_phases      TEXT,
        launched_at      INTEGER,
        journal_key      TEXT,
        final_status     TEXT,
        final_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_session ON workflow_runs(session_id);
      CREATE INDEX IF NOT EXISTS workflow_runs_task ON workflow_runs(task_id);

      CREATE TABLE IF NOT EXISTS workflow_agents (
        agent_id   TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        session_id TEXT NOT NULL,
        key        TEXT,
        label      TEXT,
        phase      TEXT,
        seq        INTEGER,
        end_status TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_agents_run ON workflow_agents(run_id, seq);
      CREATE INDEX IF NOT EXISTS workflow_agents_key ON workflow_agents(run_id, key);
    `);
  },
  // v3: un server a medio actualizar pudo leer los archivos de subagents/workflows/ sin entenderlos
  // (titulo sin fase, sin fila en workflow_agents). Se releen: la ingesta es idempotente.
  (db) => {
    db.prepare(`DELETE FROM file_offsets WHERE instr(path_key, ?) > 0 OR instr(path_key, ?) > 0`).run(
      '\\subagents\\workflows\\',
      '/subagents/workflows/',
    );
  },
  // v4: ese mismo server leyo journal.jsonl y <sesion>/workflows/<runId>.json como transcripts: dejo
  // agentes sin id (se veian trabajando para siempre) y offsets que tapaban el estado final.
  (db) => {
    db.exec(`DELETE FROM agents WHERE agent_id IS NULL`);
    db.prepare(
      `DELETE FROM file_offsets WHERE path_key LIKE '%.json' AND (instr(path_key, ?) > 0 OR instr(path_key, ?) > 0)`,
    ).run('\\workflows\\', '/workflows/');
  },
  // v5: rol de los agentes de flujo (inicio del encargo) y archivo de cada accion (titulo real de la
  // tarea). Se releen los transcripts de flujo para llenarlos: la ingesta es idempotente.
  (db) => {
    const has = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    if (!has('agents', 'prompt_head')) db.exec(`ALTER TABLE agents ADD COLUMN prompt_head TEXT`);
    if (!has('agents', 'role')) db.exec(`ALTER TABLE agents ADD COLUMN role TEXT`);
    if (!has('agents', 'look_type')) db.exec(`ALTER TABLE agents ADD COLUMN look_type TEXT`);
    if (!has('actions', 'target')) db.exec(`ALTER TABLE actions ADD COLUMN target TEXT`);
    db.prepare(`DELETE FROM file_offsets WHERE instr(path_key, ?) > 0 OR instr(path_key, ?) > 0`).run(
      '\\subagents\\workflows\\',
      '/subagents/workflows/',
    );
  },
  // v6: ajustes del usuario (presupuesto real) y etiqueta profesional de las tareas del lead, que sale del
  // archivo de cada accion: se releen todos los transcripts para llenar actions.target (idempotente).
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`DELETE FROM file_offsets`);
  },
  // v7: nombre propio y notas de las salas, por proyecto. Tablas nuevas: no hay datos viejos que reparar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_names (
        project_key TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_notes (
        id          TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        text        TEXT NOT NULL,
        done        INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_notes_project ON room_notes(project_key, created_at);
    `);
  },
  // v8: salas archivadas por el usuario (por sesion). Tabla nueva: no hay datos viejos que reparar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archived_rooms (
        session_id  TEXT PRIMARY KEY,
        archived_at INTEGER NOT NULL
      );
    `);
  },
  // v9: el nombre propio pasa a ser de cada sala (sesion), no de la carpeta. Cada sesion conocida hereda
  // el nombre que tenia su carpeta, para que nada cambie de golpe; room_names queda sin uso pero no se borra.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_names (
        session_id TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const byProject = new Map(
      (db.prepare(`SELECT project_key, name, updated_at FROM room_names`).all() as Array<{
        project_key: string;
        name: string;
        updated_at: number;
      }>).map((r) => [r.project_key, r]),
    );
    if (byProject.size === 0) return;
    const put = db.prepare(`INSERT OR IGNORE INTO session_names (session_id, name, updated_at) VALUES (?, ?, ?)`);
    const sessions = db.prepare(`SELECT session_id, cwd FROM sessions`).all() as Array<{ session_id: string; cwd: string | null }>;
    for (const s of sessions) {
      const named = byProject.get(projectKeyOf(s.cwd ?? '', s.session_id));
      if (named) put.run(s.session_id, named.name, named.updated_at);
    }
  },
  // v10: sala eliminada para siempre por el usuario: no vuelve a la oficina aunque su chat siga trabajando.
  (db) => {
    const cols = db.prepare(`PRAGMA table_info(archived_rooms)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'deleted')) {
      db.exec(`ALTER TABLE archived_rooms ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    }
  },
  // v11: las notas pasan a ser de cada sala (sesion), no de la carpeta. No se sabe desde que sala se
  // escribio cada nota vieja, asi que va a la sesion con actividad mas reciente de su carpeta (copiarla a
  // todas repetiria lo que se quiere evitar). Sin sesion conocida en la carpeta, la nota se deja como esta.
  (db) => {
    const keys = db.prepare(`SELECT DISTINCT project_key FROM room_notes WHERE project_key LIKE 'dir:%'`).all() as Array<{
      project_key: string;
    }>;
    if (keys.length === 0) return;
    const latest = new Map<string, { id: string; at: number }>();
    const sessions = db.prepare(`SELECT session_id, cwd, last_activity_at FROM sessions`).all() as Array<{
      session_id: string;
      cwd: string | null;
      last_activity_at: number | null;
    }>;
    for (const s of sessions) {
      if (!s.cwd) continue;
      const key = projectKeyOf(s.cwd, s.session_id);
      const at = s.last_activity_at ?? 0;
      const cur = latest.get(key);
      if (!cur || at > cur.at) latest.set(key, { id: s.session_id, at });
    }
    const move = db.prepare(`UPDATE room_notes SET project_key = ? WHERE project_key = ?`);
    for (const { project_key } of keys) {
      const owner = latest.get(project_key);
      if (owner) move.run(notesKeyOf(owner.id), project_key);
    }
  },
  // v12: flujos terminados que el usuario quito de la sala de control. Tabla nueva: no hay datos viejos que reparar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_runs (
        run_id       TEXT PRIMARY KEY,
        dismissed_at INTEGER NOT NULL
      );
    `);
  },
  // v13: senales de habitos de consumo (huella del input, clase de comando, tamano y error de cada resultado,
  // rama git) y eventos de sesion (compactaciones, errores de API, interrupciones, instrucciones, MCP, skills).
  // Los roles de subagente se reclasifican (tester y security) y se releen todos los transcripts para llenar
  // lo nuevo: la ingesta es idempotente.
  (db) => {
    const has = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    const actionCols: Array<[string, string]> = [
      ['input_hash', 'TEXT'],
      ['cmd_class', 'TEXT'],
      ['read_partial', 'INTEGER'],
      ['result_chars', 'INTEGER'],
      ['result_lines', 'INTEGER'],
      ['result_hash', 'TEXT'],
      ['denied', 'TEXT'],
    ];
    for (const [col, type] of actionCols) {
      if (!has('actions', col)) db.exec(`ALTER TABLE actions ADD COLUMN ${col} ${type}`);
    }
    if (!has('sessions', 'git_branch')) db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        data       TEXT
      );
      CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, ts);
      CREATE INDEX IF NOT EXISTS session_events_kind ON session_events(kind, ts);
      UPDATE agents SET role = NULL, look_type = NULL WHERE kind = 'subagent';
      DELETE FROM file_offsets;
    `);
  },
  // v14: un bloque <task-notification> con varios task-id solo cerraba al primero y el resto quedaba
  // "trabajando" para siempre (agentes fantasma). Se releen los transcripts de los leads, que es donde llegan
  // esas notificaciones, para cerrar a los que quedaron abiertos: la ingesta es idempotente.
  (db) => {
    db.prepare(
      `DELETE FROM file_offsets WHERE path_key LIKE '%.jsonl' AND instr(path_key, ?) = 0 AND instr(path_key, ?) = 0`,
    ).run('\\subagents\\', '/subagents/');
  },
  // v15: "solo lectura" en el inicio del encargo vetaba builder aunque describiera el producto y no al agente
  // (los correctores de flujo quedaban como planner). RoleStore.refreshMissing los reclasifica al arrancar.
  (db) => {
    db.exec(`UPDATE agents SET role = NULL, look_type = NULL WHERE kind = 'subagent'`);
  },
  // v16: bandeja de alertas y avisos. Lo que el usuario copio a Claude Code queda descartado hasta que salga algo
  // nuevo (habits/inbox.ts). Tabla nueva: no hay datos viejos que reparar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_alerts (
        key          TEXT PRIMARY KEY,
        level        TEXT NOT NULL,
        size         INTEGER NOT NULL DEFAULT 0,
        dismissed_at INTEGER NOT NULL
      );
    `);
  },
  // v17: Sonnet 5.5 ya tiene precio; se releen los transcripts para cotizar lo que quedo sin precio (idempotente).
  (db) => {
    db.exec(`DELETE FROM file_offsets`);
  },
  // v18: el servidor que ya corria sin el precio de Sonnet 5.5 siguio guardando costo null despues de la v17; se relee otra vez.
  (db) => {
    db.exec(`DELETE FROM file_offsets`);
  },
  // v19: Haiku 5.5 ya tiene precio (con tramo de 100K); se relee para cotizar lo que quedo sin precio. La relectura
  // ahora reescribe el costo aunque los tokens no cambien.
  (db) => {
    db.exec(`DELETE FROM file_offsets`);
  },
];

export function migrate(db: Db): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    if (!step) break;
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
