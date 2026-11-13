import { agentBaseName } from '@shared/agents';

export const LABEL_MAX = 60;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** basename que entiende rutas de Windows y POSIX */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function rawLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const p = str(input, 'file_path');
      return p ? `Leyendo ${baseName(p)}` : 'Leyendo archivo';
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(input, 'file_path') ?? str(input, 'notebook_path');
      return p ? `Editando ${baseName(p)}` : 'Editando archivo';
    }
    case 'Bash':
    case 'PowerShell':
      return str(input, 'description') ?? 'Ejecutando comando';
    case 'Grep': {
      const pattern = str(input, 'pattern');
      return pattern ? `Buscando "${truncate(oneLine(pattern), 30)}"` : 'Buscando';
    }
    case 'Glob': {
      const pattern = str(input, 'pattern');
      return pattern ? `Buscando archivos ${oneLine(pattern)}` : 'Buscando archivos';
    }
    case 'Agent':
    case 'Task':
      return `Delegando a ${agentBaseName(str(input, 'subagent_type') ?? 'general-purpose')}`;
    case 'WebFetch':
    case 'WebSearch':
      return 'Consultando la web';
    case 'Skill': {
      const skill = str(input, 'skill');
      return skill ? `Usando la skill ${skill}` : 'Usando una skill';
    }
    case 'TodoWrite':
      return 'Organizando tareas';
    case 'ToolSearch':
      return 'Buscando herramientas';
    case 'AskUserQuestion':
      return 'Esperando tu respuesta';
    case 'ExitPlanMode':
      return 'Presentando el plan';
    case 'EnterPlanMode':
      return 'Entrando a modo plan';
    case 'SubagentHandback':
      return 'Entregando su reporte';
    case 'SendMessage':
      return 'Enviando un mensaje';
    case 'TaskStop':
      return 'Deteniendo una tarea';
    case 'Monitor':
      return 'Vigilando un proceso';
    case 'Workflow':
      return 'Orquestando un flujo';
    case 'Artifact':
      return 'Publicando una página';
    case 'ScheduleWakeup':
      return 'Programando un recordatorio';
    default: {
      const mcp = /^mcp__(.+?)__/.exec(name);
      if (mcp?.[1]) return `Usando ${mcp[1]}`;
      return `Usando ${name}`;
    }
  }
}

/** etiqueta en espanol de un tool_use, maximo 60 caracteres */
export function actionLabel(name: string, input: unknown): string {
  return truncate(oneLine(rawLabel(name, asRecord(input))), LABEL_MAX);
}

const SUMMARY_KEYS = [
  'file_path',
  'notebook_path',
  'command',
  'pattern',
  'path',
  'url',
  'query',
  'skill',
  'description',
] as const;

/** resumen corto del input (ruta, comando o patron) para el transcript */
export function inputSummary(input: unknown, max = 300): string {
  const rec = asRecord(input);
  for (const key of SUMMARY_KEYS) {
    const v = str(rec, key);
    if (v) return truncate(oneLine(v), max);
  }
  return '';
}
