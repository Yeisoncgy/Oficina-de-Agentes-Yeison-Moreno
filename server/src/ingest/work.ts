import type { Db } from '../db/connection';
import { describeWork, scriptDetail, type TargetCount } from '../state/taskTitle';
import { roleOrNull } from './roleStore';

interface WorkInfoRow {
  role: string | null;
  label: string | null;
  phase: string | null;
  cwd: string | null;
}

/** titulo real (segun sus acciones) y detalle del script de un agente de flujo */
export class WorkDescriber {
  private readonly info;
  private readonly targets;

  constructor(db: Db) {
    this.info = db.prepare<[string], WorkInfoRow>(`
      SELECT a.role, w.label, w.phase, s.cwd
      FROM agents a JOIN workflow_agents w ON w.agent_id = a.agent_id
      LEFT JOIN sessions s ON s.session_id = a.session_id
      WHERE a.agent_id = ?`);
    this.targets = db.prepare<[string], TargetCount>(`
      SELECT tool, target, COUNT(*) AS n, MAX(started_at) AS last
      FROM actions WHERE agent_id = ? AND target IS NOT NULL
      GROUP BY tool, target`);
  }

  /** null si no es un agente de flujo */
  describe(agentId: string): { title: string; detail: string } | null {
    const r = this.info.get(agentId);
    if (!r) return null;
    const title = describeWork({
      role: roleOrNull(r.role) ?? 'generalist',
      label: r.label,
      phase: r.phase,
      cwd: r.cwd,
      targets: this.targets.all(agentId),
    });
    return { title, detail: scriptDetail(r.label, r.phase) };
  }
}
