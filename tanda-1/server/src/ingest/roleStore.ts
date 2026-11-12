import type { WorkflowRole } from '@shared/contract';
import type { Db } from '../db/connection';
import { classifyWorkflowRole, isTesterByCommands, isWorkflowRole, lookTypeFor, type RoleResult } from './roles';

interface RoleRow {
  agent_type: string;
  model: string | null;
  prompt_head: string | null;
  label: string | null;
  phase: string | null;
  role: string | null;
}

/** rol y tipo del elenco de todos los subagentes, guardados en agents.role / agents.look_type */
export class RoleStore {
  private readonly get;
  private readonly shellCounts;
  private readonly missing;
  private readonly set;
  private readonly setTasks;

  constructor(private readonly db: Db) {
    // de flujo: etiqueta y fase del script · del tool Agent: la descripcion del meta o, si aun no llego,
    // la del tool_use que lo lanzo
    this.get = db.prepare<[string], RoleRow>(`
      SELECT a.agent_type, a.model, a.prompt_head,
             CASE WHEN w.agent_id IS NULL THEN COALESCE(NULLIF(a.description, ''), l.description) ELSE w.label END AS label,
             w.phase, a.role
      FROM agents a
      LEFT JOIN workflow_agents w ON w.agent_id = a.agent_id
      LEFT JOIN launches l ON l.tool_use_id = a.tool_use_id
      WHERE a.agent_id = ? AND a.kind = 'subagent'`);
    // cmd_class llega con la migracion v13: sin ella nadie sube a tester, pero nada falla
    const cols = db.prepare(`PRAGMA table_info(actions)`).all() as Array<{ name: string }>;
    const tests = cols.some((c) => c.name === 'cmd_class') ? `COALESCE(SUM(cmd_class = 'test'), 0)` : '0';
    this.shellCounts = db.prepare<[string], { shells: number; tests: number }>(`
      SELECT COUNT(*) AS shells, ${tests} AS tests
      FROM actions WHERE agent_id = ? AND tool IN ('Bash', 'PowerShell')`);
    this.missing = db.prepare<[], { agent_id: string }>(
      `SELECT agent_id FROM agents WHERE kind = 'subagent' AND (role IS NULL OR role = 'generalist')`,
    );
    this.set = db.prepare<[string, string, string]>(`UPDATE agents SET role = ?, look_type = ? WHERE agent_id = ?`);
    this.setTasks = db.prepare<[string, string]>(`UPDATE tasks SET agent_type = ? WHERE agent_id = ?`);
  }

  /** recalcula el rol con lo que ya se sabe del subagente; null si no existe o no es un subagente */
  refresh(agentId: string): RoleResult | null {
    const r = this.get.get(agentId);
    if (!r) return null;
    let res = classifyWorkflowRole({
      label: r.label,
      phase: r.phase,
      promptHead: r.prompt_head,
      model: r.model,
      sourceType: r.agent_type,
    });
    // la subida a tester no se deshace
    if (res.role === 'generalist' && (r.role === 'tester' || this.runsTests(agentId))) res = testerOf(r.model);
    this.save(agentId, res);
    return res;
  }

  /**
   * generalist que ya corrio sobre todo tests: pasa a tester y se guarda; null si todavia no. El que
   * llama sabe que es generalist, el unico rol que cambia despues de decidirse.
   */
  promoteTester(agentId: string, model: string | null): RoleResult | null {
    if (!this.runsTests(agentId)) return null;
    const res = testerOf(model);
    this.save(agentId, res);
    return res;
  }

  /**
   * clasifica los subagentes sin rol (la migracion v13 los reinicia) y revisa si los generalist ya
   * subieron a tester. Conviene correrlo despues del backfill: la relectura llena actions.cmd_class y no
   * reclasifica a los subagentes cuyo encargo ya se conocia. Devuelve cuantos reviso.
   */
  refreshMissing(): number {
    return this.db.transaction(() => {
      const rows = this.missing.all();
      for (const r of rows) this.refresh(r.agent_id);
      return rows.length;
    })();
  }

  private runsTests(agentId: string): boolean {
    const c = this.shellCounts.get(agentId);
    return c !== undefined && isTesterByCommands(c.shells, c.tests);
  }

  private save(agentId: string, res: RoleResult): void {
    this.set.run(res.role, res.lookType, agentId);
    this.setTasks.run(res.lookType, agentId);
  }
}

function testerOf(model: string | null): RoleResult {
  return { role: 'tester', lookType: lookTypeFor('tester', model) };
}

export function roleOrNull(v: string | null | undefined): WorkflowRole | null {
  return isWorkflowRole(v) ? v : null;
}
