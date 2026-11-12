import { beforeAll, describe, expect, it } from 'vitest';
import { runBackfill, type AppContext } from '../src/app';
import { at, BUILDER_ID, EXPLORE_ID, loadFixture, SESSION_ID } from './helpers';

type Row = Record<string, unknown>;

let ctx: AppContext;
const get = (sql: string, ...params: unknown[]) => ctx.db.prepare(sql).get(...params) as Row | undefined;
const all = (sql: string, ...params: unknown[]) => ctx.db.prepare(sql).all(...params) as Row[];

beforeAll(async () => {
  ctx = await loadFixture();
});

describe('ingesta del CLAUDE_HOME sintetico', () => {
  it('deduplica usage por message.id tomando el maximo de cada campo', () => {
    expect(get(`SELECT COUNT(*) AS n FROM usage`)?.n).toBe(8);
    const a = get(`SELECT * FROM usage WHERE message_id = 'msg_A'`);
    expect(a).toMatchObject({
      agent_id: SESSION_ID,
      input: 10,
      output: 50,
      cache_read: 2000,
      cache_write_5m: 400,
      cache_write_1h: 600,
      ts: at('2026-01-15T10:00:12.000Z'),
      model: 'claude-opus-5-5',
    });
    expect(a?.cost_usd as number).toBeCloseTo((10 * 4 + 50 * 20 + 400 * 5 + 600 * 8 + 2000 * 0.2) / 1e6, 12);
    // sin desglose cache_creation todo va a 5m
    expect(get(`SELECT cache_write_5m, cache_write_1h FROM usage WHERE message_id = 'msg_S1'`)).toEqual({
      cache_write_5m: 500,
      cache_write_1h: 0,
    });
    expect(get(`SELECT agent_id FROM usage WHERE message_id = 'msg_S1'`)?.agent_id).toBe(EXPLORE_ID);
  });

  it('etiqueta acciones y las cierra con su tool_result', () => {
    const read = get(`SELECT * FROM actions WHERE tool_use_id = 'toolu_read1'`);
    expect(read).toMatchObject({ tool: 'Read', label: 'Leyendo app.ts', ended_at: at('2026-01-15T10:00:14.000Z'), is_error: 0 });
    expect(get(`SELECT label FROM actions WHERE tool_use_id = 'toolu_agent1'`)?.label).toBe('Delegando a Elena');
    expect(get(`SELECT label FROM actions WHERE tool_use_id = 'toolu_agent2'`)?.label).toBe('Delegando a Bruno');
    expect(String(get(`SELECT label FROM actions WHERE tool_use_id = 'toolu_grep1'`)?.label)).toMatch(/^Buscando "boton-de-prueba/);
    const bash = get(`SELECT * FROM actions WHERE tool_use_id = 'toolu_bash1'`);
    expect(bash).toMatchObject({ label: 'Corre las pruebas falsas', ended_at: null });
  });

  it('detecta prompts reales, titulo y nombre de la sesion', () => {
    const s = get(`SELECT * FROM sessions WHERE session_id = ?`, SESSION_ID);
    expect(s).toMatchObject({
      last_prompt_title: 'Segunda tarea de prueba',
      last_prompt_at: at('2026-01-15T10:10:00.000Z'),
      turn_open: 1,
      custom_title: 'Demo falsa',
      registry_name: 'Sesion demo falsa',
      project_name: 'proyecto-falso',
      cwd: 'C:\\demo\\proyecto-falso',
      cost_state_usd: 0.5,
    });
  });

  it('el fin de turno crea la tarea del lead con los tokens de su ventana', () => {
    const t = get(`SELECT * FROM tasks WHERE kind = 'lead'`);
    expect(t).toMatchObject({
      id: `${SESSION_ID}:u-p1`,
      agent_type: 'lead',
      title: 'Arregla el boton de prueba del demo',
      started_at: at('2026-01-15T10:00:10.000Z'),
      ended_at: at('2026-01-15T10:03:06.000Z'),
      input: 40,
      output: 140,
      cache_read: 12100,
      cache_write: 1000,
      unpriced_tokens: 0,
    });
    expect(all(`SELECT id FROM tasks WHERE kind = 'lead'`)).toHaveLength(1);
  });

  it('subagente async termina por task-notification', () => {
    const a = get(`SELECT * FROM agents WHERE agent_id = ?`, EXPLORE_ID);
    expect(a).toMatchObject({
      kind: 'subagent',
      agent_type: 'Explore',
      description: 'Revisar estilos falsos',
      started_at: at('2026-01-15T10:00:22.000Z'),
      ended_at: at('2026-01-15T10:03:00.000Z'),
      end_reason: 'notification',
      is_async: 1,
    });
    const t = get(`SELECT * FROM tasks WHERE id = ?`, EXPLORE_ID);
    expect(t).toMatchObject({ kind: 'subagent', title: 'Revisar estilos falsos', input: 150, output: 80, cache_read: 500, cache_write: 500 });
  });

  it('subagente sincrono termina con el tool_result de su toolUseId', () => {
    const a = get(`SELECT * FROM agents WHERE agent_id = ?`, BUILDER_ID);
    expect(a).toMatchObject({
      agent_type: 'tr-builder',
      ended_at: at('2026-01-15T10:02:00.000Z'),
      end_reason: 'tool_result',
      is_async: 0,
    });
    expect(get(`SELECT kind FROM tasks WHERE id = ?`, BUILDER_ID)?.kind).toBe('subagent');
  });

  it('re-ingerir desde cero es idempotente', async () => {
    ctx.db.prepare(`DELETE FROM file_offsets`).run();
    await runBackfill(ctx);
    expect(get(`SELECT COUNT(*) AS n FROM usage`)?.n).toBe(8);
    expect(get(`SELECT COUNT(*) AS n FROM actions`)?.n).toBe(5);
    expect(get(`SELECT COUNT(*) AS n FROM tasks`)?.n).toBe(3);
    expect(get(`SELECT output FROM usage WHERE message_id = 'msg_A'`)?.output).toBe(50);
    expect(get(`SELECT last_prompt_title, turn_open FROM sessions`)).toEqual({
      last_prompt_title: 'Segunda tarea de prueba',
      turn_open: 1,
    });
  });
});
