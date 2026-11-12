import type { Db } from '../db/connection';

// Consultas del motor de habitos. Todas agregan en SQL y entran por agente o por sesion (indices
// actions_agent, usage_agent_ts, agents_session) para que refresh() quede por debajo de 50 ms con la DB
// real. Nunca se lee texto de prompts: solo herramientas, rutas, conteos, tokens y costos.

const EDIT_SQL = `('Edit', 'Write', 'NotebookEdit', 'MultiEdit')`;
/**
 * herramientas cuyo input es contenido que escribe el modelo (el archivo, el encargo, el script del flujo): una
 * respuesta con una de estas no es charla
 */
const AUTHORED_SQL = `('Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Agent', 'Task', 'Workflow')`;
/**
 * herramientas de espera: se llaman a proposito con el mismo input mientras corre algo en segundo plano, asi
 * que sus rachas no son bucles (igual cortan las rachas de las demas)
 */
export const WAIT_TOOLS: readonly string[] = ['BashOutput', 'TaskOutput', 'Monitor'];
const WAIT_SQL = `(${WAIT_TOOLS.map((t) => `'${t}'`).join(', ')})`;
/** lectura y busqueda (Bash/PowerShell cuentan solo con git de lectura) */
const LOOKUP_SQL = `(tool IN ('Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill')
  OR (tool IN ('Bash', 'PowerShell') AND cmd_class = 'git_read'))`;
/** edicion que termino bien: sin error y sin rechazo del usuario */
const EDIT_OK_SQL = `(tool IN ${EDIT_SQL} AND ended_at IS NOT NULL AND is_error = 0 AND denied IS NULL)`;
const CTX_SQL = `(input + cache_read + cache_write_5m + cache_write_1h)`;
const IN_AGENTS = `IN (SELECT value FROM json_each(@agents))`;
const IN_SESSIONS = `IN (SELECT value FROM json_each(@sessions))`;
/** racha de acciones identicas (misma herramienta + input_hash) por agente: islas de ROW_NUMBER */
const STREAKS_CTE = (where: string) => `
  WITH seq AS (
    SELECT agent_id, tool, input_hash, target, started_at,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at, tool_use_id)
           - ROW_NUMBER() OVER (PARTITION BY agent_id, tool, input_hash ORDER BY started_at, tool_use_id) AS grp
    FROM actions WHERE ${where}
  ),
  runs AS (
    SELECT agent_id, tool, input_hash, MAX(target) AS target, COUNT(*) AS n, MAX(started_at) AS last_ts
    FROM seq WHERE input_hash IS NOT NULL AND tool NOT IN ${WAIT_SQL} GROUP BY agent_id, tool, input_hash, grp
  )`;

export interface SessionInfoRow {
  session_id: string;
  cwd: string | null;
  project_name: string | null;
  project_dir: string | null;
  registry_name: string | null;
  custom_title: string | null;
  /** nombre propio que le puso el usuario a la sala */
  custom_name: string | null;
  last_activity_at: number | null;
  turn_open: number;
  last_prompt_at: number | null;
}

export interface AgentRow {
  agent_id: string;
  session_id: string;
  kind: string;
  /** tipo del elenco (look_type) o el tecnico */
  agent_type: string;
  role: string | null;
  model: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  ended_at: number | null;
}

/** uso de la API de un agente con un modelo, en la ventana */
export interface UsageAggRow {
  agent_id: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cw5: number;
  cw1h: number;
  /** solo lo que tiene precio */
  cost: number;
  unpriced_calls: number;
  max_ctx: number;
  /** suma de lo que cada llamada paso del umbral de contexto grande */
  over_ctx: number;
  over_calls: number;
  last_ts: number;
}

export interface ActionStatRow {
  agent_id: string;
  n: number;
  /** lectura y busqueda */
  lookups: number;
  /** ediciones exitosas */
  edits: number;
  last_ts: number;
}

export interface FileActionRow {
  agent_id: string;
  tool: string;
  target: string;
  started_at: number;
  ended_at: number | null;
  is_error: number;
  denied: string | null;
  read_partial: number | null;
  input_hash: string | null;
  result_chars: number | null;
  result_lines: number | null;
}

export interface StreakRow {
  agent_id: string;
  tool: string;
  input_hash: string;
  /** archivo de la accion repetida (Read, Edit...), si tiene */
  target: string | null;
  n: number;
  last_ts: number;
}

export interface ErrorGroupRow {
  agent_id: string;
  tool: string;
  result_hash: string;
  n: number;
  /** inputs distintos que dieron este error; con 1 es la misma llamada repetida */
  inputs: number;
  input_hash: string | null;
  target: string | null;
  last_ts: number;
}

/** llamadas tras una pausa larga que reescribieron la mayor parte del contexto (cache vencida) */
export interface PauseRow {
  agent_id: string;
  model: string;
  n: number;
  cache_write: number;
  last_ts: number;
}

export interface LongOutputRow {
  agent_id: string;
  model: string;
  n: number;
  /** suma de lo que cada respuesta paso del largo razonable */
  extra: number;
  last_ts: number;
}

export interface EventRow {
  session_id: string;
  agent_id: string;
  ts: number;
  kind: string;
  data: string | null;
}

export interface DiscardRow {
  agent_id: string;
  session_id: string;
  at: number;
  /** failed | killed | stopped (notificacion) o retry (intento de workflow reemplazado) */
  reason: string;
  cost: number;
}

export interface DayCostRow {
  session_id: string;
  /** 'YYYY-MM-DD' hora local */
  day: string;
  cost: number;
  last_ts: number;
}

export interface RunCostRow {
  run_id: string;
  session_id: string;
  name: string;
  running: number;
  cost: number;
  last_ts: number | null;
}

export interface TurnRow {
  session_id: string;
  started_at: number;
  ended_at: number;
}

export interface LaunchRow {
  session_id: string;
  started_at: number;
}

export interface CtxRow {
  model: string;
  ctx: number;
  ts: number;
}

export interface TailRow {
  tool: string;
  input_hash: string | null;
  is_error: number;
  denied: string | null;
  ended_at: number | null;
}

/** sesiones y agentes elegidos + desde cuando cuentan los eventos (ms) */
export interface Scope {
  sessions: readonly string[];
  agents: readonly string[];
  since: number;
}

type AgentsParams = { agents: string; since: number };
type SessionsParams = { sessions: string; since: number };

function prepare(db: Db) {
  return {
    activeSince: db.prepare<[number], { session_id: string }>(
      `SELECT session_id FROM sessions WHERE last_activity_at >= ?`,
    ),
    // archivadas sin actividad posterior y eliminadas: no se ven en la oficina
    hidden: db.prepare<[], { session_id: string }>(`
      SELECT r.session_id FROM archived_rooms r LEFT JOIN sessions s ON s.session_id = r.session_id
      WHERE r.deleted = 1 OR COALESCE(s.last_activity_at, 0) <= r.archived_at`),
    sessionInfo: db.prepare<{ sessions: string }, SessionInfoRow>(`
      SELECT s.session_id, s.cwd, s.project_name, s.project_dir, s.registry_name, s.custom_title,
             n.name AS custom_name, s.last_activity_at, s.turn_open, s.last_prompt_at
      FROM sessions s LEFT JOIN session_names n ON n.session_id = s.session_id
      WHERE s.session_id ${IN_SESSIONS}`),
    agents: db.prepare<SessionsParams, AgentRow>(`
      SELECT agent_id, session_id, kind, COALESCE(look_type, agent_type) AS agent_type, role, model,
             started_at, last_activity_at, ended_at
      FROM agents
      WHERE session_id ${IN_SESSIONS}
        AND (kind = 'lead' OR ended_at IS NULL OR ended_at >= @since OR last_activity_at >= @since)`),
    usage: db.prepare<AgentsParams & { big: number }, UsageAggRow>(`
      SELECT agent_id, model, COUNT(*) AS calls,
             SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
             SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1h,
             COALESCE(SUM(cost_usd), 0) AS cost,
             SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
             MAX(${CTX_SQL}) AS max_ctx,
             SUM(CASE WHEN ${CTX_SQL} > @big THEN ${CTX_SQL} - @big ELSE 0 END) AS over_ctx,
             SUM(CASE WHEN ${CTX_SQL} > @big THEN 1 ELSE 0 END) AS over_calls,
             MAX(ts) AS last_ts
      FROM usage WHERE agent_id ${IN_AGENTS} AND ts >= @since
      GROUP BY agent_id, model`),
    actionStats: db.prepare<AgentsParams, ActionStatRow>(`
      SELECT agent_id, COUNT(*) AS n,
             SUM(CASE WHEN ${LOOKUP_SQL} THEN 1 ELSE 0 END) AS lookups,
             SUM(CASE WHEN ${EDIT_OK_SQL} THEN 1 ELSE 0 END) AS edits,
             MAX(started_at) AS last_ts
      FROM actions WHERE agent_id ${IN_AGENTS} AND started_at >= @since
      GROUP BY agent_id`),
    fileActions: db.prepare<AgentsParams, FileActionRow>(`
      SELECT agent_id, tool, target, started_at, ended_at, is_error, denied, read_partial, input_hash,
             result_chars, result_lines
      FROM actions
      WHERE agent_id ${IN_AGENTS} AND started_at >= @since AND target IS NOT NULL
        AND (tool = 'Read' OR tool IN ${EDIT_SQL})
      ORDER BY agent_id, started_at, tool_use_id`),
    streaks: db.prepare<AgentsParams & { min: number }, StreakRow>(`
      ${STREAKS_CTE(`agent_id ${IN_AGENTS} AND started_at >= @since`)}
      SELECT agent_id, tool, input_hash, target, n, last_ts FROM runs WHERE n >= @min`),
    errorGroups: db.prepare<AgentsParams & { min: number }, ErrorGroupRow>(`
      SELECT agent_id, tool, result_hash, COUNT(*) AS n, COUNT(DISTINCT input_hash) AS inputs,
             MAX(input_hash) AS input_hash, MAX(target) AS target, MAX(started_at) AS last_ts
      FROM actions
      WHERE agent_id ${IN_AGENTS} AND started_at >= @since AND is_error = 1 AND denied IS NULL
        AND result_hash IS NOT NULL
      GROUP BY agent_id, tool, result_hash HAVING n >= @min`),
    pauses: db.prepare<AgentsParams & { pause: number }, PauseRow>(`
      WITH u AS (
        SELECT agent_id, model, ts, cache_write_5m + cache_write_1h AS cw, ${CTX_SQL} AS ctx,
               ts - LAG(ts) OVER (PARTITION BY agent_id ORDER BY ts) AS gap
        FROM usage WHERE agent_id ${IN_AGENTS} AND ts >= @since
      )
      SELECT agent_id, model, COUNT(*) AS n, SUM(cw) AS cache_write, MAX(ts) AS last_ts
      FROM u WHERE gap > @pause AND cw * 2 > ctx
      GROUP BY agent_id, model`),
    // una respuesta con Write/Edit adentro es el archivo, no charla, y con Agent/Task/Workflow es el encargo o el
    // script: se busca una de esas acciones entre esta llamada y la siguiente del mismo agente. El razonamiento
    // (thinking) va dentro de output y no se puede separar
    longOutputs: db.prepare<AgentsParams & { long: number; keep: number }, LongOutputRow>(`
      WITH u AS (
        SELECT agent_id, model, ts, output, LEAD(ts) OVER (PARTITION BY agent_id ORDER BY ts) AS next_ts
        FROM usage WHERE agent_id ${IN_AGENTS} AND ts >= @since
      )
      SELECT u.agent_id, u.model, COUNT(*) AS n, SUM(u.output - @keep) AS extra, MAX(u.ts) AS last_ts
      FROM u
      WHERE u.output > @long AND NOT EXISTS (
        SELECT 1 FROM actions a
        WHERE a.agent_id = u.agent_id AND a.tool IN ${AUTHORED_SQL}
          AND a.started_at >= u.ts AND (u.next_ts IS NULL OR a.started_at < u.next_ts))
      GROUP BY u.agent_id, u.model`),
    events: db.prepare<{ sessions: string }, EventRow>(`
      SELECT session_id, agent_id, ts, kind, data FROM session_events
      WHERE session_id ${IN_SESSIONS} AND kind IN ('compact', 'mcp_loaded', 'instructions')
      ORDER BY session_id, ts`),
    mcpTools: db.prepare<{ sessions: string }, { session_id: string; tool: string }>(`
      SELECT DISTINCT g.session_id, x.tool
      FROM agents g JOIN actions x ON x.agent_id = g.agent_id
      WHERE g.session_id ${IN_SESSIONS} AND x.tool LIKE 'mcp\\_\\_%' ESCAPE '\\'`),
    discarded: db.prepare<SessionsParams, DiscardRow>(`
      WITH d AS (
        SELECT a.agent_id, a.session_id, a.ended_at AS at, w.end_status,
               (SELECT n.status FROM notifications n WHERE n.task_id = a.agent_id ORDER BY n.ts DESC LIMIT 1) AS notif,
               EXISTS (SELECT 1 FROM workflow_agents w2
                       WHERE w2.run_id = w.run_id AND w2.key = w.key AND w2.seq > w.seq) AS retried
        FROM agents a LEFT JOIN workflow_agents w ON w.agent_id = a.agent_id
        WHERE a.session_id ${IN_SESSIONS} AND a.kind = 'subagent' AND a.ended_at >= @since
      )
      SELECT d.agent_id, d.session_id, d.at,
             CASE WHEN d.notif IN ('failed', 'killed', 'stopped') THEN d.notif
                  WHEN d.end_status = 'superseded' OR d.retried = 1 THEN 'retry'
                  ELSE 'failed' END AS reason,
             (SELECT COALESCE(SUM(u.cost_usd), 0) FROM usage u WHERE u.agent_id = d.agent_id) AS cost
      FROM d
      WHERE d.notif IN ('failed', 'killed', 'stopped') OR d.end_status IN ('superseded', 'failed') OR d.retried = 1`),
    dayCosts: db.prepare<SessionsParams, DayCostRow>(`
      SELECT session_id, date(ts / 1000, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(cost_usd), 0) AS cost, MAX(ts) AS last_ts
      FROM usage WHERE session_id ${IN_SESSIONS} AND ts >= @since
      GROUP BY session_id, day`),
    // en curso con el mismo criterio que WorkflowsBuilder: sin senal de fin y con agentes trabajando o con el
    // journal (o el lanzamiento) movido hace poco, para que la alerta no se apague entre fases
    runs: db.prepare<{ sessions: string; recent: number }, RunCostRow>(`
      SELECT r.run_id, r.session_id, COALESCE(r.meta_name, r.tool_name, r.run_id) AS name,
             CASE WHEN r.final_status IS NULL
                   AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.task_id = r.task_id)
                   AND (EXISTS (SELECT 1 FROM workflow_agents w3 JOIN agents a ON a.agent_id = w3.agent_id
                                WHERE w3.run_id = r.run_id AND a.ended_at IS NULL)
                        OR COALESCE(f.mtime_ms, r.launched_at) > @recent)
                  THEN 1 ELSE 0 END AS running,
             COALESCE(SUM(u.cost_usd), 0) AS cost, MAX(u.ts) AS last_ts
      FROM workflow_runs r
      LEFT JOIN file_offsets f ON f.path_key = r.journal_key
      LEFT JOIN workflow_agents w ON w.run_id = r.run_id
      LEFT JOIN usage u ON u.agent_id = w.agent_id
      WHERE r.session_id ${IN_SESSIONS}
      GROUP BY r.run_id`),
    leadTurns: db.prepare<{ sessions: string }, TurnRow>(`
      SELECT agent_id AS session_id, started_at, ended_at FROM tasks
      WHERE kind = 'lead' AND agent_id ${IN_SESSIONS}
      ORDER BY agent_id, started_at`),
    leadLaunches: db.prepare<SessionsParams, LaunchRow>(`
      SELECT parent_agent_id AS session_id, started_at FROM launches
      WHERE parent_agent_id ${IN_SESSIONS} AND started_at >= @since
      ORDER BY started_at`),
    callsAfter: db.prepare<[string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM usage WHERE agent_id = ? AND ts > ?`,
    ),
    lastContexts: db.prepare<[string, number, number], CtxRow>(`
      SELECT model, ${CTX_SQL} AS ctx, ts FROM usage WHERE agent_id = ? AND ts > ?
      ORDER BY ts DESC LIMIT ?`),
    tail: db.prepare<[string, number], TailRow>(`
      SELECT tool, input_hash, is_error, denied, ended_at FROM actions WHERE agent_id = ?
      ORDER BY started_at DESC, tool_use_id DESC LIMIT ?`),
    lifeCosts: db.prepare<{ agents: string }, { agent_id: string; cost: number }>(`
      SELECT agent_id, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE agent_id ${IN_AGENTS}
      GROUP BY agent_id`),
  };
}

const json = (ids: readonly string[]): string => JSON.stringify(ids);

/** hechos crudos (ya agregados) que consumen los detectores y las alertas vivas */
export class HabitFacts {
  private readonly st: ReturnType<typeof prepare>;

  constructor(db: Db) {
    this.st = prepare(db);
  }

  sessionsActiveSince(since: number): string[] {
    return this.st.activeSince.all(since).map((r) => r.session_id);
  }

  hiddenSessions(): Set<string> {
    return new Set(this.st.hidden.all().map((r) => r.session_id));
  }

  sessionInfo(sessions: readonly string[]): SessionInfoRow[] {
    return this.st.sessionInfo.all({ sessions: json(sessions) });
  }

  /** lead de cada sesion + subagentes con actividad desde `since` o sin terminar */
  agents(sessions: readonly string[], since: number): AgentRow[] {
    return this.st.agents.all({ sessions: json(sessions), since });
  }

  usage(s: Scope, bigContext: number): UsageAggRow[] {
    return this.st.usage.all({ agents: json(s.agents), since: s.since, big: bigContext });
  }

  actionStats(s: Scope): ActionStatRow[] {
    return this.st.actionStats.all({ agents: json(s.agents), since: s.since });
  }

  /** Read y ediciones con archivo, en orden por agente */
  fileActions(s: Scope): FileActionRow[] {
    return this.st.fileActions.all({ agents: json(s.agents), since: s.since });
  }

  /** rachas de acciones identicas de largo >= min */
  streaks(s: Scope, min: number): StreakRow[] {
    return this.st.streaks.all({ agents: json(s.agents), since: s.since, min });
  }

  /** fallos con el mismo (herramienta, error) repetidos >= min veces por agente */
  errorGroups(s: Scope, min: number): ErrorGroupRow[] {
    return this.st.errorGroups.all({ agents: json(s.agents), since: s.since, min });
  }

  pauses(s: Scope, pauseMs: number): PauseRow[] {
    return this.st.pauses.all({ agents: json(s.agents), since: s.since, pause: pauseMs });
  }

  longOutputs(s: Scope, long: number, keep: number): LongOutputRow[] {
    return this.st.longOutputs.all({ agents: json(s.agents), since: s.since, long, keep });
  }

  /** compactaciones, MCP cargados e instrucciones de toda la vida de las sesiones */
  events(sessions: readonly string[]): EventRow[] {
    return this.st.events.all({ sessions: json(sessions) });
  }

  /** herramientas MCP que se usaron en cada sesion (cualquier agente) */
  mcpTools(sessions: readonly string[]): Array<{ session_id: string; tool: string }> {
    if (sessions.length === 0) return [];
    return this.st.mcpTools.all({ sessions: json(sessions) });
  }

  discarded(sessions: readonly string[], since: number): DiscardRow[] {
    return this.st.discarded.all({ sessions: json(sessions), since });
  }

  dayCosts(sessions: readonly string[], since: number): DayCostRow[] {
    return this.st.dayCosts.all({ sessions: json(sessions), since });
  }

  /** `recent`: un journal o un lanzamiento posterior a esto cuenta como corrida en curso */
  runs(sessions: readonly string[], recent: number): RunCostRow[] {
    return this.st.runs.all({ sessions: json(sessions), recent });
  }

  /** turnos cerrados del lead (tabla tasks), de toda la vida de las sesiones */
  leadTurns(sessions: readonly string[]): TurnRow[] {
    return this.st.leadTurns.all({ sessions: json(sessions) });
  }

  /** subagentes lanzados por el lead (tool Agent/Task) */
  leadLaunches(sessions: readonly string[], since: number): LaunchRow[] {
    return this.st.leadLaunches.all({ sessions: json(sessions), since });
  }

  callsAfter(agentId: string, after: number): number {
    return this.st.callsAfter.get(agentId, after)?.n ?? 0;
  }

  /** contexto de las ultimas `limit` llamadas despues de `after`, la mas reciente primero */
  lastContexts(agentId: string, after: number, limit: number): CtxRow[] {
    return this.st.lastContexts.all(agentId, after, limit);
  }

  /** ultimas acciones del agente, la mas reciente primero */
  tail(agentId: string, limit: number): TailRow[] {
    return this.st.tail.all(agentId, limit);
  }

  /** costo de toda la vida de cada agente */
  lifeCosts(agents: readonly string[]): Map<string, number> {
    if (agents.length === 0) return new Map();
    return new Map(this.st.lifeCosts.all({ agents: json(agents) }).map((r) => [r.agent_id, r.cost]));
  }
}

/** muestras de los ultimos dias para calibrar las reglas (RulesService, cacheado 1 h) */
export class CalibrationFacts {
  private readonly st;

  constructor(db: Db) {
    this.st = {
      agentCosts: db.prepare<[number], { v: number }>(
        `SELECT cost_usd AS v FROM tasks WHERE kind = 'subagent' AND ended_at >= ? AND unpriced_tokens = 0`,
      ),
      sessionDayCosts: db.prepare<[number], { v: number }>(`
        SELECT SUM(cost_usd) AS v FROM usage WHERE ts >= ?
        GROUP BY session_id, date(ts / 1000, 'unixepoch', 'localtime') HAVING v IS NOT NULL`),
      workflowCosts: db.prepare<[number], { v: number; first: number }>(`
        SELECT SUM(u.cost_usd) AS v, MIN(u.ts) AS first
        FROM workflow_agents w JOIN usage u ON u.agent_id = w.agent_id
        GROUP BY w.run_id HAVING first >= ? AND v IS NOT NULL`),
      leadTurns: db.prepare<[number], TurnRow>(`
        SELECT agent_id AS session_id, started_at, ended_at FROM tasks
        WHERE kind = 'lead' AND started_at >= ? ORDER BY agent_id, started_at`),
      compacts: db.prepare<[number], { session_id: string; ts: number }>(`
        SELECT session_id, ts FROM session_events
        WHERE kind = 'compact' AND agent_id = session_id AND ts >= ? ORDER BY session_id, ts`),
      leadLaunches: db.prepare<[number], LaunchRow>(`
        SELECT parent_agent_id AS session_id, started_at FROM launches
        WHERE parent_agent_id = session_id AND started_at >= ? ORDER BY started_at`),
      maxStreaks: db.prepare<[number], { v: number }>(`
        ${STREAKS_CTE('started_at >= ?')}
        SELECT MAX(n) AS v FROM runs GROUP BY agent_id`),
    };
  }

  agentCosts(since: number): number[] {
    return this.st.agentCosts.all(since).map((r) => r.v);
  }

  sessionDayCosts(since: number): number[] {
    return this.st.sessionDayCosts.all(since).map((r) => r.v);
  }

  workflowCosts(since: number): number[] {
    return this.st.workflowCosts.all(since).map((r) => r.v);
  }

  leadTurns(since: number): TurnRow[] {
    return this.st.leadTurns.all(since);
  }

  compacts(since: number): Array<{ session_id: string; ts: number }> {
    return this.st.compacts.all(since);
  }

  leadLaunches(since: number): LaunchRow[] {
    return this.st.leadLaunches.all(since);
  }

  maxStreaks(since: number): number[] {
    return this.st.maxStreaks.all(since).map((r) => r.v);
  }
}
