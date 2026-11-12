// Contrato server <-> web. Fuente de verdad de los tipos del snapshot y de la API.
// Todas las fechas son ISO 8601 (UTC). Los timers se calculan en el cliente desde *At.

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  /** cache write 5m + 1h */
  cacheWrite: number;
  total: number;
}

/** working: trabajando ahora · idle: sin turno activo · done: termino (se anima su salida) */
export type AgentStatus = 'working' | 'idle' | 'done';

export interface CurrentAction {
  /** nombre tecnico de la herramienta: Read, Edit, Bash, Agent... */
  tool: string;
  /** etiqueta en espanol: "Editando server.ts" */
  label: string;
  startedAt: string;
}

export interface AgentTask {
  /**
   * lead: primera linea del ultimo prompt · subagente: descripcion con la que se lanzo · agente de
   * flujo: lo que esta haciendo de verdad segun sus acciones ("Construyendo frontend · FlowsDock.tsx")
   */
  title: string;
  /** agente de flujo: la etiqueta y fase del script, como detalle ("Construccion · flujos") */
  detail?: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Rol de un agente del tool Workflow. Si el script no pidio un tipo, se infiere de su etiqueta, su
 * fase y el inicio de su encargo, y se decide una sola vez (no cambia a mitad de trabajo).
 * explorer: explora, investiga, lee · builder: construye, implementa, corrige · reviewer: revisa,
 * verifica, critica · tester: prueba, QA, verifica con tests · security: seguridad, vulnerabilidades,
 * secretos · planner: planea, disena · docs: documenta, redacta · generalist: nada claro.
 * "Revision de seguridad" es security, no reviewer.
 */
export type WorkflowRole =
  | 'explorer'
  | 'builder'
  | 'reviewer'
  | 'tester'
  | 'security'
  | 'planner'
  | 'docs'
  | 'generalist';

/**
 * Rol de cualquier agente visible. El lead siempre es 'orchestrator'. Los subagentes (tool Agent o
 * Workflow) usan las mismas reglas que WorkflowRole. Etiquetas de la UI: Orquestador, Investigacion,
 * Desarrollo, Revision, Pruebas, Seguridad, Planificacion, Documentacion, General.
 */
export type AgentRole = 'orchestrator' | WorkflowRole;

/**
 * Lugar de la sala donde esta el agente (lo decide el server; la escena lo camina con un minimo de
 * permanencia). Precedencia: door > rol fijo (reviewer/security -> review, tester -> lab) > ultima
 * herramienta > inactivo.
 * desk: Edit/Write/NotebookEdit/TodoWrite o pensando sin herramienta · library: Read/Grep/Glob/Web*,
 * Skill, ToolSearch, MCP y git de lectura · lab: Bash/PowerShell (menos git de lectura) · meeting:
 * Agent/Task/Workflow/SendMessage · review: rol reviewer o security trabajando · door: AskUserQuestion o
 * ExitPlanMode sin respuesta (espera humana) · coffee: lead inactivo < 10 min · sleep: lead inactivo >= 10 min.
 */
export type AgentPlace = 'desk' | 'library' | 'lab' | 'meeting' | 'review' | 'door' | 'coffee' | 'sleep';

/**
 * Regla de aviso. Solo avisan: la app nunca actua sobre una sesion.
 * agent_cost: un agente supera $X · session_day_cost: una sesion supera $X en el dia ·
 * workflow_cost: una corrida supera $X (presupuesto por workflow) · turns_without_compact: una sesion
 * supera N turnos sin compactar · subagents_per_turn: mas de N subagentes en un turno del lead ·
 * loop_repeats: la misma herramienta con el mismo input N veces seguidas.
 */
export type RuleId =
  | 'agent_cost'
  | 'session_day_cost'
  | 'workflow_cost'
  | 'turns_without_compact'
  | 'subagents_per_turn'
  | 'loop_repeats';

/** alerta roja viva sobre un agente o una sala (se apaga sola cuando la condicion deja de cumplirse) */
export interface LiveAlert {
  level: 'warning' | 'critical';
  /** texto corto en espanol, sin texto de prompts: "Costo $3,40 > $2,00", "Fallo 2 veces seguidas" */
  title: string;
  /** rule: salto una regla · errors: su ultima herramienta fallo 2+ veces seguidas */
  source: 'rule' | 'errors';
  ruleId?: RuleId;
}

export interface OfficeAgent {
  /** agentId (subagente) o sessionId (lead) */
  id: string;
  kind: 'lead' | 'subagent';
  /**
   * 'lead' | 'tr-builder' | 'Explore' | ... (tipo del elenco: define nombre y personaje).
   * Agente de flujo sin tipo pedido: el tipo del elenco de su rol (explorer = 'Explore', o
   * 'tr-explorer' si corre en Haiku · builder = 'tr-builder' · reviewer = 'claude-code-guide' ·
   * planner = 'Plan' · docs = 'tr-docs' · generalist = 'general-purpose'). El tipo tecnico queda en
   * workflow.sourceType.
   */
  agentType: string;
  /**
   * nombre de su persona: unico entre los agentes visibles ("Bruno", "Iris"). El lead lleva el nombre que
   * eligio el usuario (DEFAULT_LEAD_NAME mientras no elija uno)
   */
  displayName: string;
  /**
   * persona (shared/personas.ts): define personaje 3D, retrato y color. Unica entre los agentes
   * visibles de toda la oficina; estable mientras el agente siga visible. El lead es 'lead' (LEAD_PERSONA).
   */
  persona?: string;
  status: AgentStatus;
  task: AgentTask | null;
  /** null con status working = "Pensando" */
  action: CurrentAction | null;
  model: string | null;
  /** tokens de su tarea actual o ultima (lead: el turno; subagente: toda su vida) */
  tokens: TokenBreakdown;
  /** costo de esa misma tarea; null si algun modelo usado no tiene precio conocido */
  costUsd: number | null;
  /** puesto estable dentro de la sala: 0 = escritorio de lider, 1..6 = puestos, -1 = sin puesto (desborde) */
  deskIndex: number;
  /** solo en agentes lanzados por el tool Workflow: corrida, fase y etiqueta del agente en el script */
  workflow?: {
    runId: string;
    name: string;
    phase: string | null;
    label: string;
    /** tipo tecnico del meta: 'workflow-subagent' si el script no pidio tipo, o el que pidio ('tr-explorer'...) */
    sourceType: string;
    /** rol del agente (provisional 'generalist' mientras llega el inicio de su encargo) */
    role: WorkflowRole;
  } | null;
  // Identidad, lugar y alerta. El server los manda siempre; opcionales para fixtures y demo.
  /** rol de primer nivel: lead = 'orchestrator'; subagentes normales y de flujo segun sus reglas */
  role?: AgentRole;
  /** lugar de la sala al que camina (ver AgentPlace) */
  place?: AgentPlace;
  /** alerta roja viva del agente; null o ausente = sin alerta */
  alert?: LiveAlert | null;
  /** primer registro del agente (lead: inicio de la sesion) */
  startedAt?: string | null;
  /** ultima linea que escribio */
  lastActivityAt?: string | null;
  /** quien lo lanzo: agentId del agente padre, o el sessionId si lo lanzo el lead. null en el lead */
  parentId?: string | null;
  /** subagentes que lanzo en toda su vida (lead: en toda la sesion) */
  childCount?: number;
}

// ---- Corridas del tool Workflow ----

/** running: en curso · done: completo · failed: fallo · stopped: detenido o cancelado */
export type WorkflowStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowPhase {
  /** titulo de la fase (meta del script o visto en el journal) */
  title: string;
  /** pending: sin agentes · running: algun agente trabajando · done: ninguno trabajando · failed: todos fallaron */
  status: 'pending' | 'running' | 'done' | 'failed';
  agentsStarted: number;
  /** agentes terminados (con exito o con falla) */
  agentsDone: number;
}

export interface WorkflowAgentRef {
  agentId: string;
  /** etiqueta del agente en el script */
  label: string;
  phase: string | null;
  displayName: string;
  /** tipo del elenco (el de su rol si el script no pidio tipo); igual que OfficeAgent.agentType */
  agentType: string;
  /** rol del agente; igual que OfficeAgent.workflow.role */
  role?: WorkflowRole;
  /** misma persona que el agente en la oficina (o la ultima que tuvo) */
  persona?: string;
  status: 'working' | 'done' | 'failed';
  model: string | null;
  tokens: TokenBreakdown;
  /** null si algun modelo usado no tiene precio conocido */
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface WorkflowRun {
  /** carpeta subagents/workflows/<runId> */
  runId: string;
  /** meta.name del script, o el nombre que reporta el tool, o el runId */
  name: string;
  /** meta.description del script ('' si no se pudo leer) */
  description: string;
  status: WorkflowStatus;
  startedAt: string;
  endedAt: string | null;
  /** en el orden del script; las vistas solo en el journal van al final */
  phases: WorkflowPhase[];
  /** en orden de lanzamiento (incluye reintentos) */
  agents: WorkflowAgentRef[];
  /** suma de sus agentes */
  tokens: TokenBreakdown;
  /** null si algun agente tiene costo null */
  costUsd: number | null;
  /** pronostico del costo final (solo corridas en curso); ausente o null si no hay historial para estimar */
  forecast?: WorkflowForecast | null;
}

/**
 * Pronostico en vuelo de una corrida: lo gastado + lo que falta segun el historial (p25..p75 del costo
 * por agente del mismo rol y familia de modelo). Es una estimacion: la UI lo marca con "~".
 */
export interface WorkflowForecast {
  lowUsd: number;
  highUsd: number;
  /** presupuesto por workflow (regla workflow_cost) o null si la regla esta apagada */
  budgetUsd: number | null;
  /** contra el tope de la corrida: high si highUsd > budgetUsd, medium si highUsd > 0.7 x budgetUsd, si no low
   *  (riskOf es para fracciones del disponible del mes, no para el tope). null sin presupuesto */
  risk: BudgetRisk | null;
  /** agentes que entraron al calculo sin historial de su rol y modelo (se estiman con la mediana general) */
  unknownAgents: number;
}

/** apunte del usuario en una sala: algo pendiente que luego le pide a Claude Code (copiar y pegar) */
export interface RoomNote {
  id: string;
  text: string;
  /** ya se pidio o ya no aplica: no entra al copiar los pendientes */
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeRoom {
  /** sessionId */
  id: string;
  /** basename del cwd */
  projectName: string;
  /** customName si el usuario le puso uno; si no, autoTitle */
  title: string;
  // Los cuatro que siguen el server los manda siempre; son opcionales para que los fixtures y el demo
  // no tengan que armarlos.
  /** nombre que pone el sistema: el de la sesion (/rename) o projectName */
  autoTitle?: string;
  /** nombre propio que le puso el usuario a esta sala (por sesion: las de la misma carpeta no lo comparten) */
  customName?: string | null;
  /** llave de las notas de esta sala ("session:<id>"); el nombre quedo de cuando iban por carpeta */
  projectKey?: string;
  /** notas de esta sala, las mas viejas primero */
  notes?: RoomNote[];
  cwd: string;
  /** la sesion de Claude Code sigue abierta */
  open: boolean;
  busy: boolean;
  lastActivityAt: string;
  /** trabajo del agente principal de la sesion (su escritorio es el de lider) */
  lead: OfficeAgent;
  /** subagentes activos + los que terminaron hace poco (status 'done', para animar la salida) */
  subagents: OfficeAgent[];
  /** totales de la sesion completa (lead + todos sus subagentes) */
  tokens: TokenBreakdown;
  costUsd: number | null;
  /** corridas del tool Workflow de la sesion: activas + terminadas hoy, activas primero, maximo 5 */
  workflows?: WorkflowRun[];
  /**
   * lugar fijo de la sala en el mapa (0..MAX_ROOMS-1). Lo asigna el server y lo guarda en la DB: la sala no
   * se mueve mientras siga en la oficina; una nueva toma el primer lugar libre. La celda sale de cellOf en
   * web/src/scene/layout.ts. Sin el (demo, fixtures) el frontend asigna uno estable en la pagina.
   */
  slot?: number;
  /** rama git del ultimo registro de la sesion; null si no hay git (Claude Code escribe 'HEAD') */
  gitBranch?: string | null;
  /** alerta roja viva de la sala (reglas de sesion y de corrida); null o ausente = sin alerta */
  alert?: LiveAlert | null;
  /** hallazgos de habitos vivos de esta sesion (panel Habitos) */
  habitCount?: number;
}

export interface OfficeSnapshot {
  generatedAt: string;
  /** sala donde se escribio el ultimo prompt humano; ahi se sienta el usuario (el personaje del lead) */
  leadRoomId: string | null;
  /**
   * nombre del lead que eligio el usuario (PUT /api/settings/lead-name). null = el usuario todavia no eligio
   * nombre (la web lo pide); ausente = demo o fixtures
   */
  leadName?: string | null;
  /** abiertas + con actividad hoy; abiertas primero, luego por lastActivityAt desc. Sin las archivadas */
  rooms: OfficeRoom[];
  /**
   * salas que el usuario archivo y que sin eso estarian en rooms (para poder restaurarlas). Una sala archivada
   * vuelve sola a rooms si su chat tiene actividad despues de archivarla.
   */
  archivedRooms?: ArchivedRoom[];
  /** unpricedTokens: tokens de hoy de modelos sin precio conocido, fuera de costUsd (ausente = demo) */
  today: { costUsd: number; tokens: TokenBreakdown; unpricedTokens?: number };
  /** resumen vivo de habitos y alertas (insignia de la barra superior) */
  habits?: {
    /** hallazgos vivos en sesiones abiertas o de hoy */
    active: number;
    /** alertas rojas vivas (agentes + salas) */
    alerts: number;
    /** ahorro estimado de los hallazgos vivos */
    savingsUsd: number;
    /** el usuario activo la notificacion del navegador en Reglas */
    notifyBrowser: boolean;
  };
}

export interface ArchivedRoom {
  /** sessionId */
  id: string;
  /** mismo titulo que tendria en rooms */
  title: string;
  projectName: string;
  /** la sesion de Claude Code sigue abierta */
  open: boolean;
  archivedAt: string;
}

// ---- Historial ----

export interface BudgetResponse {
  /** 'YYYY-MM' (hora local) */
  month: string;
  budgetUsd: number;
  /** valor equivalente API (plan Enterprise: no es cobro real) */
  spentUsd: number;
  /**
   * spentUsd + burnRateUsd * dias laborales que faltan DESPUES de hoy. Sin dias laborales transcurridos:
   * igual a spentUsd.
   */
  projectedUsd: number;
  daily: { date: string; costUsd: number }[];
  /** tokens de modelos sin precio conocido (no suman al costo) */
  unpricedTokens: number;
  /**
   * ajuste del usuario a su gasto real: spentUsd = amountUsd + lo gastado desde `since`. Lo anterior a
   * `since` no suma (p.ej. sesiones de otra cuenta). Solo si el mes pedido es el ajustado.
   */
  baseline?: { amountUsd: number; since: string };
  // ---- Presupuesto por dia laboral (el server los manda siempre; opcionales para demo y fixtures) ----
  /** custom: el usuario fijo el monto (PUT /api/budget/amount) · default: BUDGET_DEFAULT_USD */
  budgetSource?: 'default' | 'custom';
  /** dias libres que marco el usuario en este mes ('YYYY-MM-DD'); festivos entre semana */
  daysOff?: string[];
  /**
   * dias laborales = lunes a viernes menos daysOff. elapsed cuenta hasta hoy inclusive; remaining cuenta
   * desde hoy inclusive (hoy esta en los dos si es laboral). En meses pasados remaining = 0; en futuros
   * elapsed = 0.
   */
  workdays?: { total: number; elapsed: number; remaining: number };
  /** spentUsd / workdays.elapsed; null sin dias laborales transcurridos */
  burnRateUsd?: number | null;
  /** promedio de los ultimos 5 dias laborales transcurridos (incluye hoy si es laboral); null sin datos */
  trend5dUsd?: number | null;
  /** max(0, budgetUsd - spentUsd) / workdays.remaining; null si no quedan dias laborales */
  recommendedPerDayUsd?: number | null;
  /** cache_read / (input + cache_read + cache_write) del mes, 0..1; null sin tokens */
  cachePct?: number | null;
  /** costo de trabajo descartado en el mes (ver DiscardedRow) */
  discardedUsd?: number;
}

/** monto por defecto del presupuesto mensual (editable en el panel) */
export const BUDGET_DEFAULT_USD = 500;

export type BudgetRisk = 'low' | 'medium' | 'high';

/** riesgo = extremo alto de la estimacion / presupuesto disponible: < 10 % bajo, 10-30 % medio, > 30 % alto */
export const RISK_MEDIUM_FROM = 0.1;
export const RISK_HIGH_FROM = 0.3;

export function riskOf(highUsd: number, availableUsd: number | null): BudgetRisk | null {
  if (availableUsd === null || !Number.isFinite(availableUsd)) return null;
  if (availableUsd <= 0) return 'high';
  const ratio = highUsd / availableUsd;
  if (ratio > RISK_HIGH_FROM) return 'high';
  if (ratio >= RISK_MEDIUM_FROM) return 'medium';
  return 'low';
}

export type HistoryRange = 'today' | 'week' | 'month' | 'all';

export interface RankingRow {
  /** agentType o projectName */
  key: string;
  label: string;
  tokens: TokenBreakdown;
  costUsd: number;
  tasks: number;
}

export interface RankingResponse {
  range: HistoryRange;
  byAgent: RankingRow[];
  byProject: RankingRow[];
}

export interface TaskRow {
  id: string;
  roomId: string;
  roomTitle: string;
  projectName: string;
  kind: 'lead' | 'subagent';
  agentType: string;
  displayName: string;
  title: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  tokens: TokenBreakdown;
  costUsd: number | null;
}

export interface TasksResponse {
  items: TaskRow[];
  nextCursor: string | null;
}

export type TranscriptEntryKind = 'prompt' | 'text' | 'tool_use' | 'tool_result';

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  kind: TranscriptEntryKind;
  /** texto plano, recortado a 4000 caracteres */
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface TranscriptResponse {
  agentId: string;
  entries: TranscriptEntry[];
  /** cursor para pedir entradas mas antiguas; null = no hay mas */
  nextCursor: string | null;
}

// ---- Nombres y notas de las salas ----
// El nombre y las notas van por sala (sesion): dos salas de la misma carpeta no los comparten. Las notas
// sobreviven al cierre de la sesion. Cada cambio llega a todos en el siguiente snapshot (SSE).
// PUT    /api/rooms/:id/name {name}           name null o '' = volver al nombre automatico
// POST   /api/notes        {projectKey, text}  -> RoomNote
// PATCH  /api/notes/:id    {text?, done?}      -> RoomNote
// DELETE /api/notes/:id
// DELETE /api/notes?projectKey=...&done=1     borra las hechas -> {removed}
// POST   /api/notes/move   {from, to}          pasa todas las notas de una sala a otra -> {moved}
// PUT    /api/rooms/order  {ids}               orden de la lista: las salas intercambian sus lugares del
//                                             mapa (la lista va por slot) -> {moved}
// PUT    /api/rooms/:id/archived {archived}   archiva o restaura una sala (por sesion, no por proyecto)
// DELETE /api/rooms/:id                       la elimina para siempre de la herramienta (no vuelve ni con
//                                             actividad nueva; el chat y el historial no se tocan)

export const ROOM_NAME_MAX = 80;
/** cleanLeadName (shared/agents.ts) corta el nombre del lead en este largo */
export const LEAD_NAME_MAX = 24;
export const NOTE_TEXT_MAX = 4000;

// ---- Nombre del lead ----
// Cada usuario lo elige al primer arranque; mientras no elija, el lead se llama DEFAULT_LEAD_NAME
// (shared/agents.ts). El cambio llega a todos en el siguiente snapshot (SSE).
// GET /api/settings/lead-name          -> LeadNameResponse
// PUT /api/settings/lead-name {name}   -> LeadNameResponse con el nombre limpio (400 si queda vacio)

export interface LeadNameRequest {
  name: string;
}

export interface LeadNameResponse {
  /** null = el usuario todavia no eligio nombre */
  name: string | null;
}

// ---- SSE /api/stream ----
// event: snapshot  data: OfficeSnapshot (JSON)
// event: ping      data: {} (cada 15 s)

// ---- Habitos y fugas de tokens (motor de reglas deterministas, cero tokens) ----
// GET /api/habits?range=live|today|week|month   -> HabitsResponse
//   live = sesiones abiertas + con actividad hoy (lo que se ve en la oficina)
// Nunca se incluye texto de prompts ni contenido de archivos: solo nombres de archivo, conteos y tokens.

export type HabitKind =
  /** el mismo agente leyo el mismo archivo N+ veces sin editarlo entre medio */
  | 'repeated_read'
  /** Read sin offset/limit de un archivo largo */
  | 'full_read'
  /** el contexto de una llamada supero el umbral */
  | 'big_context'
  /** muchos turnos o contexto alto sin /compact */
  | 'needs_compact'
  /** la misma herramienta con el mismo input N+ veces seguidas */
  | 'loop'
  /** la misma herramienta fallo N+ veces con el mismo error */
  | 'same_error'
  /** subagente en Fable/Opus haciendo casi solo lectura y busqueda */
  | 'expensive_model'
  /** poca cache o cache que se vence por pausas largas */
  | 'low_cache'
  /** respuestas muy largas de forma repetida */
  | 'long_output'
  /** agente de Desarrollo trabajando mucho rato sin editar nada */
  | 'idle_no_changes'
  /** servidor MCP cargado y nunca usado en la sesion */
  | 'mcp_unused'
  /** texto repetido entre las instrucciones cargadas (CLAUDE.md, memorias) */
  | 'dup_instructions'
  /** trabajo descartado: agentes failed/killed/stopped y reintentos de workflow */
  | 'discarded'
  /** salto una regla de aviso (ver ruleId) */
  | 'rule';

export interface HabitEvidence {
  /** "Lecturas", "Contexto maximo", "Costo del agente"... */
  label: string;
  value: number;
  unit: 'count' | 'tokens' | 'usd' | 'pct' | 'chars' | 'lines' | 'minutes';
  /** true si el valor es una estimacion (p.ej. tokens por tamano de texto: caracteres / 4) */
  estimated?: boolean;
}

export interface HabitFinding {
  /** estable entre recalculos: kind + alcance (sesion, agente, archivo, regla) */
  id: string;
  kind: HabitKind;
  ruleId?: RuleId;
  severity: 'info' | 'warning' | 'critical';
  roomId: string;
  roomTitle: string;
  projectName: string;
  agentId: string | null;
  agentName: string | null;
  /** una linea: "Leyo office.ts 6 veces completo" */
  title: string;
  evidence: HabitEvidence[];
  /** que hacer distinto, en espanol, 1-2 frases */
  recommendation: string;
  /** instruccion lista para pegar en Claude Code */
  copyText: string;
  /** ahorro estimado con los precios reales; null si no se puede calcular */
  savingsUsd: number | null;
  detectedAt: string;
  /** la sesion sigue abierta */
  live: boolean;
  /**
   * se copio a Claude Code y quedo descartado (bandeja). En el rango 'live' no se manda; en los historicos
   * viene marcado para que la UI lo muestre como "Enviada"
   */
  dismissed?: boolean;
}

/** tope de la lista de hallazgos por respuesta; byKind y totalSavingsUsd cuentan todos */
export const HABITS_LIST_MAX = 200;

export interface HabitsResponse {
  range: 'live' | Exclude<HistoryRange, 'all'>;
  generatedAt: string;
  /**
   * mas severos primero, luego mayor ahorro; maximo HABITS_LIST_MAX. En rangos historicos los hallazgos
   * repetidos del mismo tipo en una sesion (p.ej. varios agentes de un flujo con contexto grande) van
   * agrupados en uno solo con la evidencia sumada.
   */
  findings: HabitFinding[];
  /** hallazgos totales antes del tope (la UI muestra "200 de N") */
  total?: number;
  byKind: { kind: HabitKind; count: number; savingsUsd: number }[];
  totalSavingsUsd: number;
}

// ---- Bandeja: copiar alertas y avisos para Claude Code ----
// GET  /api/habits/inbox                                  -> HabitsInboxResponse
// POST /api/habits/inbox/dismiss {level, keys: string[]}  -> HabitsInboxResponse (despues de copiar)
// POST /api/habits/inbox/restore {keys: string[]}         -> HabitsInboxResponse (deshacer)
//
// Alertas = nivel critical; avisos = warning (los info no entran). Al copiar, esos items quedan descartados en
// todos lados (lista en vivo, contadores del HUD, rotulos y el "!" de la escena) hasta que salga algo nuevo:
// otra alerta, la misma en un episodio nuevo (se fue y volvio), un aviso que sube a critico o un grupo que
// suma agentes. Un costo que sigue subiendo no la hace volver.

export type InboxLevel = 'critical' | 'warning';

export interface InboxItem {
  /**
   * llave estable del descarte: 'f:<id del hallazgo>' o, para alertas vivas sin hallazgo,
   * 'a:agent:<agentId>:<source>:<ruleId|->' / 'a:room:<sessionId>:<source>:<ruleId|->'
   */
  key: string;
  level: InboxLevel;
  roomId: string;
  roomTitle: string;
  projectName: string;
  agentName: string | null;
  /** texto corto, sin texto de prompts */
  title: string;
  /** instruccion para el lead: el copyText del hallazgo o la de su regla */
  instruction: string;
}

export interface InboxGroup {
  level: InboxLevel;
  /** en el orden del texto: por sala y dentro de cada sala como la lista de habitos */
  items: InboxItem[];
  /** texto ordenado listo para pegar en el chat de Claude Code ('' si no hay items) */
  text: string;
}

export interface HabitsInboxResponse {
  generatedAt: string;
  /** criticas */
  alerts: InboxGroup;
  /** warnings */
  warnings: InboxGroup;
  /** vivos pero descartados ahora (ocultos hasta que salga algo nuevo) */
  dismissed: number;
}

// ---- Reglas de aviso ----
// GET /api/rules                                   -> RulesResponse
// PUT /api/rules/:id  {value?: number | null, enabled?: boolean}  -> RulesResponse
//     value null = volver al valor calibrado
// PUT /api/rules/notify {enabled: boolean}          -> RulesResponse

export interface RuleConfig {
  id: RuleId;
  /** "Costo de un agente" */
  label: string;
  unit: 'usd' | 'count';
  /** umbral vigente */
  value: number;
  /** calibrated: p90 de los ultimos 30 dias · floor: pocos datos, se usa el minimo · custom: lo fijo el usuario */
  source: 'calibrated' | 'floor' | 'custom';
  /** p90 calculado; null con menos de RULE_MIN_SAMPLES muestras */
  calibratedValue: number | null;
  samples: number;
  /** minimo por debajo del cual la calibracion no baja */
  floor: number;
  enabled: boolean;
}

export const RULE_MIN_SAMPLES = 10;

export interface RulesResponse {
  rules: RuleConfig[];
  notifyBrowser: boolean;
  windowDays: number;
  calibratedAt: string;
}

// ---- Costos (historial) ----
// GET /api/history/costs?range=today|week|month|all  -> CostsResponse
// Costo por agente = ranking byAgent · costo por tarea = tareas. Aqui: por modelo, proyecto y rol.
// PUT    /api/budget/amount   {amountUsd}           -> BudgetResponse (monto del presupuesto mensual)
// DELETE /api/budget/amount                          -> BudgetResponse (vuelve a BUDGET_DEFAULT_USD)
// PUT    /api/budget/days-off {date: 'YYYY-MM-DD', off: boolean} -> BudgetResponse del mes de esa fecha

export interface CostRow {
  /** id del modelo, projectName o rol */
  key: string;
  label: string;
  tokens: TokenBreakdown;
  /** suma SOLO de los tokens con precio; ver unpricedTokens */
  costUsd: number;
  /** tokens de modelos sin precio (no suman a costUsd; la UI marca "sin precio"). Ausente = 0 */
  unpricedTokens?: number;
  /** 0..1; null sin tokens */
  cachePct: number | null;
  tasks: number;
}

export interface DiscardedRow {
  agentId: string;
  /** tipo del elenco (look_type o agent_type) */
  agentType: string;
  role: AgentRole | null;
  roomTitle: string;
  projectName: string;
  /** failed/killed/stopped: termino sin exito · retry: intento reemplazado por un reintento del workflow */
  reason: 'failed' | 'killed' | 'stopped' | 'retry';
  tokens: TokenBreakdown;
  costUsd: number | null;
  endedAt: string | null;
}

export interface CostsResponse {
  range: HistoryRange;
  totals: { tokens: TokenBreakdown; costUsd: number; cachePct: number | null; unpricedTokens?: number };
  byModel: CostRow[];
  byProject: CostRow[];
  byRole: CostRow[];
  discarded: { costUsd: number; tokens: TokenBreakdown; count: number; items: DiscardedRow[] };
}

// ---- Comparador de eficiencia (por configuracion, no "que agente es mejor") ----
// GET /api/history/compare?range=week|month|all  -> CompareResponse

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';

export interface CompareRow {
  /** `${family}:${role}` */
  key: string;
  family: ModelFamily;
  role: AgentRole;
  tasks: number;
  /** terminadas sin error final ni interrupcion */
  completed: number;
  /** suma SOLO de las tareas con precio completo */
  costUsd: number;
  /** tareas con tokens sin precio: no entran en costUsd ni en los promedios de costo. Ausente = 0 */
  unpricedTasks?: number;
  /** null si no hay tareas completadas con precio completo */
  costPerCompletedUsd: number | null;
  /** archivos distintos editados con exito (Edit/Write/NotebookEdit) */
  filesChanged: number;
  tokensPerFileChanged: number | null;
  avgDurationMs: number | null;
  /** herramientas que fallaron (sin contar rechazos del usuario) */
  errors: number;
  /** reintentos de workflow + repeticiones tras un error */
  retries: number;
  testRuns: number;
  /** 0..1; null sin corridas de test */
  testPassPct: number | null;
  cachePct: number | null;
  discardedUsd: number;
}

export interface CompareSummary {
  tasks: number;
  costPerCompletedUsd: number | null;
  avgDurationMs: number | null;
  errors: number;
  cachePct: number | null;
}

export interface CompareResponse {
  range: Exclude<HistoryRange, 'today'>;
  rows: CompareRow[];
  /** tareas del lead y subagentes que usaron una skill vs las que no */
  skill: { with: CompareSummary; without: CompareSummary };
  workflows: { runs: number; avgDurationMs: number | null; avgCostUsd: number | null; p50CostUsd: number | null };
  /** suma del ahorro estimado de los habitos del periodo */
  potentialSavingsUsd: number;
}

// ---- Simulador de presupuesto ----
// GET /api/history/simulator -> SimulatorResponse (el calculo del escenario lo hace el cliente con riskOf)

export interface SimBaselineRow {
  role: AgentRole;
  family: ModelFamily;
  /** agentes terminados de ese rol y familia en la ventana */
  samples: number;
  /** costo por agente; null con menos de 3 muestras ("sin historico") */
  p25Usd: number | null;
  p50Usd: number | null;
  p75Usd: number | null;
}

export interface SimulatorResponse {
  windowDays: number;
  rows: SimBaselineRow[];
  /** presupuesto del mes - gastado; null si no se pudo calcular */
  availableUsd: number | null;
  /** valor vigente de la regla workflow_cost; null si esta apagada */
  workflowBudgetUsd: number | null;
}
