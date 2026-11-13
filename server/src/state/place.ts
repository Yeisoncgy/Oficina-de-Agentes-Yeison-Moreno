// Lugar de la sala al que camina cada agente (AgentPlace del contrato). Modulo puro: sin DB ni reloj propio.
import type { AgentPlace, AgentRole, AgentStatus } from '@shared/contract';

/** lead inactivo: en el cafe hasta 10 min despues de su ultima linea; despues, dormido */
export const COFFEE_MS = 10 * 60_000;

export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const LAB_TOOLS: ReadonlySet<string> = new Set(['BashOutput', 'Monitor']);
const LIBRARY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'LSP',
]);
const MEETING_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow', 'SendMessage', 'TaskStop', 'ListAgents']);
/** esperan una respuesta humana mientras no tengan tool_result */
const DOOR_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** roles con lugar propio mientras trabajan */
const ROLE_PLACE: Readonly<Partial<Record<AgentRole, AgentPlace>>> = { reviewer: 'review', security: 'review', tester: 'lab' };

export interface LastAction {
  tool: string;
  /** sin tool_result todavia */
  open: boolean;
  /** Bash/PowerShell: 'test' | 'build' | 'git_read' | 'other' (actions.cmd_class); null en las demas */
  cmdClass: string | null;
}

export interface PlaceInput {
  kind: 'lead' | 'subagent';
  status: AgentStatus;
  role: AgentRole;
  /** su accion mas reciente, abierta o cerrada (lead: del turno actual); null si no uso herramientas */
  last: LastAction | null;
  /** ultima linea que escribio (ms); cuenta para el lead inactivo */
  lastActivityMs: number | null;
  /** la sesion de Claude Code sigue abierta: cerrada, nadie espera la respuesta de la puerta */
  sessionOpen: boolean;
  now: number;
}

/**
 * lugar de una herramienta. Lo que no esta en las listas es el escritorio: Edit, Write, NotebookEdit,
 * MultiEdit, TodoWrite, las de listas de tareas (TaskCreate, TaskUpdate...) y las desconocidas
 */
export function toolPlace(tool: string, cmdClass: string | null): AgentPlace {
  if (SHELL_TOOLS.has(tool)) return cmdClass === 'git_read' ? 'library' : 'lab';
  if (LAB_TOOLS.has(tool)) return 'lab';
  if (LIBRARY_TOOLS.has(tool) || tool.startsWith('mcp__')) return 'library';
  if (MEETING_TOOLS.has(tool)) return 'meeting';
  return 'desk';
}

/** precedencia: puerta (sesion abierta) > lugar de su rol (trabajando) > ultima herramienta (trabajando) > inactivo */
export function placeOf(p: PlaceInput): AgentPlace {
  if (p.sessionOpen && p.status !== 'done' && p.last?.open && DOOR_TOOLS.has(p.last.tool)) return 'door';
  if (p.status === 'working') {
    return ROLE_PLACE[p.role] ?? (p.last ? toolPlace(p.last.tool, p.last.cmdClass) : 'desk');
  }
  if (p.kind === 'lead') {
    return p.lastActivityMs !== null && p.now - p.lastActivityMs < COFFEE_MS ? 'coffee' : 'sleep';
  }
  // subagente que termino: sale desde su escritorio
  return 'desk';
}
