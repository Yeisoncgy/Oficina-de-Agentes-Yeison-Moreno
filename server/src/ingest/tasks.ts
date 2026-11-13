import { agentBaseName } from '@shared/agents';
import type { Db } from '../db/connection';
import { TOKEN_SUM_SQL, type TokenSumRow } from '../db/tokens';
import { WorkDescriber } from './work';

/** escribe filas de la tabla tasks (historial de tareas terminadas) */
export class TaskWriter {
  private readonly sumWindow;
  private readonly sumAgent;
  private readonly upsert;
  private readonly dirtyEnded;
  private readonly clearDirty;
  private readonly work: WorkDescriber;

  constructor(db: Db) {
    this.sumWindow = db.prepare<[string, number, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ? AND ts >= ? AND ts <= ?`,
    );
    this.sumAgent = db.prepare<[string], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ?`);
    this.upsert = db.prepare(`
      INSERT INTO tasks (id, session_id, agent_id, kind, agent_type, title, started_at, ended_at,
                         input, output, cache_read, cache_write, cost_usd, unpriced_tokens)
      VALUES (@id, @session, @agent, @kind, @type, @title, @start, @end,
              @input, @output, @cache_read, @cache_write, @cost, @unpriced)
      ON CONFLICT(id) DO UPDATE SET
        agent_type = excluded.agent_type, title = excluded.title,
        started_at = excluded.started_at, ended_at = excluded.ended_at,
        input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
        cache_write = excluded.cache_write, cost_usd = excluded.cost_usd,
        unpriced_tokens = excluded.unpriced_tokens`);
    this.dirtyEnded = db.prepare<
      [],
      {
        agent_id: string;
        session_id: string;
        agent_type: string;
        description: string;
        started_at: number | null;
        ended_at: number;
      }
    >(`SELECT agent_id, session_id, COALESCE(look_type, agent_type) AS agent_type, description, started_at, ended_at
       FROM agents WHERE kind = 'subagent' AND task_dirty = 1 AND ended_at IS NOT NULL`);
    this.work = new WorkDescriber(db);
    this.clearDirty = db.prepare<[string]>(`UPDATE agents SET task_dirty = 0 WHERE agent_id = ?`);
  }

  /** turno del lead: prompt -> fin; tokens = usage del lead en esa ventana */
  leadTask(sessionId: string, promptUuid: string | null, title: string, startedAt: number, endedAt: number): void {
    const end = Math.max(startedAt, endedAt);
    const sum = this.sumWindow.get(sessionId, startedAt, end);
    this.upsert.run({
      id: `${sessionId}:${promptUuid ?? String(startedAt)}`,
      session: sessionId,
      agent: sessionId,
      kind: 'lead',
      type: 'lead',
      title,
      start: startedAt,
      end,
      ...tokenParams(sum),
    });
  }

  /** crea o actualiza la tarea de cada subagente terminado cuyo uso o estado cambio */
  refreshSubagentTasks(): number {
    const rows = this.dirtyEnded.all();
    for (const a of rows) {
      const sum = this.sumAgent.get(a.agent_id);
      const start = Math.min(a.started_at ?? a.ended_at, a.ended_at);
      this.upsert.run({
        id: a.agent_id,
        session: a.session_id,
        agent: a.agent_id,
        kind: 'subagent',
        type: a.agent_type,
        title: this.work.describe(a.agent_id)?.title ?? (a.description || agentBaseName(a.agent_type)),
        start,
        end: a.ended_at,
        ...tokenParams(sum),
      });
      this.clearDirty.run(a.agent_id);
    }
    return rows.length;
  }
}

function tokenParams(sum: TokenSumRow | undefined): Record<string, number> {
  return {
    input: sum?.input ?? 0,
    output: sum?.output ?? 0,
    cache_read: sum?.cache_read ?? 0,
    cache_write: sum?.cache_write ?? 0,
    cost: sum?.cost ?? 0,
    unpriced: sum?.unpriced ?? 0,
  };
}
