import { describe, expect, it } from 'vitest';
import { agentBaseName } from '@shared/agents';
import { assignPersonas, LEAD_PERSONA, PERSONAS, personaById, personaName } from '@shared/personas';
import { openDb, type Db } from '../src/db/connection';
import { RoleStore } from '../src/ingest/roleStore';
import { classifyWorkflowRole, isTesterByCommands, type RoleInput } from '../src/ingest/roles';
import { describeWork, type TargetCount } from '../src/state/taskTitle';

const t = (tool: string, target: string, n = 1, last = 0): TargetCount => ({ tool, target, n, last });

describe('personas unicas', () => {
  it('diez constructores visibles son diez personas distintas; el primero es Bruno', () => {
    const visible = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, type: 'tr-builder' }));
    const map = assignPersonas(new Map(), visible);
    const ids = visible.map((v) => map.get(v.id));
    expect(new Set(ids).size).toBe(10);
    expect(ids[0]).toBe('bruno');
    expect(ids).not.toContain(LEAD_PERSONA);
    expect(ids.map((id) => personaName(id ?? '')).some((n) => /\d/.test(n))).toBe(false);
  });

  it('los personajes con rol propio quedan para su rol aunque lleguen despues', () => {
    const first = assignPersonas(new Map(), [
      { id: 'b1', type: 'tr-builder' },
      { id: 'b2', type: 'tr-builder' },
    ]);
    expect(first.get('b2')).not.toBe('elena');
    const second = assignPersonas(first, [...first.keys()].map((id) => ({ id, type: 'tr-builder' })).concat({ id: 'e1', type: 'Explore' }));
    expect(second.get('e1')).toBe('elena');
  });

  it('es estable: quien sigue visible conserva su persona', () => {
    const a = assignPersonas(new Map(), [
      { id: 'x', type: 'general-purpose' },
      { id: 'y', type: 'general-purpose' },
    ]);
    const b = assignPersonas(a, [
      { id: 'y', type: 'general-purpose' },
      { id: 'z', type: 'general-purpose' },
    ]);
    expect(b.get('y')).toBe(a.get('y'));
    expect(b.get('z')).not.toBe(b.get('y'));
  });

  it('con mas agentes que personas no repite ni se rompe', () => {
    const n = PERSONAS.length + 5;
    const visible = Array.from({ length: n }, (_, i) => ({ id: `q${i}`, type: 'general-purpose' }));
    const map = assignPersonas(new Map(), visible);
    expect(new Set(map.values()).size).toBe(n);
  });

  it('las variantes numeradas tambien son estables mientras el agente siga visible', () => {
    const n = PERSONAS.length + 5;
    const visible = Array.from({ length: n }, (_, i) => ({ id: `q${i}`, type: 'general-purpose' }));
    const first = assignPersonas(new Map(), visible);
    const variants = [...first].filter(([, p]) => p.includes('#'));
    expect(variants.length).toBeGreaterThan(0);
    // entra uno mas (y luego sale otro): nadie cambia de nombre ni de look
    const more = assignPersonas(first, [...visible, { id: 'nuevo', type: 'general-purpose' }]);
    for (const [id, p] of first) expect(more.get(id), id).toBe(p);
    expect(new Set(more.values()).size).toBe(n + 1);
    const fewer = assignPersonas(more, visible.slice(1));
    for (const v of visible.slice(1)) expect(fewer.get(v.id), v.id).toBe(first.get(v.id));
  });

  it('Pruebas es Tomas (bata) y Seguridad es Sara (chaleco); quedan reservados para su rol', () => {
    const map = assignPersonas(new Map(), [
      { id: 't1', type: 'tester' },
      { id: 's1', type: 'security' },
    ]);
    expect(map.get('t1')).toBe('tomas');
    expect(map.get('s1')).toBe('sara');
    expect(personaById('tomas')?.acc).toBe('labcoat');
    expect(personaById('sara')?.acc).toBe('security');
    expect([agentBaseName('tester'), agentBaseName('security')]).toEqual(['Tomas', 'Sara']);
    // los constructores de mas no se los llevan mientras quede otra persona libre
    const builders = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, type: 'tr-builder' }));
    const crowd = assignPersonas(new Map(), builders);
    expect([...crowd.values()]).not.toContain('tomas');
    expect([...crowd.values()]).not.toContain('sara');
  });
});

describe('rol de los subagentes', () => {
  const role = (over: Partial<RoleInput>) =>
    classifyWorkflowRole({ label: null, phase: null, promptHead: null, model: null, sourceType: 'workflow-subagent', ...over });

  it('Pruebas y Seguridad por palabras (etiqueta, fase o inicio del encargo)', () => {
    expect(role({ label: 'pruebas e2e' })).toEqual({ role: 'tester', lookType: 'tester' });
    expect(role({ phase: 'QA', label: 'hud' })).toEqual({ role: 'tester', lookType: 'tester' });
    expect(role({ promptHead: 'Corre vitest y el smoke del server' }).role).toBe('tester');
    expect(role({ label: 'vulnerabilidades' })).toEqual({ role: 'security', lookType: 'security' });
    expect(role({ label: 'secretos en el repo' }).role).toBe('security');
    expect(role({ promptHead: 'Busca CVE en las dependencias' }).role).toBe('security');
  });

  it('"revision de seguridad" es Seguridad, no Revision; "revision" sola sigue siendo Revision', () => {
    expect(role({ label: 'revision de seguridad' }).role).toBe('security');
    expect(role({ label: 'security review' }).role).toBe('security');
    expect(role({ label: 'auditoria de seguridad y revision del parser' }).role).toBe('security');
    expect(role({ label: 'revision' })).toEqual({ role: 'reviewer', lookType: 'claude-code-guide' });
  });

  it('las pruebas ya no son Revision; en empate Pruebas gana a Construccion', () => {
    expect(role({ label: 'pruebas', phase: 'Pruebas', promptHead: 'Corre las pruebas' }).role).toBe('tester');
    expect(role({ label: 'corrige los tests' }).role).toBe('tester');
    expect(role({ label: 'verifica', phase: 'Pruebas' }).role).toBe('reviewer');
  });

  it('tipos: los del elenco conservan su look; los que lo dicen en su nombre y los genericos toman el de su rol', () => {
    expect(role({ sourceType: 'claude-code-guide' })).toEqual({ role: 'explorer', lookType: 'claude-code-guide' });
    expect(role({ sourceType: 'tr-explorer' })).toEqual({ role: 'explorer', lookType: 'tr-explorer' });
    expect(role({ sourceType: 'Plan', label: 'pruebas' })).toEqual({ role: 'planner', lookType: 'Plan' });
    expect(role({ sourceType: 'code-reviewer' })).toEqual({ role: 'reviewer', lookType: 'claude-code-guide' });
    expect(role({ sourceType: 'test-runner' })).toEqual({ role: 'tester', lookType: 'tester' });
    expect(role({ sourceType: 'security-auditor' })).toEqual({ role: 'security', lookType: 'security' });
    // general-purpose ya no es siempre Gael: se clasifica como uno de flujo
    expect(role({ sourceType: 'general-purpose', label: 'Explorar el parser', model: 'claude-haiku-4-5' })).toEqual({
      role: 'explorer',
      lookType: 'tr-explorer',
    });
    expect(role({ sourceType: 'general-purpose', label: 'tarea' })).toEqual({ role: 'generalist', lookType: 'general-purpose' });
  });

  it('"solo lectura" que describe el producto no veta Desarrollo; la orden al agente o la etiqueta si', () => {
    const head =
      'Proyecto c:\\Users\\demo\\Proyecto (Oficina Virtual de Agentes, cero tokens, solo lectura de ~/.claude). ' +
      'Especificacion: C:\\Users\\demo\\.claude\\plans\\plan.md (lee solo la seccion de tu modulo). ' +
      'Contrato: shared/contract.ts (lee solo los tipos que usa tu modulo).';
    expect(role({ label: 'corrector:server', phase: 'Corregir', promptHead: head })).toEqual({ role: 'builder', lookType: 'tr-builder' });
    expect(role({ label: 'corrector:web' }).role).toBe('builder');
    // orden directa al agente en el encargo
    expect(role({ label: 'corrector:server', phase: 'Corregir', promptHead: `${head} No edites nada.` }).role).not.toBe('builder');
    expect(role({ label: 'arreglos', promptHead: 'Revisa el parser sin editar archivos' }).role).not.toBe('builder');
    // en la etiqueta o la fase, "solo lectura" sigue vetando
    expect(role({ label: 'corrige el parser (solo lectura)' }).role).not.toBe('builder');
    expect(role({ label: 'corrige el parser', phase: 'Solo lectura' }).role).not.toBe('builder');
  });

  it('un generalist sube a tester con 4+ comandos y al menos la mitad de tests', () => {
    expect(isTesterByCommands(4, 2)).toBe(true);
    expect(isTesterByCommands(3, 3)).toBe(false);
    expect(isTesterByCommands(6, 2)).toBe(false);
  });
});

describe('RoleStore', () => {
  const SID = 'sesion-falsa';

  function setup(): Db {
    const db = openDb(':memory:');
    // cmd_class llega con la migracion v13 (otro modulo); la prueba no depende de que ya este
    const cols = db.prepare(`PRAGMA table_info(actions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cmd_class')) db.exec(`ALTER TABLE actions ADD COLUMN cmd_class TEXT`);
    return db;
  }
  const addAgent = (db: Db, id: string, type: string, description: string) =>
    db
      .prepare(`INSERT INTO agents (agent_id, session_id, kind, agent_type, description) VALUES (?, ?, 'subagent', ?, ?)`)
      .run(id, SID, type, description);
  const addShell = (db: Db, agentId: string, n: number, cmdClass: string) =>
    db
      .prepare(`INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, cmd_class) VALUES (?, ?, ?, 'Bash', 'x', ?, ?)`)
      .run(`${agentId}-${n}`, agentId, SID, n, cmdClass);
  const stored = (db: Db, id: string) => db.prepare(`SELECT role, look_type FROM agents WHERE agent_id = ?`).get(id);

  it('clasifica a todos los subagentes, no solo a los de flujo; con el tool_use si falta la descripcion', () => {
    const db = setup();
    addAgent(db, 'a-normal', 'general-purpose', 'Revision de seguridad del login');
    addAgent(db, 'a-sin-meta', 'general-purpose', '');
    db.prepare(`UPDATE agents SET tool_use_id = 'toolu_x' WHERE agent_id = 'a-sin-meta'`).run();
    db.prepare(
      `INSERT INTO launches (tool_use_id, session_id, parent_agent_id, subagent_type, description, started_at) VALUES ('toolu_x', ?, ?, 'general-purpose', 'Documentar la API', 0)`,
    ).run(SID, SID);
    const store = new RoleStore(db);
    expect(store.refresh('a-normal')).toEqual({ role: 'security', lookType: 'security' });
    expect(store.refresh('a-sin-meta')).toEqual({ role: 'docs', lookType: 'tr-docs' });
    expect(stored(db, 'a-normal')).toEqual({ role: 'security', look_type: 'security' });
    expect(store.refresh('no-existe')).toBeNull();
    db.close();
  });

  it('generalist sube a tester por sus comandos y no vuelve atras; refreshMissing llena los que no tienen rol', () => {
    const db = setup();
    addAgent(db, 'g1', 'general-purpose', 'tarea');
    addAgent(db, 'g2', 'workflow-subagent', 'otra tarea');
    const store = new RoleStore(db);
    expect(store.refresh('g1')?.role).toBe('generalist');
    for (let i = 0; i < 3; i++) addShell(db, 'g1', i, 'test');
    expect(store.promoteTester('g1', null)).toBeNull();
    addShell(db, 'g1', 3, 'other');
    expect(store.promoteTester('g1', null)).toEqual({ role: 'tester', lookType: 'tester' });
    expect(stored(db, 'g1')).toEqual({ role: 'tester', look_type: 'tester' });
    // reclasificar (p.ej. al releer su meta) no deshace la subida
    expect(store.refresh('g1')?.role).toBe('tester');

    expect(stored(db, 'g2')).toEqual({ role: null, look_type: null });
    expect(store.refreshMissing()).toBe(1);
    expect(stored(db, 'g2')).toEqual({ role: 'generalist', look_type: 'general-purpose' });
    db.close();
  });
});

describe('tarea real segun las acciones', () => {
  const cwd = 'C:\\Proyecto';
  it('constructor: el archivo que mas edita y su zona', () => {
    const title = describeWork({
      role: 'builder',
      label: 'flujos',
      phase: 'Construccion',
      cwd,
      targets: [t('Read', 'C:\\Proyecto\\web\\src\\hud\\Hud.tsx', 5), t('Edit', 'C:\\Proyecto\\web\\src\\hud\\FlowsDock.tsx', 3)],
    });
    expect(title).toBe('Construyendo interfaz · FlowsDock.tsx');
  });

  it('correcciones: Arreglando', () => {
    expect(
      describeWork({ role: 'builder', label: 'correcciones:scene', phase: 'Correcciones', cwd, targets: [t('Edit', 'C:\\Proyecto\\web\\src\\scene\\Room.tsx')] }),
    ).toBe('Arreglando escena 3D · Room.tsx');
  });

  it('revisor y explorador: el archivo que mas lee', () => {
    expect(
      describeWork({ role: 'reviewer', label: 'revision', phase: 'Revision', cwd, targets: [t('Read', 'C:\\Proyecto\\server\\src\\ingest\\parser.ts', 4)] }),
    ).toBe('Revisando backend · parser.ts');
    expect(
      describeWork({ role: 'explorer', label: 'inventario', phase: null, cwd, targets: [t('Read', 'C:\\Proyecto\\design\\kit\\Kit 3D.html', 2)] }),
    ).toBe('Explorando diseño · Kit 3D.html');
  });

  it('pruebas y sin archivos todavia', () => {
    expect(
      describeWork({ role: 'builder', label: 'x', phase: null, cwd, targets: [t('Write', 'C:\\Proyecto\\web\\test\\scene.test.ts')] }),
    ).toBe('Construyendo pruebas · scene.test.ts');
    expect(describeWork({ role: 'planner', label: 'arquitectura', phase: null, cwd, targets: [] })).toBe('Planeando · arquitectura');
  });

  it('ruta absoluta fuera del cwd sin zona conocida: solo el archivo, sin la raiz del disco', () => {
    expect(
      describeWork({ role: 'explorer', label: 'x', phase: null, cwd, targets: [t('Read', 'C:\\Users\\demo\\Otro Proyecto\\launcher\\main.ts', 2)] }),
    ).toBe('Explorando · main.ts');
    expect(describeWork({ role: 'explorer', label: 'x', phase: null, cwd: null, targets: [t('Read', '/home/demo/otro/main.ts')] })).toBe(
      'Explorando · main.ts',
    );
    // una zona conocida se reconoce aunque este fuera del cwd; dentro del cwd sigue el primer segmento
    expect(
      describeWork({ role: 'explorer', label: 'x', phase: null, cwd, targets: [t('Read', 'C:\\Users\\demo\\.claude\\plans\\plan.md')] }),
    ).toBe('Explorando Claude Code · plan.md');
    expect(
      describeWork({ role: 'explorer', label: 'x', phase: null, cwd, targets: [t('Read', 'C:\\Proyecto\\launcher\\main.ts')] }),
    ).toBe('Explorando launcher · main.ts');
  });

  it('pruebas y seguridad', () => {
    expect(
      describeWork({ role: 'tester', label: 'pruebas', phase: null, cwd, targets: [t('Read', 'C:\\Proyecto\\server\\test\\office.test.ts', 2)] }),
    ).toBe('Probando pruebas · office.test.ts');
    expect(
      describeWork({ role: 'security', label: 'seguridad', phase: null, cwd, targets: [t('Grep', 'C:\\Proyecto\\server\\src\\app.ts')] }),
    ).toBe('Auditando backend · app.ts');
  });
});
