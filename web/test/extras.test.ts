import { describe, expect, it } from 'vitest';
import type { BudgetStatus, WhatIfRow, WorkflowAgentRef, WorkflowRun } from '@shared/contract';
import { agentsTree, quietMs, QUIET_MS, type NowRow } from '@/lib/agentsNow';
import { budgetNotice, markSeen, reconcileSeen, seenFor } from '@/lib/budgetAlert';
import { contextTone, nextCall } from '@/lib/context';
import { runClose } from '@/lib/runClose';
import { isLiteMode } from '@/lib/stream';
import { pendingTodos, todoSummary, todoText, todoView } from '@/lib/todo';
import { letterAction } from '@/lib/workflows';
import { taskQueryString } from '@/state/api';
import { repriced, whatIfTotal } from '@/hud/extras/WhatIf';
import { changeText } from '@/hud/ReportTab';

function status(patch: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    month: '2026-03',
    budgetUsd: 500,
    spentUsd: 100,
    projectedUsd: 200,
    usedRatio: 0.2,
    threshold: 0,
    projectedOver: false,
    todayUsd: 5,
    perDayUsd: 20,
    dayOver: false,
    burnPerHourUsd: 1,
    runOutDate: null,
    crossedDate: null,
    estimatedUsd: 0,
    projectsOver: [],
    ...patch,
  };
}

describe('aviso del presupuesto en la app', () => {
  const today = '2026-03-11';

  it('sin nada nuevo no dice nada', () => {
    expect(budgetNotice(status(), null, today)).toBeNull();
  });

  it('avisa una vez por umbral: lo ya visto no vuelve hasta el siguiente', () => {
    const at75 = status({ threshold: 75, usedRatio: 0.76, spentUsd: 380, runOutDate: '2026-03-20' });
    const first = budgetNotice(at75, null, today);
    expect(first?.tone).toBe('warn');
    expect(first?.title).toContain('75 %');
    expect(first?.detail).toContain('se acaba el');
    const seen = markSeen(at75, today);
    expect(budgetNotice(at75, seen, today)).toBeNull();
    const over = status({ threshold: 100, usedRatio: 1.2, spentUsd: 600, crossedDate: '2026-03-10' });
    const second = budgetNotice(over, seen, today);
    expect(second?.tone).toBe('over');
    expect(second?.title).toContain('Pasaste el presupuesto');
  });

  it('lo visto en otro mes no cuenta', () => {
    const seen = { month: '2026-02', threshold: 100, projected: true, day: null, projects: [] };
    expect(seenFor(seen, '2026-03').threshold).toBe(0);
    expect(budgetNotice(status({ threshold: 50, usedRatio: 0.5 }), seen, today)?.title).toContain('50 %');
  });

  it('proyeccion, tope de proyecto y dia: cada uno una vez', () => {
    const b = status({ projectedOver: true, dayOver: true, projectsOver: [{ project: 'alfa', spentUsd: 30, capUsd: 20 }] });
    expect(budgetNotice(b, null, today)?.title).toContain('A este ritmo cierras el mes');
    expect(budgetNotice(b, { month: b.month, threshold: 0, projected: true, day: null, projects: [] }, today)?.title).toContain('alfa');
    expect(budgetNotice(b, { month: b.month, threshold: 0, projected: true, day: null, projects: ['alfa'] }, today)?.title).toContain('Hoy ya pasaste');
    expect(budgetNotice(b, markSeen(b, today), today)).toBeNull();
    // al dia siguiente el exceso del dia vuelve a poder avisar
    expect(budgetNotice(b, markSeen(b, today), '2026-03-12')?.title).toContain('Hoy ya pasaste');
  });

  it('si el umbral baja (se subio el presupuesto), lo visto baja con el', () => {
    const seen = { month: '2026-03', threshold: 100, projected: true, day: null, projects: ['alfa'] };
    expect(reconcileSeen(status({ threshold: 50 }), seen)).toEqual({ month: '2026-03', threshold: 50, projected: false, day: null, projects: [] });
  });
});

function row(patch: Partial<NowRow> & Pick<NowRow, 'agentId'>): NowRow {
  return {
    roomId: 'r1',
    roomTitle: 'Sala',
    roomNumber: 1,
    roomAccent: '#fff',
    name: patch.agentId,
    look: 'lead',
    lead: false,
    role: null,
    model: 'Opus 5.5',
    state: 'working',
    alert: null,
    task: '',
    doing: '',
    since: null,
    costUsd: 1,
    parentId: null,
    contextTokens: null,
    lastActivityAt: null,
    waitingSince: null,
    ...patch,
  };
}

describe('arbol de delegacion', () => {
  it('pone a cada agente bajo quien lo lanzo y suma el costo de la rama', () => {
    const tree = agentsTree([
      row({ agentId: 'nieto', parentId: 'hijo-a', costUsd: 4 }),
      row({ agentId: 'r1', lead: true, costUsd: 10 }),
      row({ agentId: 'hijo-a', parentId: 'r1', costUsd: 2 }),
      row({ agentId: 'hijo-b', parentId: 'r1', costUsd: 3 }),
      row({ agentId: 'r2', roomId: 'r2', roomNumber: 2, lead: true, costUsd: 7 }),
    ]);
    expect(tree.map((t) => [t.agentId, t.depth, t.descendants, t.branchCostUsd])).toEqual([
      ['r1', 0, 3, 19],
      ['hijo-a', 1, 1, 6],
      ['nieto', 2, 0, 4],
      ['hijo-b', 1, 0, 3],
      ['r2', 0, 0, 7],
    ]);
  });

  it('un agente con el padre fuera de vista cuelga del lider; sin precio, la rama no inventa un total', () => {
    const tree = agentsTree([
      row({ agentId: 'r1', lead: true, costUsd: 1 }),
      row({ agentId: 'huerfano', parentId: 'ya-se-fue', costUsd: null }),
    ]);
    expect(tree.map((t) => [t.agentId, t.depth, t.branchCostUsd])).toEqual([
      ['r1', 0, null],
      ['huerfano', 1, null],
    ]);
    // sin lider trabajando, el subagente queda arriba
    expect(agentsTree([row({ agentId: 'solo', parentId: 'r1' })]).map((t) => t.depth)).toEqual([0]);
  });

  it('avisa del agente que trabaja y lleva rato sin escribir', () => {
    const now = Date.parse('2026-03-11T12:00:00.000Z');
    const last = (ms: number) => new Date(now - ms).toISOString();
    expect(quietMs({ state: 'working', lastActivityAt: last(QUIET_MS + 1000) }, now)).toBe(QUIET_MS + 1000);
    expect(quietMs({ state: 'working', lastActivityAt: last(30_000) }, now)).toBeNull();
    expect(quietMs({ state: 'waiting', lastActivityAt: last(QUIET_MS * 2) }, now)).toBeNull();
    expect(quietMs({ state: 'working', lastActivityAt: null }, now)).toBeNull();
  });
});

describe('contexto y proxima llamada', () => {
  const now = Date.parse('2026-03-11T12:00:00.000Z');
  const context = { tokens: 200_000, warmUsd: 0.04, coldUsd: 1.6, cacheExpiresAt: '2026-03-11T12:03:00.000Z' };

  it('con la cache viva cobra la lectura; vencida, la escritura', () => {
    expect(nextCall(context, now)).toEqual({ tokens: 200_000, warm: true, usd: 0.04, coldUsd: 1.6, leftMs: 180_000 });
    expect(nextCall(context, now + 200_000)).toMatchObject({ warm: false, usd: 1.6, leftMs: 0 });
    expect(nextCall(null, now)).toBeNull();
    expect(nextCall({ ...context, tokens: 0 }, now)).toBeNull();
  });

  it('cortes de contexto grande', () => {
    expect([10_000, 150_000, 299_999, 300_000].map(contextTone)).toEqual(['ok', 'warn', 'warn', 'high']);
  });
});

function agent(patch: Partial<WorkflowAgentRef> & Pick<WorkflowAgentRef, 'agentId'>): WorkflowAgentRef {
  return {
    label: '',
    phase: 'Construir',
    displayName: 'x',
    agentType: 'tr-builder',
    role: 'builder',
    status: 'done',
    model: 'claude-opus-5-5',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 1,
    startedAt: '2026-03-11T10:00:00.000Z',
    endedAt: '2026-03-11T10:05:00.000Z',
    ...patch,
  };
}

function run(agents: WorkflowAgentRef[], patch: Partial<WorkflowRun> = {}): WorkflowRun {
  const cost = agents.every((a) => a.costUsd !== null) ? agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) : null;
  return {
    runId: 'wf',
    name: 'flujo',
    description: '',
    status: 'done',
    startedAt: '2026-03-11T10:00:00.000Z',
    endedAt: '2026-03-11T11:00:00.000Z',
    phases: [
      { title: 'Explorar', status: 'done', agentsStarted: 1, agentsDone: 1 },
      { title: 'Construir', status: 'done', agentsStarted: 2, agentsDone: 2 },
    ],
    agents,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: cost,
    ...patch,
  };
}

describe('cierre de un flujo', () => {
  const agents = [
    agent({ agentId: 'a', costUsd: 5 }),
    agent({ agentId: 'b', costUsd: 3, status: 'failed' }),
    agent({ agentId: 'c', phase: 'Explorar', role: 'explorer', costUsd: 2 }),
  ];

  it('agrupa por fase (en el orden del script) y por rol, y separa lo descartado', () => {
    const close = runClose(run(agents, { firstForecast: { lowUsd: 4, highUsd: 8 } }));
    expect(close.byPhase).toEqual([
      { key: 'Explorar', agents: 1, costUsd: 2 },
      { key: 'Construir', agents: 2, costUsd: 8 },
    ]);
    expect(close.byRole.map((g) => [g.role, g.agents, g.costUsd])).toEqual([
      ['builder', 2, 8],
      ['explorer', 1, 2],
    ]);
    expect(close).toMatchObject({ discardedAgents: 1, discardedUsd: 3, verdict: 'over' });
  });

  it('compara el costo real con el primer pronostico', () => {
    expect(runClose(run(agents, { firstForecast: { lowUsd: 8, highUsd: 12 } })).verdict).toBe('within');
    expect(runClose(run(agents, { firstForecast: { lowUsd: 20, highUsd: 30 } })).verdict).toBe('under');
    expect(runClose(run(agents)).verdict).toBeNull();
    const unpriced = runClose(run([agent({ agentId: 'a', costUsd: null })], { firstForecast: { lowUsd: 1, highUsd: 2 } }));
    expect(unpriced.verdict).toBeNull();
    expect(unpriced.byPhase[0]?.costUsd).toBeNull();
  });
});

describe('escenario "y si"', () => {
  const rows: WhatIfRow[] = [
    { role: 'explorer', model: 'claude-opus-5-5', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: 4 },
    { role: 'builder', model: 'claude-opus-5-5', tokens: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: 20 },
  ];
  const haiku = { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 };
  const prices = new Map([['claude-haiku-5-5', haiku]]);

  it('recotiza solo los roles que cambian de modelo', () => {
    expect(repriced(rows[1] as WhatIfRow, haiku)).toBeCloseTo(0.5, 9);
    expect(whatIfTotal(rows, {}, prices)).toBe(24);
    expect(whatIfTotal(rows, { explorer: 'claude-haiku-5-5' }, prices)).toBeCloseTo(20.1, 9);
    // un modelo que no esta en la lista deja la fila como estaba
    expect(whatIfTotal(rows, { builder: 'no-existe' }, prices)).toBe(24);
  });
});

describe('piezas sueltas', () => {
  it('el cambio contra el periodo anterior no da porcentajes sin sentido', () => {
    expect(changeText(120, 100)).toBe(' · +20 %');
    expect(changeText(80, 100)).toBe(' · −20 %');
    expect(changeText(1500, 0.95)).toBe('');
    expect(changeText(5000, 100)).toBe(' · más de 10 veces');
  });

  it('los filtros de tareas vacios no viajan', () => {
    expect(taskQueryString({}, null)).toBe('/api/history/tasks');
    expect(taskQueryString({ q: ' dtf ', project: '', kind: 'lead', minUsd: '5' }, 'abc')).toBe(
      '/api/history/tasks?q=dtf&kind=lead&minUsd=5&cursor=abc',
    );
  });

  it('vista ligera por ?lite=1', () => {
    expect(isLiteMode('?lite=1')).toBe(true);
    expect(isLiteMode('?lite')).toBe(true);
    expect(isLiteMode('?lite=0')).toBe(false);
    expect(isLiteMode('?demo=1')).toBe(false);
  });
});

describe('pendientes generales', () => {
  const note = (id: string, done: boolean, createdAt: string, updatedAt = createdAt) => ({ id, text: `tarea ${id}`, done, createdAt, updatedAt });
  const todos = [
    note('b', false, '2026-03-11T10:00:00.000Z'),
    note('viejo', true, '2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
    note('a', false, '2026-03-10T10:00:00.000Z'),
    note('reciente', true, '2026-03-05T10:00:00.000Z', '2026-03-11T09:00:00.000Z'),
  ];

  it('por hacer en el orden en que se escribieron; hechos con el ultimo marcado primero', () => {
    const view = todoView(todos);
    expect(view.pending.map((t) => t.id)).toEqual(['a', 'b']);
    expect(view.done.map((t) => t.id)).toEqual(['reciente', 'viejo']);
    expect(pendingTodos(todos)).toHaveLength(2);
    expect(pendingTodos(undefined)).toEqual([]);
  });

  it('resumen y texto para copiar', () => {
    expect(todoSummary(todoView(todos))).toBe('2 por hacer · 2 hechos');
    expect(todoSummary(todoView([todos[1] as (typeof todos)[number]]))).toBe('Nada por hacer · 1 hecho');
    expect(todoSummary(todoView([]))).toBe('Sin pendientes');
    expect(todoText(todoView([...todos, { ...note('c', false, '2026-03-12T10:00:00.000Z'), text: 'uno\ndos' }]))).toBe(
      '1. tarea a\n2. tarea b\n3. uno\n   dos',
    );
  });

  it('la tecla P abre o cierra los pendientes', () => {
    expect(letterAction('p', { historyOpen: false, historyTab: 'budget' })).toBe('toggle-todo');
    expect(letterAction('P', { historyOpen: true, historyTab: 'habits' })).toBe('toggle-todo');
  });
});
