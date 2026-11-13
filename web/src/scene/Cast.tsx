// Personajes en escena: subagentes (entran por el pasillo, caminan directo a su lugar y se sientan, salen)
// y el lider (camina entre salas y, en la suya, queda sentado en el escritorio de lider; su lugar solo cambia
// la pose, y trabajando teclea). Los cambios de lugar de los subagentes que esperan la permanencia minima se aplican en cada frame
// (tickCrew), sin volver a renderizar.

import { memo, useCallback, useMemo, useReducer, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { OfficeAgent, OfficeRoom, OfficeSnapshot } from '@shared/contract';
import type { Actor } from './actors';
import { ownerOf } from './annex';
import { Character } from './Character';
import {
  type Crew,
  createCrew,
  createLead,
  type LeadControl,
  leadActivity,
  reconcileCrew,
  sceneNow,
  syncLead,
  tickCrew,
} from './crew';
import { AgentCard } from './labels';
import { buildOfficeNav, localGround, type OfficeLayout, ROOM_NAV, type Vec2, worldGround } from './layout';

const ORIGIN = { x: 0, z: 0 };

interface CastProps {
  rooms: readonly OfficeRoom[];
  layout: OfficeLayout;
  labels: boolean;
}

/** con memo: si ninguna sala cambio (store: misma identidad), el snapshot nuevo no toca al elenco */
export const Subagents = memo(function Subagents({ rooms, layout, labels }: CastProps) {
  const crewRef = useRef<Crew | null>(null);
  if (!crewRef.current) crewRef.current = createCrew();
  const crew = crewRef.current;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const placed = useMemo(() => new Set(layout.rooms.map((r) => r.id)), [layout]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  // se reconcilia durante el render: es idempotente y asi la etiqueta muestra el snapshot actual
  useMemo(() => reconcileCrew(crew, rooms, placed, ROOM_NAV, sceneNow()), [crew, rooms, placed]);
  useFrame(() => tickCrew(crew, sceneNow()));

  const onGone = useCallback(
    (id: string) => {
      crew.members.delete(id);
      bump();
    },
    [crew],
  );

  return (
    <>
      {[...crew.members.values()].map((m) => {
        const placement = layout.byId.get(m.roomId);
        if (!placement) return null;
        const room = roomById.get(ownerOf(m.roomId));
        return (
          <CrewMemberView
            // con la sala en la llave, quien se muda al anexo se monta de nuevo (no arrastra la pose de antes)
            key={`${m.roomId}|${m.actor.id}`}
            actor={m.actor}
            agent={m.agent}
            offset={placement.center}
            labels={labels}
            dim={room ? !room.open : false}
            onGone={onGone}
          />
        );
      })}
    </>
  );
});

interface CrewMemberViewProps {
  actor: Actor;
  agent: OfficeAgent;
  offset: Vec2;
  labels: boolean;
  dim: boolean;
  onGone: (id: string) => void;
}

/**
 * Un subagente en escena. Con memo y la tarjeta memorizada por agente: un snapshot que no cambia a este agente
 * no lo vuelve a renderizar (ni rehace su etiqueta HTML, que es una raiz de React aparte).
 */
const CrewMemberView = memo(function CrewMemberView({ actor, agent, offset, labels, dim, onGone }: CrewMemberViewProps) {
  const label = useMemo(() => (labels ? <AgentCard agent={agent} /> : null), [labels, agent]);
  return (
    <Character
      actor={actor}
      agentType={agent.agentType}
      persona={agent.persona}
      offset={offset}
      ground={localGround}
      selectId={agent.id}
      label={label}
      alert={agent.status === 'done' ? null : (agent.alert?.level ?? null)}
      dim={dim}
      onGone={onGone}
    />
  );
});

interface LeadAvatarProps {
  layout: OfficeLayout;
  snapshot: OfficeSnapshot;
  labels?: boolean;
}

export function LeadAvatar({ layout, snapshot, labels = false }: LeadAvatarProps) {
  const ctlRef = useRef<LeadControl | null>(null);
  if (!ctlRef.current) ctlRef.current = createLead();
  const ctl = ctlRef.current;
  const graph = useMemo(() => buildOfficeNav(layout), [layout]);
  const roomId = snapshot.leadRoomId !== null && layout.byId.has(snapshot.leadRoomId) ? snapshot.leadRoomId : null;
  const room = roomId ? snapshot.rooms.find((r) => r.id === roomId) : undefined;
  const lead = room?.lead ?? null;
  const wantPlace = lead?.place ?? null;

  // idempotente: solo reacciona si cambio la distribucion, la sala o el lugar del lider
  useMemo(() => syncLead(ctl, layout, graph, roomId, wantPlace), [ctl, layout, graph, roomId, wantPlace]);
  useFrame(() => {
    ctl.actor.activity = leadActivity(ctl, lead);
  });
  ctl.actor.activity = leadActivity(ctl, lead);
  const ground = useCallback((x: number, z: number) => worldGround(layout, x, z), [layout]);
  // misma tarjeta mientras el lider no cambie: Character (memo) no se re-renderiza con cada snapshot
  const label = useMemo(() => (labels && lead ? <AgentCard agent={lead} /> : null), [labels, lead]);

  return (
    <Character
      actor={ctl.actor}
      agentType="lead"
      offset={ORIGIN}
      ground={ground}
      selectId={lead?.id ?? null}
      label={label}
      showArrow={false}
      alert={lead?.alert?.level ?? null}
      dim={room ? !room.open : false}
    />
  );
}
