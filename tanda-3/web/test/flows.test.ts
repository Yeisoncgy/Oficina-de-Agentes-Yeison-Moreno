import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeRoom, TokenBreakdown, WorkflowAgentRef, WorkflowRun } from '@shared/contract';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import { createMockSnapshot } from '../src/scene/mock';
import { modelLabel } from '../src/lib/models';
import {
  boardColumns,
  collectRuns,
  columnCountText,
  dockMode,
  flowActivity,
  flowAgentViews,
  flowsSummary,
  flowsSummaryParts,
  flowsSummaryText,
  columnSpan,
  groupAgentsByPhase,
  namesText,
  nextColumnKey,
  phaseAnnouncement,
  phasesDoneText,
  prefAfterToggle,
  prettyRunName,
  runAgentCounts,
  runProgress,
  runStory,
  runTimeline,
  startsCollapsed,
  type FlowEntry,
} from '../src/lib/workflows';

const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
/** instante del ciclo de 120 s del flujo de la demo */
const at = (sec: number) => NOW - (NOW % 120_000) + sec * 1000;
const demoEntry = (sec: number): FlowEntry => {
  const entry = collectRuns(createMockSnapshot(at(sec)))[0];
  if (!entry) throw new Error('la demo no trajo el flujo');
  return entry;
};

const tokens = (total = 0): TokenBreakdown => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });

function ref(partial: Partial<WorkflowAgentRef> & Pick<WorkflowAgentRef, 'agentId'>): WorkflowAgentRef {
  return {
    label: 'etiqueta',
    phase: 'Fase A',
    displayName: 'Agente',
    agentType: 'tr-builder',
    role: 'builder',
    status: 'working',
    model: 'claude-opus-5-5',
    tokens: tokens(100),
    costUsd: 0.1,
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: null,
    ...partial,
  };
}

function run(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    runId: 'wf_prueba',
    name: 'flujo_de-prueba',
    description: '',
    status: 'running',
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: null,
    phases: [],
    agents: [],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  };
}

function live(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: 'Agente',
    status: 'working',
    task: null,
    action: null,
    model: 'claude-opus-5-5',
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 1,
    ...partial,
  };
}

function room(subagents: OfficeAgent[]): OfficeRoom {
  return {
    id: 'sala',
    projectName: 'proyecto',
    title: 'proyecto',
    cwd: '/tmp/proyecto',
    open: true,
    busy: true,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: live('lead', { kind: 'lead', agentType: 'lead', status: 'idle' }),
    subagents,
    tokens: tokens(),
    costUsd: 0,
  };
}

describe('modelo visible', () => {
  it('nombre corto de la familia y version, sin sufijo de fecha', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });
});

describe('demo: personas unicas y flujo de ejemplo', () => {
  it('ningun agente visible repite persona ni nombre (salvo el lider, que es uno solo)', () => {
    for (let s = 0; s < 240; s += 7) {
      const snap = createMockSnapshot(NOW + s * 1000);
      const subs = snap.rooms.flatMap((r) => r.subagents);
      expect(new Set(subs.map((a) => a.persona)).size).toBe(subs.length);
      expect(new Set(subs.map((a) => a.displayName)).size).toBe(subs.length);
      expect(subs.some((a) => /\s\d+$/.test(a.displayName))).toBe(false);
    }
  });

  it('el lider de la demo se llama como el por defecto y la demo no pide nombre (sin leadName)', () => {
    const snap = createMockSnapshot(NOW);
    expect(snap.rooms.map((r) => r.lead.displayName)).toEqual(snap.rooms.map(() => DEFAULT_LEAD_NAME));
    expect('leadName' in snap).toBe(false);
    expect(snap.leadRoomId).not.toBeNull();
  });

  it('el flujo avanza por sus fases y sus agentes traen modelo, rol, tarea real y detalle', () => {
    const early = demoEntry(10);
    const late = demoEntry(100);
    expect(early.run.phases.map((p) => p.status)).toEqual(['running', 'pending', 'pending']);
    expect(late.run.phases.map((p) => p.status)).toEqual(['done', 'done', 'running']);
    const groups = groupAgentsByPhase(late.run, late.room);
    expect(groups.map((g) => g.title)).toEqual(['Exploracion', 'Construccion', 'Revision']);
    const reviewer = late.room.subagents.find((a) => a.workflow?.role === 'reviewer');
    expect(reviewer).toMatchObject({ model: 'claude-fable-5-1', task: { detail: 'Revision · revisa:pruebas' } });
    expect(reviewer?.task?.title).toMatch(/^Revisando /);
  });
});

describe('sala de control: nombre y cabecera', () => {
  it('nombre legible: guiones a espacios y primera letra en mayuscula', () => {
    expect(prettyRunName('flujo-de-ejemplo')).toBe('Flujo de ejemplo');
    expect(prettyRunName('mi_flujo--grande ')).toBe('Mi flujo grande');
    expect(prettyRunName('Revision UI')).toBe('Revision UI');
    expect(prettyRunName('---')).toBe('---');
  });

  it('progreso global: un segmento por fase, sin porcentaje inventado', () => {
    const mid = runProgress(demoEntry(60).run);
    expect(mid.segments.map((s) => s.status)).toEqual(['done', 'running', 'pending']);
    expect(mid.segments.map((s) => s.fill)).toEqual([1, 0, 0]);
    expect(mid).toMatchObject({ phasesDone: 1, total: 3 });
    const late = runProgress(demoEntry(100).run);
    expect(late.segments.map((s) => s.fill)).toEqual([1, 1, 0]);
    expect(phasesDoneText(late.phasesDone, late.total)).toBe('2 de 3 fases terminadas');
    expect(phasesDoneText(0, 1)).toBe('0 de 1 fase terminada');
    const half = runProgress(
      run({ phases: [{ title: 'A', status: 'running', agentsStarted: 2, agentsDone: 1 }] }),
    );
    expect(half.segments[0]?.fill).toBe(0.5);
  });

  it('aria-live: anuncia la fase actual o el fin de la corrida', () => {
    expect(phaseAnnouncement(demoEntry(100).run)).toBe('Flujo de ejemplo: fase 3 de 3, Revision, en curso');
    expect(phaseAnnouncement(demoEntry(10).run)).toBe('Flujo de ejemplo: fase 1 de 3, Exploracion, en curso');
    expect(phaseAnnouncement(run({ status: 'done' }))).toBe('Flujo de prueba: terminado');
    expect(phaseAnnouncement(run({ status: 'failed' }))).toBe('Flujo de prueba: falló');
  });
});

describe('sala de control: columnas por fase', () => {
  it('una columna por fase en el orden del script; la en curso resaltada, las pendientes vacias', () => {
    const early = boardColumns(demoEntry(10).run, demoEntry(10).room);
    expect(early.map((c) => c.title)).toEqual(['Exploracion', 'Construccion', 'Revision']);
    expect(early.map((c) => c.status)).toEqual(['running', 'pending', 'pending']);
    expect(early.map((c) => c.current)).toEqual([true, false, false]);
    expect(early.map((c) => c.total)).toEqual([1, 0, 0]);
    expect(columnCountText(early[1]!)).toBe('Sin agentes');

    const { run: late, room: lateRoom } = demoEntry(100);
    const cols = boardColumns(late, lateRoom);
    expect(cols.map((c) => c.status)).toEqual(['done', 'done', 'running']);
    expect(cols.map((c) => c.current)).toEqual([false, false, true]);
    expect(cols.map((c) => [c.done, c.total])).toEqual([
      [1, 1],
      [2, 2],
      [0, 1],
    ]);
    expect(cols.map(columnCountText)).toEqual(['1/1 terminado', '2/2 terminados', '0/1 terminados']);
    // la tarjeta muestra lo que hace de verdad (task.title del agente vivo), no la etiqueta del script
    expect(cols[2]?.agents[0]?.work).toMatch(/^Revisando /);
  });

  it('una corrida terminada no resalta ninguna columna; los agentes sin fase declarada van al final', () => {
    const r = run({
      status: 'done',
      phases: [{ title: 'Fase A', status: 'done', agentsStarted: 1, agentsDone: 1 }],
      agents: [
        ref({ agentId: 'a1', status: 'done', endedAt: '2026-09-28T19:55:00Z' }),
        ref({ agentId: 'a2', phase: 'Extra', status: 'failed', endedAt: '2026-09-28T19:56:00Z' }),
      ],
    });
    const cols = boardColumns(r, null);
    expect(cols.map((c) => [c.title, c.status, c.current])).toEqual([
      ['Fase A', 'done', false],
      ['Extra', 'failed', false],
    ]);
    expect(cols[1]?.index).toBe(-1);
  });
});

describe('sala de control: estado de cada tarjeta', () => {
  const r = run({
    agents: [
      ref({ agentId: 'accion', label: 'impl:a' }),
      ref({ agentId: 'piensa', label: 'impl:b' }),
      ref({ agentId: 'listo', label: 'impl:c', status: 'done', endedAt: '2026-09-28T19:58:00Z' }),
      ref({ agentId: 'fallo', label: 'impl:d', status: 'failed', endedAt: '2026-09-28T19:58:00Z' }),
      ref({ agentId: 'intento1', label: 'impl:e', status: 'failed', endedAt: '2026-09-28T19:57:00Z' }),
      ref({ agentId: 'intento2', label: 'impl:e' }),
    ],
  });
  const sala = room([
    live('accion', { action: { tool: 'Edit', label: 'Editando Ejemplo.tsx', startedAt: '2026-09-28T19:59:50Z' } }),
    live('piensa'),
    live('intento2', { status: 'idle' }),
  ]);
  const views = new Map(flowAgentViews(r, sala).map((v) => [v.ref.agentId, v]));
  const activity = (id: string) => flowActivity(views.get(id)!);

  it('textos de estado grandes y claros', () => {
    expect(activity('accion')).toMatchObject({
      tone: 'working',
      status: 'Trabajando',
      detail: 'Editando Ejemplo.tsx',
      tool: 'Edit',
      startedAt: '2026-09-28T19:59:50Z',
    });
    expect(activity('piensa')).toMatchObject({ tone: 'thinking', status: 'Pensando', detail: null });
    expect(activity('listo')).toMatchObject({ tone: 'done', status: 'Terminado' });
    expect(activity('listo').detail).toMatch(/^a las \d\d:\d\d$/);
    expect(activity('fallo')).toMatchObject({ tone: 'failed', status: 'Falló' });
    expect(activity('intento1')).toMatchObject({ tone: 'retried', status: 'Reintentado' });
    expect(views.get('intento1')?.dim).toBe(true);
    expect(activity('intento2')).toMatchObject({ tone: 'idle', status: 'En espera' });
  });

  it('cuenta trabajando, terminados, fallidos y reintentados sin mezclarlos', () => {
    expect(runAgentCounts(r)).toEqual({ working: 3, done: 1, failed: 1, retried: 1 });
  });
});

describe('que pasa ahora: la frase de la corrida', () => {
  /** la sala de la demo alterna "espera respuesta" y cafe: aqui el lead no espera */
  const calm = (sec: number): FlowEntry => {
    const e = demoEntry(sec);
    return { run: e.run, room: { ...e.room, lead: { ...e.room.lead, place: 'coffee' } } };
  };
  const phasesAB = (b: 'pending' | 'failed') => [
    { title: 'Fase A', status: 'done' as const, agentsStarted: 1, agentsDone: 1 },
    { title: 'Fase B', status: b, agentsStarted: b === 'failed' ? 1 : 0, agentsDone: b === 'failed' ? 1 : 0 },
  ];
  const end = '2026-09-28T19:52:05Z';

  it('en curso: la fase actual, quienes trabajan y que sigue', () => {
    const mid = calm(60);
    const story = runStory(mid.run, mid.room, at(60));
    expect(story).toMatchObject({ tone: 'live', headline: 'Fase 2 de 3 · Construccion' });
    expect(story.detail).toMatch(/^\S+ y \S+ están trabajando\. Después sigue Revision\.$/);
    const last = calm(100);
    expect(runStory(last.run, last.room, at(100)).detail).toMatch(/^\S+ está trabajando\. Es la última fase\.$/);
  });

  it('esperando al usuario gana a todo y dice quien sigue trabajando', () => {
    const e = calm(60);
    const waiting = { ...e.room, lead: { ...e.room.lead, place: 'door' as const } };
    const story = runStory(e.run, waiting, at(60));
    expect(story).toMatchObject({ tone: 'waiting', headline: 'Espera tu respuesta' });
    expect(story.detail).toMatch(/respóndela en Claude Code\. Mientras tanto, \S+ y \S+ siguen trabajando\.$/);
  });

  it('entre fases y antes del primer agente no inventa trabajo', () => {
    const between = run({ phases: phasesAB('pending'), agents: [ref({ agentId: 'a1', phase: 'Fase A', status: 'done', endedAt: end })] });
    expect(runStory(between, room([]), NOW)).toMatchObject({ tone: 'between', headline: 'Pasando a Fase B' });
    expect(runStory(run({}), room([]), NOW)).toMatchObject({ tone: 'between', headline: 'Preparando el flujo' });
  });

  it('terminado, fallido y detenido: resumen con la duracion y las fallas', () => {
    const agents = [
      ref({ agentId: 'a1', label: 'uno', status: 'done', endedAt: end }),
      ref({ agentId: 'a2', label: 'dos', status: 'failed', endedAt: end }),
    ];
    const done = run({ status: 'done', endedAt: end, phases: [{ title: 'Fase A', status: 'done', agentsStarted: 2, agentsDone: 2 }], agents });
    expect(runStory(done, room([]), NOW)).toEqual({
      tone: 'done',
      headline: 'Terminado',
      detail: 'Terminó en 2 m 05 s con 2 agentes: 1 falló.',
    });
    const failed = run({
      status: 'failed',
      endedAt: end,
      phases: phasesAB('failed'),
      agents: [ref({ agentId: 'a1', phase: 'Fase A', status: 'done', endedAt: end }), ref({ agentId: 'b1', phase: 'Fase B', status: 'failed', endedAt: end })],
    });
    expect(runStory(failed, room([]), NOW).detail).toBe('Falló en la fase Fase B: 1 agente falló. Duró 2 m 05 s.');
    const stopped = run({ status: 'stopped', endedAt: end, phases: phasesAB('pending'), agents: [ref({ agentId: 'a1', phase: 'Fase A', status: 'done', endedAt: end })] });
    expect(runStory(stopped, room([]), NOW).detail).toBe('Se detuvo en la fase Fase A, con 1 de 2 fases hechas. Duró 2 m 05 s.');
  });

  it('nombres en una frase', () => {
    expect(namesText([])).toBe('');
    expect(namesText(['Nico'])).toBe('Nico');
    expect(namesText(['Nico', 'Vera'])).toBe('Nico y Vera');
    expect(namesText(['Nico', 'Vera', 'Lucía'])).toBe('Nico, Vera y Lucía');
    expect(namesText(['Nico', 'Vera', 'Lucía', 'Simón', 'Iris'])).toBe('Nico, Vera, Lucía y 2 más');
  });
});

describe('tablero enfocado y linea de tiempo', () => {
  it('pliega las terminadas solo mientras el flujo corre y marca la siguiente', () => {
    const { run: r, room: sala } = demoEntry(60);
    const cols = boardColumns(r, sala);
    expect(cols.map((c) => startsCollapsed(c, r, cols))).toEqual([true, false, false]);
    expect(nextColumnKey(cols)).toBe(cols[2]?.key);
    const finished = { ...r, status: 'done' as const };
    expect(cols.map((c) => startsCollapsed(c, finished, cols))).toEqual([false, false, false]);
    expect(nextColumnKey(boardColumns(demoEntry(100).run, demoEntry(100).room))).toBeNull();
  });

  it('cuanto duro cada fase: del primer arranque al ultimo fin, o hasta ahora', () => {
    const { run: r, room: sala } = demoEntry(60);
    const [explora, construye, revisa] = boardColumns(r, sala);
    const ms = (c: typeof explora) => {
      const span = c ? columnSpan(c, at(60)) : null;
      return span ? span.endMs - span.startMs : null;
    };
    expect(ms(explora)).toBe(40_000);
    expect(ms(construye)).toBe(20_000);
    expect(ms(revisa)).toBeNull();
  });

  it('una barra por agente en el tiempo, agrupadas por fase, con marcas redondas', () => {
    const { run: r, room: sala } = demoEntry(60);
    const tl = runTimeline(r, sala, at(60));
    expect(tl.groups.map((g) => g.title)).toEqual(['Exploracion', 'Construccion']);
    const [explorer] = tl.groups[0]?.bars ?? [];
    expect(explorer).toMatchObject({ open: false });
    expect(explorer?.from).toBeCloseTo(0);
    expect(explorer?.to).toBeCloseTo(40 / 60);
    const builders = tl.groups[1]?.bars ?? [];
    expect(builders.every((b) => b.open && b.to === 1)).toBe(true);
    expect(builders[0]?.from).toBeCloseTo(40 / 60);
    expect(tl.now).toBe(1);
    expect(tl.ticks.map((t) => t.label)).toEqual(['0:00', '0:10', '0:20', '0:30', '0:40', '0:50', '1:00']);

    const done = runTimeline({ ...r, status: 'done', endedAt: new Date(at(100)).toISOString() }, sala, at(120));
    expect(done.now).toBeNull();
    expect(done.endMs).toBe(at(100));
  });
});

describe('barra compacta y vista grande', () => {
  it('resumen corto de la barra: estado, fase, quienes trabajan y el valor', () => {
    const summary = flowsSummary([demoEntry(60)]);
    expect(summary).toMatchObject({ active: 1, phase: { current: 2, total: 3 }, working: 2 });
    const parts = flowsSummaryParts(summary);
    expect(parts.slice(0, 3)).toEqual(['Flujo en curso', 'Fase 2 de 3', '2 trabajando']);
    expect(parts[3]).toMatch(/^\$\d+,\d\d$/);
    expect(flowsSummaryText(summary)).toMatch(
      /^Flujo en curso · Fase 2 de 3 · 2 agentes trabajando · \$\d+,\d\d valor equivalente API$/,
    );
  });

  it('con varias corridas no hay fase unica; sin precio no se inventa un monto', () => {
    const a = run({ runId: 'a', agents: [ref({ agentId: 'x' })], costUsd: null });
    const b = run({ runId: 'b', agents: [ref({ agentId: 'y' }), ref({ agentId: 'z', status: 'done' })] });
    const entries = [a, b].map((r) => ({ run: r, room: room([]) }));
    expect(flowsSummaryParts(flowsSummary(entries))).toEqual(['2 flujos en curso', '2 trabajando', 'sin precio']);
    expect(flowsSummaryParts(flowsSummary([]))).toEqual(['Sin flujos en curso']);
  });

  it('F abre la vista grande; cerrada queda la barra mientras haya un flujo en curso', () => {
    expect(dockMode('auto', true)).toBe('bar');
    expect(dockMode('bar', true)).toBe('bar');
    expect(dockMode('auto', false)).toBe('hidden');
    expect(dockMode('open', false)).toBe('open');
    expect(prefAfterToggle('auto', true)).toBe('open');
    expect(prefAfterToggle('open', true)).toBe('bar');
    expect(prefAfterToggle('open', false)).toBe('auto');
  });
});
