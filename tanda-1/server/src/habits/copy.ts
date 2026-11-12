// Textos de los hallazgos y de las alertas vivas. Nunca llevan texto de prompts (la pantalla se
// proyecta): solo nombres de archivo (basename), herramientas, servidores MCP, conteos, tokens y montos.
// El copyText se pega en el chat del lead: el de un hallazgo de subagente le dice al lead que pedir al
// delegar (el subagente ya termino, y un subagente no puede lanzar subagentes).
import type { HabitKind, RuleId } from '@shared/contract';

const usdFmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const oneDecimalFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

/** $3,40 · $120 (igual que la UI) */
export function usd(n: number): string {
  return n >= 100 ? `$${wholeFmt.format(n)}` : `$${usdFmt.format(n)}`;
}

/** 950 · 12,3 k · 1,2 M */
export function tokens(n: number): string {
  if (n < 1000) return wholeFmt.format(n);
  if (n < 1_000_000) return `${oneDecimalFmt.format(n / 1000)} k`;
  return `${oneDecimalFmt.format(n / 1_000_000)} M`;
}

/** "a" · "a y b" · "a, b y c" · "a, b, c y 2 más" */
export function list(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} y ${rest} más`;
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} y ${shown[shown.length - 1]}`;
}

function times(n: number): string {
  return n === 1 ? '1 vez' : `${n} veces`;
}

export interface Copy {
  title: string;
  recommendation: string;
  copyText: string;
}

/** se pega tal cual en Claude Code: /compact acepta instrucciones de que conservar */
export const COMPACT_COMMAND = '/compact Conserva las decisiones, los archivos tocados y los pendientes de la tarea actual.';

/** quien hizo lo que se senala: el lead o un subagente con su rol (AgentRole) */
export interface Who {
  isLead: boolean;
  role: string | null;
}

const ROLE_TASK: Readonly<Record<string, string>> = {
  explorer: 'una investigación',
  builder: 'trabajo de Desarrollo',
  reviewer: 'una revisión',
  tester: 'pruebas',
  security: 'una revisión de seguridad',
  planner: 'una planificación',
  docs: 'documentación',
};

function taskOf(role: string | null): string {
  return ROLE_TASK[role ?? ''] ?? 'una tarea parecida';
}

/** "Cuando delegues trabajo de Desarrollo, pídele al subagente que" */
function delegate(role: string | null): string {
  return `Cuando delegues ${taskOf(role)}, pídele al subagente que`;
}

export function repeatedReadCopy(file: string, n: number, who: Who): Copy {
  return {
    title: `Leyó ${file} ${times(n)} sin editarlo`,
    recommendation:
      'Cada relectura vuelve a meter el archivo en el contexto y se paga otra vez. Lee una vez y, para volver a un tramo, ubícalo con Grep y léelo con offset/limit.',
    copyText: who.isLead
      ? `Ya leíste ${file} varias veces sin cambiarlo: no lo vuelvas a leer completo. Usa lo que ya tienes en el contexto y, si necesitas un tramo, ubícalo con Grep y léelo con offset/limit.`
      : `${delegate(who.role)} no relea completo un archivo que ya leyó (como ${file}): que use lo que ya tiene en el contexto y, si necesita un tramo, lo ubique con Grep y lo lea con offset/limit.`,
  };
}

export function fullReadCopy(files: readonly string[], count: number, maxLines: number | null, who: Who): Copy {
  const one = count === 1 && files.length === 1;
  const lines = maxLines !== null ? ` (${wholeFmt.format(maxLines)} líneas)` : '';
  return {
    title: one ? `Leyó completo ${files[0] ?? ''}${lines}` : `Leyó completos ${count} archivos largos: ${list(files)}`,
    recommendation:
      'Leer entero un archivo largo llena el contexto con partes que no se usan. Ubica con Grep lo que buscas y lee tramos de unas 200 líneas con offset/limit.',
    copyText: who.isLead
      ? `Para el resto de la tarea no vuelvas a leer ${one ? 'completo' : 'completos'} ${list(files)}: ubica con Grep y lee con offset/limit solo el tramo que necesitas.`
      : `${delegate(who.role)} no lea completos los archivos largos (como ${list(files)}): que ubique con Grep lo que busca y lea con offset/limit solo el tramo que necesita.`,
  };
}

export function bigContextCopy(maxCtx: number, isLead: boolean): Copy {
  return {
    title: `Contexto de ${tokens(maxCtx)} tokens en una llamada`,
    recommendation: isLead
      ? 'Cada llamada vuelve a pagar todo el contexto. Compacta con /compact al cerrar una etapa y delega la exploración pesada a subagentes que devuelvan solo conclusiones.'
      : 'Un subagente con el contexto así de lleno paga todo eso en cada llamada. Dale encargos más acotados y pídele que devuelva conclusiones y rutas, no contenido.',
    copyText: isLead
      ? COMPACT_COMMAND
      : 'Divide los encargos grandes: lanza subagentes con tareas más acotadas y pídeles que devuelvan solo conclusiones y rutas de archivo, no el contenido de los archivos.',
  };
}

export function needsCompactCopy(calls: number, avgCtx: number): Copy {
  return {
    title: `${calls} llamadas sin compactar con ${tokens(avgCtx)} tokens de contexto`,
    recommendation:
      'Las próximas llamadas pagan ese contexto completo cada vez. Usa /compact al terminar esta etapa para seguir con un resumen.',
    copyText: COMPACT_COMMAND,
  };
}

export function loopCopy(tool: string, n: number, who: Who): Copy {
  return {
    title: `Repitió ${tool} ${times(n)} seguidas con el mismo input`,
    recommendation:
      'Repetir la misma llamada no cambia el resultado y cada vuelta se paga. Hay que parar, entender por qué no avanza y cambiar de enfoque.',
    copyText: who.isLead
      ? `Estás repitiendo ${tool} con los mismos parámetros y el resultado no cambia. Detente, explica en dos líneas qué esperabas obtener y prueba un enfoque distinto.`
      : `${delegate(who.role)} no repita ${tool} con los mismos parámetros: si el resultado no cambia, que se detenga, explique en dos líneas qué esperaba obtener y pruebe un enfoque distinto.`,
  };
}

export function sameErrorCopy(tool: string, n: number, who: Who): Copy {
  return {
    title: `${tool} falló ${times(n)} con el mismo error`,
    recommendation:
      'Reintentar sin cambiar nada repite el mismo fallo y su costo. Hay que leer el error una vez y corregir la causa antes de volver a intentarlo.',
    copyText: who.isLead
      ? `${tool} ya falló ${times(n)} con el mismo error. No lo reintentes igual: lee el mensaje de error, identifica la causa y cambia el comando o el archivo antes de volver a correrlo.`
      : `${delegate(who.role)}, si ${tool} falla, lea el mensaje de error y corrija la causa antes de reintentar: que no repita la misma llamada sin cambiar nada.`,
  };
}

export function expensiveModelCopy(family: string, lookupPct: number): Copy {
  return {
    title: `Subagente en ${family} con ${Math.round(lookupPct * 100)} % de lectura y búsqueda`,
    recommendation:
      'Leer y buscar no necesita el modelo más caro. Lanza estos subagentes con model: "sonnet", o con model: "haiku" si solo ubican archivos.',
    copyText: `Para subagentes que solo leen o buscan (explorar, ubicar archivos, resumir) usa model: "haiku" o model: "sonnet" en la llamada a Agent; deja ${family} para diseñar, decidir y revisar.`,
  };
}

export function lowCacheCopy(hitPct: number | null, expired: number, who: Who): Copy {
  if (hitPct !== null) {
    return {
      title: `Solo ${Math.round(hitPct * 100)} % del contexto sale de la cache`,
      recommendation:
        'Cuando cambia el inicio del contexto (modelo, herramientas, CLAUDE.md) la cache se pierde y todo se paga como escritura. Mantén esas piezas estables durante la tarea.',
      copyText: who.isLead
        ? 'No cambies de modelo ni edites CLAUDE.md, las memorias o la configuración de herramientas mientras dure esta tarea: cada cambio invalida la cache.'
        : `Cuando delegues ${taskOf(who.role)}, usa el mismo tipo de subagente y el mismo modelo para los encargos parecidos, y no edites CLAUDE.md ni las memorias mientras trabaja: así reusa la cache en vez de escribirla de nuevo.`,
    };
  }
  return {
    title: `La cache se venció ${times(expired)} por pausas de más de 5 min`,
    recommendation:
      'La cache dura 5 minutos: tras una pausa más larga se vuelve a escribir todo el contexto. Agrupa el trabajo en mensajes seguidos y deja las revisiones largas para el final.',
    copyText: who.isLead
      ? 'Agrupa en un solo plan lo que queda de esta etapa y avanza sin detenerte a preguntar en cada paso: quiero evitar pausas de más de 5 minutos entre mensajes.'
      : `${delegate(who.role)} corra en segundo plano los comandos que tardan más de 5 minutos y siga avanzando mientras terminan; responde pronto sus pedidos de permiso: cada pausa larga le vence la cache.`,
  };
}

export function longOutputCopy(n: number, who: Who): Copy {
  return {
    title: `${n} llamadas con más de 8 k tokens de salida sin editar archivos`,
    recommendation:
      'La salida (texto y razonamiento) es la parte más cara de cada llamada, y aquí no fue a un archivo, a un encargo ni a un flujo. Revisa el esfuerzo de razonamiento en las tareas simples y pide respuestas breves.',
    copyText: who.isLead
      ? 'En los pasos simples piensa lo justo y responde en máximo 10 líneas: conclusiones, rutas y próximos pasos, sin repetir código ni contenido de archivos.'
      : `${delegate(who.role)} te devuelva un informe de máximo 10 líneas (conclusiones y rutas archivo:línea), sin pegar código ni contenido de archivos.`,
  };
}

/** siempre es un subagente de Desarrollo; `model` es el suyo, que puede no ser caro */
export function idleCopy(minutes: number, actions: number, model: { label: string; expensive: boolean }): Copy {
  return {
    title: `${minutes} min y ${actions} acciones sin editar ningún archivo`,
    recommendation: model.expensive
      ? `Un agente de Desarrollo que solo lee está explorando con ${model.label}, un modelo caro. Pide primero el plan con los archivos exactos y luego la edición.`
      : 'Un agente de Desarrollo que solo lee no avanza en la tarea. Pide primero el plan con los archivos exactos y luego la edición.',
    copyText: `Cuando delegues ${taskOf('builder')}, dile al subagente qué archivos debe cambiar y pídele que empiece por la edición. Si antes hay que investigar, lanza tú primero un subagente con model: "haiku" que ubique los archivos y pásale sus conclusiones.`,
  };
}

export function mcpUnusedCopy(servers: readonly string[]): Copy {
  const n = servers.length;
  return {
    title: `${n === 1 ? 'Servidor MCP cargado' : `${n} servidores MCP cargados`} sin uso: ${list(servers)}`,
    recommendation:
      'Cada servidor MCP suma sus herramientas a la sesión aunque no se usen. Desactiva en esta carpeta los que no necesitas (/mcp o la configuración del proyecto).',
    copyText: `No uso ${n === 1 ? 'el servidor MCP' : 'los servidores MCP'} ${list(servers, n)} en esta carpeta: desactívalos solo para este proyecto en .claude/settings.local.json (disabledMcpjsonServers); si no están ahí, dime cuáles apagar con /mcp.`,
  };
}

export function dupInstructionsCopy(dupTokens: number, files: readonly string[]): Copy {
  const where = files.length > 0 ? list(files) : 'CLAUDE.md y las memorias';
  return {
    title: `Instrucciones con ~${tokens(dupTokens)} tokens repetidos (${where})`,
    recommendation:
      'El texto repetido entre CLAUDE.md y las memorias se paga en cada llamada de la sesión. Deja cada regla en un solo archivo.',
    copyText: `Revisa ${where} de esta carpeta y quita los párrafos repetidos entre ellos: deja cada regla en un solo archivo, sin cambiar lo que dice.`,
  };
}

export function discardedCopy(agents: number, cost: number): Copy {
  return {
    title: `Trabajo descartado: ${agents === 1 ? '1 agente' : `${agents} agentes`} por ${usd(cost)}`,
    recommendation:
      'Los agentes que fallan, se detienen o se reintentan se pagan igual. Antes de relanzar, corrige lo que hizo fallar al primero.',
    copyText:
      'Antes de relanzar un agente que falló o se detuvo, revisa por qué pasó y agrega al encargo lo que le faltó; no repitas el mismo encargo tal cual.',
  };
}

// ---- Reglas (hallazgos kind 'rule') ----

/** instruccion de cada regla: la del hallazgo y la de su alerta viva en la bandeja (loop_repeats sin herramienta) */
const RULE_INSTRUCTION: Readonly<Record<RuleId, string>> = {
  agent_cost:
    'Divide los encargos grandes en subagentes más acotados y usa model: "sonnet" o model: "haiku" para los que solo leen o buscan.',
  session_day_cost:
    'Esta sesión ya superó mi tope diario: termina primero lo pendiente más importante, delega las lecturas a subagentes con model: "haiku" y avísame antes de lanzar trabajo grande.',
  workflow_cost:
    'En los próximos flujos usa model: "sonnet" o model: "haiku" para las fases de exploración y revisión, y limita cuántos agentes corren en paralelo por fase.',
  turns_without_compact: COMPACT_COMMAND,
  subagents_per_turn:
    'Antes de lanzar más subagentes, agrupa los encargos parecidos en uno solo y dime cuántos vas a lanzar y por qué.',
  loop_repeats:
    'Estás repitiendo la misma herramienta con los mismos parámetros y el resultado no cambia. Detente, explica en dos líneas qué esperabas obtener y prueba un enfoque distinto.',
};

export function ruleInstruction(id: RuleId): string {
  return RULE_INSTRUCTION[id];
}

/** alerta viva de fallos seguidos (source 'errors'), que no tiene regla */
export const ERRORS_INSTRUCTION =
  'Su última herramienta falló varias veces seguidas: lee el error completo antes de reintentar y cambia de enfoque en vez de repetir el mismo comando.';

export function agentCostCopy(cost: number, limit: number): Copy {
  return {
    title: `Costo del agente ${usd(cost)} > ${usd(limit)}`,
    recommendation:
      'Superó el tope por agente. Revisa si el encargo era demasiado grande o si pudo correr con un modelo más barato.',
    copyText: RULE_INSTRUCTION.agent_cost,
  };
}

export function sessionDayCostCopy(cost: number, limit: number, day: string): Copy {
  return {
    title: `La sesión gastó ${usd(cost)} el ${day} > ${usd(limit)}`,
    recommendation:
      'La sesión superó el tope diario. Compacta, delega la exploración a subagentes baratos y cierra la sesión al terminar la etapa.',
    copyText: RULE_INSTRUCTION.session_day_cost,
  };
}

export function workflowCostCopy(cost: number, limit: number, name: string): Copy {
  return {
    title: `El flujo ${name} costó ${usd(cost)} > ${usd(limit)}`,
    recommendation:
      'La corrida superó el presupuesto por workflow. Usa modelos más baratos en las fases de exploración y revisión y limita cuántos agentes corren por fase.',
    copyText: RULE_INSTRUCTION.workflow_cost,
  };
}

export function turnsWithoutCompactCopy(turns: number): Copy {
  return {
    title: `${turns} turnos sin compactar`,
    recommendation:
      'Con tantos turnos el contexto arrastra todo lo anterior en cada llamada. Compacta al cerrar cada etapa.',
    copyText: RULE_INSTRUCTION.turns_without_compact,
  };
}

export function subagentsPerTurnCopy(launches: number, limit: number): Copy {
  return {
    title: `${launches} subagentes en un turno > ${limit}`,
    recommendation:
      'Muchos subagentes en un turno multiplican el costo. Agrupa encargos parecidos y lanza solo los que aportan algo distinto.',
    copyText: RULE_INSTRUCTION.subagents_per_turn,
  };
}

// ---- Hallazgos juntados (varios del mismo tipo en una sesion) ----

export interface GroupFacts {
  /** hallazgos juntados */
  n: number;
  /** agentes distintos */
  agents: number;
  /** archivos (basename) o herramientas distintos, en orden */
  names: readonly string[];
  /** quien lo hizo */
  who: 'lead' | 'subagents' | 'mixed';
  /** tope de la regla (evidencia 'Tope'); null si no aplica */
  limit: number | null;
}

/** copyText para varios del mismo tipo: al lead por lo suyo y, si hubo subagentes, por lo que pedir al delegar */
function groupText(who: GroupFacts['who'], lead: string, subagents: string): string {
  if (who === 'lead') return lead;
  if (who === 'subagents') return subagents;
  return `${lead} ${subagents}`;
}

/**
 * Titulo (con la cantidad de agentes o archivos) y, cuando el de cada hallazgo nombra un archivo o una
 * herramienta, un copyText general. null = el tipo no se junta (uno por sesion): se usa el del primero.
 */
export function groupCopy(kind: HabitKind, ruleId: RuleId | undefined, g: GroupFacts): Partial<Copy> & { title: string } | null {
  const many = (one: string, several: string): string => (g.agents > 1 ? several : one);
  const names = list(g.names);
  switch (kind) {
    case 'repeated_read':
      return {
        title: many(`Releyó ${g.names.length} archivos sin editarlos`, `${g.agents} agentes releyeron ${g.names.length} archivos sin editarlos`),
        copyText: groupText(
          g.who,
          `Ya leíste varias veces ${names} sin cambiarlos: no los vuelvas a leer completos. Usa lo que ya tienes en el contexto y, si necesitas un tramo, ubícalo con Grep y léelo con offset/limit.`,
          'Cuando delegues trabajo a subagentes, pídeles que no relean completo un archivo que ya leyeron: que usen lo que ya tienen en el contexto y, si necesitan un tramo, lo ubiquen con Grep y lo lean con offset/limit.',
        ),
      };
    case 'full_read':
      return {
        title: many(`Leyó completos ${g.names.length} archivos largos`, `${g.agents} agentes leyeron completos ${g.names.length} archivos largos`),
        copyText: groupText(
          g.who,
          `Para el resto de la tarea no vuelvas a leer completos ${names}: ubica con Grep y lee con offset/limit solo el tramo que necesitas.`,
          `Cuando delegues trabajo a subagentes, pídeles que no lean completos los archivos largos (como ${names}): que ubiquen con Grep lo que buscan y lean con offset/limit solo el tramo que necesitan.`,
        ),
      };
    case 'big_context':
      return { title: `${g.agents} agentes con más de ${tokens(150_000)} tokens de contexto en una llamada` };
    case 'loop':
      return {
        title: `${g.agents} agentes repitieron ${names} con el mismo input`,
        copyText: groupText(
          g.who,
          `Estás repitiendo ${names} con los mismos parámetros y el resultado no cambia. Detente, explica en dos líneas qué esperabas obtener y prueba un enfoque distinto.`,
          'Cuando delegues trabajo a subagentes, pídeles que no repitan una herramienta con los mismos parámetros: si el resultado no cambia, que se detengan, expliquen qué esperaban obtener y prueben un enfoque distinto.',
        ),
      };
    case 'same_error':
      return {
        title: `${g.n} errores repetidos con ${names}${g.agents > 1 ? ` en ${g.agents} agentes` : ''}`,
        copyText: groupText(
          g.who,
          `${names} ya falló varias veces con el mismo error. No lo reintentes igual: lee el mensaje de error, identifica la causa y cambia el comando o el archivo antes de volver a correrlo.`,
          'Cuando delegues trabajo a subagentes, pídeles que, si una herramienta falla, lean el mensaje de error y corrijan la causa antes de reintentar: que no repitan la misma llamada sin cambiar nada.',
        ),
      };
    case 'expensive_model':
      return { title: `${g.agents} subagentes en un modelo caro con casi solo lectura y búsqueda` };
    case 'low_cache':
      return { title: `${g.agents} agentes con poca cache` };
    case 'long_output':
      return {
        title: `${g.agents} agentes con llamadas de más de 8 k tokens de salida sin editar archivos`,
        copyText: groupText(
          g.who,
          'En los pasos simples piensa lo justo y responde en máximo 10 líneas: conclusiones, rutas y próximos pasos, sin repetir código ni contenido de archivos.',
          'Cuando delegues trabajo a subagentes, pídeles que te devuelvan un informe de máximo 10 líneas (conclusiones y rutas archivo:línea), sin pegar código ni contenido de archivos.',
        ),
      };
    case 'idle_no_changes':
      return { title: `${g.agents} agentes de Desarrollo sin editar ningún archivo` };
    case 'rule': {
      const limit = g.limit !== null ? usd(g.limit) : null;
      if (ruleId === 'agent_cost' && limit) return { title: `${g.agents} agentes costaron más de ${limit}` };
      if (ruleId === 'session_day_cost' && limit) return { title: `La sesión gastó más de ${limit} en ${g.n} días` };
      if (ruleId === 'workflow_cost' && limit) return { title: `${g.n} flujos costaron más de ${limit}` };
      return null;
    }
    default:
      return null;
  }
}

// ---- Alertas vivas (titulo corto sobre el agente o la sala) ----

export const alertTitles = {
  agentCost: (cost: number, limit: number) => `Costo ${usd(cost)} > ${usd(limit)}`,
  loop: (tool: string, n: number) => `Repitió ${tool} ${times(n)}`,
  errors: (n: number) => `Falló ${n} veces seguidas`,
  sessionDayCost: (cost: number, limit: number) => `Hoy ${usd(cost)} > ${usd(limit)}`,
  workflowCost: (cost: number, limit: number) => `Flujo ${usd(cost)} > ${usd(limit)}`,
  turnsWithoutCompact: (turns: number) => `${turns} turnos sin compactar`,
  subagentsPerTurn: (n: number) => `${n} subagentes en este turno`,
};
