import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptResponse, WorkflowRun } from '@shared/contract';
import { buildApp, createContext, runBackfill, type AppContext } from '../src/app';
import { migrate, openDb } from '../src/db/connection';
import { classifyPath } from '../src/ingest/paths';
import { discoverTargets, sessionTargets } from '../src/ingest/scanner';
import { makeIgnored } from '../src/ingest/watcher';
import { parseWorkflowMeta } from '../src/ingest/workflowMeta';
import { parseWorkflowLaunch } from '../src/ingest/workflows';
import { at, line, loadFixture, TempHome, WF_PROJECT, WF_SESSION_ID, WORKFLOW_HOME } from './helpers';

type Row = Record<string, unknown>;

const EXPLORA = 'afexplora0000001';
const MUNDO = 'afmundo000000001';
const PERSO_1 = 'afperso000000001';
const PERSO_2 = 'afperso000000002';
const PRUEBA = 'afprueba00000001';
const HUD = 'afhud00000000001';

const sessionDir = path.join(WORKFLOW_HOME, 'projects', WF_PROJECT, WF_SESSION_ID);
const runDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_falso');
const scriptsDir = path.join(sessionDir, 'workflows', 'scripts');

describe('parseWorkflowMeta (sin evaluar el script)', () => {
  it('comillas simples/dobles, template literals y phases con detail/model', () => {
    const src = [
      `import x from 'y';`,
      `export const meta = {`,
      `  name: 'mi-flujo',`,
      `  description: "Dice \\"hola\\" y usa { llaves } en el texto",`,
      `  // comentario con una llave suelta: {`,
      `  /* otro } comentario */`,
      `  phases: [`,
      `    { title: 'Uno', detail: 'con, comas', model: 'opus' },`,
      '    { detail: `plantilla ${x}`, title: "Dos" },',
      '    { title: `Tres`, model: "haiku" },',
      `    { title: 'Cuatro' + otra },`,
      `  ],`,
      `  extra: { anidado: [1, 2, { title: 'no es fase' }] },`,
      `};`,
      `export default async function run() {}`,
    ].join('\n');
    expect(parseWorkflowMeta(src)).toEqual({
      name: 'mi-flujo',
      description: 'Dice "hola" y usa { llaves } en el texto',
      phases: ['Uno', 'Dos', 'Tres'],
    });
  });

  it('template con interpolacion no se inventa; sin phases = null', () => {
    const src = 'export const meta = { name: `flujo-${id}`, "description": `sin interpolar`, };';
    expect(parseWorkflowMeta(src)).toEqual({ name: null, description: 'sin interpolar', phases: null });
  });

  it('sin meta o con llaves sin cerrar devuelve null', () => {
    expect(parseWorkflowMeta('export default async function run() {}')).toBeNull();
    expect(parseWorkflowMeta("export const meta = { name: 'roto', phases: [ { title: 'x' ")).toBeNull();
    expect(parseWorkflowMeta("export const meta = { name: 'roto }")).toBeNull();
  });
});

describe('parseWorkflowLaunch', () => {
  it('usa toolUseResult y, si falta, el texto "Task ID / Run ID"', () => {
    expect(parseWorkflowLaunch({ runId: 'wf_a', taskId: 'wt1', workflowName: 'x', scriptPath: 'C:\\s.js' }, '')).toEqual({
      runId: 'wf_a',
      taskId: 'wt1',
      name: 'x',
      scriptPath: 'C:\\s.js',
    });
    expect(parseWorkflowLaunch(null, 'Workflow launched.\nTask ID: wt2\nRun ID: wf_b')).toEqual({
      runId: 'wf_b',
      taskId: 'wt2',
      name: null,
      scriptPath: null,
    });
    expect(parseWorkflowLaunch({ status: 'async_launched' }, 'sin ids')).toBeNull();
  });
});

describe('descubrimiento de archivos de Workflow', () => {
  it('clasifica agentes, journal y estado final; workflows/scripts no genera targets', () => {
    expect(classifyPath(WORKFLOW_HOME, path.join(runDir, `agent-${MUNDO}.jsonl`))).toMatchObject({
      kind: 'subagent',
      agentId: MUNDO,
      runId: 'wf_falso',
      sessionId: WF_SESSION_ID,
    });
    expect(classifyPath(WORKFLOW_HOME, path.join(runDir, `agent-${MUNDO}.meta.json`))).toMatchObject({ kind: 'meta', runId: 'wf_falso' });
    expect(classifyPath(WORKFLOW_HOME, path.join(runDir, 'journal.jsonl'))).toMatchObject({ kind: 'journal', runId: 'wf_falso' });
    expect(classifyPath(WORKFLOW_HOME, path.join(sessionDir, 'workflows', 'wf_falso.json'))).toMatchObject({
      kind: 'wfstate',
      runId: 'wf_falso',
    });
    expect(classifyPath(WORKFLOW_HOME, path.join(scriptsDir, 'agent-ascript000000001.jsonl'))).toBeNull();
    expect(classifyPath(WORKFLOW_HOME, path.join(scriptsDir, 'flujo-falso-wf_falso.js'))).toBeNull();
  });

  it('el watcher recorre subagents/workflows/<runId> e ignora workflows/scripts', () => {
    const ignored = makeIgnored(WORKFLOW_HOME);
    expect(ignored(runDir)).toBe(false);
    expect(ignored(path.join(runDir, 'journal.jsonl'))).toBe(false);
    expect(ignored(path.join(runDir, `agent-${HUD}.jsonl`))).toBe(false);
    expect(ignored(path.join(sessionDir, 'workflows'))).toBe(false);
    expect(ignored(path.join(sessionDir, 'workflows', 'wf_falso.json'))).toBe(false);
    expect(ignored(scriptsDir)).toBe(true);
    expect(ignored(path.join(scriptsDir, 'agent-ascript000000001.jsonl'))).toBe(true);
    expect(ignored(path.join(sessionDir, 'tool-results'))).toBe(true);
    expect(ignored(path.join(runDir, 'notas.txt'))).toBe(true);
  });

  it('el backfill incluye journal y agentes de la corrida y nada de scripts/', async () => {
    const targets = await discoverTargets(WORKFLOW_HOME);
    const kinds = targets.map((t) => t.kind);
    expect(kinds.filter((k) => k === 'journal')).toHaveLength(1);
    expect(targets.filter((t) => t.kind === 'subagent' && t.runId === 'wf_falso')).toHaveLength(6);
    expect(targets.filter((t) => t.kind === 'meta' && t.runId === 'wf_falso')).toHaveLength(6);
    expect(targets.some((t) => t.path.includes(`${path.sep}scripts${path.sep}`))).toBe(false);
  });
});

describe('corrida sintetica wf_falso', () => {
  let ctx: AppContext;
  const get = (sql: string, ...params: unknown[]) => ctx.db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: unknown[]) => ctx.db.prepare(sql).all(...params) as Row[];

  beforeAll(async () => {
    ctx = await loadFixture('2026-03-10T15:10:00.000Z', WORKFLOW_HOME);
  });

  it('crea los agentes con su tipo y el titulo "<fase> · <descripcion>"', () => {
    const rows = all(`SELECT agent_id, agent_type, description FROM agents WHERE kind = 'subagent' ORDER BY started_at, agent_id`);
    expect(rows).toEqual([
      { agent_id: EXPLORA, agent_type: 'Explore', description: 'Exploracion · mapa' },
      { agent_id: MUNDO, agent_type: 'workflow-subagent', description: 'Construccion · mundo' },
      { agent_id: PERSO_1, agent_type: 'workflow-subagent', description: 'Construccion · personajes' },
      { agent_id: PERSO_2, agent_type: 'workflow-subagent', description: 'Construccion · personajes' },
      { agent_id: PRUEBA, agent_type: 'workflow-subagent', description: 'Pruebas · pruebas' },
      { agent_id: HUD, agent_type: 'workflow-subagent', description: 'Construccion · hud' },
    ]);
    // el senuelo de workflows/scripts no genero nada
    expect(get(`SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'ascript000000001'`)?.n).toBe(0);
    expect(get(`SELECT COUNT(*) AS n FROM usage WHERE message_id = 'msg_SCRIPT'`)?.n).toBe(0);
  });

  it('fin por journal: result (con agentId o solo key), failed y reintento', () => {
    const end = (id: string) => get(`SELECT ended_at, end_reason FROM agents WHERE agent_id = ?`, id);
    expect(end(EXPLORA)).toEqual({ ended_at: at('2026-03-10T15:01:00.000Z'), end_reason: 'journal' });
    expect(end(MUNDO)).toEqual({ ended_at: at('2026-03-10T15:03:00.000Z'), end_reason: 'journal' });
    expect(end(PERSO_1)).toEqual({ ended_at: at('2026-03-10T15:02:00.000Z'), end_reason: 'journal' });
    expect(end(PRUEBA)).toEqual({ ended_at: at('2026-03-10T15:05:00.000Z'), end_reason: 'journal' });
    expect(end(PERSO_2)).toEqual({ ended_at: null, end_reason: null });
    expect(end(HUD)).toEqual({ ended_at: null, end_reason: null });
    const wf = all(`SELECT agent_id, key, end_status FROM workflow_agents ORDER BY seq`);
    expect(wf.map((r) => [r.agent_id, r.end_status])).toEqual([
      [EXPLORA, 'result'],
      [MUNDO, 'result'],
      [PERSO_1, 'failed'],
      [PERSO_2, null],
      [PRUEBA, 'failed'],
      [HUD, null],
    ]);
  });

  it('enlaza la corrida con su Task ID y lee el meta del script', () => {
    expect(get(`SELECT task_id, tool_name, meta_name, meta_description, meta_phases, launched_at FROM workflow_runs`)).toEqual({
      task_id: 'wtfalso01',
      tool_name: 'nombre-del-tool',
      meta_name: 'flujo-falso',
      meta_description: 'Construye un mundo "falso" { con llaves }',
      meta_phases: JSON.stringify(['Exploracion', 'Construccion', 'Pruebas', 'Cierre']),
      launched_at: at('2026-03-10T14:59:31.000Z'),
    });
  });

  it('snapshot: cada agente de flujo es una persona distinta con el personaje de su rol', () => {
    const room = ctx.office.build().rooms[0];
    const subs = room?.subagents ?? [];
    // dos constructores: el primero es Bruno; el segundo, otra persona del equipo (nunca "Bruno 2")
    expect(subs.map((s) => [s.id, s.displayName, s.persona, s.status, s.agentType])).toEqual([
      [PERSO_2, 'Bruno', 'bruno', 'working', 'tr-builder'],
      [HUD, 'Iris', 'iris', 'working', 'tr-builder'],
    ]);
    expect(new Set(subs.map((s) => s.persona)).size).toBe(subs.length);
    expect(subs[0]).toMatchObject({
      task: { detail: 'Construccion · personajes', startedAt: '2026-03-10T15:02:10.000Z', endedAt: null },
      action: { tool: 'Read', label: 'Leyendo personajes.ts' },
      workflow: { runId: 'wf_falso', name: 'flujo-falso', phase: 'Construccion', label: 'personajes' },
    });
    // la tarea dice lo que hace segun sus acciones, no la etiqueta del script
    expect(subs[0]?.task?.title).toBe('Construyendo · personajes.ts');
    expect(subs[1]?.workflow).toEqual({
      runId: 'wf_falso',
      name: 'flujo-falso',
      phase: 'Construccion',
      label: 'hud',
      sourceType: 'workflow-subagent',
      role: 'builder',
    });
  });

  it('snapshot: corrida en curso con fases pending/running/done/failed y tokens de sus agentes', () => {
    const runs = ctx.office.build().rooms[0]?.workflows ?? [];
    expect(runs).toHaveLength(1);
    const run = runs[0] as WorkflowRun;
    expect(run).toMatchObject({
      runId: 'wf_falso',
      name: 'flujo-falso',
      description: 'Construye un mundo "falso" { con llaves }',
      status: 'running',
      startedAt: '2026-03-10T14:59:31.000Z',
      endedAt: null,
    });
    expect(run.phases).toEqual([
      { title: 'Exploracion', status: 'done', agentsStarted: 1, agentsDone: 1 },
      { title: 'Construccion', status: 'running', agentsStarted: 4, agentsDone: 2 },
      { title: 'Pruebas', status: 'failed', agentsStarted: 1, agentsDone: 1 },
      { title: 'Cierre', status: 'pending', agentsStarted: 0, agentsDone: 0 },
    ]);
    // dentro de la corrida nadie se repite; los que estan en la oficina conservan su persona. Tomas queda
    // reservado para el rol de pruebas, asi que el pool general empieza en Lucia
    expect(run.agents.map((a) => [a.agentId, a.label, a.phase, a.status, a.displayName, a.role])).toEqual([
      [EXPLORA, 'mapa', 'Exploracion', 'done', 'Elena', 'explorer'],
      [MUNDO, 'mundo', 'Construccion', 'done', 'Lucía', 'builder'],
      [PERSO_1, 'personajes', 'Construccion', 'failed', 'Nico', 'builder'],
      [PERSO_2, 'personajes', 'Construccion', 'working', 'Bruno', 'builder'],
      [PRUEBA, 'pruebas', 'Pruebas', 'failed', 'Tomás', 'tester'],
      [HUD, 'hud', 'Construccion', 'working', 'Iris', 'builder'],
    ]);
    expect(new Set(run.agents.map((a) => a.persona)).size).toBe(run.agents.length);
    expect(run.agents[1]).toMatchObject({ model: 'claude-opus-5-5', endedAt: '2026-03-10T15:03:00.000Z' });
    expect(run.tokens).toEqual({ input: 121, output: 81, cacheRead: 1000, cacheWrite: 0, total: 1202 });
    expect(run.costUsd).not.toBeNull();
  });

  it('un agente con failed termina igual: status done en la oficina', async () => {
    const early = await loadFixture('2026-03-10T15:02:20.000Z', WORKFLOW_HOME);
    const room = early.office.build().rooms[0];
    const perso1 = room?.subagents.find((s) => s.id === PERSO_1);
    expect(perso1).toMatchObject({ status: 'done', action: null, task: { endedAt: '2026-03-10T15:02:00.000Z' } });
    expect(room?.workflows?.[0]?.agents.find((a) => a.agentId === PERSO_1)?.status).toBe('failed');
    early.db.close();
  });

  it('historial, ranking y transcript funcionan igual que para un subagente normal', async () => {
    const tasks = all(`SELECT id, agent_type, title, output FROM tasks WHERE kind = 'subagent' ORDER BY ended_at`);
    // el historial guarda el tipo del rol y la tarea real (sin archivos todavia: verbo + etiqueta)
    expect(tasks).toEqual([
      { id: EXPLORA, agent_type: 'Explore', title: 'Explorando · mapa', output: 20 },
      { id: PERSO_1, agent_type: 'tr-builder', title: 'Construyendo · personajes', output: 1 },
      { id: MUNDO, agent_type: 'tr-builder', title: 'Construyendo · mundo', output: 50 },
      { id: PRUEBA, agent_type: 'tester', title: 'Probando · pruebas', output: 2 },
    ]);
    const app = buildApp(ctx);
    const ranking = (await app.inject({ method: 'GET', url: '/api/history/ranking?range=all' })).json() as {
      byAgent: Array<{ key: string; label: string; tasks: number }>;
    };
    expect(ranking.byAgent.find((r) => r.key === 'workflow-subagent')).toBeUndefined();
    expect(ranking.byAgent.find((r) => r.key === 'tr-builder')).toMatchObject({ label: 'Bruno', tasks: 2 });
    const res = await app.inject({ method: 'GET', url: `/api/agents/${PERSO_2}/transcript` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as TranscriptResponse).entries.map((e) => e.kind)).toEqual(['prompt', 'tool_use']);
    await app.close();
  });

  it('migracion v3: releer subagents/workflows/ desde cero es idempotente', async () => {
    const snapshot = () => ({
      wf: all(`SELECT agent_id, run_id, key, label, phase, seq, end_status FROM workflow_agents ORDER BY agent_id`),
      agents: all(`SELECT agent_id, agent_type, description, started_at, ended_at, end_reason FROM agents ORDER BY agent_id`),
      tasks: all(`SELECT id, title, started_at, ended_at, input, output FROM tasks ORDER BY id`),
      usage: get(`SELECT COUNT(*) AS n, SUM(output) AS output FROM usage`),
    });
    const before = snapshot();
    ctx.db.pragma('user_version = 2');
    migrate(ctx.db);
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(20);
    expect(get(`SELECT COUNT(*) AS n FROM file_offsets WHERE path_key LIKE '%journal.jsonl'`)?.n).toBe(0);
    await runBackfill(ctx);
    expect(snapshot()).toEqual(before);
  });
});

describe('migracion v4', () => {
  it('borra agentes sin id y los offsets de <sesion>/workflows/<runId>.json', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO agents (agent_id, session_id, kind, agent_type) VALUES (NULL, 's1', 'subagent', 'general-purpose')`).run();
    db.prepare(`INSERT INTO agents (agent_id, session_id, kind, agent_type) VALUES ('a1', 's1', 'subagent', 'Explore')`).run();
    const offset = db.prepare(`INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES (?, ?, 1, 1, 1)`);
    offset.run('c:\\p\\s1\\workflows\\wf_x.json', 'C:\\p\\s1\\workflows\\wf_x.json');
    offset.run('/p/s1/workflows/wf_y.json', '/p/s1/workflows/wf_y.json');
    offset.run('c:\\p\\s1.jsonl', 'C:\\p\\s1.jsonl');
    db.pragma('user_version = 3');
    migrate(db);
    expect(db.prepare(`SELECT agent_id FROM agents`).all()).toEqual([{ agent_id: 'a1' }]);
    // v6 relee todos los transcripts: tampoco quedan offsets de otros archivos
    expect(db.prepare(`SELECT path_key FROM file_offsets`).all()).toEqual([]);
    db.close();
  });
});

// ---- escenarios que escriben archivos (CLAUDE_HOME temporal fuera del arbol) ----

const SID = '44444444-5555-4666-8777-888888888888';
const PROJECT = 'C--demo-flujo-temporal';
const LEAD_REL = `projects/${PROJECT}/${SID}.jsonl`;
const base = { sessionId: SID, cwd: 'C:\\demo\\flujo-temporal' };
const iso = (ms: number) => new Date(ms).toISOString();
const runRel = (runId: string) => `projects/${PROJECT}/${SID}/subagents/workflows/${runId}`;

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

function writeAgent(h: TempHome, runId: string, agentId: string, phase: string, startMs: number, endMs: number, open: boolean): void {
  h.write(
    `${runRel(runId)}/agent-${agentId}.meta.json`,
    JSON.stringify({ agentType: 'workflow-subagent', description: agentId.slice(0, 6), workflowPhase: phase, spawnDepth: 1 }),
  );
  const common = { ...base, isSidechain: true, agentId };
  h.write(
    `${runRel(runId)}/agent-${agentId}.jsonl`,
    line({ ...common, type: 'user', uuid: `${agentId}-u`, timestamp: iso(startMs), message: { role: 'user', content: 'tarea falsa' } }) +
      line({
        ...common,
        type: 'assistant',
        uuid: `${agentId}-a`,
        timestamp: iso(endMs),
        message: {
          id: `msg_${agentId}`,
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: open
            ? [{ type: 'tool_use', id: `toolu_${agentId}`, name: 'Read', input: { file_path: 'C:\\demo\\falso.ts' } }]
            : [{ type: 'text', text: 'fin falso' }],
          stop_reason: open ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
  );
}

function context(h: TempHome, clock: () => number): AppContext {
  return createContext({ db: openDb(':memory:'), claudeHome: h.root, now: clock, log: () => {} });
}

function runOf(ctx: AppContext, runId: string): WorkflowRun | undefined {
  return ctx.office.build().rooms.find((r) => r.id === SID)?.workflows?.find((w) => w.runId === runId);
}

async function reingest(ctx: AppContext, h: TempHome, rel: string): Promise<void> {
  const target = classifyPath(h.root, h.path(rel));
  if (target) ctx.queue.enqueue(target);
  await ctx.queue.idle();
}

describe('corridas en vivo', () => {
  it('enlaza Task ID/Run ID por el texto del tool_result y termina con su task-notification', async () => {
    home = new TempHome();
    const real = Date.now();
    home.write(
      LEAD_REL,
      line({ ...base, type: 'user', uuid: 'p1', timestamp: iso(real - 120_000), message: { role: 'user', content: 'Lanza un flujo temporal' } }) +
        line({
          ...base,
          type: 'assistant',
          uuid: 'a1',
          timestamp: iso(real - 110_000),
          message: {
            id: 'msg_L1',
            model: 'claude-opus-5-5',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_wt', name: 'Workflow', input: { script: 'export const meta = {}' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }) +
        line({
          ...base,
          type: 'user',
          uuid: 'u2',
          timestamp: iso(real - 109_000),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_wt', content: [{ type: 'text', text: 'Workflow launched.\nTask ID: wtemp0001\nRun ID: wf_temp' }] }],
          },
        }),
    );
    home.write(
      `${runRel('wf_temp')}/journal.jsonl`,
      line({ type: 'launched' }) + line({ type: 'started', key: 'k1', agentId: 'atemp00000000001', label: 'uno', phase: 'Fase A' }),
    );
    writeAgent(home, 'wf_temp', 'atemp00000000001', 'Fase A', real - 100_000, real - 90_000, true);

    const ctx = context(home, () => real + 10_000);
    await runBackfill(ctx);
    expect(ctx.db.prepare(`SELECT task_id FROM workflow_runs WHERE run_id = 'wf_temp'`).get()).toEqual({ task_id: 'wtemp0001' });
    expect(runOf(ctx, 'wf_temp')).toMatchObject({ status: 'running', endedAt: null, name: 'wf_temp' });
    // quitar de la lista un flujo en curso no lo oculta: solo salen los que ya no corren
    ctx.roomNotes.dismissRun('wf_temp', real);
    expect(runOf(ctx, 'wf_temp')?.status).toBe('running');
    ctx.db.exec(`DELETE FROM dismissed_runs`);

    const notifAt = real - 5_000;
    home.append(
      LEAD_REL,
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: iso(notifAt),
        sessionId: SID,
        content:
          '<task-notification>\n<task-id>wtemp0001</task-id>\n<tool-use-id>toolu_wt</tool-use-id>\n<status>completed</status>\n<summary>listo</summary>\n</task-notification>',
      }),
    );
    await reingest(ctx, home, LEAD_REL);
    expect(runOf(ctx, 'wf_temp')).toMatchObject({ status: 'done', endedAt: iso(notifAt) });
    expect(ctx.db.prepare(`SELECT ended_at, end_reason FROM agents WHERE agent_id = 'atemp00000000001'`).get()).toEqual({
      ended_at: real - 90_000,
      end_reason: 'workflow',
    });
    expect(runOf(ctx, 'wf_temp')?.agents.map((a) => a.status)).toEqual(['done']);
    // terminado y quitado de la lista: sale de la sala de control, pero su costo sigue en el historial
    ctx.roomNotes.dismissRun('wf_temp', real);
    expect(runOf(ctx, 'wf_temp')).toBeUndefined();
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'atemp00000000001'`).get()).toEqual({ n: 1 });
    ctx.db.close();
  });

  it('respaldo por inactividad del journal, fin por journal en vivo y script ilegible', async () => {
    home = new TempHome();
    const real = Date.now();
    home.write(`projects/${PROJECT}/${SID}/workflows/scripts/roto-wf_quieto.js`, "export const meta = { name: 'roto', phases: [ { title: 'x' ");
    home.write(
      `${runRel('wf_quieto')}/journal.jsonl`,
      line({ type: 'launched' }) +
        line({ type: 'started', key: 'k1', agentId: 'aquieto000000001', label: 'uno', phase: 'Unica' }) +
        line({ type: 'started', key: 'k2', agentId: 'aquieto000000002', label: 'dos', phase: 'Unica' }),
    );
    writeAgent(home, 'wf_quieto', 'aquieto000000001', 'Unica', real - 60_000, real - 50_000, true);
    writeAgent(home, 'wf_quieto', 'aquieto000000002', 'Unica', real - 60_000, real - 40_000, false);
    home.write(
      `${runRel('wf_fallido')}/journal.jsonl`,
      line({ type: 'started', key: 'k1', agentId: 'afallido00000001', label: 'uno', phase: 'Rota' }) +
        line({ type: 'failed', key: 'k1', agentId: 'afallido00000001' }),
    );
    writeAgent(home, 'wf_fallido', 'afallido00000001', 'Rota', real - 60_000, real - 55_000, false);

    let now = real + 30_000;
    const ctx = context(home, () => now);
    await runBackfill(ctx);
    expect(runOf(ctx, 'wf_quieto')).toMatchObject({ status: 'running', name: 'wf_quieto', description: '' });

    home.append(
      `${runRel('wf_quieto')}/journal.jsonl`,
      line({ type: 'result', key: 'k1', agentId: 'aquieto000000001', result: { ok: true } }) +
        line({ type: 'failed', key: 'k2', agentId: 'aquieto000000002' }),
    );
    await reingest(ctx, home, `${runRel('wf_quieto')}/journal.jsonl`);
    const ends = ctx.db.prepare(`SELECT agent_id, ended_at, end_reason FROM agents WHERE agent_id LIKE 'aquieto%' ORDER BY agent_id`).all();
    expect(ends).toEqual([
      { agent_id: 'aquieto000000001', ended_at: real - 50_000, end_reason: 'journal' },
      { agent_id: 'aquieto000000002', ended_at: real - 40_000, end_reason: 'journal' },
    ]);
    // journal recien modificado: sigue en curso aunque no queden agentes trabajando
    expect(runOf(ctx, 'wf_quieto')?.status).toBe('running');

    now = real + 3 * 60_000;
    expect(runOf(ctx, 'wf_quieto')).toMatchObject({
      status: 'done',
      endedAt: iso(real - 40_000),
      phases: [{ title: 'Unica', status: 'done', agentsStarted: 2, agentsDone: 2 }],
    });
    expect(runOf(ctx, 'wf_fallido')).toMatchObject({
      status: 'failed',
      phases: [{ title: 'Rota', status: 'failed', agentsStarted: 1, agentsDone: 1 }],
    });
    expect(ctx.db.prepare(`SELECT meta_name, meta_phases FROM workflow_runs WHERE run_id = 'wf_quieto'`).get()).toEqual({
      meta_name: null,
      meta_phases: null,
    });
    ctx.db.close();
  });

  it('estado final <runId>.json: killed = stopped, nombre y fases desde su script', async () => {
    home = new TempHome();
    const real = Date.now();
    home.write(`${runRel('wf_final')}/journal.jsonl`, line({ type: 'started', key: 'k1', agentId: 'afinal0000000001', label: 'uno', phase: 'Uno' }));
    writeAgent(home, 'wf_final', 'afinal0000000001', 'Uno', real - 40_000, real - 20_000, true);
    home.write(
      `projects/${PROJECT}/${SID}/workflows/wf_final.json`,
      JSON.stringify({
        runId: 'wf_final',
        taskId: 'wfinal01',
        workflowName: 'nombre-del-tool',
        status: 'killed',
        startTime: real - 60_000,
        durationMs: 50_000,
        timestamp: iso(real - 10_000),
        phases: [{ title: 'Uno', detail: 'x' }, { title: 'Dos', model: 'opus' }],
        script: "export const meta = { name: 'final-falso', description: `desde el estado`, phases: [{ title: 'Uno' }, { title: 'Dos' }] };",
        logs: [],
        result: null,
      }),
    );

    const ctx = context(home, () => real + 5_000);
    await runBackfill(ctx);
    expect(runOf(ctx, 'wf_final')).toMatchObject({
      status: 'stopped',
      name: 'final-falso',
      description: 'desde el estado',
      startedAt: iso(real - 60_000),
      endedAt: iso(real - 10_000),
      phases: [
        { title: 'Uno', status: 'done', agentsStarted: 1, agentsDone: 1 },
        { title: 'Dos', status: 'pending', agentsStarted: 0, agentsDone: 0 },
      ],
    });
    expect(ctx.db.prepare(`SELECT ended_at, end_reason FROM agents WHERE agent_id = 'afinal0000000001'`).get()).toEqual({
      ended_at: real - 20_000,
      end_reason: 'workflow',
    });
    // el sondeo de sesiones abiertas no relee los agentes de una corrida terminada
    const polled = await sessionTargets(home.root, home.path('projects', PROJECT), SID, { skipFinishedWorkflows: true });
    expect(polled.map((t) => t.kind)).toEqual(['wfstate']);
    ctx.db.close();
  });
});
