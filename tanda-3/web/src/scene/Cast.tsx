// Personajes en escena: subagentes (entran, pasan por la reunion, van a su lugar, salen) y el lider
// (camina entre salas y, en la suya, queda sentado en el escritorio de lider; el lugar del lider solo cambia
// su pose). Los cambios de lugar de los subagentes que esperan la permanencia minima se aplican en cada frame
// (tickCrew), sin volver a renderizar.

import { useCallback, useMemo, useReducer, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { OfficeRoom, OfficeSnapshot } from '@shared/contract';
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
import { buildOfficeNav, localGround, type OfficeLayout, ROOM_NAV, worldGround } from './layout';

const ORIGIN = { x: 0, z: 0 };

interface CastProps {
  rooms: readonly OfficeRoom[];
  layout: OfficeLayout;
  labels: boolean;
}

export function Subagents({ rooms, layout, labels }: CastProps) {
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
          <Character
            // con la sala en la llave, quien se muda al anexo se monta de nuevo (no arrastra la pose de antes)
            key={`${m.roomId}|${m.actor.id}`}
            actor={m.actor}
            agentType={m.agent.agentType}
            persona={m.agent.persona}
            offset={placement.center}
            ground={localGround}
            selectId={m.agent.id}
            label={labels ? <AgentCard agent={m.agent} /> : null}
            alert={m.agent.status === 'done' ? null : (m.agent.alert?.level ?? null)}
            dim={room ? !room.open : false}
            onGone={onGone}
          />
        );
      })}
    </>
  );
}

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

  return (
    <Character
      actor={ctl.actor}
      agentType="lead"
      offset={ORIGIN}
      ground={ground}
      selectId={lead?.id ?? null}
      label={labels && lead ? <AgentCard agent={lead} /> : null}
      showArrow={false}
      alert={lead?.alert?.level ?? null}
      dim={room ? !room.open : false}
    />
  );
}
