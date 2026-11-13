import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection';
import { isInside, pathKey, SAFE_ID, type FileTarget } from './paths';
import { readNewLines } from './reader';
import { parseWorkflowMeta, type WorkflowScriptMeta } from './workflowMeta';

type Rec = Record<string, unknown>;
type JournalTarget = Extract<FileTarget, { kind: 'journal' }>;
type StateTarget = Extract<FileTarget, { kind: 'wfstate' }>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function safeId(v: unknown): string | null {
  const s = str(v);
  return s && SAFE_ID.test(s) ? s : null;
}

function tsOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v !== 'string' || v.length === 0) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/** agentType de los agentes del tool Workflow cuando el script no pidio otro */
export const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

/** estados finales de una corrida (<runId>.json y task-notification) */
const WORKFLOW_END_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);
const SCRIPT_MAX_BYTES = 1024 * 1024;
const SCRIPT_EXT = /\.(m?js|ts)$/;

/** lo que el lead sabe de una corrida al recibir el tool_result del tool Workflow */
export interface WorkflowLaunch {
  runId: string;
  taskId: string | null;
  name: string | null;
  scriptPath: string | null;
}

/** runId/taskId del tool_result del tool Workflow: toolUseResult o el texto "Task ID: ... Run ID: ..." */
export function parseWorkflowLaunch(toolUseResult: unknown, text: string): WorkflowLaunch | null {
  const tur = isRecord(toolUseResult) ? toolUseResult : null;
  const runId = safeId(tur?.runId) ?? /Run ID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
  if (!runId) return null;
  return {
    runId,
    taskId: safeId(tur?.taskId) ?? /Task ID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null,
    name: str(tur?.workflowName),
    scriptPath: str(tur?.scriptPath),
  };
}

/**
 * Escribe workflow_runs y workflow_agents desde el journal de cada corrida, su estado final, los
 * meta.json de sus agentes y el tool_result del lead. Solo lee: nunca ejecuta el script.
 */
export class WorkflowIngestor {
  private readonly st;

  constructor(private readonly db: Db) {
    this.st = {
      getOffset: db.prepare<[string], { byte_offset: number; size: number; mtime_ms: number }>(
        `SELECT byte_offset, size, mtime_ms FROM file_offsets WHERE path_key = ?`,
      ),
      setOffset: db.prepare(`
        INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES (@key, @path, @offset, @size, @mtime)
        ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, byte_offset = excluded.byte_offset,
          size = excluded.size, mtime_ms = excluded.mtime_ms`),
      ensureSession: db.prepare<[string, string]>(`INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`),
      ensureRun: db.prepare<[string, string]>(`INSERT OR IGNORE INTO workflow_runs (run_id, session_id) VALUES (?, ?)`),
      setJournal: db.prepare<[string, string]>(`UPDATE workflow_runs SET journal_key = ? WHERE run_id = ?`),
      getRun: db.prepare<
        [string],
        { script_path: string | null; meta_name: string | null; meta_phases: string | null }
      >(`SELECT script_path, meta_name, meta_phases FROM workflow_runs WHERE run_id = ?`),
      setMeta: db.prepare(`
        UPDATE workflow_runs SET meta_name = @name, meta_description = @description, meta_phases = @phases
        WHERE run_id = @run`),
      launch: db.prepare(`
        INSERT INTO workflow_runs (run_id, session_id, task_id, tool_use_id, tool_name, script_path, launched_at)
        VALUES (@run, @session, @task, @toolUse, @name, @script, @ts)
        ON CONFLICT(run_id) DO UPDATE SET
          task_id = COALESCE(workflow_runs.task_id, excluded.task_id),
          tool_use_id = COALESCE(workflow_runs.tool_use_id, excluded.tool_use_id),
          tool_name = COALESCE(workflow_runs.tool_name, excluded.tool_name),
          script_path = COALESCE(workflow_runs.script_path, excluded.script_path),
          launched_at = MIN(COALESCE(workflow_runs.launched_at, excluded.launched_at), excluded.launched_at)`),
      finalState: db.prepare(`
        UPDATE workflow_runs SET
          task_id = COALESCE(task_id, @task), tool_name = COALESCE(tool_name, @name),
          launched_at = COALESCE(launched_at, @started), final_status = @status, final_at = @endedAt
        WHERE run_id = @run`),
      maxSeq: db.prepare<[string], { seq: number | null }>(`SELECT MAX(seq) AS seq FROM workflow_agents WHERE run_id = ?`),
      ensureAgent: db.prepare<[string, string, string]>(
        `INSERT OR IGNORE INTO workflow_agents (agent_id, run_id, session_id) VALUES (?, ?, ?)`,
      ),
      agentMeta: db.prepare(`
        INSERT INTO workflow_agents (agent_id, run_id, session_id, label, phase) VALUES (@agent, @run, @session, @label, @phase)
        ON CONFLICT(agent_id) DO UPDATE SET
          label = COALESCE(workflow_agents.label, excluded.label),
          phase = COALESCE(workflow_agents.phase, excluded.phase)`),
      started: db.prepare(`
        INSERT INTO workflow_agents (agent_id, run_id, session_id, key, label, phase, seq)
        VALUES (@agent, @run, @session, @key, @label, @phase, @seq)
        ON CONFLICT(agent_id) DO UPDATE SET
          key = COALESCE(workflow_agents.key, excluded.key),
          label = COALESCE(excluded.label, workflow_agents.label),
          phase = COALESCE(excluded.phase, workflow_agents.phase),
          seq = COALESCE(workflow_agents.seq, excluded.seq)`),
      // un reintento con la misma key deja atras al intento anterior que no reporto fin
      supersede: db.prepare(`
        UPDATE workflow_agents SET end_status = 'superseded'
        WHERE run_id = @run AND key = @key AND agent_id <> @agent AND end_status IS NULL
          AND seq < (SELECT w.seq FROM workflow_agents w WHERE w.agent_id = @agent)`),
      lastByKey: db.prepare<[string, string], { agent_id: string }>(
        `SELECT agent_id FROM workflow_agents WHERE run_id = ? AND key = ? ORDER BY seq DESC LIMIT 1`,
      ),
      ended: db.prepare(`
        INSERT INTO workflow_agents (agent_id, run_id, session_id, end_status) VALUES (@agent, @run, @session, @status)
        ON CONFLICT(agent_id) DO UPDATE SET
          end_status = CASE WHEN workflow_agents.end_status = 'result' THEN 'result' ELSE excluded.end_status END`),
    };
  }

  /** fila de la corrida y del agente en cuanto aparece su meta o su transcript */
  ensureAgent(agentId: string, runId: string, sessionId: string): void {
    this.st.ensureRun.run(runId, sessionId);
    this.st.ensureAgent.run(agentId, runId, sessionId);
  }

  agentMeta(agentId: string, runId: string, sessionId: string, label: string | null, phase: string | null): void {
    this.st.ensureRun.run(runId, sessionId);
    this.st.agentMeta.run({ agent: agentId, run: runId, session: sessionId, label, phase });
  }

  /** tool_result del tool Workflow en un transcript: enlaza runId con su task id */
  recordLaunch(sessionId: string, toolUseId: string, launch: WorkflowLaunch, ts: number): void {
    this.st.launch.run({
      run: launch.runId,
      session: sessionId,
      task: launch.taskId,
      toolUse: toolUseId,
      name: launch.name,
      script: launch.scriptPath,
      ts,
    });
  }

  /** lee lo nuevo del journal.jsonl de una corrida */
  async ingestJournal(target: JournalTarget): Promise<number> {
    const key = pathKey(target.path);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target.path);
    } catch {
      return 0;
    }
    const size = stat.size;
    const mtime = Math.floor(stat.mtimeMs);
    const prev = this.st.getOffset.get(key);
    if (prev && prev.size === size && prev.mtime_ms === mtime) return 0;

    this.db.transaction(() => {
      this.st.ensureSession.run(target.sessionId, target.projectDir);
      this.st.ensureRun.run(target.runId, target.sessionId);
      this.st.setJournal.run(key, target.runId);
    })();
    let seq = this.st.maxSeq.get(target.runId)?.seq ?? 0;
    let count = 0;
    const result = await readNewLines(target.path, prev?.byte_offset ?? 0, (lines, endOffset) => {
      this.db.transaction(() => {
        for (const line of lines) seq = this.journalLine(target, line, seq);
        this.st.setOffset.run({ key, path: target.path, offset: endOffset, size, mtime });
      })();
      count += lines.length;
    });
    if (result) {
      this.st.setOffset.run({ key, path: target.path, offset: result.endOffset, size: result.size, mtime: result.mtimeMs });
    }
    const scripts = path.join(path.dirname(target.path), '..', '..', '..', 'workflows', 'scripts');
    const found = this.resolveScript(target.runId, scripts);
    // el mtime del journal cuenta para el estado de la corrida aunque no haya lineas completas nuevas
    return count + (found ? 1 : 0) + (result ? 1 : 0);
  }

  private journalLine(target: JournalTarget, raw: string, seq: number): number {
    if (raw.length === 0) return seq;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      return seq;
    }
    if (!isRecord(o)) return seq;
    const key = str(o.key);
    const base = { run: target.runId, session: target.sessionId };
    if (o.type === 'started') {
      const agent = safeId(o.agentId);
      if (!agent) return seq;
      const next = seq + 1;
      this.st.started.run({ ...base, agent, key, label: str(o.label), phase: str(o.phase), seq: next });
      if (key) this.st.supersede.run({ run: target.runId, key, agent });
      return next;
    }
    if (o.type === 'result' || o.type === 'failed') {
      const agent = safeId(o.agentId) ?? (key ? (this.st.lastByKey.get(target.runId, key)?.agent_id ?? null) : null);
      if (agent) this.st.ended.run({ ...base, agent, status: o.type });
    }
    return seq;
  }

  /** <sesion>/workflows/<runId>.json: estado final de la corrida (lo escribe Claude Code al terminar) */
  ingestState(target: StateTarget): number {
    const key = pathKey(target.path);
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(target.path);
      const prev = this.st.getOffset.get(key);
      if (prev && prev.size === stat.size && prev.mtime_ms === Math.floor(stat.mtimeMs)) return 0;
      raw = fs.readFileSync(target.path, 'utf8');
    } catch {
      return 0;
    }
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      // puede estar escribiendose: se reintenta en el proximo evento, sin guardar offset
      return 0;
    }
    if (!isRecord(o)) return 0;
    const status = str(o.status);
    const started = tsOf(o.startTime);
    const duration = typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) ? o.durationMs : null;
    const endedAt = tsOf(o.timestamp) ?? (started !== null && duration !== null ? started + duration : null);
    const isFinal = status !== null && WORKFLOW_END_STATUSES.has(status);
    let meta: WorkflowScriptMeta | null = typeof o.script === 'string' ? parseWorkflowMeta(o.script) : null;
    if (Array.isArray(o.phases) && !meta?.phases) {
      const titles = o.phases.flatMap((p) => (isRecord(p) && typeof p.title === 'string' && p.title.trim() ? [p.title.trim()] : []));
      meta = { name: meta?.name ?? null, description: meta?.description ?? null, phases: titles };
    }
    this.db.transaction(() => {
      this.st.ensureSession.run(target.sessionId, target.projectDir);
      this.st.ensureRun.run(target.runId, target.sessionId);
      this.st.finalState.run({
        run: target.runId,
        task: safeId(o.taskId),
        name: str(o.workflowName),
        started,
        status: isFinal ? status : null,
        endedAt: isFinal ? endedAt : null,
      });
      const run = this.st.getRun.get(target.runId);
      if (meta && run && run.meta_name === null && run.meta_phases === null) this.saveMeta(target.runId, meta);
      this.st.setOffset.run({ key, path: target.path, offset: stat.size, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
    })();
    return 1;
  }

  /**
   * busca el script de la corrida en <sesion>/workflows/scripts: el scriptPath que reporto el tool
   * (solo si queda dentro de esa carpeta) o el archivo <nombre>-<runId>.js; true si guardo su meta
   */
  private resolveScript(runId: string, scriptsDir: string): boolean {
    const run = this.st.getRun.get(runId);
    if (!run || run.meta_name !== null || run.meta_phases !== null) return false;
    let file: string | null = null;
    if (run.script_path && isInside(scriptsDir, run.script_path) && fs.existsSync(run.script_path)) file = run.script_path;
    if (!file) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(scriptsDir);
      } catch {
        return false;
      }
      const hit = names.find((n) => SCRIPT_EXT.test(n) && n.replace(SCRIPT_EXT, '').endsWith(`-${runId}`));
      if (hit) file = path.join(scriptsDir, hit);
    }
    if (!file) return false;
    let src: string;
    try {
      if (fs.statSync(file).size > SCRIPT_MAX_BYTES) return false;
      src = fs.readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    const meta = parseWorkflowMeta(src);
    if (!meta) return false;
    this.saveMeta(runId, meta);
    return true;
  }

  private saveMeta(runId: string, meta: WorkflowScriptMeta): void {
    this.st.setMeta.run({
      run: runId,
      name: meta.name,
      description: meta.description,
      phases: meta.phases ? JSON.stringify(meta.phases) : null,
    });
  }
}
