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
