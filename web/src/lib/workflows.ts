// Logica pura del panel de Flujos (corridas del tool Workflow): orden, agrupacion por fase, tira del flujo,
// pronostico, resumen de la barra plegada, estado del dock, atajos del HUD y enlace agente -> panel del
// agente. Solo campos del contrato.
import type {
  AgentRole,
  BudgetRisk,
  OfficeAgent,
  OfficeRoom,
  OfficeSnapshot,
  WorkflowAgentRef,
  WorkflowForecast,
  WorkflowPhase,
  WorkflowRole,
  WorkflowRun,
  WorkflowStatus,
} from '@shared/contract';
import { findAgent, useOfficeStore, type FlowsDockPref, type HistoryTab, type HudLayer } from '@/state/store';
import { elapsedMs, formatClock, formatDuration, formatTimeOfDay, formatUsd } from './format';

export const RUN_STATUS_LABEL: Record<WorkflowStatus, string> = {
  running: 'En curso',
  done: 'Terminado',
  failed: 'Falló',
  stopped: 'Detenido',
};

/** Roles del contrato: el lead es el Orquestador; los agentes de flujo usan los demas */
export const ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: 'Orquestador',
  explorer: 'Investigación',
  builder: 'Desarrollo',
  reviewer: 'Revisión',
  tester: 'Pruebas',
  security: 'Seguridad',
  planner: 'Planificación',
  docs: 'Documentación',
  generalist: 'General',
};

/** Orden de la leyenda de Flujos (roles de un agente de flujo; el Orquestador es el lead) */
export const WORKFLOW_ROLES: readonly WorkflowRole[] = [
  'explorer',
  'builder',
  'reviewer',
  'tester',
  'security',
  'planner',
  'docs',
  'generalist',
];

export const PHASE_STATUS_LABEL: Record<WorkflowPhase['status'], string> = {
  pending: 'Pendiente',
  running: 'En curso',
  done: 'Terminada',
  failed: 'Fallida',
};

export const NO_PHASE_TITLE = 'Sin fase';

export interface FlowEntry {
  room: OfficeRoom;
  run: WorkflowRun;
}

export function isRunning(run: WorkflowRun): boolean {
  return run.status === 'running';
}

/** "flujo-de-ejemplo" -> "Flujo de ejemplo": guiones y guiones bajos a espacios, primera letra en mayuscula */
export function prettyRunName(name: string): string {
  const text = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return name.trim() || 'Flujo sin nombre';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function timeOf(iso: string | null): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** En curso primero (la mas reciente arriba); despues las terminadas de hoy, la ultima en terminar primero */
function compareEntries(a: FlowEntry, b: FlowEntry): number {
  const ar = isRunning(a.run);
  const br = isRunning(b.run);
  if (ar !== br) return ar ? -1 : 1;
  const diff = ar
    ? timeOf(b.run.startedAt) - timeOf(a.run.startedAt)
    : timeOf(b.run.endedAt ?? b.run.startedAt) - timeOf(a.run.endedAt ?? a.run.startedAt);
  return diff !== 0 ? diff : a.run.runId.localeCompare(b.run.runId);
}

/** Todas las corridas del snapshot (activas + terminadas hoy) con su sala */
export function collectRuns(snapshot: OfficeSnapshot | null): FlowEntry[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  const out: FlowEntry[] = [];
  for (const room of snapshot.rooms) {
    for (const run of room.workflows ?? []) {
      if (seen.has(run.runId)) continue;
      seen.add(run.runId);
      out.push({ room, run });
    }
  }
  return out.sort(compareEntries);
}

export function activeRunCount(snapshot: OfficeSnapshot | null): number {
  if (!snapshot) return 0;
  let n = 0;
  for (const room of snapshot.rooms) for (const run of room.workflows ?? []) if (isRunning(run)) n += 1;
  return n;
}

export function runCount(snapshot: OfficeSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.rooms.reduce((sum, room) => sum + (room.workflows?.length ?? 0), 0);
}

/** La corrida tal como viene en el snapshot (referencia estable para selectores del store) */
export function findRun(snapshot: OfficeSnapshot | null, runId: string): WorkflowRun | null {
  if (!snapshot) return null;
  for (const room of snapshot.rooms) {
    const run = room.workflows?.find((r) => r.runId === runId);
    if (run) return run;
  }
  return null;
}

export function roomActiveRuns(room: OfficeRoom): WorkflowRun[] {
  return (room.workflows ?? []).filter(isRunning);
}

/** Corrida que muestra el dock: la elegida si sigue en el snapshot; si no, la primera (activas primero) */
export function pickEntry(entries: readonly FlowEntry[], runId: string | null): FlowEntry | null {
  return (runId ? entries.find((e) => e.run.runId === runId) : undefined) ?? entries[0] ?? null;
}

/** "Fase 2 de 4": la ultima fase que ya arranco; null si el script no declaro fases */
export function phaseProgress(run: WorkflowRun): { current: number; total: number } | null {
  const total = run.phases.length;
  if (total === 0) return null;
  let current = 0;
  run.phases.forEach((phase, i) => {
    if (phase.status !== 'pending') current = i + 1;
  });
  return { current: Math.max(1, current), total };
}

export function runElapsedMs(run: WorkflowRun, nowMs: number): number {
  return elapsedMs(run.startedAt, run.endedAt, nowMs);
}

/** La fase que marca "Fase N de M" con su titulo; null si el script no declaro fases */
export function currentPhase(run: WorkflowRun): { index: number; phase: WorkflowPhase } | null {
  const progress = phaseProgress(run);
  const phase = progress ? run.phases[progress.current - 1] : undefined;
  return progress && phase ? { index: progress.current - 1, phase } : null;
}

export interface PhaseSegment {
  title: string;
  status: WorkflowPhase['status'];
  /** 0..1: terminada o fallida = 1 · en curso = agentes terminados / arrancados · pendiente = 0 */
  fill: number;
}

/**
 * Barra de progreso global: un segmento por fase. No hay porcentaje: una fase en curso puede lanzar mas
 * agentes, asi que "terminados / arrancados" solo rellena su segmento, nunca promete cuanto falta.
 */
export function runProgress(run: WorkflowRun): { segments: PhaseSegment[]; phasesDone: number; total: number } {
  const segments = run.phases.map((phase) => {
    let fill = 0;
    if (phase.status === 'done' || phase.status === 'failed') fill = 1;
    else if (phase.status === 'running' && phase.agentsStarted > 0) {
      fill = Math.min(1, Math.max(0, phase.agentsDone / phase.agentsStarted));
    }
    return { title: phase.title, status: phase.status, fill };
  });
  const phasesDone = run.phases.filter((p) => p.status === 'done' || p.status === 'failed').length;
  return { segments, phasesDone, total: run.phases.length };
}

export function phasesDoneText(done: number, total: number): string {
  return total === 1 ? `${done} de 1 fase terminada` : `${done} de ${total} fases terminadas`;
}

/** Texto del aria-live: cambia solo cuando cambia la fase o el estado de la corrida (no con los cronometros) */
export function phaseAnnouncement(run: WorkflowRun): string {
  const name = prettyRunName(run.name);
  if (!isRunning(run)) return `${name}: ${RUN_STATUS_LABEL[run.status].toLowerCase()}`;
  const now = currentPhase(run);
  if (!now) return `${name}: en curso`;
  return `${name}: fase ${now.index + 1} de ${run.phases.length}, ${now.phase.title}, ${PHASE_STATUS_LABEL[
    now.phase.status
  ].toLowerCase()}`;
}

// ---- agentes ----

export interface FlowAgentView {
  ref: WorkflowAgentRef;
  /** el mismo agente en room.subagents (accion y tokens en vivo); null si ya salio de la oficina */
  live: OfficeAgent | null;
  /** 1 = primer intento de esa etiqueta en esa fase */
  attempt: number;
  /** hay un intento posterior con la misma etiqueta en la misma fase */
  retried: boolean;
  /** intento fallido que se reintento: se muestra atenuado */
  dim: boolean;
  /** clave de look (persona o, si no llego, tipo): retrato, color y personaje */
  look: string;
  /** nombre de su persona */
  name: string;
  role: WorkflowRole;
  model: string | null;
  /** lo que hace de verdad (task.title del agente en la oficina) o, si ya salio, su etiqueta del script */
  work: string;
}

function attemptKey(ref: WorkflowAgentRef): string {
  // sin etiqueta no hay forma de saber si es un reintento: cada agente cuenta solo
  return ref.label ? `${ref.phase ?? ''}\u0000${ref.label}` : `\u0001${ref.agentId}`;
}

export function flowAgentViews(run: WorkflowRun, room: OfficeRoom | null): FlowAgentView[] {
  const totals = new Map<string, number>();
  for (const ref of run.agents) totals.set(attemptKey(ref), (totals.get(attemptKey(ref)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return run.agents.map((ref) => {
    const key = attemptKey(ref);
    const attempt = (seen.get(key) ?? 0) + 1;
    seen.set(key, attempt);
    const retried = attempt < (totals.get(key) ?? 0);
    const live = room?.subagents.find((a) => a.id === ref.agentId) ?? null;
    return {
      ref,
      live,
      attempt,
      retried,
      dim: retried && ref.status === 'failed',
      look: live?.persona ?? ref.persona ?? live?.agentType ?? ref.agentType,
      name: live?.displayName ?? ref.displayName,
      role: ref.role ?? live?.workflow?.role ?? 'generalist',
      model: live?.model ?? ref.model,
      work: live?.task?.title || ref.label || 'Sin etiqueta',
    };
  });
}

export interface FlowPhaseGroup {
  key: string;
  /** posicion en run.phases; -1 = fase que no declaro el script (o sin fase) */
  index: number;
  title: string;
  phase: WorkflowPhase | null;
  agents: FlowAgentView[];
}

/**
 * Agentes agrupados por fase en el orden del script. Las fases sin agentes tambien aparecen (pendientes);
 * los agentes de una fase que el script no declaro van al final, en orden de aparicion.
 */
export function groupAgentsByPhase(run: WorkflowRun, room: OfficeRoom | null): FlowPhaseGroup[] {
  const groups: FlowPhaseGroup[] = run.phases.map((phase, index) => ({
    key: `fase-${index}`,
    index,
    title: phase.title,
    phase,
    agents: [],
  }));
  const byTitle = new Map<string, FlowPhaseGroup>();
  for (const group of groups) if (!byTitle.has(group.title)) byTitle.set(group.title, group);
  const extras = new Map<string | null, FlowPhaseGroup>();
  for (const view of flowAgentViews(run, room)) {
    const title = view.ref.phase;
    let group = title === null ? undefined : byTitle.get(title);
    if (!group) {
      group = extras.get(title);
      if (!group) {
        group = { key: `extra-${extras.size}`, index: -1, title: title ?? NO_PHASE_TITLE, phase: null, agents: [] };
        extras.set(title, group);
        groups.push(group);
      }
    }
    group.agents.push(view);
  }
  return groups;
}

// ---- tablero: una columna por fase ----

export type ColumnStatus = WorkflowPhase['status'];

export interface BoardColumn extends FlowPhaseGroup {
  status: ColumnStatus;
  /** columna resaltada: fase en curso de una corrida en curso */
  current: boolean;
  /** agentes terminados (con exito o con falla) / agentes de la columna */
  done: number;
  total: number;
}

/** estado de una fase que el script no declaro: sale de sus agentes */
function statusFromAgents(agents: readonly FlowAgentView[]): ColumnStatus {
  if (agents.length === 0) return 'pending';
  if (agents.some((a) => a.ref.status === 'working')) return 'running';
  return agents.every((a) => a.ref.status === 'failed') ? 'failed' : 'done';
}

/** Columnas del tablero en el orden del script (las pendientes tambien, vacias) */
export function boardColumns(run: WorkflowRun, room: OfficeRoom | null): BoardColumn[] {
  return groupAgentsByPhase(run, room)
    .filter((g) => g.agents.length > 0 || g.phase !== null)
    .map((group) => {
      const status = group.phase?.status ?? statusFromAgents(group.agents);
      return {
        ...group,
        status,
        current: isRunning(run) && status === 'running',
        done: group.agents.filter((a) => a.ref.status !== 'working').length,
        total: group.agents.length,
      };
    });
}

/** "1/2 terminados" · "Sin agentes" */
export function columnCountText(column: Pick<BoardColumn, 'done' | 'total'>): string {
  if (column.total === 0) return 'Sin agentes';
  return `${column.done}/${column.total} ${column.done === 1 && column.total === 1 ? 'terminado' : 'terminados'}`;
}

// ---- tira del flujo: Solicitud -> Orquestador -> una etapa por fase -> Aprobacion humana -> Completado ----

export type PipeNodeKind = 'request' | 'orchestrator' | 'phase' | 'approval' | 'result';

/** done: cumplido · active: pasa ahora · waiting: espera al usuario · pending: todavia no · failed: fallo o se detuvo */
export type PipeNodeStatus = 'done' | 'active' | 'waiting' | 'pending' | 'failed';

export const PIPE_STATUS_LABEL: Record<PipeNodeStatus, string> = {
  done: 'hecho',
  active: 'en curso',
  waiting: 'espera tu respuesta',
  pending: 'pendiente',
  failed: 'falló',
};

export interface PipeNode {
  key: string;
  kind: PipeNodeKind;
  label: string;
  status: PipeNodeStatus;
  /** solo fases con agentes: "2/3" terminados de los arrancados */
  detail: string | null;
}

const PIPE_FROM_COLUMN: Record<ColumnStatus, PipeNodeStatus> = {
  pending: 'pending',
  running: 'active',
  done: 'done',
  failed: 'failed',
};

/**
 * Aprobacion humana se enciende cuando el lead de la sala espera al usuario (lugar 'door': AskUserQuestion o
 * ExitPlanMode sin respuesta), mientras el flujo corre o si es el ultimo que termino bien en la sala (el lead
 * puede estar pidiendo el visto bueno del resultado). Una corrida vieja no se enciende por una pregunta nueva.
 */
export function awaitsHuman(run: WorkflowRun, room: OfficeRoom): boolean {
  if (room.lead.place !== 'door') return false;
  if (isRunning(run)) return true;
  if (run.status !== 'done') return false;
  const start = timeOf(run.startedAt);
  return !(room.workflows ?? []).some((other) => other.runId !== run.runId && timeOf(other.startedAt) > start);
}

export function flowPipeline(run: WorkflowRun, room: OfficeRoom): PipeNode[] {
  const running = isRunning(run);
  const launched = run.agents.length > 0;
  const nodes: PipeNode[] = [{ key: 'request', kind: 'request', label: 'Solicitud', status: 'done', detail: null }];
  nodes.push({
    key: 'orchestrator',
    kind: 'orchestrator',
    label: ROLE_LABEL.orchestrator,
    status: launched || run.status === 'done' ? 'done' : running ? 'active' : 'failed',
    detail: null,
  });
  const columns = boardColumns(run, room);
  for (const column of columns) {
    nodes.push({
      key: `phase:${column.key}`,
      kind: 'phase',
      label: column.title,
      status: PIPE_FROM_COLUMN[column.status],
      detail: column.total > 0 ? `${column.done}/${column.total}` : null,
    });
  }
  if (columns.length === 0) {
    nodes.push({ key: 'phase:none', kind: 'phase', label: 'Agentes', status: 'pending', detail: null });
  }
  nodes.push({
    key: 'approval',
    kind: 'approval',
    label: 'Aprobación humana',
    status: awaitsHuman(run, room) ? 'waiting' : run.status === 'done' ? 'done' : 'pending',
    detail: null,
  });
  nodes.push({
    key: 'result',
    kind: 'result',
    label: run.status === 'failed' ? 'Falló' : run.status === 'stopped' ? 'Detenido' : 'Completado',
    status: running ? 'pending' : run.status === 'done' ? 'done' : 'failed',
    detail: null,
  });
  return nodes;
}

/** "Solicitud, hecho → Orquestador, hecho → Construccion, en curso, 1/2 → ..." para lectores de pantalla */
export function pipelineText(nodes: readonly PipeNode[]): string {
  return nodes
    .map((node) => [node.label, PIPE_STATUS_LABEL[node.status], node.detail].filter(Boolean).join(', '))
    .join(' → ');
}

// ---- pronostico en vuelo ----

export const RISK_LABEL: Record<BudgetRisk, string> = {
  low: 'Riesgo bajo',
  medium: 'Riesgo medio',
  high: 'Riesgo alto',
};

/** Pronostico que se muestra: solo corridas en curso con historial para estimar */
export function runForecast(run: WorkflowRun): WorkflowForecast | null {
  return isRunning(run) ? (run.forecast ?? null) : null;
}

/** "~$1,20–$2,40": es una estimacion, por eso la tilde; si los extremos coinciden, una sola cifra */
export function forecastText(forecast: Pick<WorkflowForecast, 'lowUsd' | 'highUsd'>): string {
  const low = formatUsd(forecast.lowUsd);
  const high = formatUsd(forecast.highUsd);
  return low === high ? `~${low}` : `~${low}–${high}`;
}

/** Explicacion del pronostico y su riesgo (tooltip y lector de pantalla) */
export function forecastDetail(forecast: WorkflowForecast): string {
  const parts = ['Costo final estimado: lo gastado más lo que falta según el historial de agentes del mismo rol y modelo'];
  parts.push(
    forecast.budgetUsd === null
      ? 'Sin presupuesto por flujo (la regla está apagada)'
      : `${forecast.risk ? RISK_LABEL[forecast.risk] : 'Sin riesgo calculado'} contra el presupuesto por flujo de ${formatUsd(
          forecast.budgetUsd,
        )} (el tope de esta corrida, no el del mes): medio si el extremo alto pasa el 70 % del tope, alto si lo supera`,
  );
  if (forecast.unknownAgents > 0) {
    parts.push(
      forecast.unknownAgents === 1
        ? '1 agente sin historial de su rol y modelo (se estima con la mediana general)'
        : `${forecast.unknownAgents} agentes sin historial de su rol y modelo (se estiman con la mediana general)`,
    );
  }
  return `${parts.join('. ')}.`;
}

/** Cuantos agentes de la corrida trabajan, terminaron, fallaron (sin reintento) o se reintentaron */
export function runAgentCounts(run: WorkflowRun): { working: number; done: number; failed: number; retried: number } {
  const counts = { working: 0, done: 0, failed: 0, retried: 0 };
  for (const view of flowAgentViews(run, null)) {
    if (view.dim) counts.retried += 1;
    else if (view.ref.status === 'working') counts.working += 1;
    else if (view.ref.status === 'done') counts.done += 1;
    else counts.failed += 1;
  }
  return counts;
}

export type FlowTone = 'working' | 'thinking' | 'idle' | 'done' | 'failed' | 'retried';

export interface FlowActivity {
  tone: FlowTone;
  /** Trabajando · Pensando · En espera · Terminado · Falló · Reintentado */
  status: string;
  /** accion en curso u hora de fin */
  detail: string | null;
  /** herramienta de la accion en curso (su icono) */
  tool: string | null;
  /** inicio de la accion en curso: su cronometro */
  startedAt: string | null;
}

/** Estado de un agente del flujo: LED + estado grande + lo que hace ahora */
export function flowActivity(view: FlowAgentView): FlowActivity {
  const { ref, live } = view;
  const at = ref.endedAt ? `a las ${formatTimeOfDay(ref.endedAt)}` : null;
  if (view.dim) return { tone: 'retried', status: 'Reintentado', detail: at, tool: null, startedAt: null };
  if (ref.status === 'failed') return { tone: 'failed', status: 'Falló', detail: at, tool: null, startedAt: null };
  if (ref.status === 'done') return { tone: 'done', status: 'Terminado', detail: at, tool: null, startedAt: null };
  if (live?.status === 'idle') return { tone: 'idle', status: 'En espera', detail: null, tool: null, startedAt: null };
  if (live?.action) {
    return {
      tone: 'working',
      status: 'Trabajando',
      detail: live.action.label,
      tool: live.action.tool,
      startedAt: live.action.startedAt,
    };
  }
  if (live) return { tone: 'thinking', status: 'Pensando', detail: null, tool: null, startedAt: null };
  return { tone: 'working', status: 'Trabajando', detail: null, tool: null, startedAt: null };
}

// ---- relato: que pasa ahora, en una frase ----

export type StoryTone = 'live' | 'between' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface RunStory {
  tone: StoryTone;
  /** corto y grande: "Fase 2 de 3 · Construccion", "Espera tu respuesta", "Terminado" */
  headline: string;
  /** una o dos frases con quien trabaja y que sigue; nunca el texto de un prompt */
  detail: string;
}

/** "Nico" · "Nico y Vera" · "Nico, Vera y Lucia" · "Nico, Vera, Lucia y 2 más" */
export function namesText(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} y ${names.length - max} más`;
}

function agentsWord(n: number): string {
  return n === 1 ? '1 agente' : `${n} agentes`;
}

/**
 * Frase de la cabecera de una corrida. Solo usa datos del contrato: nombres de persona, titulos de fase,
 * estados y tiempos. Espera tu respuesta gana a todo (el flujo no avanza sin el usuario).
 */
export function runStory(run: WorkflowRun, room: OfficeRoom, nowMs: number): RunStory {
  const columns = boardColumns(run, room);
  const views = columns.flatMap((c) => c.agents);
  const counts = runAgentCounts(run);
  const duration = formatDuration(runElapsedMs(run, nowMs));
  const phased = columns.filter((c) => c.index >= 0);
  const total = run.phases.length;
  const working = isRunning(run) ? views.filter((v) => v.ref.status === 'working' && !v.dim) : [];
  const who = namesText(working.map((v) => v.name));

  if (awaitsHuman(run, room)) {
    const meanwhile =
      working.length === 0 ? '' : ` Mientras tanto, ${who} ${working.length === 1 ? 'sigue' : 'siguen'} trabajando.`;
    return {
      tone: 'waiting',
      headline: 'Espera tu respuesta',
      detail: isRunning(run)
        ? `El orquestador de la sala ${room.title} te hizo una pregunta; respóndela en Claude Code.${meanwhile}`
        : `El flujo terminó y el orquestador de la sala ${room.title} espera tu visto bueno en Claude Code.`,
    };
  }

  if (run.status === 'done') {
    const issues: string[] = [];
    if (counts.failed > 0) issues.push(counts.failed === 1 ? '1 falló' : `${counts.failed} fallaron`);
    if (counts.retried > 0) issues.push(counts.retried === 1 ? '1 se reintentó' : `${counts.retried} se reintentaron`);
    return {
      tone: 'done',
      headline: 'Terminado',
      detail: `Terminó en ${duration} con ${agentsWord(views.length)}${issues.length > 0 ? `: ${issues.join(' y ')}` : ', sin fallas'}.`,
    };
  }

  if (run.status === 'failed') {
    const where = columns.find((c) => c.status === 'failed');
    const failedHere = where ? where.agents.filter((a) => a.ref.status === 'failed' && !a.dim).length : 0;
    return {
      tone: 'failed',
      headline: 'Falló',
      detail: where
        ? `Falló en la fase ${where.title}${failedHere > 0 ? `: ${failedHere === 1 ? '1 agente falló' : `${failedHere} agentes fallaron`}` : ''}. Duró ${duration}.`
        : `El flujo falló después de ${duration}.`,
    };
  }

  if (run.status === 'stopped') {
    const started = [...columns].reverse().find((c) => c.total > 0);
    const done = runProgress(run).phasesDone;
    return {
      tone: 'stopped',
      headline: 'Detenido',
      detail: started
        ? `Se detuvo en la fase ${started.title}${total > 0 ? `, con ${done} de ${total} fases hechas` : ''}. Duró ${duration}.`
        : `Se detuvo antes de lanzar agentes. Duró ${duration}.`,
    };
  }

  // en curso
  if (views.length === 0) {
    return {
      tone: 'between',
      headline: 'Preparando el flujo',
      detail: 'El script arrancó y todavía no lanzó ningún agente.',
    };
  }
  const running = columns.filter((c) => c.status === 'running');
  const lastStarted = columns.reduce((last, c, i) => (c.total > 0 ? i : last), -1);
  const next = columns.slice(lastStarted + 1).find((c) => c.status === 'pending' && c.index >= 0);

  if (working.length === 0) {
    return next
      ? {
          tone: 'between',
          headline: `Pasando a ${next.title}`,
          detail: 'Ningún agente trabaja en este momento: el script está por lanzar la siguiente fase.',
        }
      : {
          tone: 'between',
          headline: 'Cerrando el flujo',
          detail: 'Todos los agentes terminaron; falta que el script entregue el resultado.',
        };
  }

  const only = running.length === 1 ? running[0] : undefined;
  const headline =
    only && only.index >= 0 && total > 0
      ? `Fase ${only.index + 1} de ${total} · ${only.title}`
      : running.length > 1
        ? `${running.length} fases en paralelo`
        : only
          ? only.title
          : 'En curso';
  const doing = working.length === 1 ? `${who} está trabajando` : `${who} están trabajando`;
  const after =
    phased.length === 0 ? '' : next ? ` Después sigue ${next.title}.` : ' Es la última fase.';
  return { tone: 'live', headline, detail: `${doing}.${after}` };
}

// ---- tiempos por fase y linea de tiempo ----

/** Primer arranque y ultimo fin de los agentes de una columna (ahora, si alguno sigue); null sin agentes */
export function columnSpan(column: Pick<BoardColumn, 'agents'>, nowMs: number): { startMs: number; endMs: number } | null {
  if (column.agents.length === 0) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  for (const view of column.agents) {
    startMs = Math.min(startMs, timeOf(view.ref.startedAt) || nowMs);
    endMs = Math.max(endMs, view.ref.endedAt ? timeOf(view.ref.endedAt) : nowMs);
  }
  return { startMs, endMs: Math.max(startMs, endMs) };
}

/**
 * Tablero enfocado: con el flujo corriendo, las fases ya terminadas se pliegan a un resumen para dejarle
 * el espacio a la actual. Las fallidas nunca se pliegan; una corrida que ya no corre se ve completa.
 */
export function startsCollapsed(column: Pick<BoardColumn, 'status'>, run: WorkflowRun, columns: readonly Pick<BoardColumn, 'current'>[]): boolean {
  return isRunning(run) && column.status === 'done' && columns.some((c) => c.current);
}

/** Clave de la primera fase pendiente despues de la ultima que arranco ("Sigue"); null si no hay */
export function nextColumnKey(columns: readonly BoardColumn[]): string | null {
  const lastStarted = columns.reduce((last, c, i) => (c.total > 0 ? i : last), -1);
  return columns.slice(lastStarted + 1).find((c) => c.status === 'pending')?.key ?? null;
}

export interface TimelineBar {
  view: FlowAgentView;
  /** 0..1 dentro del eje */
  from: number;
  to: number;
  /** sigue trabajando: la barra llega hasta ahora */
  open: boolean;
}

export interface TimelineGroup {
  key: string;
  title: string;
  index: number;
  status: ColumnStatus;
  bars: TimelineBar[];
}

export interface Timeline {
  startMs: number;
  endMs: number;
  groups: TimelineGroup[];
  /** marcas del eje: posicion 0..1 y tiempo desde el inicio ("1:30") */
  ticks: { at: number; label: string }[];
  /** posicion de "ahora" (solo en curso) */
  now: number | null;
}

const TICK_STEPS_MS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

/** Linea de tiempo: una barra por agente desde que arranco hasta que termino (o ahora), agrupadas por fase */
export function runTimeline(run: WorkflowRun, room: OfficeRoom | null, nowMs: number, maxTicks = 6): Timeline {
  const running = isRunning(run);
  const startMs = timeOf(run.startedAt) || nowMs;
  let endMs = running ? nowMs : timeOf(run.endedAt);
  for (const ref of run.agents) endMs = Math.max(endMs, ref.endedAt ? timeOf(ref.endedAt) : running ? nowMs : 0);
  endMs = Math.max(endMs, startMs + 1_000);
  const span = endMs - startMs;
  const pos = (ms: number) => Math.min(1, Math.max(0, (ms - startMs) / span));

  const groups = boardColumns(run, room)
    .filter((c) => c.total > 0)
    .map((c) => ({
      key: c.key,
      title: c.title,
      index: c.index,
      status: c.status,
      bars: c.agents.map((view) => {
        const open = view.ref.status === 'working' && running;
        const from = pos(timeOf(view.ref.startedAt) || startMs);
        const to = pos(view.ref.endedAt ? timeOf(view.ref.endedAt) : open ? nowMs : endMs);
        return { view, from, to: Math.max(from, to), open };
      }),
    }));

  const step = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ?? 3_600_000;
  const ticks: { at: number; label: string }[] = [];
  for (let t = 0; t <= span; t += step) ticks.push({ at: t / span, label: formatClock(t) });
  return { startMs, endMs, groups, ticks, now: running ? pos(nowMs) : null };
}

// ---- barra plegada ----

export interface FlowsSummary {
  active: number;
  /** solo con una corrida activa (con varias no hay una fase unica) */
  phase: { current: number; total: number } | null;
  working: number;
  tokens: number;
  /** null si alguna corrida activa tiene costo null (modelo sin precio): nunca se inventa un monto */
  costUsd: number | null;
}

export function flowsSummary(entries: readonly FlowEntry[]): FlowsSummary {
  const active = entries.filter((e) => isRunning(e.run));
  let working = 0;
  let tokens = 0;
  let costUsd: number | null = 0;
  for (const { run } of active) {
    for (const agent of run.agents) if (agent.status === 'working') working += 1;
    tokens += run.tokens.total;
    costUsd = costUsd === null || run.costUsd === null ? null : costUsd + run.costUsd;
  }
  const only = active.length === 1 ? active[0] : undefined;
  return { active: active.length, phase: only ? phaseProgress(only.run) : null, working, tokens, costUsd };
}

export function activeRunsText(n: number): string {
  if (n === 0) return 'Sin flujos en curso';
  return n === 1 ? 'Flujo en curso' : `${n} flujos en curso`;
}

export function workingAgentsText(n: number): string {
  if (n === 0) return 'ningún agente trabajando';
  return n === 1 ? '1 agente trabajando' : `${n} agentes trabajando`;
}

export function summaryCostText(costUsd: number | null): string {
  return costUsd === null ? 'costo sin precio conocido' : `${formatUsd(costUsd)} valor equivalente API`;
}

/** Partes cortas de la barra compacta, en orden: "Flujo en curso", "Fase 2 de 3", "3 trabajando", "$0,84" */
export function flowsSummaryParts(summary: FlowsSummary): string[] {
  if (summary.active === 0) return [activeRunsText(0)];
  const parts = [activeRunsText(summary.active)];
  if (summary.phase) parts.push(phaseText(summary.phase));
  parts.push(summary.working === 0 ? 'nadie trabajando' : `${summary.working} trabajando`);
  parts.push(summary.costUsd === null ? 'sin precio' : formatUsd(summary.costUsd));
  return parts;
}

/** Version para lectores de pantalla: "Flujo en curso · Fase 2 de 3 · 3 agentes trabajando · $0,84 valor equivalente API" */
export function flowsSummaryText(summary: FlowsSummary): string {
  if (summary.active === 0) return activeRunsText(0);
  const parts = [activeRunsText(summary.active)];
  if (summary.phase) parts.push(phaseText(summary.phase));
  parts.push(workingAgentsText(summary.working), summaryCostText(summary.costUsd));
  return parts.join(' · ');
}

export function phaseText(progress: { current: number; total: number }): string {
  return `Fase ${progress.current} de ${progress.total}`;
}

/** Indicador de la lista de salas: "Nombre · Fase 2 de 3" de la corrida activa mas reciente */
export function roomFlowText(room: OfficeRoom): { run: WorkflowRun; text: string; extra: number } | null {
  const active = roomActiveRuns(room).sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
  const run = active[0];
  if (!run) return null;
  const progress = phaseProgress(run);
  const name = prettyRunName(run.name);
  return { run, text: progress ? `${name} · ${phaseText(progress)}` : name, extra: active.length - 1 };
}

// ---- estado del dock ----

/** hidden: nada · bar: barra compacta abajo · open: vista grande (sala de control) */
export type DockMode = 'hidden' | 'bar' | 'open';

/**
 * La vista grande tapa media pantalla: solo se abre a pedido (F, boton Flujos, lista de salas o panel del
 * agente). Mientras haya un flujo en curso y la vista este cerrada, queda la barra compacta.
 */
export function dockMode(pref: FlowsDockPref, hasActive: boolean): DockMode {
  if (pref === 'open') return 'open';
  return hasActive ? 'bar' : 'hidden';
}

/** Cerrar la vista grande: con flujos en curso queda la barra; sin ellos se oculta y vuelve con el proximo */
export function prefAfterClose(hasActive: boolean): FlowsDockPref {
  return hasActive ? 'bar' : 'auto';
}

/** Tecla F y boton "Flujos" de la barra superior */
export function prefAfterToggle(pref: FlowsDockPref, hasActive: boolean): FlowsDockPref {
  return dockMode(pref, hasActive) === 'open' ? prefAfterClose(hasActive) : 'open';
}

export type EscapeTarget = 'history' | 'flows' | 'drawer' | null;

/** Esc cierra la capa de arriba: historial; luego, entre dock y panel derecho (agente o sala), el ultimo que se toco */
export function escapeTarget(state: {
  historyOpen: boolean;
  drawerOpen: boolean;
  dockOpen: boolean;
  lastLayer: HudLayer | null;
}): EscapeTarget {
  if (state.historyOpen) return 'history';
  const drawer = state.drawerOpen;
  if (state.dockOpen && (!drawer || state.lastLayer === 'flows')) return 'flows';
  if (drawer) return 'drawer';
  return null;
}

/** open-history: en la ultima pestana vista · open-habits: en Habitos */
export type LetterAction =
  | 'open-history'
  | 'open-habits'
  | 'close-history'
  | 'toggle-flows'
  | 'toggle-agents'
  | 'toggle-todo'
  | null;

/**
 * Letras del HUD, ya sin modificadores y fuera de campos de texto: H abre o cierra el historial · A lo abre
 * en Habitos (o lo cierra si ya esta ahi) · F alterna la sala del flujo (toggleFlowRoom; no con el historial encima)
 * · L abre o cierra "Agentes ahora" (con el historial encima lo cambia por la tabla) · P abre o cierra los
 * pendientes
 */
export function letterAction(key: string, state: { historyOpen: boolean; historyTab: HistoryTab }): LetterAction {
  const letter = key.toLowerCase();
  if (letter === 'h') return state.historyOpen ? 'close-history' : 'open-history';
  if (letter === 'a') return state.historyOpen && state.historyTab === 'habits' ? 'close-history' : 'open-habits';
  if (letter === 'f') return state.historyOpen ? null : 'toggle-flows';
  if (letter === 'l') return 'toggle-agents';
  if (letter === 'p') return 'toggle-todo';
  return null;
}

// ---- el flujo vive en su sala ----

/**
 * El flujo se ve dentro de la oficina, no en una vista aparte. Llevar a un flujo = la camara
 * viaja a su sala y se abre el panel de la sala, que lo cuenta. La vista grande queda solo para "Ver detalle".
 * false si la corrida ya no esta en el snapshot.
 */
export function openFlowRoom(runId: string): boolean {
  const store = useOfficeStore.getState();
  const entry = collectRuns(store.snapshot).find((e) => e.run.runId === runId);
  if (!entry) return false;
  const hasActive = activeRunCount(store.snapshot) > 0;
  if (dockMode(store.flowsDock, hasActive) === 'open') store.setFlowsDock(prefAfterClose(hasActive));
  store.selectFlowsRun(runId);
  store.focusRoom(entry.room.id);
  store.selectRoom(entry.room.id);
  return true;
}

/**
 * Tecla F y boton Flujos: abre la sala del flujo mas importante (en curso primero); si su panel ya esta
 * abierto, lo cierra. Sin flujos hoy abre la vista grande, que lo dice.
 */
export function toggleFlowRoom(): void {
  const store = useOfficeStore.getState();
  const entry = collectRuns(store.snapshot)[0];
  if (!entry) {
    store.setFlowsDock(prefAfterToggle(store.flowsDock, false));
    return;
  }
  if (store.selectedRoomId === entry.room.id) {
    store.selectRoom(null);
    return;
  }
  openFlowRoom(entry.run.runId);
}

/** Corrida que cuenta el panel de la sala: la pedida si es de esta sala; si no, la en curso mas reciente; si no, la ultima */
export function roomFlowRun(room: OfficeRoom, askedRunId: string | null): WorkflowRun | null {
  const runs = room.workflows ?? [];
  const asked = askedRunId ? runs.find((r) => r.runId === askedRunId) : undefined;
  if (asked) return asked;
  return runs.map((run) => ({ room, run })).sort(compareEntries)[0]?.run ?? null;
}

// ---- enlace agente -> panel del agente ----

/**
 * Clic en un agente del flujo: si sigue en la oficina se abre su panel (la camara y el panel hacen el
 * resto); si ya salio, no se toca la seleccion y la vista avisa "Ya salió de la oficina".
 */
export function openFlowAgent(agentId: string): 'selected' | 'gone' {
  const store = useOfficeStore.getState();
  if (!findAgent(store.snapshot, agentId)) return 'gone';
  store.selectAgent(agentId);
  return 'selected';
}
