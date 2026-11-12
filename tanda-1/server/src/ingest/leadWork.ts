// Etiqueta profesional de un turno del lead segun lo que hizo (sus acciones), nunca el texto del prompt:
// "Construyendo backend · office.ts", "Orquestando un flujo", "Coordinando 3 agentes", "Respondiendo una consulta".
import type { Db } from '../db/connection';
import { describeWork, EDIT_TOOLS, READ_TOOLS, type TargetCount } from '../state/taskTitle';

const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

interface ToolCount {
  tool: string;
  n: number;
}

export function leadWorkTitle(tools: readonly ToolCount[], targets: readonly TargetCount[], cwd: string | null): string {
  const count = (set: ReadonlySet<string> | string) =>
    tools.filter((t) => (typeof set === 'string' ? t.tool === set : set.has(t.tool))).reduce((s, t) => s + t.n, 0);
  const edits = targets.filter((t) => EDIT_TOOLS.has(t.tool));
  const reads = targets.filter((t) => READ_TOOLS.has(t.tool));
  const flows = count('Workflow');
  const agents = count(DELEGATE_TOOLS);
  if (edits.length > 0) return describeWork({ role: 'builder', label: null, phase: null, cwd, targets });
  if (flows > 0) return flows === 1 ? 'Orquestando un flujo de agentes' : `Orquestando ${flows} flujos de agentes`;
  if (agents > 0) return agents === 1 ? 'Coordinando un agente' : `Coordinando ${agents} agentes`;
  if (reads.length > 0) return describeWork({ role: 'reviewer', label: null, phase: null, cwd, targets: reads });
  if (count(SHELL_TOOLS) > 0) return 'Ejecutando comandos';
  if (tools.length > 0) return 'Trabajando con herramientas';
  return 'Respondiendo una consulta';
}

/** titulo de lo que hizo el lead de una sesion entre dos instantes */
export class LeadWork {
  private readonly tools;
  private readonly targets;
  private readonly cwd;

  constructor(db: Db) {
    this.tools = db.prepare<[string, number, number], ToolCount>(`
      SELECT tool, COUNT(*) AS n FROM actions
      WHERE agent_id = ? AND started_at >= ? AND started_at <= ? GROUP BY tool`);
    this.targets = db.prepare<[string, number, number], TargetCount>(`
      SELECT tool, target, COUNT(*) AS n, MAX(started_at) AS last FROM actions
      WHERE agent_id = ? AND started_at >= ? AND started_at <= ? AND target IS NOT NULL
      GROUP BY tool, target`);
    this.cwd = db.prepare<[string], { cwd: string | null }>(`SELECT cwd FROM sessions WHERE session_id = ?`);
  }

  describe(sessionId: string, from: number, to: number): string {
    const tools = this.tools.all(sessionId, from, to);
    const targets = this.targets.all(sessionId, from, to);
    return leadWorkTitle(tools, targets, this.cwd.get(sessionId)?.cwd ?? null);
  }
}
