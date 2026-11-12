import { agentBaseName, DEFAULT_LEAD_NAME } from '@shared/agents';
import type { ArchivedRoom, CurrentAction, OfficeAgent, OfficeRoom, OfficeSnapshot, WorkflowRun } from '@shared/contract';
import { assignPersonas, LEAD_PERSONA, PERSONA_BY_TYPE, personaName } from '@shared/personas';
import { DESK_ORDER, MAX_ROOMS, TIMING } from '../config';
import type { Db } from '../db/connection';
import { strictCost, toBreakdown, TOKEN_SUM_SQL, type TokenSumRow } from '../db/tokens';
import { baseName } from '../ingest/labels';
import { roleOrNull, RoleStore } from '../ingest/roleStore';
import { fixedRole, TESTER_MIN_SHELLS, WORKFLOW_AGENT_TYPE } from '../ingest/roles';
import { LeadWork } from '../ingest/leadWork';
import { WorkDescriber } from '../ingest/work';
import { NO_ALERTS, type AlertsIndex, type AlertsProvider } from './alerts';
import { placeOf, type LastAction } from './place';
import { notesKeyOf, RoomNotes } from './roomNotes';
import { assignRoomSlots, reorderSlots, sameSlots } from './roomSlots';
import { Settings } from './settings';
import { isRegistryOpen, type RegistryEntry, type SessionRegistry } from './sessions';
import { WorkflowRuns, type RunForecaster } from './workflows';

interface SessionRow {
  session_id: string;
  project_dir: string | null;
  cwd: string | null;
  project_name: string | null;
  registry_name: string | null;
  custom_title: string | null;
  last_activity_at: number | null;
  last_prompt_at: number | null;
  last_prompt_title: string | null;
  last_turn_end_at: number | null;
  transcript_mtime: number | null;
  /** ultimo gitBranch del lead ('HEAD' = sin git); null sin la migracion v13 */
  git_branch: string | null;
}

interface AgentRow {
  agent_id: string;
  agent_type: string;
  description: string;
  tool_use_id: string | null;
  model: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  ended_at: number | null;
  /** subagentes que lanzo con el tool Agent */
  child_count: number;
}

interface SubagentRow extends AgentRow {
  wf_run: string | null;
  wf_run_name: string | null;
  wf_label: string | null;
  wf_phase: string | null;
  look_type: string | null;
  role: string | null;
  /** quien lo lanzo (agentId o sessionId); de flujo o sin launch: el sessionId */
  parent_id: string;
}

interface LastActionRow {
  tool_use_id: string;
  tool: string;
  ended_at: number | null;
  cmd_class: string | null;
}

/** personas recordadas de agentes que ya salieron (para el panel de Flujos) */
const REMEMBERED_PERSONAS = 2000;

interface Candidate {
  id: string;
  row: SessionRow | null;
  entry: RegistryEntry | null;
  open: boolean;
  lastActivity: number;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** puestos estables: conserva el que ya tenia; los nuevos toman el primero libre de DESK_ORDER o -1 */
export function assignDesks(prev: ReadonlyMap<string, number>, visibleIds: readonly string[]): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  for (const id of visibleIds) {
    const desk = prev.get(id);
    if (desk !== undefined && desk > 0 && !used.has(desk)) {
      next.set(id, desk);
      used.add(desk);
    }
  }
  for (const id of visibleIds) {
    if (next.has(id)) continue;
    let desk = -1;
    for (const k of DESK_ORDER) {
      if (!used.has(k)) {
        desk = k;
        used.add(k);
        break;
      }
    }
    next.set(id, desk);
  }
  return next;
}

export interface NameSlot {
  type: string;
  name: string;
}

/** nombre visible: base del tipo; si ya hay otro visible con ese nombre, sufijo " 2", " 3"... estable */
export function assignNames(
  prev: ReadonlyMap<string, NameSlot>,
  visible: ReadonlyArray<{ id: string; type: string }>,
): Map<string, NameSlot> {
  const next = new Map<string, NameSlot>();
  const used = new Set<string>();
  for (const v of visible) {
    const p = prev.get(v.id);
    if (p && p.type === v.type && !used.has(p.name)) {
      next.set(v.id, p);
      used.add(p.name);
    }
  }
  for (const v of visible) {
    if (next.has(v.id)) continue;
    const base = agentBaseName(v.type);
    let n = 1;
    let name = base;
    while (used.has(name)) {
      n++;
      name = `${base} ${n}`;
    }
    next.set(v.id, { type: v.type, name });
    used.add(name);
  }
  return next;
}

/** arma el OfficeSnapshot desde la DB + el registro de sesiones; guarda puestos y personas en memoria */
export class OfficeBuilder {
  private desks = new Map<string, Map<string, number>>();
  /** persona de cada agente visible: unica en toda la oficina */
  private personas = new Map<string, string>();
  /** ultima persona de cada agente (visibles y los que ya salieron), en orden de uso */
  private lastPersona = new Map<string, string>();
  private readonly roles: RoleStore;
  private readonly work: WorkDescriber;
  private readonly leadWork: LeadWork;
  private readonly roomNotes: RoomNotes;
  private readonly settings: Settings;
  /** lugar fijo de cada sala en el mapa (espejo de settings.room_slots); se carga en el primer build */
  private slots: Map<string, number> | null = null;
  /** alertas y conteos del motor de habitos; sin el, ninguna */
  private alerts: AlertsProvider = NO_ALERTS;
  /** cuantos Bash/PowerShell tenia un generalist visible la ultima vez que se reviso si ya es tester */
  private readonly testerChecks = new Map<string, number>();
  /**
   * primer build en que se vio una sesion o un subagente que aun no tiene timestamps propios (sesion solo
   * del registro, subagente creado por su meta): su hora de respaldo, fija entre builds
   */
  private readonly firstSeen = new Map<string, number>();

  private readonly candidates;
  private readonly agent;
  private readonly visibleSubs;
  private readonly sumAgentSince;
  private readonly sumAgent;
  private readonly sumSession;
  private readonly sumSince;
  private readonly openAction;
  private readonly lastAction;
  private readonly shellCount;
  private readonly launchDescription;
  private readonly workflows: WorkflowRuns;

  constructor(
    db: Db,
    private readonly registry: SessionRegistry,
    private readonly now: () => number,
  ) {
    this.workflows = new WorkflowRuns(db);
    this.roles = new RoleStore(db);
    this.work = new WorkDescriber(db);
    this.leadWork = new LeadWork(db);
    this.roomNotes = new RoomNotes(db);
    this.settings = new Settings(db);
    // columnas de la migracion v13: en una DB sin ellas las consultas no fallan, solo no las usan
    const has = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    const gitBranch = has('sessions', 'git_branch') ? 's.git_branch' : 'NULL';
    const cmdClass = has('actions', 'cmd_class') ? 'cmd_class' : 'NULL';
    this.candidates = db.prepare<[number, string], SessionRow>(`
      SELECT s.session_id, s.project_dir, s.cwd, s.project_name, s.registry_name, s.custom_title,
             s.last_activity_at, s.last_prompt_at, s.last_prompt_title, s.last_turn_end_at,
             f.mtime_ms AS transcript_mtime, ${gitBranch} AS git_branch
      FROM sessions s LEFT JOIN file_offsets f ON f.path_key = s.transcript_key
      WHERE s.last_activity_at >= ? OR s.session_id IN (SELECT value FROM json_each(?))`);
    this.agent = db.prepare<[string], AgentRow>(
      `SELECT agent_id, agent_type, description, tool_use_id, model, started_at, last_activity_at, ended_at,
              (SELECT COUNT(*) FROM launches c WHERE c.parent_agent_id = agents.agent_id) AS child_count
       FROM agents WHERE agent_id = ?`,
    );
    this.visibleSubs = db.prepare<[string, number], SubagentRow>(`
      SELECT a.agent_id, a.agent_type, a.description, a.tool_use_id, a.model, a.started_at, a.last_activity_at,
             a.ended_at, w.run_id AS wf_run, COALESCE(r.meta_name, r.tool_name, w.run_id) AS wf_run_name,
             w.label AS wf_label, w.phase AS wf_phase, a.look_type, a.role,
             CASE WHEN w.run_id IS NULL THEN COALESCE(l.parent_agent_id, a.session_id) ELSE a.session_id END AS parent_id,
             (SELECT COUNT(*) FROM launches c WHERE c.parent_agent_id = a.agent_id) AS child_count
      FROM agents a
      LEFT JOIN workflow_agents w ON w.agent_id = a.agent_id
      LEFT JOIN workflow_runs r ON r.run_id = w.run_id
      LEFT JOIN launches l ON l.tool_use_id = a.tool_use_id
      WHERE a.session_id = ? AND a.kind = 'subagent' AND (a.ended_at IS NULL OR a.ended_at >= ?)
      ORDER BY COALESCE(a.started_at, 0), a.agent_id`);
    this.sumAgentSince = db.prepare<[string, number], TokenSumRow>(
      `SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ? AND ts >= ?`,
    );
    this.sumAgent = db.prepare<[string], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE agent_id = ?`);
    this.sumSession = db.prepare<[string], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE session_id = ?`);
    this.sumSince = db.prepare<[number], TokenSumRow>(`SELECT ${TOKEN_SUM_SQL} FROM usage WHERE ts >= ?`);
    this.openAction = db.prepare<[string, number], { tool: string; label: string; started_at: number }>(`
      SELECT tool, label, started_at FROM actions
      WHERE agent_id = ? AND ended_at IS NULL AND started_at >= ?
      ORDER BY started_at DESC LIMIT 1`);
    // la mas reciente, abierta o cerrada: decide el lugar
    this.lastAction = db.prepare<[string, number], LastActionRow>(`
      SELECT tool_use_id, tool, ended_at, ${cmdClass} AS cmd_class FROM actions
      WHERE agent_id = ? AND started_at >= ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1`);
    this.shellCount = db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM actions WHERE agent_id = ? AND tool IN ('Bash', 'PowerShell')`,
    );
    this.launchDescription = db.prepare<[string], { description: string }>(
      `SELECT description FROM launches WHERE tool_use_id = ?`,
    );
  }

  build(): OfficeSnapshot {
    const now = this.now();
    const midnight = startOfLocalDay(now);
    const reg = this.registry.entries;
    const rows = this.candidates.all(midnight, JSON.stringify([...reg.keys()]));

    const cands: Candidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.session_id);
      const entry = reg.get(row.session_id) ?? null;
      const open = entry ? isRegistryOpen(entry, row.transcript_mtime, now) : false;
      const last = row.last_activity_at;
      if (!open && (last === null || last < midnight)) continue;
      cands.push({
        id: row.session_id,
        row,
        entry,
        open,
        lastActivity: last ?? entry?.updatedAtMs ?? entry?.startedAtMs ?? this.firstSeenAt(row.session_id, now),
      });
    }
    // sesion recien abierta que aun no escribio transcript
    for (const [id, entry] of reg) {
      if (seen.has(id) || !isRegistryOpen(entry, null, now)) continue;
      const lastActivity = entry.updatedAtMs ?? entry.startedAtMs ?? this.firstSeenAt(id, now);
      cands.push({ id, row: null, entry, open: true, lastActivity });
    }
    cands.sort((a, b) => Number(b.open) - Number(a.open) || b.lastActivity - a.lastActivity);

    // archivada = fuera, salvo que su chat haya tenido actividad despues de archivarla (se volvio a usar).
    // Eliminada = fuera siempre, y tampoco sale en la lista de archivadas.
    const archivedAt = this.roomNotes.archived();
    const archived: ArchivedRoom[] = [];
    const shown = cands.filter((c) => {
      const a = archivedAt.get(c.id);
      if (a === undefined) return true;
      if (a.deleted) return false;
      if ((c.row?.last_activity_at ?? 0) > a.at) return true;
      const t = this.titles(c);
      archived.push({ id: c.id, title: t.title, projectName: t.projectName, open: c.open, archivedAt: iso(a.at) });
      return false;
    });

    const chosen = shown.slice(0, MAX_ROOMS);
    // personas unicas en toda la oficina: primero se juntan los visibles de todas las salas
    const subRows = new Map<string, SubagentRow[]>();
    const visible: Array<{ id: string; type: string }> = [];
    for (const c of chosen) {
      const rows = this.visibleSubs.all(c.id, now - TIMING.doneVisibleMs);
      for (const r of rows) visible.push({ id: r.agent_id, type: this.lookType(r) });
      subRows.set(c.id, rows);
    }
    this.personas = assignPersonas(this.personas, visible);
    for (const [id, p] of this.personas) this.remember(id, p);
    for (const id of [...this.testerChecks.keys()]) if (!this.personas.has(id)) this.testerChecks.delete(id);
    const alive = new Set(cands.map((c) => c.id));
    for (const id of [...this.firstSeen.keys()]) if (!alive.has(id) && !this.personas.has(id)) this.firstSeen.delete(id);

    const alerts = this.alerts.current();
    const slots = this.roomSlots(chosen.map((c) => c.id));
    const leadName = this.settings.leadName();
    const leadDisplay = leadName ?? DEFAULT_LEAD_NAME;
    const rooms = chosen.map((c) => ({
      ...this.buildRoom(c, now, subRows.get(c.id) ?? [], alerts, leadDisplay),
      slot: slots.get(c.id),
    }));
    const present = new Set(rooms.map((r) => r.id));
    for (const id of [...this.desks.keys()]) if (!present.has(id)) this.desks.delete(id);

    let leadRoomId: string | null = null;
    let lastPrompt = -Infinity;
    for (const c of chosen) {
      const p = c.row?.last_prompt_at;
      if (p !== null && p !== undefined && p > lastPrompt) {
        lastPrompt = p;
        leadRoomId = c.id;
      }
    }

    const today = this.sumSince.get(midnight);
    return {
      generatedAt: iso(now),
      leadRoomId,
      leadName,
      rooms,
      archivedRooms: archived,
      today: { costUsd: today?.cost ?? 0, tokens: toBreakdown(today), unpricedTokens: today?.unpriced ?? 0 },
      habits: alerts.summary(),
    };
  }

  /** motor de habitos que da las alertas vivas; build() solo lee su indice ya calculado */
  setAlertsProvider(p: AlertsProvider): void {
    this.alerts = p;
  }

  /** pronostico en vuelo de las corridas en curso (WorkflowRun.forecast) */
  setForecaster(f: RunForecaster | null): void {
    this.workflows.setForecaster(f);
  }

  /** orden nuevo de la lista (`reorderSlots`); false si no cambio nada */
  reorderRooms(ids: readonly string[]): boolean {
    const saved = this.slots ?? this.settings.roomSlots();
    const next = reorderSlots(saved, ids);
    if (sameSlots(saved, next)) return false;
    this.settings.setRoomSlots(next);
    this.slots = next;
    return true;
  }

  /** lugar fijo de las salas visibles; se escribe en la DB solo cuando algo cambia */
  private roomSlots(visible: readonly string[]): Map<string, number> {
    const saved = this.slots ?? this.settings.roomSlots();
    const next = assignRoomSlots(saved, visible);
    if (!sameSlots(saved, next)) this.settings.setRoomSlots(next);
    this.slots = next;
    return next;
  }

  /**
   * tipo del elenco del agente: el suyo si tiene look propio, si no el de su rol. Se clasifica si aun no
   * tiene rol, o si su tipo cambio despues (el meta o el tool_use llegaron despues que el transcript)
   */
  private lookType(r: SubagentRow): string {
    const fixed = fixedRole(r.agent_type);
    const stale = fixed !== null && (fixed.role !== r.role || fixed.lookType !== r.look_type);
    if (r.role === null || r.look_type === null || stale) {
      const res = this.roles.refresh(r.agent_id);
      if (res) {
        r.look_type = res.lookType;
        r.role = res.role;
      }
    }
    return r.look_type ?? (r.agent_type === WORKFLOW_AGENT_TYPE ? 'general-purpose' : r.agent_type);
  }

  private firstSeenAt(id: string, now: number): number {
    const t = this.firstSeen.get(id);
    if (t !== undefined) return t;
    this.firstSeen.set(id, now);
    return now;
  }

  private remember(agentId: string, persona: string): void {
    this.lastPersona.delete(agentId);
    this.lastPersona.set(agentId, persona);
    if (this.lastPersona.size > REMEMBERED_PERSONAS) {
      const oldest = this.lastPersona.keys().next().value;
      if (oldest !== undefined) this.lastPersona.delete(oldest);
    }
  }

  /** nombre de la persona que la oficina le dio al agente (Habitos usa el mismo nombre que la escena) */
  personaNameOf(agentId: string): string | null {
    const p = this.lastPersona.get(agentId);
    return p ? personaName(p) : null;
  }

  /** nombre y persona conocidos de cada agente (para el panel de Flujos) */
  private personaRefs(): Map<string, { name: string; persona: string }> {
    const out = new Map<string, { name: string; persona: string }>();
    for (const [id, p] of this.lastPersona) out.set(id, { name: personaName(p), persona: p });
    return out;
  }

  /** carpeta, nombres y llave del proyecto de una sala (tambien para la lista de archivadas) */
  private titles(c: Candidate) {
    const row = c.row;
    const cwd = row?.cwd ?? c.entry?.cwd ?? '';
    const projectName = row?.project_name ?? (cwd ? baseName(cwd) : (row?.project_dir ?? c.id));
    const autoTitle = c.entry?.name ?? row?.registry_name ?? row?.custom_title ?? projectName;
    const projectKey = notesKeyOf(c.id);
    const customName = this.roomNotes.name(c.id);
    return { cwd, projectName, autoTitle, projectKey, customName, title: customName ?? autoTitle };
  }

  private buildRoom(
    c: Candidate,
    now: number,
    subRows: readonly SubagentRow[],
    alerts: AlertsIndex,
    leadDisplay: string,
  ): OfficeRoom {
    const { cwd, projectName, autoTitle, projectKey, customName, title } = this.titles(c);
    const busy = c.open && c.entry?.status === 'busy';
    const lead = this.buildLead(c, busy, now, alerts, leadDisplay);
    const subagents = this.buildSubagents(c.id, c.open, now, subRows, alerts);
    const total = this.sumSession.get(c.id);
    const workflows: WorkflowRun[] = this.workflows.forSession(c.id, now, startOfLocalDay(now), this.personaRefs());
    return {
      id: c.id,
      projectName,
      title,
      autoTitle,
      customName,
      projectKey,
      notes: this.roomNotes.notes(projectKey),
      cwd,
      open: c.open,
      busy,
      lastActivityAt: iso(c.lastActivity),
      lead,
      subagents,
      tokens: toBreakdown(total),
      costUsd: strictCost(total),
      workflows,
      gitBranch: branchOf(c.row?.git_branch),
      alert: alerts.room(c.id),
      habitCount: alerts.habitCount(c.id),
    };
  }

  private buildLead(c: Candidate, busy: boolean, now: number, alerts: AlertsIndex, displayName: string): OfficeAgent {
    const row = c.row;
    const lastPrompt = row?.last_prompt_at ?? null;
    const turnEnd = row?.last_turn_end_at ?? null;
    const agent = this.agent.get(c.id);

    let working: boolean;
    if (c.open) {
      working = busy;
    } else {
      const last = row?.last_activity_at ?? null;
      working =
        lastPrompt !== null &&
        (turnEnd === null || lastPrompt > turnEnd) &&
        last !== null &&
        now - last <= TIMING.leadActiveWindowMs;
    }

    let task: OfficeAgent['task'] = null;
    if (lastPrompt !== null) {
      let endMs: number | null = null;
      if (!working) {
        endMs = turnEnd !== null && turnEnd >= lastPrompt ? turnEnd : Math.max(lastPrompt, agent?.last_activity_at ?? lastPrompt);
      }
      // se muestra lo que esta haciendo, nunca el texto del prompt (se ve en la pantalla que se proyecta)
      const title = this.leadWork.describe(c.id, lastPrompt, endMs ?? now);
      task = { title, startedAt: iso(lastPrompt), endedAt: endMs !== null ? iso(endMs) : null };
    }

    const sum = lastPrompt !== null ? this.sumAgentSince.get(c.id, lastPrompt) : undefined;
    const status = working ? 'working' : 'idle';
    // solo cuenta la accion del turno actual: al empezar uno nuevo esta pensando en su escritorio
    const last = lastOf(this.lastAction.get(c.id, lastPrompt ?? 0));
    return {
      id: c.id,
      kind: 'lead',
      agentType: 'lead',
      displayName,
      persona: LEAD_PERSONA,
      status,
      task,
      action: working ? this.currentAction(c.id, lastPrompt ?? 0) : null,
      model: agent?.model ?? null,
      tokens: toBreakdown(sum),
      costUsd: strictCost(sum),
      deskIndex: 0,
      role: 'orchestrator',
      place: placeOf({
        kind: 'lead',
        status,
        role: 'orchestrator',
        last,
        lastActivityMs: agent?.last_activity_at ?? c.lastActivity,
        sessionOpen: c.open,
        now,
      }),
      alert: alerts.agent(c.id),
      startedAt: isoOrNull(agent?.started_at ?? c.entry?.startedAtMs),
      lastActivityAt: isoOrNull(agent?.last_activity_at),
      parentId: null,
      childCount: agent?.child_count ?? 0,
    };
  }

  private buildSubagents(
    roomId: string,
    sessionOpen: boolean,
    now: number,
    rows: readonly SubagentRow[],
    alerts: AlertsIndex,
  ): OfficeAgent[] {
    const desks = assignDesks(this.desks.get(roomId) ?? new Map(), rows.map((r) => r.agent_id));
    this.desks.set(roomId, desks);

    return rows.map((r) => {
      const done = r.ended_at !== null;
      const sum = this.sumAgent.get(r.agent_id);
      const lastRow = done ? undefined : this.lastAction.get(r.agent_id, 0);
      this.checkTester(r);
      const type = this.lookType(r);
      const role = roleOrNull(r.role) ?? 'generalist';
      const status = done ? 'done' : 'working';
      const persona = this.personas.get(r.agent_id) ?? PERSONA_BY_TYPE[type] ?? 'gael';
      const startedAt = r.started_at ?? r.last_activity_at ?? this.firstSeenAt(r.agent_id, now);
      const endedAt = r.ended_at !== null ? iso(r.ended_at) : null;
      let task: OfficeAgent['task'];
      const work = r.wf_run !== null ? this.work.describe(r.agent_id) : null;
      if (work) {
        task = { title: work.title, detail: work.detail, startedAt: iso(startedAt), endedAt };
      } else {
        let title = r.description;
        if (!title && r.tool_use_id) title = this.launchDescription.get(r.tool_use_id)?.description ?? '';
        task = { title, startedAt: iso(startedAt), endedAt };
      }
      const agent: OfficeAgent = {
        id: r.agent_id,
        kind: 'subagent',
        agentType: type,
        displayName: personaName(persona),
        persona,
        status,
        task,
        action: done ? null : this.currentAction(r.agent_id, 0),
        model: r.model,
        tokens: toBreakdown(sum),
        costUsd: strictCost(sum),
        deskIndex: desks.get(r.agent_id) ?? -1,
        role,
        place: placeOf({
          kind: 'subagent',
          status,
          role,
          last: lastOf(lastRow),
          lastActivityMs: r.last_activity_at,
          sessionOpen,
          now,
        }),
        alert: alerts.agent(r.agent_id),
        startedAt: isoOrNull(r.started_at),
        lastActivityAt: isoOrNull(r.last_activity_at),
        parentId: r.parent_id,
        childCount: r.child_count,
      };
      if (r.wf_run !== null) {
        agent.workflow = {
          runId: r.wf_run,
          name: r.wf_run_name ?? r.wf_run,
          phase: r.wf_phase,
          label: r.wf_label ?? '',
          sourceType: r.agent_type,
          role,
        };
      }
      return agent;
    });
  }

  /**
   * generalist visible, trabajando o recien terminado: cuando cambia su cantidad de Bash/PowerShell se
   * revisa si ya corre sobre todo tests (tester). Por conteo y no por su ultima accion: los comandos en
   * paralelo con Read/Edit y los que cierran entre dos builds tambien cuentan
   */
  private checkTester(r: SubagentRow): void {
    if (r.role !== 'generalist') return;
    const shells = this.shellCount.get(r.agent_id)?.n ?? 0;
    if (shells < TESTER_MIN_SHELLS || this.testerChecks.get(r.agent_id) === shells) return;
    this.testerChecks.set(r.agent_id, shells);
    const res = this.roles.promoteTester(r.agent_id, r.model);
    if (res) {
      r.role = res.role;
      r.look_type = res.lookType;
    }
  }

  private currentAction(agentId: string, since: number): CurrentAction | null {
    const a = this.openAction.get(agentId, since);
    return a ? { tool: a.tool, label: a.label, startedAt: iso(a.started_at) } : null;
  }
}

function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : iso(ms);
}

/** Claude Code escribe 'HEAD' fuera de un repo git */
function branchOf(branch: string | null | undefined): string | null {
  return branch && branch !== 'HEAD' ? branch : null;
}

function lastOf(a: LastActionRow | undefined): LastAction | null {
  return a ? { tool: a.tool, open: a.ended_at === null, cmdClass: a.cmd_class } : null;
}
