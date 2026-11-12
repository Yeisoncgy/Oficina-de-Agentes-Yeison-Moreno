import fs from 'node:fs';
import type { Db } from '../db/connection';
import { actionLabel, baseName } from './labels';
import { pathKey, type FileTarget } from './paths';
import { costUsd, type UsageTokens } from './pricing';
import { extractPrompt } from './prompt';
import { readNewLines } from './reader';
import { RoleStore } from './roleStore';
import { promptHead, taskText } from './roles';
import {
  apiErrorCategory,
  cmdClass,
  commandName,
  compactData,
  inputHash,
  instructionsData,
  interruptOf,
  mcpServersFrom,
  readPartial,
  textHash,
  type SessionEventData,
  type SessionEventKind,
} from './signals';
import { TaskWriter } from './tasks';
import { parseWorkflowLaunch, WORKFLOW_AGENT_TYPE, WorkflowIngestor } from './workflows';

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v !== 'string' || v.length === 0) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** usage de la API -> tokens; sin desglose cache_creation todo va a cache 5m */
export function parseUsage(u: Rec): UsageTokens {
  const totalWrite = tokenCount(u.cache_creation_input_tokens);
  let cacheWrite5m = totalWrite;
  let cacheWrite1h = 0;
  if (isRecord(u.cache_creation)) {
    const e5 = tokenCount(u.cache_creation.ephemeral_5m_input_tokens);
    const e1 = tokenCount(u.cache_creation.ephemeral_1h_input_tokens);
    cacheWrite1h = e1;
    cacheWrite5m = e5 + Math.max(0, totalWrite - (e5 + e1));
  }
  return {
    input: tokenCount(u.input_tokens),
    output: tokenCount(u.output_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
  };
}

const END_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/** texto libre del agente dentro del bloque (sin cerrar, hasta el final): lo que cite ahi no es cabecera */
const FREE_TEXT = /<(summary|result)>[\s\S]*?(?:<\/\1>|$)/g;

/**
 * pares (task-id, status) de los bloques <task-notification> con estado final. Un bloque puede traer
 * varios task-id con un solo status (p.ej. los agentes que quedaron detenidos al cerrarse la sesion):
 * todos reciben ese status, o el ultimo quedaria "trabajando" para siempre.
 */
export function parseNotifications(text: string): Array<{ taskId: string; status: string }> {
  const out: Array<{ taskId: string; status: string }> = [];
  for (const m of text.matchAll(NOTIFICATION)) {
    const body = (m[1] ?? '').replace(FREE_TEXT, '');
    const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(body)?.[1];
    if (!status || !END_STATUSES.has(status)) continue;
    for (const id of body.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)) {
      if (id[1]) out.push({ taskId: id[1], status });
    }
  }
  return out;
}

/** ruta o patron que toca una herramienta (para el titulo real de la tarea) */
export function actionTarget(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ['file_path', 'notebook_path', 'path', 'pattern']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim().slice(0, 500);
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** tipos de linea que cuentan como actividad de la sesion */
const SESSION_ACTIVITY = new Set(['user', 'assistant', 'system', 'attachment', 'queue-operation']);

/** margen para reabrir un subagente que vuelve a escribir tras su fin (SendMessage) */
const REOPEN_SLACK_MS = 1_000;

interface FileCtx {
  sessionId: string;
  agentId: string;
  isLead: boolean;
  /** ultima actividad user/assistant del agente (DB + lo leido) */
  lastConv: number | null;
  endedAt: number | null;
  /** timestamp de la ultima linea leida (cualquier tipo) */
  lastTs: number | null;
  lastMsgId: string | null;
  lastStop: string | null;
  // acumuladores del bloque actual (se vuelcan en flush)
  convMin: number | null;
  convMax: number | null;
  sessionMax: number | null;
  cwd: string | null;
  model: string | null;
  customTitle: string | null;
  /** lead: ultimo gitBranch visto en el bloque */
  gitBranch: string | null;
  usageTouched: boolean;
  /** ya se guardo el inicio del encargo de este subagente */
  promptKnown: boolean;
  /**
   * /comando de la linea anterior. Si la linea siguiente es la inyeccion meta de su contenido, fue una
   * skill (los comandos internos como /compact no la tienen). El attachment invoked_skills NO sirve: es
   * la reinyeccion de skills ya usadas tras una compactacion.
   */
  pendingCommand: { uuid: string; name: string; ts: number } | null;
}

interface UsageRow {
  agent_id: string;
  session_id: string;
  ts: number;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  speed: string | null;
  cost_usd: number | null;
}

interface TurnRow {
  turn_open: number;
  last_prompt_at: number | null;
  last_prompt_uuid: string | null;
  last_prompt_title: string | null;
}

function prepareStatements(db: Db) {
  return {
    getOffset: db.prepare<[string], { byte_offset: number; size: number; mtime_ms: number }>(
      `SELECT byte_offset, size, mtime_ms FROM file_offsets WHERE path_key = ?`,
    ),
    setOffset: db.prepare(`
      INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES (@key, @path, @offset, @size, @mtime)
      ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, byte_offset = excluded.byte_offset,
        size = excluded.size, mtime_ms = excluded.mtime_ms`),
    ensureSession: db.prepare<[string, string]>(
      `INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`,
    ),
    setSessionTranscript: db.prepare<[string, string, string]>(
      `UPDATE sessions SET transcript_path = ?, transcript_key = ? WHERE session_id = ?`,
    ),
    ensureAgent: db.prepare<[string, string, string, string]>(
      `INSERT OR IGNORE INTO agents (agent_id, session_id, kind, agent_type) VALUES (?, ?, ?, ?)`,
    ),
    setAgentTranscript: db.prepare<[string, string, string]>(
      `UPDATE agents SET transcript_path = ?, transcript_key = ? WHERE agent_id = ?`,
    ),
    loadAgent: db.prepare<
      [string],
      {
        last_activity_at: number | null;
        ended_at: number | null;
        last_msg_id: string | null;
        last_stop: string | null;
        prompt_head: string | null;
      }
    >(`SELECT last_activity_at, ended_at, last_msg_id, last_stop, prompt_head FROM agents WHERE agent_id = ?`),
    setPromptHead: db.prepare<[string, string]>(
      `UPDATE agents SET prompt_head = ? WHERE agent_id = ? AND prompt_head IS NULL`,
    ),
    setMetaModel: db.prepare<[string, string]>(`UPDATE agents SET model = COALESCE(model, ?) WHERE agent_id = ?`),
    touchAgent: db.prepare(`
      UPDATE agents SET
        started_at = CASE WHEN @min IS NULL THEN started_at
                          WHEN started_at IS NULL OR started_at > @min THEN @min ELSE started_at END,
        last_activity_at = CASE WHEN @max IS NULL THEN last_activity_at
                                WHEN last_activity_at IS NULL OR last_activity_at < @max THEN @max
                                ELSE last_activity_at END,
        model = COALESCE(@model, model),
        last_msg_id = @lastMsgId,
        last_stop = @lastStop,
        task_dirty = CASE WHEN @dirty = 1 THEN 1 ELSE task_dirty END
      WHERE agent_id = @id`),
    touchSession: db.prepare(`
      UPDATE sessions SET
        last_activity_at = CASE WHEN @max IS NULL THEN last_activity_at
                                WHEN last_activity_at IS NULL OR last_activity_at < @max THEN @max
                                ELSE last_activity_at END,
        cwd = COALESCE(cwd, @cwd),
        project_name = COALESCE(project_name, @project),
        custom_title = COALESCE(@customTitle, custom_title),
        git_branch = COALESCE(@gitBranch, git_branch)
      WHERE session_id = @id`),
    // un fin deducido (fallback/closed) se recalcula con las lineas nuevas; uno por senal del padre
    // solo se deshace si el subagente siguio escribiendo despues
    reopenAgent: db.prepare<[string, number]>(
      `UPDATE agents SET ended_at = NULL, end_reason = NULL
       WHERE agent_id = ? AND kind = 'subagent' AND ended_at IS NOT NULL
         AND (end_reason IN ('fallback', 'closed') OR ended_at + ${REOPEN_SLACK_MS} < ?)`,
    ),
    getUsage: db.prepare<[string], UsageRow>(
      `SELECT agent_id, session_id, ts, model, input, output, cache_read, cache_write_5m, cache_write_1h, speed, cost_usd
       FROM usage WHERE message_id = ?`,
    ),
    upsertUsage: db.prepare(`
      INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read,
                         cache_write_5m, cache_write_1h, speed, cost_usd)
      VALUES (@id, @agent, @session, @ts, @model, @input, @output, @cacheRead, @cacheWrite5m, @cacheWrite1h, @speed, @cost)
      ON CONFLICT(message_id) DO UPDATE SET
        ts = excluded.ts, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
        cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
        speed = excluded.speed, cost_usd = excluded.cost_usd`),
    markDirty: db.prepare<[string]>(`UPDATE agents SET task_dirty = 1 WHERE agent_id = ?`),
    // la relectura (p.ej. la de la v13) pasa por el conflicto: ahi tambien se llenan las senales nuevas
    insertAction: db.prepare(`
      INSERT INTO actions (tool_use_id, agent_id, session_id, tool, label, started_at, target, input_hash, cmd_class, read_partial)
      VALUES (@id, @agent, @session, @tool, @label, @startedAt, @target, @inputHash, @cmdClass, @readPartial)
      ON CONFLICT(tool_use_id) DO UPDATE SET target = COALESCE(actions.target, excluded.target),
        input_hash = COALESCE(excluded.input_hash, actions.input_hash),
        cmd_class = COALESCE(excluded.cmd_class, actions.cmd_class),
        read_partial = COALESCE(excluded.read_partial, actions.read_partial)`),
    closeAction: db.prepare<[number, number, string]>(
      `UPDATE actions SET ended_at = ?, is_error = ? WHERE tool_use_id = ? AND ended_at IS NULL`,
    ),
    // sin la guarda de closeAction: una relectura llena el resultado de acciones ya cerradas
    setActionResult: db.prepare(`
      UPDATE actions SET result_chars = @chars, result_lines = CASE WHEN tool = 'Read' THEN @lines ELSE NULL END,
        result_hash = @hash, denied = @denied
      WHERE tool_use_id = @id`),
    insertEvent: db.prepare(`
      INSERT INTO session_events (id, session_id, agent_id, ts, kind, data) VALUES (@id, @session, @agent, @ts, @kind, @data)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, data = excluded.data`),
    actionTool: db.prepare<[string], { tool: string }>(`SELECT tool FROM actions WHERE tool_use_id = ?`),
    insertLaunch: db.prepare<[string, string, string, string, string, number]>(
      `INSERT OR IGNORE INTO launches (tool_use_id, session_id, parent_agent_id, subagent_type, description, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    launchResult: db.prepare<[number, number, string | null, number, string]>(
      `UPDATE launches SET result_at = COALESCE(result_at, ?), is_async = MAX(is_async, ?),
         result_agent_id = COALESCE(result_agent_id, ?), is_error = ?
       WHERE tool_use_id = ?`,
    ),
    insertNotification: db.prepare<[string, number, string, string]>(
      `INSERT OR IGNORE INTO notifications (task_id, ts, session_id, status) VALUES (?, ?, ?, ?)`,
    ),
    getTurn: db.prepare<[string], TurnRow>(
      `SELECT turn_open, last_prompt_at, last_prompt_uuid, last_prompt_title FROM sessions WHERE session_id = ?`,
    ),
    setPrompt: db.prepare<[number, string | null, string, string]>(
      `UPDATE sessions SET last_prompt_at = ?, last_prompt_uuid = ?, last_prompt_title = ?, turn_open = 1
       WHERE session_id = ?`,
    ),
    endTurn: db.prepare<[number, string]>(
      `UPDATE sessions SET turn_open = 0, last_turn_end_at = MAX(COALESCE(last_turn_end_at, 0), ?)
       WHERE session_id = ?`,
    ),
    setCostState: db.prepare<[number, string, string]>(
      `UPDATE sessions SET cost_state_usd = ?, cost_state_json = ? WHERE session_id = ?`,
    ),
    upsertMeta: db.prepare(`
      UPDATE agents SET agent_type = @type, description = @description,
        tool_use_id = COALESCE(@toolUseId, tool_use_id), is_async = MAX(is_async, @isAsync),
        meta_seen = 1, task_dirty = 1
      WHERE agent_id = @id`),
  };
}

/**
 * Interpreta los transcripts de Claude Code y los escribe en la DB. Idempotente: toda fila se
 * identifica por PK (message.id, tool_use_id, agentId...). Un archivo se procesa por bloques,
 * cada bloque en una transaccion junto con su offset.
 */
export class Ingestor {
  private readonly st: ReturnType<typeof prepareStatements>;
  private readonly workflows: WorkflowIngestor;
  private readonly roles: RoleStore;
  readonly tasks: TaskWriter;
  /**
   * /comando que quedo como ultima linea de una lectura, con el offset donde termino: su linea meta puede
   * llegar en la siguiente lectura en vivo. Solo se retoma si esa lectura sigue desde el mismo offset.
   */
  private readonly pendingCommands = new Map<string, { cmd: NonNullable<FileCtx['pendingCommand']>; offset: number }>();

  constructor(private readonly db: Db) {
    this.st = prepareStatements(db);
    this.tasks = new TaskWriter(db);
    this.workflows = new WorkflowIngestor(db);
    this.roles = new RoleStore(db);
  }

  /** procesa lo nuevo de un archivo; devuelve cuantas lineas (o metas) se leyeron */
  async ingest(target: FileTarget): Promise<number> {
    if (target.kind === 'meta') return this.ingestMeta(target);
    if (target.kind === 'journal') return this.workflows.ingestJournal(target);
    if (target.kind === 'wfstate') return this.workflows.ingestState(target);
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

    this.ensureRows(target, key);
    const ctx = this.loadCtx(target);
    const from = prev?.byte_offset ?? 0;
    const carried = this.pendingCommands.get(ctx.agentId);
    if (carried && carried.offset === from && size >= from) ctx.pendingCommand = carried.cmd;
    let count = 0;
    const result = await readNewLines(target.path, prev?.byte_offset ?? 0, (lines, endOffset) => {
      this.db.transaction(() => {
        for (const line of lines) this.processLine(ctx, line);
        this.flush(ctx);
        this.st.setOffset.run({ key, path: target.path, offset: endOffset, size, mtime });
      })();
      count += lines.length;
    });
    if (result) {
      this.st.setOffset.run({
        key,
        path: target.path,
        offset: result.endOffset,
        size: result.size,
        mtime: result.mtimeMs,
      });
    }
    if (ctx.pendingCommand && result) this.pendingCommands.set(ctx.agentId, { cmd: ctx.pendingCommand, offset: result.endOffset });
    else this.pendingCommands.delete(ctx.agentId);
    // agente de flujo: el titulo de su tarea depende de lo que toco; se reescribe con lo recien leido
    if (count > 0 && target.kind === 'subagent' && target.runId) this.st.markDirty.run(target.agentId);
    return count;
  }

  private ingestMeta(target: Extract<FileTarget, { kind: 'meta' }>): number {
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
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      // puede estar escribiendose: se reintenta en el proximo evento, sin guardar offset
      return 0;
    }
    if (!isRecord(meta)) return 0;
    const runId = target.runId;
    const agentType = str(meta.agentType) ?? (runId ? WORKFLOW_AGENT_TYPE : 'general-purpose');
    const description = typeof meta.description === 'string' ? meta.description : '';
    // agente de Workflow: la tarea lleva su fase delante ("Construccion · mundo")
    const phase = runId ? str(meta.workflowPhase)?.trim() || null : null;
    let title = description;
    if (phase) title = description.trim() ? `${phase} · ${description}` : phase;
    this.db.transaction(() => {
      this.st.ensureSession.run(target.sessionId, target.projectDir);
      this.st.ensureAgent.run(target.agentId, target.sessionId, 'subagent', agentType);
      this.st.upsertMeta.run({
        id: target.agentId,
        type: agentType,
        description: title,
        toolUseId: str(meta.toolUseId),
        isAsync: meta.requestShape === 'background' ? 1 : 0,
      });
      if (runId) {
        this.workflows.agentMeta(target.agentId, runId, target.sessionId, str(description.trim()), phase);
        // alias del modelo (haiku/sonnet/opus) hasta que el transcript traiga el id completo
        const metaModel = str(meta.model);
        if (metaModel) this.st.setMetaModel.run(metaModel, target.agentId);
      }
      // todos los subagentes tienen rol; si el transcript llego antes que el meta, se clasifico sin su tipo
      this.roles.refresh(target.agentId);
      this.st.setOffset.run({
        key,
        path: target.path,
        offset: stat.size,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
      });
    })();
    return 1;
  }

  private ensureRows(target: Extract<FileTarget, { kind: 'lead' | 'subagent' }>, key: string): void {
    this.st.ensureSession.run(target.sessionId, target.projectDir);
    if (target.kind === 'lead') {
      this.st.setSessionTranscript.run(target.path, key, target.sessionId);
      this.st.ensureAgent.run(target.sessionId, target.sessionId, 'lead', 'lead');
      this.st.setAgentTranscript.run(target.path, key, target.sessionId);
    } else {
      this.st.ensureAgent.run(target.agentId, target.sessionId, 'subagent', target.runId ? WORKFLOW_AGENT_TYPE : 'general-purpose');
      this.st.setAgentTranscript.run(target.path, key, target.agentId);
      if (target.runId) this.workflows.ensureAgent(target.agentId, target.runId, target.sessionId);
    }
  }

  private loadCtx(target: Extract<FileTarget, { kind: 'lead' | 'subagent' }>): FileCtx {
    const agentId = target.kind === 'lead' ? target.sessionId : target.agentId;
    const row = this.st.loadAgent.get(agentId);
    return {
      sessionId: target.sessionId,
      agentId,
      isLead: target.kind === 'lead',
      lastConv: row?.last_activity_at ?? null,
      endedAt: row?.ended_at ?? null,
      lastTs: null,
      lastMsgId: row?.last_msg_id ?? null,
      lastStop: row?.last_stop ?? null,
      convMin: null,
      convMax: null,
      sessionMax: null,
      cwd: null,
      model: null,
      customTitle: null,
      gitBranch: null,
      usageTouched: false,
      promptKnown: target.kind === 'lead' || (row?.prompt_head ?? null) !== null,
      pendingCommand: null,
    };
  }

  private processLine(ctx: FileCtx, raw: string): void {
    if (raw.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const o = parsed;
    const type = typeof o.type === 'string' ? o.type : '';
    const ts = parseTs(o.timestamp);
    const command = ctx.pendingCommand;
    ctx.pendingCommand = null;

    switch (type) {
      case 'assistant':
        if (ts !== null) this.onAssistant(ctx, o, ts);
        break;
      case 'user':
        if (ts !== null) this.onUser(ctx, o, ts, command);
        break;
      case 'system':
        if (ctx.isLead && o.subtype === 'turn_duration' && ts !== null) this.onTurnEnd(ctx, ts);
        else if (ts !== null) this.onSystem(ctx, o, ts);
        break;
      case 'attachment':
        if (ctx.isLead && ts !== null) this.onAttachment(ctx, o, ts);
        break;
      case 'queue-operation':
        if (ts !== null) this.onNotificationText(ctx, contentText(o.content), ts);
        break;
      case 'cost-state':
        // acumulado del proceso desde startTime hasta esta linea: solo sirve para verificar
        if (ctx.isLead && typeof o.totalCostUSD === 'number') {
          const window = { startTime: parseTs(o.startTime), at: ts ?? ctx.lastTs, modelUsage: o.modelUsage ?? null };
          this.st.setCostState.run(o.totalCostUSD, JSON.stringify(window), ctx.sessionId);
        }
        break;
      case 'custom-title':
        if (ctx.isLead && typeof o.customTitle === 'string' && o.customTitle.trim()) {
          ctx.customTitle = o.customTitle.trim();
        }
        break;
      default:
        break;
    }

    if (ts !== null) {
      ctx.lastTs = ts;
      if (type === 'user' || type === 'assistant') {
        if (ctx.convMin === null || ts < ctx.convMin) ctx.convMin = ts;
        if (ctx.convMax === null || ts > ctx.convMax) ctx.convMax = ts;
        if (ctx.lastConv === null || ts > ctx.lastConv) ctx.lastConv = ts;
      }
      if (SESSION_ACTIVITY.has(type) && (ctx.sessionMax === null || ts > ctx.sessionMax)) ctx.sessionMax = ts;
    }
    if (ctx.cwd === null && typeof o.cwd === 'string' && o.cwd.length > 0) ctx.cwd = o.cwd;
    if (ctx.isLead && typeof o.gitBranch === 'string' && o.gitBranch.length > 0) ctx.gitBranch = o.gitBranch;
  }

  /** evento de sesion; la id sale del uuid de la linea (+ el tipo) para que la relectura no duplique */
  private addEvent<K extends SessionEventKind>(ctx: FileCtx, id: string, ts: number, kind: K, data: SessionEventData[K]): void {
    this.st.insertEvent.run({ id, session: ctx.sessionId, agent: ctx.agentId, ts, kind, data: JSON.stringify(data) });
  }

  /** compactaciones (solo del lead: las de subagentes no cuentan para sus turnos) y reintentos de la API */
  private onSystem(ctx: FileCtx, o: Rec, ts: number): void {
    const uuid = str(o.uuid);
    if (!uuid) return;
    if (o.subtype === 'compact_boundary' && ctx.isLead) {
      this.addEvent(ctx, `${uuid}:compact`, ts, 'compact', compactData(o.compactMetadata));
    } else if (o.subtype === 'api_error') {
      this.addEvent(ctx, `${uuid}:api_error`, ts, 'api_error', {
        retryAttempt: typeof o.retryAttempt === 'number' ? o.retryAttempt : null,
        maxRetries: typeof o.maxRetries === 'number' ? o.maxRetries : null,
        category: apiErrorCategory(o.error),
      });
    }
  }

  /** instrucciones (CLAUDE.md...) y servidores MCP que se cargaron en la sesion */
  private onAttachment(ctx: FileCtx, o: Rec, ts: number): void {
    const uuid = str(o.uuid);
    const a = o.attachment;
    if (!uuid || !isRecord(a)) return;
    if (a.type === 'instructions') {
      const data = instructionsData(a.files);
      if (data) this.addEvent(ctx, `${uuid}:instructions`, ts, 'instructions', data);
    } else if (a.type === 'deferred_tools_delta' || a.type === 'mcp_instructions_delta') {
      const servers = mcpServersFrom(a.addedNames);
      if (servers.length > 0) this.addEvent(ctx, `${uuid}:mcp_loaded`, ts, 'mcp_loaded', { servers });
    }
  }

  private onAssistant(ctx: FileCtx, o: Rec, ts: number): void {
    const msg = o.message;
    const uuid = str(o.uuid);
    // error final de la API que ve el usuario (ya sin reintentos); su mensaje es sintetico
    if (o.isApiErrorMessage === true && uuid) {
      this.addEvent(ctx, `${uuid}:api_error`, ts, 'api_error', { retryAttempt: null, maxRetries: null, category: str(o.error) });
    }
    if (!isRecord(msg)) return;
    const model = str(msg.model);
    const msgId = str(msg.id);
    const stop = str(msg.stop_reason);
    // una respuesta llega partida en varias lineas con el mismo message.id
    if (msgId) {
      if (msgId !== ctx.lastMsgId) {
        ctx.lastMsgId = msgId;
        ctx.lastStop = stop;
      } else if (stop) {
        ctx.lastStop = stop;
      }
    }
    if (model && model !== '<synthetic>') {
      ctx.model = model;
      if (msgId && isRecord(msg.usage)) this.upsertUsage(ctx, msgId, model, msg.usage, ts);
    }
    if (!Array.isArray(msg.content)) return;
    let skills = 0;
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      const name = str(block.name);
      if (!id || !name) continue;
      this.st.insertAction.run({
        id,
        agent: ctx.agentId,
        session: ctx.sessionId,
        tool: name,
        label: actionLabel(name, block.input),
        startedAt: ts,
        target: actionTarget(block.input),
        inputHash: inputHash(block.input),
        cmdClass: cmdClass(name, block.input),
        readPartial: readPartial(name, block.input),
      });
      const skill = name === 'Skill' && isRecord(block.input) ? str(block.input.skill) : null;
      if (skill && uuid) {
        this.addEvent(ctx, skills === 0 ? `${uuid}:skill` : `${uuid}:skill:${skills}`, ts, 'skill', { name: skill, via: 'tool' });
        skills++;
      }
      if (name === 'Agent' || name === 'Task') {
        const input = isRecord(block.input) ? block.input : {};
        this.st.insertLaunch.run(
          id,
          ctx.sessionId,
          ctx.agentId,
          str(input.subagent_type) ?? 'general-purpose',
          typeof input.description === 'string' ? input.description : '',
          ts,
        );
      }
    }
  }

  private upsertUsage(ctx: FileCtx, msgId: string, model: string, usage: Rec, ts: number): void {
    const t = parseUsage(usage);
    const speed = str(usage.speed);
    const ex = this.st.getUsage.get(msgId);
    if (!ex) {
      this.st.upsertUsage.run({
        id: msgId,
        agent: ctx.agentId,
        session: ctx.sessionId,
        ts,
        model,
        ...t,
        speed,
        cost: costUsd(model, t, speed),
      });
      ctx.usageTouched = true;
      return;
    }
    const merged: UsageTokens = {
      input: Math.max(ex.input, t.input),
      output: Math.max(ex.output, t.output),
      cacheRead: Math.max(ex.cache_read, t.cacheRead),
      cacheWrite5m: Math.max(ex.cache_write_5m, t.cacheWrite5m),
      cacheWrite1h: Math.max(ex.cache_write_1h, t.cacheWrite1h),
    };
    const mergedSpeed = ex.speed ?? speed;
    const firstTs = Math.min(ex.ts, ts);
    const cost = costUsd(ex.model, merged, mergedSpeed);
    // un precio nuevo (o un tramo corregido) debe reescribir el costo aunque los tokens no cambien
    const same =
      cost === ex.cost_usd &&
      merged.input === ex.input &&
      merged.output === ex.output &&
      merged.cacheRead === ex.cache_read &&
      merged.cacheWrite5m === ex.cache_write_5m &&
      merged.cacheWrite1h === ex.cache_write_1h &&
      mergedSpeed === ex.speed &&
      firstTs === ex.ts;
    if (same) return;
    this.st.upsertUsage.run({
      id: msgId,
      agent: ex.agent_id,
      session: ex.session_id,
      ts: firstTs,
      model: ex.model,
      ...merged,
      speed: mergedSpeed,
      cost,
    });
    if (ex.agent_id === ctx.agentId) ctx.usageTouched = true;
    else this.st.markDirty.run(ex.agent_id);
  }

  private onUser(ctx: FileCtx, o: Rec, ts: number, command: FileCtx['pendingCommand']): void {
    const msg = o.message;
    const content = isRecord(msg) ? msg.content : undefined;
    const texts: string[] = [];
    if (Array.isArray(content)) {
      const tur = isRecord(o.toolUseResult) ? o.toolUseResult : null;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result') {
          const toolUseId = str(block.tool_use_id);
          if (!toolUseId) continue;
          const isError = block.is_error === true ? 1 : 0;
          this.st.closeAction.run(ts, isError, toolUseId);
          const text = contentText(block.content);
          const file = tur && isRecord(tur.file) ? tur.file : null;
          this.st.setActionResult.run({
            id: toolUseId,
            chars: text.length,
            lines: file && typeof file.totalLines === 'number' ? file.totalLines : null,
            hash: isError ? textHash(text) : null,
            denied: str(o.toolDenialKind),
          });
          const isAsync = tur !== null && (tur.status === 'async_launched' || tur.isAsync === true) ? 1 : 0;
          this.st.launchResult.run(ts, isAsync, tur ? str(tur.agentId) : null, isError, toolUseId);
          if (!isError) this.onWorkflowResult(ctx, toolUseId, tur, text, ts);
        } else if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
          if (block.text.includes('<task-notification>')) this.onNotificationText(ctx, block.text, ts);
        }
      }
    } else if (typeof content === 'string') {
      texts.push(content);
      if (content.includes('<task-notification>')) this.onNotificationText(ctx, content, ts);
    }

    // skill por /comando: la linea que sigue al comando es la inyeccion meta de su contenido
    if (command && o.isMeta === true) {
      this.addEvent(ctx, `${command.uuid}:skill`, command.ts, 'skill', { name: command.name, via: 'command' });
    }
    const uuid = str(o.uuid);
    if (uuid) {
      for (const text of texts) {
        const interrupt = interruptOf(text);
        if (interrupt) {
          this.addEvent(ctx, `${uuid}:interrupt`, ts, 'interrupt', interrupt);
          break;
        }
      }
      for (const text of texts) {
        const name = commandName(text);
        if (name) {
          ctx.pendingCommand = { uuid, name, ts };
          break;
        }
      }
    }

    if (ctx.isLead && o.isSidechain !== true) {
      const prompt = extractPrompt(o);
      if (prompt) this.onPrompt(ctx, str(o.uuid), prompt.title, ts);
    }
    if (!ctx.isLead && !ctx.promptKnown && o.toolUseResult === undefined) this.onFirstTask(ctx, content);
  }

  /** primer encargo de un subagente: guarda su inicio (define el rol de los agentes de flujo) */
  private onFirstTask(ctx: FileCtx, content: unknown): void {
    const text = contentText(content);
    if (!text.trim()) return;
    const task = taskText(text);
    if (task === null) return; // relevo del harness del Workflow, no es el encargo
    const head = promptHead(task);
    if (!head) return;
    this.st.setPromptHead.run(head, ctx.agentId);
    ctx.promptKnown = true;
    this.roles.refresh(ctx.agentId);
  }

  /** tool_result del tool Workflow: enlaza la corrida (runId) con su task id para leer su fin */
  private onWorkflowResult(ctx: FileCtx, toolUseId: string, tur: Rec | null, text: string, ts: number): void {
    if (!(tur && typeof tur.runId === 'string') && !text.includes('Run ID:')) return;
    if (this.st.actionTool.get(toolUseId)?.tool !== 'Workflow') return;
    const launch = parseWorkflowLaunch(tur, text);
    if (launch) this.workflows.recordLaunch(ctx.sessionId, toolUseId, launch, ts);
  }

  private onPrompt(ctx: FileCtx, uuid: string | null, title: string, ts: number): void {
    const turn = this.st.getTurn.get(ctx.sessionId);
    // un prompt nuevo cierra el turno anterior que no tuvo turn_duration
    if (turn && turn.turn_open === 1 && turn.last_prompt_at !== null && turn.last_prompt_at < ts) {
      const end = Math.max(turn.last_prompt_at, Math.min(ctx.lastConv ?? turn.last_prompt_at, ts));
      this.tasks.leadTask(ctx.sessionId, turn.last_prompt_uuid, turn.last_prompt_title ?? '', turn.last_prompt_at, end);
      this.st.endTurn.run(end, ctx.sessionId);
    }
    this.st.setPrompt.run(ts, uuid, title, ctx.sessionId);
  }

  private onTurnEnd(ctx: FileCtx, ts: number): void {
    const turn = this.st.getTurn.get(ctx.sessionId);
    if (turn && turn.turn_open === 1 && turn.last_prompt_at !== null && ts >= turn.last_prompt_at) {
      this.tasks.leadTask(ctx.sessionId, turn.last_prompt_uuid, turn.last_prompt_title ?? '', turn.last_prompt_at, ts);
    }
    this.st.endTurn.run(ts, ctx.sessionId);
  }

  private onNotificationText(ctx: FileCtx, text: string, ts: number): void {
    if (!text.includes('<task-notification>')) return;
    for (const n of parseNotifications(text)) {
      this.st.insertNotification.run(n.taskId, ts, ctx.sessionId, n.status);
    }
  }

  private flush(ctx: FileCtx): void {
    this.st.touchAgent.run({
      id: ctx.agentId,
      min: ctx.convMin,
      max: ctx.convMax,
      model: ctx.model,
      lastMsgId: ctx.lastMsgId,
      lastStop: ctx.lastStop,
      dirty: ctx.usageTouched ? 1 : 0,
    });
    if (ctx.sessionMax !== null || ctx.cwd !== null || ctx.customTitle !== null || ctx.gitBranch !== null) {
      this.st.touchSession.run({
        id: ctx.sessionId,
        max: ctx.sessionMax,
        cwd: ctx.cwd,
        project: ctx.cwd ? baseName(ctx.cwd) : null,
        customTitle: ctx.customTitle,
        gitBranch: ctx.gitBranch,
      });
    }
    if (!ctx.isLead && ctx.endedAt !== null && ctx.convMax !== null) {
      const res = this.st.reopenAgent.run(ctx.agentId, ctx.convMax);
      if (res.changes > 0) ctx.endedAt = null;
    }
    ctx.convMin = null;
    ctx.convMax = null;
    ctx.sessionMax = null;
    ctx.model = null;
    ctx.customTitle = null;
    ctx.gitBranch = null;
    ctx.usageTouched = false;
  }
}
