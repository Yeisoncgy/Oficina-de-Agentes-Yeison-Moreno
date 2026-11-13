import { TIMING } from '../config';
import type { Db } from '../db/connection';
import type { TaskWriter } from './tasks';

interface CandidateRow {
  agent_id: string;
  session_id: string;
  tool_use_id: string | null;
  is_async: number;
  started_at: number | null;
  last_activity_at: number | null;
  last_stop: string | null;
  ended_at: number | null;
  end_reason: string | null;
  mtime_ms: number | null;
  session_activity: number | null;
  /** agente de Workflow: result | failed | superseded segun su journal */
  wf_end: string | null;
  /** fin de su corrida (task-notification o <runId>.json) */
  run_end: number | null;
}

/** fines que una senal del padre (notificacion o tool_result) puede corregir */
const SOFT_END = `('fallback', 'closed')`;
const TERMINAL_STOPS = new Set(['end_turn', 'stop_sequence']);

/**
 * Decide que subagentes terminaron y cierra turnos del lead en sesiones muertas. Corre despues de
 * cada lote de ingesta y en cada sweep, porque el fin de un subagente depende de archivos distintos
 * (su transcript, el del padre, el registro de sesiones) que pueden llegar en cualquier orden.
 */
export class Reconciler {
  private readonly linkLaunch;
  private readonly fillFromLaunch;
  private readonly candidates;
  private readonly firstNotification;
  private readonly getLaunch;
  private readonly hasOpenAction;
  private readonly endAgent;
  private readonly openTurns;
  private readonly endTurn;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskWriter,
  ) {
    this.linkLaunch = db.prepare(`
      UPDATE agents SET tool_use_id = (
        SELECT l.tool_use_id FROM launches l WHERE l.result_agent_id = agents.agent_id LIMIT 1)
      WHERE kind = 'subagent' AND tool_use_id IS NULL
        AND EXISTS (SELECT 1 FROM launches l WHERE l.result_agent_id = agents.agent_id)`);
    // sin meta.json todavia: el tipo y la descripcion salen del tool_use que lo lanzo
    this.fillFromLaunch = db.prepare(`
      UPDATE agents SET
        agent_type = (SELECT l.subagent_type FROM launches l WHERE l.tool_use_id = agents.tool_use_id),
        description = (SELECT l.description FROM launches l WHERE l.tool_use_id = agents.tool_use_id),
        task_dirty = 1
      WHERE kind = 'subagent' AND meta_seen = 0 AND tool_use_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM launches l WHERE l.tool_use_id = agents.tool_use_id
                    AND (l.subagent_type <> agents.agent_type OR l.description <> agents.description))`);
    this.candidates = db.prepare<[], CandidateRow>(`
      SELECT a.agent_id, a.session_id, a.tool_use_id, a.is_async, a.started_at, a.last_activity_at,
             a.last_stop, a.ended_at, a.end_reason, f.mtime_ms, s.last_activity_at AS session_activity,
             w.end_status AS wf_end,
             COALESCE((SELECT MIN(n.ts) FROM notifications n WHERE n.task_id = r.task_id), r.final_at) AS run_end
      FROM agents a
      LEFT JOIN file_offsets f ON f.path_key = a.transcript_key
      LEFT JOIN sessions s ON s.session_id = a.session_id
      LEFT JOIN workflow_agents w ON w.agent_id = a.agent_id
      LEFT JOIN workflow_runs r ON r.run_id = w.run_id
      WHERE a.kind = 'subagent' AND (
        a.ended_at IS NULL OR (a.end_reason IN ${SOFT_END} AND (
          EXISTS (SELECT 1 FROM notifications n WHERE n.task_id = a.agent_id)
          OR EXISTS (SELECT 1 FROM launches l WHERE l.tool_use_id = a.tool_use_id
                     AND l.result_at IS NOT NULL AND l.is_async = 0))))`);
    this.firstNotification = db.prepare<[string, number], { ts: number | null }>(
      `SELECT MIN(ts) AS ts FROM notifications WHERE task_id = ? AND ts >= ?`,
    );
    this.getLaunch = db.prepare<[string], { result_at: number | null; is_async: number }>(
      `SELECT result_at, is_async FROM launches WHERE tool_use_id = ?`,
    );
    this.hasOpenAction = db.prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM actions WHERE agent_id = ? AND ended_at IS NULL LIMIT 1`,
    );
    this.endAgent = db.prepare<[number, string, string]>(
      `UPDATE agents SET ended_at = ?, end_reason = ?, task_dirty = 1 WHERE agent_id = ?`,
    );
    this.openTurns = db.prepare<
      [],
      {
        session_id: string;
        last_prompt_at: number | null;
        last_prompt_uuid: string | null;
        last_prompt_title: string | null;
        session_activity: number | null;
        lead_activity: number | null;
      }
    >(`
      SELECT s.session_id, s.last_prompt_at, s.last_prompt_uuid, s.last_prompt_title,
             s.last_activity_at AS session_activity, a.last_activity_at AS lead_activity
      FROM sessions s LEFT JOIN agents a ON a.agent_id = s.session_id
      WHERE s.turn_open = 1`);
    this.endTurn = db.prepare<[number, string]>(
      `UPDATE sessions SET turn_open = 0, last_turn_end_at = MAX(COALESCE(last_turn_end_at, 0), ?)
       WHERE session_id = ?`,
    );
  }

  /** devuelve cuantas filas cambiaron */
  run(now: number, openSessionIds: ReadonlySet<string>): number {
    const alive = (sessionId: string, activity: number | null): boolean =>
      openSessionIds.has(sessionId) || (activity !== null && now - activity <= TIMING.leadActiveWindowMs);

    return this.db.transaction(() => {
      let changes = 0;
      changes += this.linkLaunch.run().changes;
      changes += this.fillFromLaunch.run().changes;

      for (const a of this.candidates.all()) {
        const decided = this.decideEnd(a, now, alive);
        if (!decided) continue;
        if (decided.end === a.ended_at && decided.reason === a.end_reason) continue;
        this.endAgent.run(decided.end, decided.reason, a.agent_id);
        changes++;
      }

      for (const t of this.openTurns.all()) {
        if (t.last_prompt_at === null || alive(t.session_id, t.session_activity)) continue;
        const end = Math.max(t.last_prompt_at, t.lead_activity ?? t.last_prompt_at);
        this.tasks.leadTask(t.session_id, t.last_prompt_uuid, t.last_prompt_title ?? '', t.last_prompt_at, end);
        this.endTurn.run(end, t.session_id);
        changes++;
      }

      changes += this.tasks.refreshSubagentTasks();
      return changes;
    })();
  }

  private decideEnd(
    a: CandidateRow,
    now: number,
    alive: (sessionId: string, activity: number | null) => boolean,
  ): { end: number; reason: string } | null {
    const lastActivity = a.last_activity_at ?? a.started_at;
    // una senal vieja no cierra a un subagente que siguio trabajando despues (SendMessage)
    const floor = lastActivity === null ? 0 : lastActivity - TIMING.endSignalSlackMs;

    let end: number | null = null;
    let reason: string | null = null;
    const notif = this.firstNotification.get(a.agent_id, floor);
    if (notif?.ts !== null && notif?.ts !== undefined) {
      end = notif.ts;
      reason = 'notification';
    }
    if (a.tool_use_id && a.is_async === 0) {
      const launch = this.getLaunch.get(a.tool_use_id);
      if (launch && launch.is_async === 0 && launch.result_at !== null && launch.result_at >= floor) {
        if (end === null || launch.result_at < end) {
          end = launch.result_at;
          reason = 'tool_result';
        }
      }
    }
    if (end !== null && reason !== null) return { end, reason };
    if (a.ended_at !== null) return null;

    // agente de Workflow: su journal (result, failed o reintento) o el fin de su corrida
    if (a.wf_end !== null) return { end: lastActivity ?? a.mtime_ms ?? now, reason: 'journal' };
    if (a.run_end !== null) {
      return { end: lastActivity !== null ? Math.min(lastActivity, a.run_end) : a.run_end, reason: 'workflow' };
    }

    if (
      a.last_stop !== null &&
      TERMINAL_STOPS.has(a.last_stop) &&
      a.mtime_ms !== null &&
      now - a.mtime_ms > TIMING.subagentQuietMs &&
      !this.hasOpenAction.get(a.agent_id)
    ) {
      return { end: lastActivity ?? a.mtime_ms, reason: 'fallback' };
    }
    if (!alive(a.session_id, a.session_activity)) {
      return { end: lastActivity ?? a.session_activity ?? now, reason: 'closed' };
    }
    return null;
  }
}
