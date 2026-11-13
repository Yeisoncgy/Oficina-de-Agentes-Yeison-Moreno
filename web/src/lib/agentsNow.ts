// "Agentes ahora": todos los agentes que trabajan o esperan una respuesta, en una tabla, sin navegar la escena.
// Logica pura: AgentsNowModal la dibuja y web/test/agents-now.test.ts la prueba.
import type { LiveAlert, OfficeAgent, OfficeRoom, OfficeSnapshot } from '@shared/contract';
import { roomsBySlot } from '@/state/notesApi';
import { lookKey } from '@/theme';
import { modelLabel } from './models';
import { agentRole, roomAgents } from './office';
import { roomIdentity } from './roomIdentity';
import { ROLE_LABEL } from './workflows';

/** waiting: espera tu respuesta (AskUserQuestion o ExitPlanMode) · working: trabajando */
export type NowState = 'waiting' | 'working';

export interface NowRow {
  agentId: string;
  roomId: string;
  roomTitle: string;
  roomNumber: number;
  roomAccent: string;
  name: string;
  look: string;
  lead: boolean;
  role: string | null;
  model: string;
  state: NowState;
  alert: LiveAlert | null;
  task: string;
  doing: string;
  /** inicio de la tarea (lead: el turno; subagente: su encargo), para el cronometro */
  since: string | null;
  /** lead: el turno; subagente: toda su vida. null = sin precio conocido */
  costUsd: number | null;
  /** quien lo lanzo (agentId, o el sessionId si fue el lider); null en el lider */
  parentId: string | null;
  /** tamano del contexto de su ultima llamada; null si aun no hizo ninguna */
  contextTokens: number | null;
  /** ultima linea que escribio */
  lastActivityAt: string | null;
  /** desde cuando espera tu respuesta; null si no espera */
  waitingSince: string | null;
}

/** fila del arbol de delegacion: la misma fila con su nivel y lo que lleva toda su rama */
export interface TreeRow extends NowRow {
  depth: number;
  /** agentes activos que cuelgan de el (hijos, nietos...) */
  descendants: number;
  /** su costo + el de toda su rama; null si alguno no tiene precio */
  branchCostUsd: number | null;
}

/** sin escribir nada desde hace mas de esto, un agente que "trabaja" merece una mirada */
export const QUIET_MS = 3 * 60_000;

/** ms sin actividad de un agente que trabaja; null si no aplica o no se sabe */
export function quietMs(row: Pick<NowRow, 'state' | 'lastActivityAt'>, nowMs: number): number | null {
  if (row.state !== 'working' || !row.lastActivityAt) return null;
  const last = Date.parse(row.lastActivityAt);
  if (Number.isNaN(last)) return null;
  const ms = nowMs - last;
  return ms >= QUIET_MS ? ms : null;
}

/**
 * Arbol de delegacion: por sala, el lider arriba y debajo los agentes que lanzo, cada uno con los suyos.
 * Un agente cuyo padre ya no esta a la vista cuelga del lider de su sala (o queda arriba si el lider no trabaja).
 */
export function agentsTree(rows: readonly NowRow[]): TreeRow[] {
  const byRoom = new Map<string, NowRow[]>();
  for (const r of rows) {
    const list = byRoom.get(r.roomId);
    if (list) list.push(r);
    else byRoom.set(r.roomId, [r]);
  }
  const rooms = [...byRoom.values()].sort((a, b) => (a[0]?.roomNumber ?? 0) - (b[0]?.roomNumber ?? 0));
  const out: TreeRow[] = [];
  for (const list of rooms) {
    const ids = new Set(list.map((r) => r.agentId));
    const lead = list.find((r) => r.lead) ?? null;
    const parentOf = (r: NowRow): string | null => {
      if (r.lead) return null;
      if (r.parentId && r.parentId !== r.agentId && ids.has(r.parentId)) return r.parentId;
      return lead ? lead.agentId : null;
    };
    const children = new Map<string | null, NowRow[]>();
    for (const r of list) {
      const key = parentOf(r);
      const c = children.get(key);
      if (c) c.push(r);
      else children.set(key, [r]);
    }
    const visit = (r: NowRow, depth: number, seen: Set<string>): TreeRow[] => {
      if (seen.has(r.agentId)) return [];
      seen.add(r.agentId);
      const below = (children.get(r.agentId) ?? []).flatMap((c) => visit(c, depth + 1, seen));
      let branch: number | null = r.costUsd;
      for (const b of below) {
        if (b.depth !== depth + 1) continue;
        branch = branch === null || b.branchCostUsd === null ? null : branch + b.branchCostUsd;
      }
      return [{ ...r, depth, descendants: below.length, branchCostUsd: branch }, ...below];
    };
    const seen = new Set<string>();
    for (const root of children.get(null) ?? []) out.push(...visit(root, 0, seen));
  }
  return out;
}

export interface NowView {
  rows: NowRow[];
  working: number;
  waiting: number;
  /** suma de lo que tiene precio */
  costUsd: number;
  /** filas sin precio (no entran a costUsd) */
  unpriced: number;
}

function nowState(agent: OfficeAgent, room: OfficeRoom): NowState | null {
  if (agent.place === 'door' && room.open) return 'waiting';
  return agent.status === 'working' ? 'working' : null;
}

function doingText(agent: OfficeAgent, state: NowState): string {
  if (state === 'waiting') return 'Espera tu respuesta';
  return agent.action?.label ?? 'Pensando';
}

const RANK: Record<NowState, number> = { waiting: 0, working: 1 };

/** Espera tu respuesta primero, luego las alertas, luego por numero de sala con el lider arriba */
export function agentsNow(snapshot: OfficeSnapshot | null): NowView {
  const view: NowView = { rows: [], working: 0, waiting: 0, costUsd: 0, unpriced: 0 };
  if (!snapshot) return view;
  roomsBySlot(snapshot.rooms).forEach((room, index) => {
    const identity = roomIdentity(room, index);
    for (const agent of roomAgents(room)) {
      const state = nowState(agent, room);
      if (!state) continue;
      const role = agentRole(agent);
      view.rows.push({
        agentId: agent.id,
        roomId: room.id,
        roomTitle: room.title,
        roomNumber: identity.number,
        roomAccent: identity.accent,
        name: agent.displayName,
        look: lookKey(agent),
        lead: agent.kind === 'lead',
        role: role ? ROLE_LABEL[role] : null,
        model: modelLabel(agent.model),
        state,
        alert: agent.alert ?? null,
        task: agent.task?.title || agent.workflow?.label || 'Sin tarea asignada',
        doing: doingText(agent, state),
        since: agent.task?.startedAt ?? agent.startedAt ?? null,
        costUsd: agent.costUsd,
        parentId: agent.kind === 'lead' ? null : (agent.parentId ?? null),
        contextTokens: agent.context?.tokens ?? null,
        lastActivityAt: agent.lastActivityAt ?? null,
        waitingSince: agent.waitingSince ?? null,
      });
      if (state === 'waiting') view.waiting += 1;
      else view.working += 1;
      if (agent.costUsd === null) view.unpriced += 1;
      else view.costUsd += agent.costUsd;
    }
  });
  view.rows = view.rows
    .map((row, order) => ({ row, order }))
    .sort((a, b) => {
      const byState = RANK[a.row.state] - RANK[b.row.state];
      if (byState !== 0) return byState;
      const byAlert = (b.row.alert ? 1 : 0) - (a.row.alert ? 1 : 0);
      return byAlert !== 0 ? byAlert : a.order - b.order;
    })
    .map((e) => e.row);
  return view;
}
