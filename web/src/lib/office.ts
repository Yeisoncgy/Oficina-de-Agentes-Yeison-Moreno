import type {
  AgentPlace,
  AgentRole,
  AgentStatus,
  LiveAlert,
  OfficeAgent,
  OfficeRoom,
  OfficeSnapshot,
  TokenBreakdown,
} from '@shared/contract';
import { findAgent } from '@/state/store';
import { formatDayMonth, formatTimeOfDay, formatUsd } from './format';
import { localDateKey } from './history';

export function roomAgents(room: OfficeRoom): OfficeAgent[] {
  return [room.lead, ...room.subagents];
}

export interface RoomStats {
  working: number;
  /** agentes que siguen en la sala (sin contar los que ya salen) */
  present: number;
}

export function roomStats(room: OfficeRoom): RoomStats {
  let working = 0;
  let present = 0;
  for (const agent of roomAgents(room)) {
    if (agent.status === 'working') working += 1;
    if (agent.status !== 'done') present += 1;
  }
  return { working, present };
}

export function workingAgentsCount(snapshot: OfficeSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.rooms.reduce((sum, room) => sum + roomStats(room).working, 0);
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Trabajando',
  idle: 'Inactivo',
  done: 'Terminó',
};

/** Lo que hace el agente ahora mismo, en una linea */
export function activityText(agent: OfficeAgent): string {
  if (agent.status === 'done') return 'Terminó su tarea';
  if (agent.status === 'idle') return agent.kind === 'lead' ? 'Esperando el siguiente prompt' : 'En espera';
  return agent.action?.label ?? 'Pensando';
}

/** Hora de ultima actividad: 21:12 · ayer 19:40 · 20 sep */
export function formatLastActivity(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const key = localDateKey(ms);
  if (key === localDateKey(nowMs)) return formatTimeOfDay(ms);
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(yesterday.getTime())) return `ayer ${formatTimeOfDay(ms)}`;
  return formatDayMonth(ms, nowMs);
}

/** Sin nadie trabajando y sin actividad en este tiempo, la sala se ve apagada en la lista */
export const ROOM_INACTIVE_AFTER_MS = 15 * 60_000;

export type RoomState = 'working' | 'waiting' | 'inactive' | 'closed';

export const ROOM_STATE_LABEL: Record<RoomState, string> = {
  working: 'Trabajando',
  waiting: 'En espera',
  inactive: 'Inactiva',
  closed: 'Cerrada',
};

export function roomState(room: OfficeRoom, nowMs: number): RoomState {
  if (room.busy || roomStats(room).working > 0) return 'working';
  if (!room.open) return 'closed';
  const at = Date.parse(room.lastActivityAt);
  return Number.isNaN(at) || nowMs - at >= ROOM_INACTIVE_AFTER_MS ? 'inactive' : 'waiting';
}

/** "ahora" · "hace 12 min" · "hace 3 h" y, de ahi en adelante, la hora o el dia */
export function formatAgo(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const min = Math.floor((nowMs - ms) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  if (min < 6 * 60) return `hace ${Math.floor(min / 60)} h`;
  return formatLastActivity(iso, nowMs);
}

/** Linea de estado de una sala en la lista: cuantos trabajan o hace cuanto fue la ultima actividad */
export function roomStatusText(room: OfficeRoom, nowMs: number): string {
  const state = roomState(room, nowMs);
  if (state !== 'working') return `${ROOM_STATE_LABEL[state]} · ${formatAgo(room.lastActivityAt, nowMs)}`;
  const { working } = roomStats(room);
  return working > 0 ? `Trabajando · ${working} ${working === 1 ? 'agente' : 'agentes'}` : 'Trabajando';
}

export type ToolKind = 'read' | 'edit' | 'write' | 'shell' | 'search' | 'agent' | 'web' | 'todo' | 'other';

/** Familia de una herramienta de Claude Code, para elegir su icono */
export function toolKind(tool: string): ToolKind {
  const t = tool.toLowerCase();
  if (t === 'read' || t === 'notebookread') return 'read';
  if (t === 'edit' || t === 'multiedit' || t === 'notebookedit') return 'edit';
  if (t === 'write') return 'write';
  if (t === 'bash' || t === 'bashoutput' || t === 'killshell' || t === 'powershell') return 'shell';
  if (t === 'grep' || t === 'glob' || t === 'ls' || t === 'toolsearch') return 'search';
  if (t === 'agent' || t === 'task' || t === 'skill') return 'agent';
  if (t === 'webfetch' || t === 'websearch') return 'web';
  if (t === 'todowrite' || t === 'todoread') return 'todo';
  return 'other';
}

export type ActionKind = 'tool' | 'thinking' | 'idle' | 'done';

export interface ActionView {
  kind: ActionKind;
  /** texto de la fila de accion */
  label: string;
  /** nombre tecnico de la herramienta (solo 'tool') */
  tool: string | null;
  /** inicio de la accion (solo 'tool'): su cronometro */
  startedAt: string | null;
  /** cambia cuando llega una accion nueva: dispara la animacion de llegada */
  key: string;
}

/** Estado de la fila de accion del panel y de la tarjeta (D3) */
export function actionView(agent: OfficeAgent, gone: boolean, endIso: string | null): ActionView {
  if (gone || agent.status === 'done') {
    const end = endIso ?? agent.task?.endedAt ?? null;
    return {
      kind: 'done',
      label: end ? `Terminó a las ${formatTimeOfDay(end)}` : 'Terminó',
      tool: null,
      startedAt: null,
      key: 'done',
    };
  }
  if (agent.status === 'idle') {
    return {
      kind: 'idle',
      label: agent.kind === 'lead' ? 'Esperando el siguiente prompt' : 'Sin acción en curso',
      tool: null,
      startedAt: null,
      key: 'idle',
    };
  }
  if (agent.action) {
    return {
      kind: 'tool',
      label: agent.action.label,
      tool: agent.action.tool,
      startedAt: agent.action.startedAt,
      key: `tool:${agent.action.startedAt}:${agent.action.tool}:${agent.action.label}`,
    };
  }
  return { kind: 'thinking', label: 'Pensando', tool: null, startedAt: null, key: 'thinking' };
}

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export interface TokenSegment {
  key: TokenKind;
  label: string;
  /** etiqueta corta para la tarjeta flotante */
  short: string;
  value: number;
  /** 0..1 del total */
  share: number;
  /** 0..1 respecto del mayor de los cuatro (largo de la barra del panel) */
  ofMax: number;
}

export const TOKEN_LABELS: Record<TokenKind, string> = {
  input: 'Entrada',
  output: 'Salida',
  cacheRead: 'Caché lectura',
  cacheWrite: 'Caché escritura',
};

const TOKEN_SHORT: Record<TokenKind, string> = {
  input: 'Entrada',
  output: 'Salida',
  cacheRead: 'Caché L',
  cacheWrite: 'Caché E',
};

export function tokenSegments(tokens: TokenBreakdown): TokenSegment[] {
  const keys: TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const sum = keys.reduce((acc, key) => acc + Math.max(0, tokens[key]), 0);
  const denom = tokens.total > 0 ? Math.max(tokens.total, sum) : sum;
  const max = keys.reduce((acc, key) => Math.max(acc, tokens[key]), 0);
  return keys.map((key) => {
    const value = Math.max(0, tokens[key]);
    return {
      key,
      label: TOKEN_LABELS[key],
      short: TOKEN_SHORT[key],
      value,
      share: denom > 0 ? value / denom : 0,
      ofMax: max > 0 ? value / max : 0,
    };
  });
}

// ---- identidad, lugar y alertas ----

export const PLACE_LABEL: Record<AgentPlace, string> = {
  desk: 'Escritorio',
  library: 'Biblioteca',
  lab: 'Laboratorio',
  meeting: 'Reunión',
  review: 'Revisión',
  door: 'Puerta: espera tu respuesta',
  coffee: 'Café',
  sleep: 'Dormido',
};

/** Rol de primer nivel; sin el campo (demo, fixtures): el lead es el Orquestador y el de flujo trae el suyo */
export function agentRole(agent: OfficeAgent): AgentRole | null {
  if (agent.role) return agent.role;
  if (agent.kind === 'lead') return 'orchestrator';
  return agent.workflow?.role ?? null;
}

/**
 * Quien lanzo al agente. lead: el lider de la sesion (parentId = sessionId) · agent: un subagente que sigue
 * en la oficina · gone: un subagente que ya salio (no se inventa su nombre) · none: es el lead, o el
 * snapshot no trajo el dato.
 */
export type AgentParent =
  | { kind: 'lead'; id: string }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'gone'; id: string }
  | { kind: 'none' };

export interface AgentIdentity {
  role: AgentRole | null;
  place: AgentPlace | null;
  projectName: string;
  /** rama git de la sesion; null sin git */
  branch: string | null;
  parent: AgentParent;
  /**
   * subagentes que lanzo con Agent/Task en toda su vida (childCount; sin el dato, los que se ven). Los
   * agentes de flujo no entran: el server no los cuenta en childCount
   */
  childCount: number;
  /** los de childCount que siguen en la oficina, en el orden de la sala */
  children: { id: string; name: string }[];
  /** agentes de flujo (tool Workflow) que siguen en la oficina: el lead los lanza, aparte de childCount */
  flowChildren: { id: string; name: string }[];
  startedAt: string | null;
  lastActivityAt: string | null;
}

function isLeadRef(id: string, room: OfficeRoom): boolean {
  return id === room.id || id === room.lead.id;
}

function parentOf(agent: OfficeAgent, room: OfficeRoom, snapshot: OfficeSnapshot | null): AgentParent {
  const id = agent.parentId;
  if (agent.kind === 'lead' || !id) return { kind: 'none' };
  if (isLeadRef(id, room)) return { kind: 'lead', id: room.lead.id };
  // la sala de la seleccion puede ser la ultima foto (agente que ya salio): tambien se busca ahi
  const parent = findAgent(snapshot, id)?.agent ?? room.subagents.find((a) => a.id === id);
  return parent ? { kind: 'agent', id, name: parent.displayName } : { kind: 'gone', id };
}

/** Ficha del panel del agente: todo sale del snapshot, sin texto de prompts */
export function agentIdentity(agent: OfficeAgent, room: OfficeRoom, snapshot: OfficeSnapshot | null): AgentIdentity {
  const launchedBy = (a: OfficeAgent): boolean =>
    !!a.parentId && (agent.kind === 'lead' ? isLeadRef(a.parentId, room) : a.parentId === agent.id);
  const launched = room.subagents.filter((a) => a.id !== agent.id && launchedBy(a));
  const toRef = (a: OfficeAgent) => ({ id: a.id, name: a.displayName });
  // los de flujo cuelgan del lead (parentId = sessionId) pero childCount solo cuenta Agent/Task: mezclarlos
  // daria un total corto y taparia los que ya salieron
  const children = launched.filter((a) => !a.workflow).map(toRef);
  const flowChildren = launched.filter((a) => a.workflow).map(toRef);
  const branch = room.gitBranch && room.gitBranch !== 'HEAD' ? room.gitBranch : null;
  return {
    role: agentRole(agent),
    place: agent.place ?? null,
    projectName: room.projectName,
    branch,
    parent: parentOf(agent, room, snapshot),
    childCount: Math.max(agent.childCount ?? 0, children.length),
    children,
    flowChildren,
    startedAt: agent.startedAt ?? null,
    lastActivityAt: agent.lastActivityAt ?? null,
  };
}

/**
 * Fila "Subagentes": total = lanzados con Agent/Task en toda su vida + agentes de flujo presentes; los que
 * ya salieron se cuentan solo contra childCount (de los de flujo que salieron no hay dato)
 */
export function childrenTotals(identity: Pick<AgentIdentity, 'childCount' | 'children' | 'flowChildren'>): {
  total: number;
  left: number;
} {
  return {
    total: identity.childCount + identity.flowChildren.length,
    left: Math.max(0, identity.childCount - identity.children.length),
  };
}

/** "office-site · main" o solo el proyecto sin git */
export function projectBranchText(identity: Pick<AgentIdentity, 'projectName' | 'branch'>): string {
  return identity.branch ? `${identity.projectName} · ${identity.branch}` : identity.projectName;
}

export const ALERT_LEVEL_LABEL: Record<LiveAlert['level'], string> = {
  warning: 'Aviso',
  critical: 'Alerta crítica',
};

const ALERT_RANK: Record<LiveAlert['level'], number> = { warning: 1, critical: 2 };

/** La mas severa; en empate, la primera */
function worstAlert(alerts: readonly (LiveAlert | null | undefined)[]): LiveAlert | null {
  let worst: LiveAlert | null = null;
  for (const alert of alerts) {
    if (alert && (!worst || ALERT_RANK[alert.level] > ALERT_RANK[worst.level])) worst = alert;
  }
  return worst;
}

/**
 * Alerta del panel del agente: la suya. El lead ve la mas severa entre la suya y la de su sala (reglas de
 * sesion y corrida); en empate gana la de la sala, como en roomAlert, para que el panel y la lista coincidan
 */
export function drawerAlert(agent: OfficeAgent, room: OfficeRoom): LiveAlert | null {
  if (agent.kind !== 'lead') return agent.alert ?? null;
  return worstAlert([room.alert, agent.alert]);
}

/**
 * Alerta de una sala en la lista: la de la sala o la mas severa de sus agentes presentes (los que ya salen
 * no cuentan). En empate gana la de la sala. agentName dice de quien es si no es de la sala.
 */
export function roomAlert(room: OfficeRoom): { alert: LiveAlert; agentName: string | null } | null {
  const agents = roomAgents(room).filter((a) => a.status !== 'done' && a.alert);
  const alert = worstAlert([room.alert, ...agents.map((a) => a.alert)]);
  if (!alert) return null;
  if (alert === room.alert) return { alert, agentName: null };
  return { alert, agentName: agents.find((a) => a.alert === alert)?.displayName ?? null };
}

export interface HabitsBadge {
  /** alert: hay alertas rojas vivas · findings: solo hallazgos · quiet: nada vivo (o sin datos) */
  tone: 'alert' | 'findings' | 'quiet';
  /** numero de la insignia: alertas si las hay; si no, hallazgos */
  count: number;
  /** texto completo para el lector de pantalla y el tooltip */
  label: string;
}

/** Insignia de la barra superior (snapshot.habits); abre el historial en Habitos */
export function habitsBadge(habits: OfficeSnapshot['habits']): HabitsBadge {
  if (!habits) return { tone: 'quiet', count: 0, label: 'Hábitos: sin datos del motor de hábitos. Abrir hábitos' };
  const parts: string[] = [];
  if (habits.alerts > 0) parts.push(habits.alerts === 1 ? '1 alerta roja' : `${habits.alerts} alertas rojas`);
  if (habits.active > 0) parts.push(habits.active === 1 ? '1 hallazgo vivo' : `${habits.active} hallazgos vivos`);
  if (habits.savingsUsd > 0) parts.push(`ahorro estimado ${formatUsd(habits.savingsUsd)}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'sin alertas ni hallazgos vivos';
  const label = `Hábitos: ${summary}. Abrir hábitos`;
  if (habits.alerts > 0) return { tone: 'alert', count: habits.alerts, label };
  if (habits.active > 0) return { tone: 'findings', count: habits.active, label };
  return { tone: 'quiet', count: 0, label };
}

export interface SelectionView {
  room: OfficeRoom;
  agent: OfficeAgent;
  /** el agente ya no esta en el snapshot: se muestran sus ultimos datos */
  gone: boolean;
  /** generatedAt del ultimo snapshot donde aparecia */
  lastSeenAt: string;
}

/**
 * Agente seleccionado con memoria: si desaparece del snapshot se conserva su ultima foto
 * marcada como terminada, para que el panel no se cierre en la cara del usuario.
 */
export function resolveSelection(
  selectedId: string | null,
  snapshot: OfficeSnapshot | null,
  previous: SelectionView | null,
): SelectionView | null {
  if (!selectedId) return null;
  const found = findAgent(snapshot, selectedId);
  if (found && snapshot) return { room: found.room, agent: found.agent, gone: false, lastSeenAt: snapshot.generatedAt };
  if (!previous || previous.agent.id !== selectedId) return null;
  if (previous.gone) return previous;
  return {
    room: previous.room,
    agent: { ...previous.agent, status: 'done', action: null },
    gone: true,
    lastSeenAt: previous.lastSeenAt,
  };
}
