// Snapshot de demostracion (?demo=1). Datos OBVIAMENTE ficticios: salas "demo", tareas "de ejemplo".
// Es determinista para un nowMs dado y va cambiando en el tiempo para lucir las animaciones:
// un agente entra y sale cada 90 s, las acciones rotan cada 8 s, los agentes cambian de lugar cada 20 s
// (puesto, biblioteca, laboratorio, reunion, revision, puerta), el lider cambia de sala cada 45 s y un
// flujo de ejemplo en la sala B pasa por sus 3 fases cada 120 s. La sala B tiene una alerta de ejemplo
// y un agente alertado. Cada agente es una persona distinta. Sin leadName: la demo no pide nombre.

import type {
  AgentPlace,
  AgentRole,
  AgentStatus,
  CurrentAction,
  LiveAlert,
  OfficeAgent,
  OfficeRoom,
  OfficeSnapshot,
  TokenBreakdown,
  WorkflowAgentRef,
  WorkflowPhase,
  WorkflowRole,
  WorkflowRun,
} from '@shared/contract';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import { LEAD_PERSONA, PERSONA_BY_TYPE, personaName } from '@shared/personas';

const HOUR_MS = 3_600_000;
const CYCLE_MS = 90_000;
const ACTION_MS = 8_000;
const PLACE_MS = 20_000;

/** herramienta y etiqueta de ejemplo segun el lugar (como las ubica el server: place.ts) */
const PLACE_ACTIONS: Readonly<Record<AgentPlace, readonly [string, string][]>> = {
  desk: [
    ['Edit', 'Editando archivo de ejemplo'],
    ['Write', 'Escribiendo borrador de ejemplo'],
  ],
  library: [
    ['Read', 'Leyendo notas de ejemplo'],
    ['Grep', 'Buscando en el proyecto demo'],
  ],
  lab: [['Bash', 'Ejecutando pruebas de ejemplo']],
  meeting: [['Agent', 'Lanzando un agente de ejemplo']],
  review: [['Read', 'Revisando un archivo de ejemplo']],
  door: [['AskUserQuestion', 'Esperando una respuesta de ejemplo']],
  coffee: [],
  sleep: [],
};

type Mode = 'typing' | 'thinking' | 'mixed';

interface AgentSpec {
  id: string;
  kind: 'lead' | 'subagent';
  agentType: string;
  displayName?: string;
  deskIndex: number;
  title: string | null;
  status: AgentStatus;
  mode: Mode;
  startedAtMs: number;
  endedAtMs?: number | null;
  /** desfase para que no todos cambien de accion a la vez */
  phase: number;
  /** tokens por minuto de trabajo (ficticio) */
  rate: number;
  /** persona unica (por defecto la del tipo) */
  persona?: string;
  model?: string;
  detail?: string;
  workflow?: OfficeAgent['workflow'];
  role?: AgentRole;
  /** lugares por los que rota cada PLACE_MS (sin esto: su puesto) */
  places?: readonly AgentPlace[];
  alert?: LiveAlert;
}

const iso = (ms: number) => new Date(ms).toISOString();

function tokens(input: number, output: number, cacheRead: number, cacheWrite: number): TokenBreakdown {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function sumTokens(list: readonly TokenBreakdown[]): TokenBreakdown {
  return list.reduce(
    (acc, t) => tokens(acc.input + t.input, acc.output + t.output, acc.cacheRead + t.cacheRead, acc.cacheWrite + t.cacheWrite),
    tokens(0, 0, 0, 0),
  );
}

function demoCost(t: TokenBreakdown): number {
  return Math.round(((t.input * 3 + t.output * 15 + t.cacheRead * 0.3 + t.cacheWrite * 3.75) / 1_000_000) * 100) / 100;
}

function makeAgent(nowMs: number, spec: AgentSpec): OfficeAgent {
  const end = spec.endedAtMs ?? null;
  const minutes = Math.max(0, ((end ?? nowMs) - spec.startedAtMs) / 60_000);
  const slot = Math.floor((nowMs + spec.phase) / ACTION_MS);
  const places: readonly AgentPlace[] = spec.places ?? ['desk'];
  const place = places[Math.floor((nowMs + spec.phase * 7) / PLACE_MS) % places.length] ?? 'desk';
  let action: CurrentAction | null = null;
  if (spec.status === 'working') {
    const thinking = spec.mode === 'thinking' || (spec.mode === 'mixed' && slot % 3 === 2);
    const options = PLACE_ACTIONS[place];
    const pick = options[(slot + Math.round(spec.phase / 1000)) % Math.max(1, options.length)];
    if (!thinking && pick) action = { tool: pick[0], label: pick[1], startedAt: iso(slot * ACTION_MS - spec.phase) };
  }
  const k = spec.rate;
  const tok = tokens(
    Math.round(900 + minutes * 260 * k),
    Math.round(300 + minutes * 90 * k),
    Math.round(6_000 + minutes * 2_100 * k),
    Math.round(1_200 + minutes * 160 * k),
  );
  const persona = spec.persona ?? (spec.kind === 'lead' ? LEAD_PERSONA : (PERSONA_BY_TYPE[spec.agentType] ?? 'gael'));
  const agent: OfficeAgent = {
    id: spec.id,
    kind: spec.kind,
    agentType: spec.agentType,
    displayName: spec.displayName ?? (spec.kind === 'lead' ? DEFAULT_LEAD_NAME :personaName(persona)),
    persona,
    status: spec.status,
    task: spec.title
      ? {
          title: spec.title,
          ...(spec.detail ? { detail: spec.detail } : {}),
          startedAt: iso(spec.startedAtMs),
          endedAt: end === null ? null : iso(end),
        }
      : null,
    action,
    model: spec.model ?? 'claude-sonnet-4-6',
    tokens: tok,
    costUsd: demoCost(tok),
    deskIndex: spec.deskIndex,
    place,
    alert: spec.alert && spec.status !== 'done' ? spec.alert : null,
  };
  if (spec.workflow) agent.workflow = spec.workflow;
  const role = spec.role ?? spec.workflow?.role;
  if (role) agent.role = role;
  return agent;
}

// ---- flujo de ejemplo: 3 fases que avanzan en un ciclo de 120 s ----

const FLOW_CYCLE_MS = 120_000;
const FLOW_RUN = 'wf_demo';
const FLOW_NAME = 'flujo-de-ejemplo';

interface FlowSpec {
  id: string;
  label: string;
  phase: string;
  role: WorkflowRole;
  agentType: string;
  persona: string;
  model: string;
  title: string;
  deskIndex: number;
  /** segundos del ciclo en que trabaja */
  from: number;
  to: number;
}

const FLOW_PHASES = ['Exploracion', 'Construccion', 'Revision'] as const;

/** lugares de cada rol del flujo (revision es de pie en su mesa mientras trabaja) */
const FLOW_PLACES: Readonly<Partial<Record<WorkflowRole, readonly AgentPlace[]>>> = {
  explorer: ['library'],
  builder: ['desk', 'lab', 'desk'],
  reviewer: ['review'],
};

const FLOW_AGENTS: readonly FlowSpec[] = [
  { id: 'demo-flujo-explora', label: 'explora:mapa', phase: 'Exploracion', role: 'explorer', agentType: 'Explore', persona: 'lucia', model: 'claude-haiku-4-5', title: 'Explorando diseño · ejemplo-kit.html', deskIndex: 4, from: 0, to: 40 },
  { id: 'demo-flujo-interfaz', label: 'impl:interfaz', phase: 'Construccion', role: 'builder', agentType: 'tr-builder', persona: 'nico', model: 'claude-sonnet-4-6', title: 'Construyendo interfaz · Ejemplo.tsx', deskIndex: 3, from: 40, to: 88 },
  { id: 'demo-flujo-backend', label: 'impl:backend', phase: 'Construccion', role: 'builder', agentType: 'tr-builder', persona: 'vera', model: 'claude-opus-5-5', title: 'Construyendo backend · ejemplo.ts', deskIndex: 2, from: 44, to: 92 },
  { id: 'demo-flujo-revisa', label: 'revisa:pruebas', phase: 'Revision', role: 'reviewer', agentType: 'claude-code-guide', persona: 'simon', model: 'claude-fable-5-1', title: 'Revisando pruebas · ejemplo.test.ts', deskIndex: 4, from: 92, to: 118 },
];

/** agentes del flujo visibles en la sala (trabajando o recien terminados) y la corrida completa */
function demoFlow(nowMs: number): { visible: OfficeAgent[]; run: WorkflowRun } {
  const cycle = Math.floor(nowMs / FLOW_CYCLE_MS);
  const start = cycle * FLOW_CYCLE_MS;
  const t = (nowMs - start) / 1000;
  const visible: OfficeAgent[] = [];
  const refs: WorkflowAgentRef[] = [];
  for (const f of FLOW_AGENTS) {
    if (t < f.from) continue;
    const done = t >= f.to;
    const agent = makeAgent(nowMs, {
      id: `${f.id}-${cycle}`,
      kind: 'subagent',
      agentType: f.agentType,
      persona: f.persona,
      model: f.model,
      deskIndex: f.deskIndex,
      title: f.title,
      detail: `${f.phase} · ${f.label}`,
      status: done ? 'done' : 'working',
      mode: f.role === 'reviewer' ? 'mixed' : 'typing',
      startedAtMs: start + f.from * 1000,
      endedAtMs: done ? start + f.to * 1000 : null,
      phase: f.from * 100,
      rate: 1.2,
      workflow: { runId: FLOW_RUN, name: FLOW_NAME, phase: f.phase, label: f.label, sourceType: 'workflow-subagent', role: f.role },
      places: FLOW_PLACES[f.role] ?? ['desk'],
    });
    if (!done || t < f.to + 6) visible.push(agent);
    refs.push({
      agentId: agent.id,
      label: f.label,
      phase: f.phase,
      displayName: agent.displayName,
      agentType: f.agentType,
      role: f.role,
      persona: f.persona,
      status: done ? 'done' : 'working',
      model: f.model,
      tokens: agent.tokens,
      costUsd: agent.costUsd,
      startedAt: agent.task?.startedAt ?? iso(start),
      endedAt: agent.task?.endedAt ?? null,
    });
  }
  const phases: WorkflowPhase[] = FLOW_PHASES.map((title) => {
    const list = refs.filter((r) => r.phase === title);
    const working = list.some((r) => r.status === 'working');
    return {
      title,
      status: working ? 'running' : list.length > 0 ? 'done' : 'pending',
      agentsStarted: list.length,
      agentsDone: list.filter((r) => r.status !== 'working').length,
    };
  });
  const tok = sumTokens(refs.map((r) => r.tokens));
  return {
    visible,
    run: {
      runId: FLOW_RUN,
      name: FLOW_NAME,
      description: 'Flujo ficticio de demostración: explora, construye y revisa',
      status: 'running',
      startedAt: iso(start),
      endedAt: null,
      phases,
      agents: refs,
      tokens: tok,
      costUsd: Math.round(refs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100,
    },
  };
}

function makeRoom(
  base: Omit<OfficeRoom, 'tokens' | 'costUsd' | 'lead' | 'subagents'>,
  lead: OfficeAgent,
  subagents: OfficeAgent[],
): OfficeRoom {
  const all = [lead, ...subagents];
  return {
    ...base,
    lead,
    subagents,
    tokens: sumTokens(all.map((a) => a.tokens)),
    costUsd: Math.round(all.reduce((s, a) => s + (a.costUsd ?? 0), 0) * 100) / 100,
  };
}

/** Estado de un agente que entra, trabaja, termina y se va dentro de cada ciclo de 90 s */
function cycling(
  nowMs: number,
  window: { from: number; to: number; doneFor: number },
  spec: Omit<AgentSpec, 'id' | 'status' | 'startedAtMs' | 'endedAtMs'> & { idPrefix: string },
): OfficeAgent | null {
  const cycleStart = Math.floor(nowMs / CYCLE_MS) * CYCLE_MS;
  const t = (nowMs - cycleStart) / 1000;
  if (t < window.from || t >= window.to + window.doneFor) return null;
  const done = t >= window.to;
  const { idPrefix, ...rest } = spec;
  return makeAgent(nowMs, {
    ...rest,
    id: `${idPrefix}-${Math.floor(nowMs / CYCLE_MS)}`,
    status: done ? 'done' : 'working',
    startedAtMs: cycleStart + window.from * 1000,
    endedAtMs: done ? cycleStart + window.to * 1000 : null,
  });
}

export function createMockSnapshot(nowMs: number): OfficeSnapshot {
  const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const ago = (min: number) => hourStart - min * 60_000;

  const leadA = makeAgent(nowMs, {
    id: 'demo-sala-a-lider',
    kind: 'lead',
    agentType: 'lead',
    displayName: DEFAULT_LEAD_NAME,
    deskIndex: 0,
    title: 'Tarea de ejemplo del líder',
    status: 'working',
    mode: 'mixed',
    startedAtMs: ago(12),
    phase: 1_500,
    rate: 1.4,
    role: 'orchestrator',
    places: ['desk', 'library', 'lab', 'desk', 'meeting'],
  });
  const subsA = [
    makeAgent(nowMs, {
      id: 'demo-agente-bruno',
      kind: 'subagent',
      agentType: 'tr-builder',
      deskIndex: 6,
      title: 'Ejemplo: construir un componente ficticio',
      status: 'working',
      mode: 'typing',
      startedAtMs: ago(9),
      phase: 0,
      rate: 1.1,
      role: 'builder',
      places: ['desk', 'desk', 'lab'],
    }),
    makeAgent(nowMs, {
      id: 'demo-agente-elena',
      kind: 'subagent',
      agentType: 'Explore',
      deskIndex: 5,
      title: 'Ejemplo: explorar un repositorio de prueba',
      status: 'working',
      mode: 'mixed',
      startedAtMs: ago(6),
      phase: 3_000,
      rate: 0.8,
      role: 'explorer',
      places: ['library', 'library', 'desk'],
    }),
    makeAgent(nowMs, {
      id: 'demo-agente-dora',
      kind: 'subagent',
      agentType: 'tr-docs',
      deskIndex: 4,
      title: 'Ejemplo: documentar un módulo de prueba',
      status: 'idle',
      mode: 'typing',
      startedAtMs: ago(20),
      phase: 5_000,
      rate: 0.5,
      role: 'docs',
    }),
    makeAgent(nowMs, {
      id: 'demo-agente-gael',
      kind: 'subagent',
      agentType: 'general-purpose',
      deskIndex: 3,
      title: 'Ejemplo: tarea general de prueba',
      status: 'working',
      mode: 'thinking',
      startedAtMs: ago(3),
      phase: 6_500,
      rate: 0.9,
      role: 'generalist',
    }),
    cycling(nowMs, { from: 10, to: 62, doneFor: 7 }, {
      idPrefix: 'demo-agente-paula',
      kind: 'subagent',
      agentType: 'Plan',
      deskIndex: 2,
      title: 'Ejemplo: planear una tarea ficticia',
      mode: 'mixed',
      phase: 2_000,
      rate: 1,
      role: 'planner',
      places: ['library', 'desk'],
    }),
  ].filter((a): a is OfficeAgent => a !== null);

  const leadB = makeAgent(nowMs, {
    id: 'demo-sala-b-lider',
    kind: 'lead',
    agentType: 'lead',
    displayName: DEFAULT_LEAD_NAME,
    deskIndex: 0,
    title: 'Consulta de ejemplo ya respondida',
    status: 'idle',
    mode: 'typing',
    startedAtMs: ago(25),
    endedAtMs: ago(18),
    phase: 0,
    rate: 1,
    role: 'orchestrator',
    // espera una respuesta de ejemplo (sin el lider en la sala: el rotulo lo avisa) o toma cafe
    places: ['door', 'door', 'coffee'],
  });
  const subsB = [
    makeAgent(nowMs, {
      id: 'demo-agente-marco',
      kind: 'subagent',
      agentType: 'tr-explorer',
      deskIndex: 6,
      title: 'Ejemplo: inventariar archivos de prueba',
      status: 'working',
      mode: 'typing',
      startedAtMs: ago(4),
      phase: 4_000,
      rate: 0.7,
      role: 'explorer',
      places: ['library', 'lab'],
      alert: { level: 'warning', title: 'Ejemplo: falló 2 veces seguidas', source: 'errors' },
    }),
    makeAgent(nowMs, {
      id: 'demo-agente-guido',
      kind: 'subagent',
      agentType: 'claude-code-guide',
      deskIndex: 5,
      title: 'Ejemplo: responder una duda ficticia',
      status: 'working',
      mode: 'mixed',
      startedAtMs: ago(7),
      phase: 1_000,
      rate: 0.6,
      role: 'reviewer',
      places: ['review'],
    }),
    cycling(nowMs, { from: 30, to: 80, doneFor: 6 }, {
      idPrefix: 'demo-agente-iris',
      kind: 'subagent',
      agentType: 'general-purpose',
      persona: 'iris',
      deskIndex: -1,
      title: 'Ejemplo: tarea sin escritorio libre',
      mode: 'mixed',
      phase: 3_500,
      rate: 0.8,
      role: 'generalist',
      places: ['lab', 'desk'],
    }),
  ].filter((a): a is OfficeAgent => a !== null);
  const flow = demoFlow(nowMs);
  subsB.push(...flow.visible);

  const leadC = makeAgent(nowMs, {
    id: 'demo-sala-c-lider',
    kind: 'lead',
    agentType: 'lead',
    displayName: DEFAULT_LEAD_NAME,
    deskIndex: 0,
    title: null,
    status: 'idle',
    mode: 'typing',
    startedAtMs: ago(50),
    phase: 0,
    rate: 1,
    role: 'orchestrator',
    places: ['sleep'],
  });

  const rooms: OfficeRoom[] = [
    makeRoom(
      {
        id: 'demo-sala-a',
        projectName: 'demo',
        title: 'Sala demo · tarea de ejemplo',
        cwd: '/demo/proyecto-ejemplo',
        open: true,
        busy: true,
        lastActivityAt: iso(nowMs - 2_000),
      },
      leadA,
      subsA,
    ),
    makeRoom(
      {
        id: 'demo-sala-b',
        projectName: 'demo-b',
        title: 'Sala demo B',
        cwd: '/demo/proyecto-b',
        open: true,
        busy: false,
        lastActivityAt: iso(nowMs - 40_000),
        workflows: [flow.run],
        alert: { level: 'critical', title: 'Ejemplo: costo del día sobre el límite', source: 'rule', ruleId: 'session_day_cost' },
        habitCount: 2,
      },
      leadB,
      subsB,
    ),
    makeRoom(
      {
        id: 'demo-sala-c',
        projectName: 'demo-c',
        title: 'Sala demo cerrada',
        cwd: '/demo/proyecto-c',
        open: false,
        busy: false,
        lastActivityAt: iso(ago(45)),
      },
      leadC,
      [],
    ),
  ];

  const total = sumTokens(rooms.map((r) => r.tokens));
  return {
    generatedAt: iso(nowMs),
    leadRoomId: Math.floor(nowMs / 45_000) % 2 === 0 ? 'demo-sala-a' : 'demo-sala-b',
    rooms,
    today: { costUsd: Math.round(rooms.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100, tokens: total },
    habits: {
      active: 2,
      alerts: rooms.reduce((n, r) => n + (r.alert ? 1 : 0) + r.subagents.filter((a) => a.alert).length, 0),
      savingsUsd: 0.42,
      notifyBrowser: false,
    },
  };
}
