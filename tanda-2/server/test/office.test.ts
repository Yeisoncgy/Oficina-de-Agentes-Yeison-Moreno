import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import type { LiveAlert } from '@shared/contract';
import type { Db } from '../src/db/connection';
import type { AlertsIndex } from '../src/state/alerts';
import { assignDesks, assignNames, OfficeBuilder } from '../src/state/office';
import { BUILDER_ID, EXPLORE_ID, loadFixture, SESSION_ID, WF_SESSION_ID, WORKFLOW_HOME } from './helpers';

/** columnas de la migracion v13 (otro modulo): la prueba no depende de que ya esten */
function ensureColumn(db: Db, table: string, col: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
}

describe('assignDesks', () => {
  it('llena desde el de la derecha de la fila de adelante (6, 5, 4, 3, 2, 1) y conserva el puesto', () => {
    const first = assignDesks(new Map(), ['a', 'b', 'c', 'd']);
    expect([...first.entries()]).toEqual([
      ['a', 6],
      ['b', 5],
      ['c', 4],
      ['d', 3],
    ]);
    // sale 'a', entra 'e': los demas no se mueven, 'e' ocupa el 6 que quedo libre
    const second = assignDesks(first, ['b', 'c', 'd', 'e']);
    expect(second.get('b')).toBe(5);
    expect(second.get('c')).toBe(4);
    expect(second.get('e')).toBe(6);
  });

  it('desborde = -1 (despues de la sala y sus 3 anexos) y reintenta cuando se libera un puesto', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `a${i}`);
    const full = assignDesks(new Map(), ids);
    expect(full.get('a24')).toBe(-1);
    const after = assignDesks(full, ids.slice(1));
    expect(after.get('a24')).toBe(6);
  });
});

describe('assignNames', () => {
  it('sufijo estable para el mismo tipo', () => {
    const first = assignNames(new Map(), [
      { id: 'x1', type: 'Explore' },
      { id: 'x2', type: 'Explore' },
      { id: 'b1', type: 'tr-builder' },
    ]);
    expect(first.get('x1')?.name).toBe('Elena');
    expect(first.get('x2')?.name).toBe('Elena 2');
    expect(first.get('b1')?.name).toBe('Bruno');
    const second = assignNames(first, [
      { id: 'x2', type: 'Explore' },
      { id: 'x3', type: 'Explore' },
    ]);
    expect(second.get('x2')?.name).toBe('Elena 2');
    expect(second.get('x3')?.name).toBe('Elena');
  });
});

describe('snapshot de la oficina', () => {
  it('sala abierta con el lead trabajando y su accion actual', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    const snap = ctx.office.build();
    expect(snap.rooms).toHaveLength(1);
    const room = snap.rooms[0];
    expect(room).toMatchObject({
      id: SESSION_ID,
      projectName: 'proyecto-falso',
      title: 'Sesion demo falsa',
      open: true,
      busy: true,
      subagents: [],
    });
    expect(room?.lead).toMatchObject({
      kind: 'lead',
      agentType: 'lead',
      displayName: DEFAULT_LEAD_NAME,
      status: 'working',
      deskIndex: 0,
      model: 'claude-opus-5-5',
      // nunca el texto del prompt: lo que esta haciendo segun sus acciones
      task: { title: 'Ejecutando comandos', startedAt: '2026-01-15T10:10:00.000Z', endedAt: null },
      action: { tool: 'Bash', label: 'Corre las pruebas falsas', startedAt: '2026-01-15T10:10:05.000Z' },
    });
    // tokens del turno actual: solo msg_E
    expect(room?.lead.tokens).toEqual({ input: 3, output: 25, cacheRead: 5000, cacheWrite: 0, total: 5028 });
    expect(room?.tokens.total).toBeGreaterThan(room?.lead.tokens.total ?? 0);
    expect(room?.costUsd).not.toBeNull();
    expect(snap.leadRoomId).toBe(SESSION_ID);
    expect(snap.today.tokens.total).toBeGreaterThan(0);
  });

  it('subagentes terminados hace <= 30 s siguen visibles como done con puesto estable', async () => {
    const ctx = await loadFixture('2026-01-15T10:02:20.000Z');
    const subs = ctx.office.build().rooms[0]?.subagents ?? [];
    expect(subs.map((s) => [s.id, s.displayName, s.status, s.deskIndex, s.action])).toEqual([
      [EXPLORE_ID, 'Elena', 'done', 6, null],
      [BUILDER_ID, 'Bruno', 'done', 5, null],
    ]);
    expect(subs[0]?.task).toEqual({
      title: 'Revisar estilos falsos',
      startedAt: '2026-01-15T10:00:22.000Z',
      endedAt: '2026-01-15T10:03:00.000Z',
    });
    expect(subs[0]?.tokens.total).toBe(150 + 80 + 500 + 500);
  });
});

describe('snapshot: rol, lugar e identidad', () => {
  it('lead: orquestador en el laboratorio (su Bash del turno sigue abierto), sin padre y con 2 subagentes', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    const snap = ctx.office.build();
    const room = snap.rooms[0];
    expect(room?.lead).toMatchObject({
      role: 'orchestrator',
      place: 'lab',
      alert: null,
      startedAt: '2026-01-15T10:00:00.000Z',
      lastActivityAt: '2026-01-15T10:10:30.000Z',
      parentId: null,
      childCount: 2,
    });
    // sin motor de habitos: nada encendido
    expect(room).toMatchObject({ alert: null, habitCount: 0 });
    expect(snap.habits).toEqual({ active: 0, alerts: 0, savingsUsd: 0, notifyBrowser: false });
  });

  it('subagentes: rol de su tipo, lanzados por el lead y saliendo desde su escritorio', async () => {
    const ctx = await loadFixture('2026-01-15T10:02:20.000Z');
    const subs = ctx.office.build().rooms[0]?.subagents ?? [];
    expect(subs.map((s) => [s.id, s.role, s.place, s.parentId, s.childCount, s.startedAt, s.lastActivityAt])).toEqual([
      [EXPLORE_ID, 'explorer', 'desk', SESSION_ID, 0, '2026-01-15T10:00:22.000Z', '2026-01-15T10:02:50.000Z'],
      [BUILDER_ID, 'builder', 'desk', SESSION_ID, 0, '2026-01-15T10:00:26.000Z', '2026-01-15T10:01:50.000Z'],
    ]);
  });

  it('flujo: lugar por la ultima herramienta, padre = la sesion; el lead que lanzo el Workflow esta en la reunion', async () => {
    const ctx = await loadFixture('2026-03-10T15:10:00.000Z', WORKFLOW_HOME);
    const room = ctx.office.build().rooms[0];
    expect(room?.lead).toMatchObject({ role: 'orchestrator', status: 'working', place: 'meeting', childCount: 0 });
    expect(room?.subagents.map((s) => [s.displayName, s.role, s.place, s.parentId, s.workflow?.role])).toEqual([
      ['Bruno', 'builder', 'library', WF_SESSION_ID, 'builder'],
      ['Iris', 'builder', 'desk', WF_SESSION_ID, 'builder'],
    ]);
  });

  it('rama git de la sesion: "HEAD" (sin git) = null', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    ensureColumn(ctx.db, 'sessions', 'git_branch');
    const setBranch = ctx.db.prepare(`UPDATE sessions SET git_branch = ? WHERE session_id = ?`);
    const office = new OfficeBuilder(ctx.db, ctx.registry, ctx.now);
    setBranch.run('feature/zonas', SESSION_ID);
    expect(office.build().rooms[0]?.gitBranch).toBe('feature/zonas');
    setBranch.run('HEAD', SESSION_ID);
    expect(office.build().rooms[0]?.gitBranch).toBeNull();
  });

  it('alertas y conteos vienen del proveedor inyectado', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    const agentAlert: LiveAlert = { level: 'critical', title: 'Costo $3,40 > $2,00', source: 'rule', ruleId: 'agent_cost' };
    const roomAlert: LiveAlert = { level: 'warning', title: '31 turnos sin compactar', source: 'rule', ruleId: 'turns_without_compact' };
    const index: AlertsIndex = {
      agent: (id) => (id === SESSION_ID ? agentAlert : null),
      room: (id) => (id === SESSION_ID ? roomAlert : null),
      habitCount: (id) => (id === SESSION_ID ? 3 : 0),
      summary: () => ({ active: 3, alerts: 2, savingsUsd: 1.25, notifyBrowser: true }),
    };
    ctx.office.setAlertsProvider({ current: () => index });
    const snap = ctx.office.build();
    expect(snap.rooms[0]?.lead.alert).toEqual(agentAlert);
    expect(snap.rooms[0]).toMatchObject({ alert: roomAlert, habitCount: 3 });
    expect(snap.habits).toEqual({ active: 3, alerts: 2, savingsUsd: 1.25, notifyBrowser: true });
  });

  it('un general-purpose que corre sobre todo tests sube a Pruebas y camina al laboratorio', async () => {
    const ctx = await loadFixture('2026-01-15T10:11:00.000Z');
    ensureColumn(ctx.db, 'actions', 'cmd_class');
    const t0 = Date.parse('2026-01-15T10:10:40.000Z');
    const id = 'agenerico00000001';
    ctx.db
      .prepare(
        `INSERT INTO agents (agent_id, session_id, kind, agent_type, description, tool_use_id, started_at, last_activity_at)
         VALUES (?, ?, 'subagent', 'general-purpose', 'tarea falsa', 'toolu_gen', ?, ?)`,
      )
      .run(id, SESSION_ID, t0, t0 + 4000);
    // lo lanzo el explorador, no el lead
    ctx.db
      .prepare(
        `INSERT INTO launches (tool_use_id, session_id, parent_agent_id, subagent_type, description, started_at)
         VALUES ('toolu_gen', ?, ?, 'general-purpose', 'tarea falsa', ?)`,
      )
      .run(SESSION_ID, EXPLORE_ID, t0);
    const shell = ctx.db.prepare(
      `INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, ended_at, cmd_class)
       VALUES (?, ?, ?, 'Bash', 'x', ?, ?, ?)`,
    );
    const office = new OfficeBuilder(ctx.db, ctx.registry, ctx.now);
    shell.run('toolu_g1', id, SESSION_ID, t0 + 1000, t0 + 1500, 'test');
    shell.run('toolu_g2', id, SESSION_ID, t0 + 2000, t0 + 2500, 'build');
    const early = office.build().rooms[0]?.subagents.find((s) => s.id === id);
    expect(early).toMatchObject({ role: 'generalist', agentType: 'general-purpose', place: 'lab', parentId: EXPLORE_ID });

    shell.run('toolu_g3', id, SESSION_ID, t0 + 3000, t0 + 3500, 'test');
    shell.run('toolu_g4', id, SESSION_ID, t0 + 4000, null, 'git_read');
    const sub = office.build().rooms[0]?.subagents.find((s) => s.id === id);
    // el lugar de su rol gana a su ultima herramienta (git de lectura = biblioteca)
    expect(sub).toMatchObject({ role: 'tester', agentType: 'tester', place: 'lab', persona: early?.persona });
    expect(ctx.db.prepare(`SELECT role, look_type FROM agents WHERE agent_id = ?`).get(id)).toEqual({
      role: 'tester',
      look_type: 'tester',
    });
  });
});
