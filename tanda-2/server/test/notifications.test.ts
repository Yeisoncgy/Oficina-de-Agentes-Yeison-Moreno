import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/connection';
import { parseNotifications } from '../src/ingest/parser';

describe('migracion v14', () => {
  it('relee solo los transcripts de los leads para cerrar a los agentes fantasma', () => {
    const db = openDb(':memory:');
    const put = db.prepare(`INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES (?, ?, 9, 9, 9)`);
    put.run('c:\\p\\s1.jsonl', 'lead');
    put.run('c:\\p\\s1\\subagents\\agent-a.jsonl', 'subagente');
    put.run('c:\\p\\s1\\subagents\\workflows\\wf\\journal.jsonl', 'journal');
    put.run('c:\\p\\s1\\subagents\\agent-a.meta.json', 'meta');
    db.pragma('user_version = 13');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    const left = (db.prepare(`SELECT path FROM file_offsets ORDER BY path`).all() as Array<{ path: string }>).map((r) => r.path);
    // la v17 vacia los offsets para recotizar: no queda ninguno
    expect(left).toEqual([]);
  });
});

describe('migracion v15', () => {
  it('borra el rol de los subagentes para reclasificarlos y deja al lead como estaba', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO agents (agent_id, session_id, kind, agent_type, role, look_type) VALUES ('a1', 's1', 'subagent', 'workflow-subagent', 'planner', 'planner')`,
    ).run();
    db.prepare(`INSERT INTO agents (agent_id, session_id, kind, agent_type, role) VALUES ('s1', 's1', 'lead', 'lead', 'orchestrator')`).run();
    db.pragma('user_version = 14');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(db.prepare(`SELECT agent_id, role, look_type FROM agents ORDER BY agent_id`).all()).toEqual([
      { agent_id: 'a1', role: null, look_type: null },
      { agent_id: 's1', role: 'orchestrator', look_type: null },
    ]);
  });
});

describe('bloques <task-notification>', () => {
  it('un bloque con varios task-id da el mismo status a todos', () => {
    const text = [
      '<task-notification>',
      '<task-id>agente-uno</task-id>',
      '<task-id>agente-dos</task-id>',
      '<status>stopped</status>',
      '</task-notification>',
    ].join('\n');
    expect(parseNotifications(text)).toEqual([
      { taskId: 'agente-uno', status: 'stopped' },
      { taskId: 'agente-dos', status: 'stopped' },
    ]);
  });

  it('un bloque sin estado final no cierra a nadie', () => {
    const text = '<task-notification><task-id>agente-uno</task-id><status>running</status></task-notification>';
    expect(parseNotifications(text)).toEqual([]);
  });

  it('varios bloques en el mismo texto', () => {
    const text =
      '<task-notification><task-id>a</task-id><status>completed</status></task-notification>' +
      'texto entre medio' +
      '<task-notification><task-id>b</task-id><status>failed</status></task-notification>';
    expect(parseNotifications(text)).toEqual([
      { taskId: 'a', status: 'completed' },
      { taskId: 'b', status: 'failed' },
    ]);
  });

  it('un task-id citado dentro de <summary> o <result> no cierra a otro agente', () => {
    const text = [
      '<task-notification>',
      '<task-id>agente-uno</task-id>',
      '<status>completed</status>',
      '<summary>cita <task-id>agente-citado</task-id> y <status>failed</status></summary>',
      '<result>otro texto libre <task-id>agente-otro</task-id></result>',
      '</task-notification>',
    ].join('\n');
    expect(parseNotifications(text)).toEqual([{ taskId: 'agente-uno', status: 'completed' }]);
    // un <result> sin cerrar tambien es texto libre hasta el final del bloque
    const open = '<task-notification><task-id>a</task-id><status>killed</status><result>resto <task-id>b</task-id></task-notification>';
    expect(parseNotifications(open)).toEqual([{ taskId: 'a', status: 'killed' }]);
  });
});
