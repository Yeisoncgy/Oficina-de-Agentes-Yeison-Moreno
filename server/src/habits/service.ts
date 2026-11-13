import { agentBaseName, DEFAULT_LEAD_NAME } from '@shared/agents';
import {
  HABITS_LIST_MAX,
  type HabitKind,
  type HabitsInboxResponse,
  type HabitsResponse,
  type InboxItem,
  type InboxLevel,
  type LiveAlert,
} from '@shared/contract';
import { TIMING } from '../config';
import type { Db } from '../db/connection';
import { baseName } from '../ingest/labels';
import { EMPTY_ALERTS, type AlertsIndex, type AlertsProvider } from '../state/alerts';
import { Settings } from '../state/settings';
import { alertTitles, ERRORS_INSTRUCTION, ruleInstruction } from './copy';
import * as detect from './detectors';
import { groupBy, LIMITS, type AgentBook, type Draft, type TurnSpan } from './detectors';
import { HabitFacts, type AgentRow, type DayCostRow, type RunCostRow, type Scope, type SessionInfoRow } from './facts';
import {
  groupFindings,
  HISTORY_GROUP_MIN,
  LIVE_GROUP_MIN,
  savingsTotals,
  sortFindings,
  toPublic,
  type Scored,
} from './group';
import { alertKey, coveredAlertKeys, type DismissInput, DismissedAlerts, findingKey, inboxGroup, type SeenItem } from './inbox';
import { RULE_DEFS, type RulesService } from './rules';
import { RULE_IDS } from './ruleSettings';

export interface HabitsDeps {
  db: Db;
  clock: () => number;
  rules: RulesService;
  /**
   * sesiones abiertas segun el registro de Claude Code (SessionRegistry.openIds). Sin esto, abierta =
   * con actividad hoy.
   */
  openIds?: () => ReadonlySet<string>;
  /**
   * sesiones cuyo registro dice status 'busy' (la misma senal que usa OfficeBuilder para el lead). En una
   * sesion abierta el lead trabaja solo si esta aqui; sin esto (o en una sesion sin registro), trabaja con el
   * turno abierto y actividad en los ultimos 10 min.
   */
  busyIds?: () => ReadonlySet<string>;
  /** nombre de la persona que la oficina le asigno al agente mientras sigue visible; null = no esta visible */
  personaName?: (agentId: string) => string | null;
}

/** acciones del final que se miran para las rachas vivas (loop_repeats tiene tope 50) */
const TAIL_ACTIONS = 50;

const iso = (ms: number): string => new Date(ms).toISOString();

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** inicio de la ventana en hora local: hoy, hoy + 6 dias anteriores, o el mes */
function windowStart(range: Exclude<HabitsResponse['range'], 'live'>, now: number): number {
  const d = new Date(startOfLocalDay(now));
  if (range === 'week') d.setDate(d.getDate() - 6);
  if (range === 'month') d.setDate(1);
  return d.getTime();
}

function roomLabel(s: SessionInfoRow): { title: string; projectName: string } {
  const projectName = s.project_name ?? (s.cwd ? baseName(s.cwd) : (s.project_dir ?? s.session_id));
  return { projectName, title: s.custom_name ?? s.registry_name ?? s.custom_title ?? projectName };
}


/** momentos (epoch ms) agrupados por llave, en el orden de las filas */
function tsBy<T>(rows: readonly T[], key: (r: T) => string, ts: (r: T) => number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [k, list] of groupBy(rows, key)) out.set(k, list.map(ts));
  return out;
}

/** la alerta mas severa; a igual nivel gana la primera de la lista */
function worst(alerts: readonly LiveAlert[]): LiveAlert | null {
  return alerts.find((a) => a.level === 'critical') ?? alerts[0] ?? null;
}

interface Evaluation {
  /** sin juntar, con sus reclamos de ahorro */
  findings: Scored[];
  sessions: SessionInfoRow[];
  agents: AgentRow[];
  dayCosts: DayCostRow[];
  runs: RunCostRow[];
  turns: Map<string, TurnSpan[]>;
  leadCompacts: Map<string, number[]>;
  launches: Map<string, number[]>;
  /** sesiones donde el lead esta trabajando ahora */
  leadWorking: Set<string>;
}

/** lo vivo de la ultima pasada, con lo descartado incluido (la bandeja y el descarte lo filtran) */
interface LiveState {
  /** hallazgos vivos juntados y ordenados como la lista 'live' */
  listed: Scored[];
  /** todas las alertas vivas de cada agente y cada sala (no solo la peor) */
  agentAlerts: Map<string, LiveAlert[]>;
  roomAlerts: Map<string, LiveAlert[]>;
  rooms: Map<string, { title: string; projectName: string }>;
  /** sala y nombre de cada agente; nombre null = el lead (las instrucciones ya le hablan a el) */
  agents: Map<string, { roomId: string; name: string | null }>;
}

type AlertScope = 'agent' | 'room';

/**
 * Motor de habitos: hallazgos por reglas deterministas (cero tokens, solo lectura de la DB) y alertas
 * vivas para el snapshot. refresh() recalcula lo vivo (sesiones abiertas o de hoy, eventos desde la
 * medianoche) y current() entrega ese indice ya calculado a OfficeBuilder.
 */
export class HabitsService implements AlertsProvider {
  private readonly facts: HabitFacts;
  private readonly clock: () => number;
  private readonly rules: RulesService;
  private readonly openIds: (() => ReadonlySet<string>) | null;
  private readonly busyIds: (() => ReadonlySet<string>) | null;
  private readonly personaName: ((agentId: string) => string | null) | null;
  private readonly dismissed: DismissedAlerts;
  private readonly settings: Settings;
  private index: AlertsIndex = EMPTY_ALERTS;
  private live: LiveState | null = null;

  constructor(deps: HabitsDeps) {
    this.facts = new HabitFacts(deps.db);
    this.settings = new Settings(deps.db);
    this.clock = deps.clock;
    this.rules = deps.rules;
    this.openIds = deps.openIds ?? null;
    this.busyIds = deps.busyIds ?? null;
    this.personaName = deps.personaName ?? null;
    this.dismissed = new DismissedAlerts(deps.db, deps.clock());
  }

  current(): AlertsIndex {
    return this.index;
  }

  /** el lead con el nombre que eligio el usuario (se lee en cada pasada: la ruta de ajustes lo cambia) */
  private agentName(a: AgentRow): string {
    return a.kind === 'lead' ? this.leadName() : agentBaseName(a.agent_type);
  }

  private leadName(): string {
    return this.settings.leadName() ?? DEFAULT_LEAD_NAME;
  }

  /**
   * Recalcula lo vivo. Lo descartado en la bandeja no cuenta en ningun lado (alertas del snapshot, conteos,
   * resumen): si la peor alerta de un agente esta descartada, sale la siguiente.
   */
  refresh(): void {
    const now = this.clock();
    const midnight = startOfLocalDay(now);
    const ev = this.evaluate(this.liveSessions(now), midnight, now);
    const allAgent = this.agentAlerts(ev);
    const allRoom = this.roomAlerts(ev);
    // lo mismo que muestra la lista 'live': juntados y sin ahorros contados dos veces
    const listed = sortFindings(groupFindings(ev.findings, LIVE_GROUP_MIN));
    this.dismissed.observe(this.seen(listed, allAgent, allRoom), now, (key) => this.childrenOf(key, listed));
    this.live = {
      listed,
      agentAlerts: allAgent,
      roomAlerts: allRoom,
      rooms: new Map(ev.sessions.map((s) => [s.session_id, roomLabel(s)])),
      agents: new Map(
        ev.agents.map((a) => [a.agent_id, { roomId: a.session_id, name: a.kind === 'lead' ? null : (this.personaName?.(a.agent_id) ?? this.agentName(a)) }]),
      ),
    };
    const agentAlerts = this.visibleAlerts('agent', allAgent);
    const roomAlerts = this.visibleAlerts('room', allRoom);
    const visible = listed.filter((f) => !this.dismissed.has(findingKey(f.id)));
    const counts = new Map<string, number>();
    for (const f of visible) counts.set(f.roomId, (counts.get(f.roomId) ?? 0) + 1);
    const summary = {
      active: visible.length,
      alerts: agentAlerts.size + roomAlerts.size,
      savingsUsd: savingsTotals(ev.findings).total,
      notifyBrowser: this.rules.notifyBrowser(),
    };
    this.index = {
      agent: (id) => agentAlerts.get(id) ?? null,
      room: (id) => roomAlerts.get(id) ?? null,
      habitCount: (id) => counts.get(id) ?? 0,
      summary: () => summary,
    };
  }

  /** bandeja: alertas y avisos vivos sin descartar, con el texto para pegar en Claude Code */
  inbox(): HabitsInboxResponse {
    const { items, dismissed } = this.inboxItems(this.liveState());
    return {
      generatedAt: iso(this.clock()),
      alerts: inboxGroup('critical', items),
      warnings: inboxGroup('warning', items),
      dismissed,
    };
  }

  /**
   * Descarta lo que se copio. Solo cuentan las llaves que estan ahora en ese nivel de la bandeja: si algo
   * nuevo llego despues de copiar, no se oculta sin haberlo copiado. Con cada hallazgo se ocultan sus alertas
   * vivas cubiertas y, si es un grupo, sus miembros (asi no reaparecen si el grupo se separa).
   */
  dismiss(level: InboxLevel, keys: readonly string[]): HabitsInboxResponse {
    const live = this.liveState();
    const current = new Map(this.inboxItems(live).items.filter((i) => i.level === level).map((i) => [i.key, i]));
    const inputs: DismissInput[] = [];
    for (const key of new Set(keys)) {
      const item = current.get(key);
      if (!item) continue;
      const f = live.listed.find((x) => findingKey(x.id) === key);
      const children = f
        ? [
            ...coveredAlertKeys(f).map((k) => ({ key: k, level: this.alertLevel(live, k) ?? f.severity })),
            ...(f.members ?? []).map((m) => ({ key: findingKey(m), level: f.severity })),
          ]
        : [];
      inputs.push({ key, level: item.level, size: f?.members?.length ?? 0, children });
    }
    this.dismissed.add(inputs, this.clock());
    this.refresh();
    return this.inbox();
  }

  /** deshacer: vuelven a la bandeja y a la oficina (con sus alertas cubiertas y miembros) */
  restore(keys: readonly string[]): HabitsInboxResponse {
    const live = this.liveState();
    this.dismissed.restore(keys, (key) => this.childrenOf(key, live.listed));
    this.refresh();
    return this.inbox();
  }

  /**
   * Hallazgos del rango. En los rangos historicos los del mismo tipo en una sesion van juntados en uno; en
   * 'live', solo si son mas de 3. La lista se corta en HABITS_LIST_MAX (total = cuantos habia); byKind y
   * totalSavingsUsd cuentan todos, sin sumar dos veces las mismas llamadas.
   */
  findings(range: HabitsResponse['range']): HabitsResponse {
    const now = this.clock();
    let ev: Evaluation;
    if (range === 'live') {
      ev = this.evaluate(this.liveSessions(now), startOfLocalDay(now), now);
    } else {
      const since = windowStart(range, now);
      ev = this.evaluate(this.facts.sessionsActiveSince(since), since, now);
    }
    const grouped = sortFindings(groupFindings(ev.findings, range === 'live' ? LIVE_GROUP_MIN : HISTORY_GROUP_MIN));
    // en vivo lo copiado a Claude Code no se ve; en el historico va marcado como enviado
    const listed = range === 'live' ? grouped.filter((f) => !this.dismissed.has(findingKey(f.id))) : grouped;
    const savings = savingsTotals(ev.findings);
    const byKind = new Map<HabitKind, { kind: HabitKind; count: number; savingsUsd: number }>();
    for (const f of listed) {
      const k = byKind.get(f.kind) ?? { kind: f.kind, count: 0, savingsUsd: savings.byKind.get(f.kind) ?? 0 };
      k.count++;
      byKind.set(f.kind, k);
    }
    return {
      range,
      generatedAt: iso(now),
      findings: listed.slice(0, HABITS_LIST_MAX).map((f) => {
        const pub = toPublic(f);
        return range !== 'live' && this.wasSent(f) ? { ...pub, dismissed: true } : pub;
      }),
      total: listed.length,
      byKind: [...byKind.values()].sort((a, b) => b.savingsUsd - a.savingsUsd || b.count - a.count || a.kind.localeCompare(b.kind)),
      totalSavingsUsd: savings.total,
    };
  }

  /** copiado a Claude Code: el hallazgo, o en el historico un grupo con todos sus miembros copiados */
  private wasSent(f: Scored): boolean {
    if (this.dismissed.has(findingKey(f.id))) return true;
    const members = f.members ?? [];
    return members.length > 0 && members.every((m) => this.dismissed.has(findingKey(m)));
  }

  private liveState(): LiveState {
    if (!this.live) this.refresh();
    return this.live ?? { listed: [], agentAlerts: new Map(), roomAlerts: new Map(), rooms: new Map(), agents: new Map() };
  }

  /** todo lo vivo por llave, descartado o no (los miembros de un grupo siguen vivos mientras el grupo lo este) */
  private seen(
    listed: readonly Scored[],
    agentAlerts: ReadonlyMap<string, readonly LiveAlert[]>,
    roomAlerts: ReadonlyMap<string, readonly LiveAlert[]>,
  ): Map<string, SeenItem> {
    const seen = new Map<string, SeenItem>();
    for (const f of listed) {
      seen.set(findingKey(f.id), { level: f.severity, size: f.members?.length ?? 0 });
      for (const m of f.members ?? []) seen.set(findingKey(m), { level: f.severity, size: 0 });
    }
    for (const [id, list] of agentAlerts) for (const a of list) seen.set(alertKey('agent', id, a), { level: a.level, size: 0 });
    for (const [id, list] of roomAlerts) for (const a of list) seen.set(alertKey('room', id, a), { level: a.level, size: 0 });
    return seen;
  }

  /** lo que se descarta y se restaura junto con un hallazgo: sus alertas cubiertas y sus miembros */
  private childrenOf(key: string, listed: readonly Scored[]): string[] {
    const f = listed.find((x) => findingKey(x.id) === key);
    return f ? [...coveredAlertKeys(f), ...(f.members ?? []).map(findingKey)] : [];
  }

  /** la peor alerta no descartada de cada agente o sala */
  private visibleAlerts(scope: AlertScope, all: ReadonlyMap<string, readonly LiveAlert[]>): Map<string, LiveAlert> {
    const out = new Map<string, LiveAlert>();
    for (const [id, list] of all) {
      const alert = worst(list.filter((a) => !this.dismissed.has(alertKey(scope, id, a))));
      if (alert) out.set(id, alert);
    }
    return out;
  }

  private alertLevel(live: LiveState, key: string): LiveAlert['level'] | null {
    for (const [scope, all] of [['agent', live.agentAlerts], ['room', live.roomAlerts]] as const) {
      for (const [id, list] of all) for (const a of list) if (alertKey(scope, id, a) === key) return a.level;
    }
    return null;
  }

  /**
   * Items de la bandeja en el orden de la lista 'live': primero los hallazgos (criticos y avisos; los info no
   * entran) y despues las alertas vivas que ningun hallazgo cuenta. `dismissed` = vivos pero ocultos.
   */
  private inboxItems(live: LiveState): { items: InboxItem[]; dismissed: number } {
    const items: InboxItem[] = [];
    const covered = new Set<string>();
    let dismissed = 0;
    for (const f of live.listed) {
      for (const k of coveredAlertKeys(f)) covered.add(k);
      if (f.severity === 'info') continue;
      const key = findingKey(f.id);
      if (this.dismissed.has(key)) {
        dismissed++;
        continue;
      }
      items.push({
        key,
        level: f.severity,
        roomId: f.roomId,
        roomTitle: f.roomTitle,
        projectName: f.projectName,
        agentName: f.agentId !== null && f.agentId !== f.roomId ? f.agentName : null,
        title: f.title,
        instruction: f.copyText || f.recommendation,
      });
    }
    const add = (scope: AlertScope, id: string, a: LiveAlert): void => {
      const key = alertKey(scope, id, a);
      if (covered.has(key)) return;
      if (this.dismissed.has(key)) {
        dismissed++;
        return;
      }
      const agent = scope === 'agent' ? live.agents.get(id) : undefined;
      const roomId = agent?.roomId ?? id;
      const room = live.rooms.get(roomId);
      items.push({
        key,
        level: a.level,
        roomId,
        roomTitle: room?.title ?? roomId,
        projectName: room?.projectName ?? '',
        agentName: agent?.name ?? null,
        title: a.title,
        instruction: a.ruleId ? ruleInstruction(a.ruleId) : ERRORS_INSTRUCTION,
      });
    };
    for (const [id, list] of live.agentAlerts) for (const a of list) add('agent', id, a);
    for (const [id, list] of live.roomAlerts) for (const a of list) add('room', id, a);
    return { items, dismissed };
  }

  /** abiertas + con actividad hoy, sin las archivadas (sin actividad posterior) ni las eliminadas */
  private liveSessions(now: number): string[] {
    const ids = new Set(this.facts.sessionsActiveSince(startOfLocalDay(now)));
    for (const id of this.openIds?.() ?? []) ids.add(id);
    const hidden = this.facts.hiddenSessions();
    return [...ids].filter((id) => !hidden.has(id)).sort();
  }

  private evaluate(sessionIds: readonly string[], since: number, now: number): Evaluation {
    const f = this.facts;
    const sessions = f.sessionInfo(sessionIds);
    const agents = f.agents(sessionIds, since);
    const scope: Scope = { sessions: sessionIds, agents: agents.map((a) => a.agent_id), since };
    const book = detect.buildBook(agents, f.usage(scope, LIMITS.bigContext));
    const stats = f.actionStats(scope);
    const files = f.fileActions(scope);
    const events = f.events(sessionIds);
    const open = this.openIds?.() ?? null;
    const midnight = startOfLocalDay(now);
    // la sesion sigue abierta (sin registro: con actividad hoy)
    const isOpen = (s: SessionInfoRow): boolean => (open ? open.has(s.session_id) : (s.last_activity_at ?? 0) >= midnight);

    const compacts = events.filter((e) => e.kind === 'compact');
    const compactsByAgent = tsBy(compacts, (e) => e.agent_id, (e) => e.ts);
    const leadCompacts = tsBy(compacts.filter((e) => e.agent_id === e.session_id), (e) => e.session_id, (e) => e.ts);

    // turnos del lead: los cerrados (tasks) + el abierto
    const turns = new Map<string, TurnSpan[]>();
    for (const [id, rows] of groupBy(f.leadTurns(sessionIds), (t) => t.session_id)) {
      turns.set(id, rows.map((t) => ({ start: t.started_at, end: t.ended_at })));
    }
    for (const s of sessions) {
      const start = s.last_prompt_at;
      if (s.turn_open !== 1 || start === null) continue;
      const list = turns.get(s.session_id) ?? [];
      if (list.some((t) => t.start === start)) continue;
      list.push({ start, end: null });
      list.sort((a, b) => a.start - b.start);
      turns.set(s.session_id, list);
    }
    // el turno abierto puede haber empezado antes de la ventana: sus lanzamientos cuentan igual
    const openStarts = [...turns.values()].flat().filter((t) => t.end === null).map((t) => t.start);
    const launchRows = f.leadLaunches(sessionIds, Math.min(since, ...openStarts));
    const launches = tsBy(launchRows, (l) => l.session_id, (l) => l.started_at);

    // solo las sesiones abiertas pueden compactar: en las cerradas ni se consulta
    const leads = sessions.map((s): detect.LeadCompactState => {
      if (!isOpen(s)) return { sessionId: s.session_id, open: false, calls: 0, recent: [] };
      const after = Math.max(0, ...(leadCompacts.get(s.session_id) ?? []));
      const calls = f.callsAfter(s.session_id, after);
      const recent = calls >= LIMITS.compactCalls ? f.lastContexts(s.session_id, after, LIMITS.compactRecent) : [];
      return { sessionId: s.session_id, open: true, calls, recent };
    });

    const loopLimit = this.rules.value('loop_repeats');
    const loopThreshold = loopLimit ?? RULE_DEFS.loop_repeats.floor;
    const dayCosts = f.dayCosts(sessionIds, since);
    const runs = f.runs(sessionIds, now - TIMING.workflowQuietMs);
    const drafts: Draft[] = [
      ...detect.repeatedReads(files, compactsByAgent, book),
      ...detect.fullReads(files, book),
      ...detect.bigContexts(book),
      ...detect.needsCompact(leads),
      ...detect.loops(f.streaks(scope, loopThreshold), book, loopThreshold, loopLimit !== null),
      ...detect.sameErrors(f.errorGroups(scope, LIMITS.sameErrors), book),
      ...detect.expensiveModels(stats, book),
      ...detect.lowCache(book, f.pauses(scope, LIMITS.cachePauseMs)),
      ...detect.longOutputs(f.longOutputs(scope, LIMITS.longOutput, LIMITS.longOutputKeep), book),
      ...detect.idleNoChanges(stats, book),
      // mcp_unused (MCP cargado sin uso) no se muestra (decision de producto); el detector queda en detectors.ts
      ...detect.dupInstructions(events, book),
      ...detect.discarded(f.discarded(sessionIds, since)),
    ];
    for (const id of RULE_IDS) {
      const limit = this.rules.value(id);
      if (limit === null) continue;
      switch (id) {
        case 'agent_cost': {
          const subs = agents.filter((a) => a.kind === 'subagent').map((a) => a.agent_id);
          drafts.push(...detect.agentCostRule(book, limit, f.lifeCosts(subs)));
          break;
        }
        case 'session_day_cost':
          drafts.push(...detect.sessionDayCostRule(dayCosts, limit));
          break;
        case 'workflow_cost':
          drafts.push(...detect.workflowCostRule(runs, limit, since));
          break;
        case 'turns_without_compact':
          drafts.push(...detect.turnsWithoutCompactRule(turns, leadCompacts, since, limit));
          break;
        case 'subagents_per_turn':
          drafts.push(...detect.subagentsPerTurnRule(turns, launches, since, limit));
          break;
        case 'loop_repeats':
          // va dentro del hallazgo 'loop' (critico y con ruleId) para no contar dos veces lo mismo
          break;
      }
    }

    // el lead trabaja: en una sesion abierta con registro, segun su status (como OfficeBuilder); si no, con el
    // turno abierto y actividad reciente
    const busy = this.busyIds?.() ?? null;
    const leadWorking = new Set<string>();
    for (const s of sessions) {
      const working =
        busy && open?.has(s.session_id)
          ? busy.has(s.session_id)
          : s.turn_open === 1 && (s.last_activity_at ?? 0) >= now - TIMING.leadActiveWindowMs;
      if (working) leadWorking.add(s.session_id);
    }

    const findings = this.decorate(drafts, sessions, book, isOpen);
    return { findings, sessions, agents, dayCosts, runs, turns, leadCompacts, launches, leadWorking };
  }

  private decorate(
    drafts: readonly Draft[],
    sessions: readonly SessionInfoRow[],
    book: AgentBook,
    isOpen: (s: SessionInfoRow) => boolean,
  ): Scored[] {
    const rooms = new Map(sessions.map((s) => [s.session_id, { ...roomLabel(s), live: isOpen(s) }]));
    const out = drafts.map((d): Scored => {
      const { at, ...rest } = d;
      const room = rooms.get(d.roomId);
      const agent = d.agentId !== null ? book.get(d.agentId)?.row : undefined;
      return {
        ...rest,
        roomTitle: room?.title ?? d.roomId,
        projectName: room?.projectName ?? '',
        agentName: agent
          ? (this.personaName?.(agent.agent_id) ?? this.agentName(agent))
          : d.agentId === d.roomId
            ? this.leadName()
            : null,
        detectedAt: iso(at),
        live: room?.live ?? false,
      };
    });
    return sortFindings(out);
  }

  /** agentes trabajando: costo de vida sobre el tope, racha final repetida, o 2+ fallos seguidos (todas) */
  private agentAlerts(ev: Evaluation): Map<string, LiveAlert[]> {
    const out = new Map<string, LiveAlert[]>();
    const working = ev.agents.filter((a) => (a.kind === 'lead' ? ev.leadWorking.has(a.session_id) : a.ended_at === null));
    const costLimit = this.rules.value('agent_cost');
    const loopLimit = this.rules.value('loop_repeats');
    const subs = working.filter((a) => a.kind !== 'lead').map((a) => a.agent_id);
    const costs = costLimit !== null ? this.facts.lifeCosts(subs) : new Map<string, number>();
    for (const a of working) {
      const alerts: LiveAlert[] = [];
      const cost = costs.get(a.agent_id) ?? 0;
      if (costLimit !== null && a.kind !== 'lead' && cost > costLimit) {
        alerts.push({ level: 'critical', title: alertTitles.agentCost(cost, costLimit), source: 'rule', ruleId: 'agent_cost' });
      }
      const tail = this.facts.tail(a.agent_id, TAIL_ACTIONS);
      const repeat = detect.tailRepeat(tail);
      if (loopLimit !== null && repeat && repeat.n >= loopLimit) {
        alerts.push({ level: 'critical', title: alertTitles.loop(repeat.tool, repeat.n), source: 'rule', ruleId: 'loop_repeats' });
      }
      const errors = detect.tailErrors(tail);
      if (errors >= LIMITS.errorsInARow) alerts.push({ level: 'warning', title: alertTitles.errors(errors), source: 'errors' });
      if (alerts.length > 0) out.set(a.agent_id, alerts);
    }
    return out;
  }

  /** salas vivas: costo de hoy, corrida en curso, turnos sin compactar, subagentes del turno abierto (todas) */
  private roomAlerts(ev: Evaluation): Map<string, LiveAlert[]> {
    const out = new Map<string, LiveAlert[]>();
    const dayLimit = this.rules.value('session_day_cost');
    const runLimit = this.rules.value('workflow_cost');
    const turnsLimit = this.rules.value('turns_without_compact');
    const launchLimit = this.rules.value('subagents_per_turn');
    // en la evaluacion viva dayCosts solo trae el dia de hoy
    const today = new Map<string, number>();
    for (const d of ev.dayCosts) today.set(d.session_id, (today.get(d.session_id) ?? 0) + d.cost);
    for (const s of ev.sessions) {
      const id = s.session_id;
      const alerts: LiveAlert[] = [];
      const cost = today.get(id) ?? 0;
      if (dayLimit !== null && cost > dayLimit) {
        alerts.push({ level: 'critical', title: alertTitles.sessionDayCost(cost, dayLimit), source: 'rule', ruleId: 'session_day_cost' });
      }
      if (runLimit !== null) {
        const run = ev.runs
          .filter((r) => r.session_id === id && r.running === 1 && r.cost > runLimit)
          .sort((a, b) => b.cost - a.cost)[0];
        if (run) {
          alerts.push({ level: 'critical', title: alertTitles.workflowCost(run.cost, runLimit), source: 'rule', ruleId: 'workflow_cost' });
        }
      }
      const turns = ev.turns.get(id) ?? [];
      const sinceCompact = detect.turnsSinceCompact(turns, ev.leadCompacts.get(id) ?? []);
      if (turnsLimit !== null && sinceCompact >= turnsLimit) {
        alerts.push({
          level: 'warning',
          title: alertTitles.turnsWithoutCompact(sinceCompact),
          source: 'rule',
          ruleId: 'turns_without_compact',
        });
      }
      // el turno de la DB sigue abierto hasta el proximo prompt: solo cuenta mientras el lead trabaja
      const openTurn = ev.leadWorking.has(id) ? turns.find((t) => t.end === null) : undefined;
      const launched = openTurn ? (detect.launchesPerTurn([openTurn], ev.launches.get(id) ?? [])[0] ?? 0) : 0;
      if (launchLimit !== null && launched > launchLimit) {
        alerts.push({ level: 'warning', title: alertTitles.subagentsPerTurn(launched), source: 'rule', ruleId: 'subagents_per_turn' });
      }
      if (alerts.length > 0) out.set(id, alerts);
    }
    return out;
  }
}
