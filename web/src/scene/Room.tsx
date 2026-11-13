// Una sala = una sesion de Claude Code, armada con el Kit 3D: paredes con papel tapiz y zocalo, ventanal
// con el cielo vivo, reloj con la hora, cartel sobre la puerta, alfombra, 7 puestos, las zonas (banco,
// estanteria, cafe, reunion, revision) y una de tres decoraciones (Biblioteca, Taller, Cafeteria) elegida
// por hash del id. Uno de tres estilos (Loft, Japandi, Synthwave; world/themes.ts) segun el lugar de la
// sala en el mapa. Una luz puntual por sala, del color del estilo.
// Cerrada: luz apagada, colores apagados, pantallas negras y el cartel dice CERRADA.
// Alerta de la sala: la misma luz se tine de rojo y late; el rotulo lleva la insignia. Sin el usuario en la
// sala, si el lider espera una respuesta (place 'door') o tiene una alerta viva (bucle, errores), el rotulo
// lo dice y su escritorio tiene halo.
// Anexo (annex >= 1): la misma sala para los puestos 7 en adelante, sin lider (escritorio apagado, nada
// suyo en el rotulo) y con la decoracion de su sala.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Color, type Material, type PointLight } from 'three';
import type { LiveAlert, OfficeAgent, OfficeRoom } from '@shared/contract';
import { roomStats } from '@/lib/office';
import { type RoomIdentity, roomIdentity } from '@/lib/roomIdentity';
import { useOfficeStore } from '@/state/store';
import { STATE } from '@/theme';
import { annexIndexOf, localDesk, ownerOf } from './annex';
import { KitGeo } from './builder';
import { Desk, type DeskHalo, screenModeOf } from './Desk';
import { FlowBoard } from './PhaseBoard';
import { AgentCard, RoomPlaque } from './labels';
import { DESK_COLS_X, DESKS, PLATFORM_H, PROPS, ROOM_D, type RoomPlacement } from './layout';
import { MAT } from './materials';
import { fastRaycast, prepareRaycast } from './raycast';
import { markRoomDoubleClick } from './sceneEvents';
import { releaseSign, retainSign, signRect } from './textures';
import { AMBIENT } from './world/ambient';
import { decorOf, LAMP_LIGHT } from './world/kit';
import { SIGN_FACE } from './world/pieces';
import { roomGeometry } from './world/room';
import { DoorLeaf, Dust, Foliage, LightPools, Steam, StringLights } from './world/RoomLife';
import { type FloorKind, type ThemeId, THEMES, themeOfSlot } from './world/themes';

export const LOBBY_ID = '__lobby__';

/** rotulo de la sala: franja de piso entre la fila de adelante y el borde, centrado bajo los escritorios */
const TAG_X = DESK_COLS_X[1];
const TAG_Z = ROOM_D / 2 - 0.42;

/** ocupante de cada puesto de la sala o de su anexo: el activo manda sobre el que ya termino. El lider solo en la sala */
function deskOccupants(room: OfficeRoom | null, annex: number): Map<number, OfficeAgent> {
  const map = new Map<number, OfficeAgent>();
  if (!room) return map;
  if (annex === 0) map.set(0, room.lead);
  for (const a of room.subagents) {
    if (a.deskIndex < 1 || annexIndexOf(a.deskIndex) !== annex) continue;
    const desk = localDesk(a.deskIndex);
    if (desk < 1) continue;
    const current = map.get(desk);
    if (!current || (current.status === 'done' && a.status !== 'done')) map.set(desk, a);
  }
  return map;
}

/** la sala vista desde un lugar del mapa: solo los subagentes de ese anexo (la sala lleva tambien a los sin puesto) */
function annexView(room: OfficeRoom | null, annex: number): OfficeRoom | null {
  if (!room) return null;
  const subagents = room.subagents.filter((a) => annexIndexOf(a.deskIndex) === annex);
  return subagents.length === room.subagents.length ? room : { ...room, subagents };
}

/** "Anexo" (el primero) o "Anexo 2" */
function annexLabel(annex: number): string {
  return annex > 1 ? `Anexo ${annex}` : 'Anexo';
}

export interface PlaqueSignals {
  alert: LiveAlert | null;
  /** alerta viva del lider; solo sin el usuario en la sala (con el, la lleva su personaje) */
  leadAlert: LiveAlert | null;
  /** el lider espera una respuesta (pregunta o plan sin responder) y el usuario no esta en la sala */
  waiting: boolean;
}

/** lo que anuncia el rotulo de la sala; cerrada o lobby, nada. Un anexo no tiene lider: nada suyo */
export function plaqueSignals(room: OfficeRoom | null, leadHere: boolean, annex = 0): PlaqueSignals {
  if (!room || !room.open) return { alert: null, leadAlert: null, waiting: false };
  const onPlaque = annex === 0 && !leadHere && room.lead.status !== 'done';
  return {
    alert: room.alert ?? null,
    leadAlert: onPlaque ? (room.lead.alert ?? null) : null,
    waiting: onPlaque && room.lead.place === 'door',
  };
}

const ALERT_COLOR = new Color(STATE.error);
const LIGHT_COLOR: Readonly<Record<ThemeId, Color>> = {
  loft: new Color(THEMES.loft.light),
  japandi: new Color(THEMES.japandi.light),
  synth: new Color(THEMES.synth.light),
};

const FLOOR_MAT: Readonly<Record<FloorKind, { open: Material; closed: Material }>> = {
  cement: { open: MAT.cement, closed: MAT.cementClosed },
  sand: { open: MAT.sand, closed: MAT.sandClosed },
  grid: { open: MAT.grid, closed: MAT.gridClosed },
};
/** latido de la alerta: critica mas rapido y mas roja */
const ALERT_BEAT: Readonly<Record<LiveAlert['level'], { hz: number; tint: number }>> = {
  warning: { hz: 0.6, tint: 0.45 },
  critical: { hz: 1.1, tint: 0.7 },
};

/**
 * La unica luz puntual de la sala abierta, con intensidad animada. Con alerta se tine de rojo y late (con movimiento reducido queda tenida, sin latir).
 */
/** trabajando la sala se ve mas encendida y en calma un poco mas baja: el estado se lee de lejos, sin texto */
const BUSY_GAIN = 1.2;
const CALM_GAIN = 0.8;

const RoomLight = memo(function RoomLight({
  closed,
  busy,
  alert,
  theme,
}: {
  closed: boolean;
  busy: boolean;
  alert: LiveAlert['level'] | null;
  theme: ThemeId;
}) {
  const light = useRef<PointLight>(null);
  useFrame(() => {
    const l = light.current;
    if (!l) return;
    const lamp = LIGHT_COLOR[theme];
    const base = closed ? 0 : LAMP_LIGHT.intensity * Math.PI * AMBIENT.lamp * AMBIENT.lampI * (busy ? BUSY_GAIN : CALM_GAIN);
    if (!alert || closed) {
      l.color.copy(lamp);
      l.intensity = base;
      return;
    }
    const beat = ALERT_BEAT[alert];
    const pulse = AMBIENT.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(AMBIENT.t * Math.PI * 2 * beat.hz);
    l.color.copy(lamp).lerp(ALERT_COLOR, beat.tint * (0.6 + 0.4 * pulse));
    // con la lampara apagada (de dia) la alerta igual se ve: un minimo que sube con cada latido
    l.intensity = Math.max(base, LAMP_LIGHT.intensity * Math.PI * 0.35) * (0.85 + 0.3 * pulse);
  });
  const [x, y, z] = LAMP_LIGHT.pos;
  // cada luz puntual montada se calcula en todos los pixeles de la escena: la de una sala cerrada (apagada)
  // no se monta. El precio es recompilar materiales cuando una sala abre o cierra, que pasa pocas veces
  if (closed) return null;
  return <pointLight ref={light} position={[x, y, z]} color={THEMES[theme].light} intensity={0} distance={LAMP_LIGHT.distance} decay={LAMP_LIGHT.decay} />;
});

/** cara del cartel de sala con su texto (region propia en el atlas de carteles) */
const SignFace = memo(function SignFace({ title, subtitle, closed }: { title: string; subtitle: string; closed: boolean }) {
  const sign = useMemo(() => signRect(title, subtitle, closed), [title, subtitle, closed]);
  useEffect(() => {
    retainSign(sign.key);
    return () => releaseSign(sign.key);
  }, [sign.key]);
  const geometry = useMemo(() => {
    const f = SIGN_FACE;
    return new KitGeo(5).qz(f.x0, f.y0, f.x1, f.y1, f.z, '#ffffff', { uvRect: sign.rect }).build();
  }, [sign.rect]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      material={closed ? MAT.signClosed : MAT.sign}
      position={[PROPS.sign.x, PROPS.sign.y, PROPS.sign.z]}
      rotation={[0, Math.PI / 2, 0]}
      receiveShadow
    />
  );
});

const TAG_POS: [number, number, number] = [TAG_X, 0.02, TAG_Z];
const TAG_Z_RANGE: [number, number] = [9, 5];

interface RoomTagProps {
  title: string;
  subtitle: string | null;
  closed: boolean;
  busy: boolean;
  lastActivityAt: string | null;
  alert: LiveAlert | null;
  leadAlert: LiveAlert | null;
  waiting: boolean;
  identity: RoomIdentity | undefined;
  selected: boolean;
  onFocus: () => void;
}

/**
 * Rotulo de la sala (etiqueta HTML). Con memo y props estables: drei <Html> vuelve a pintar su raiz de React en
 * cada render, asi que solo se renderiza cuando cambia algo del rotulo, no con cada snapshot.
 */
const RoomTag = memo(function RoomTag(props: RoomTagProps) {
  return (
    // en el piso, delante de los escritorios: no tapa la sala de atras ni a nadie trabajando
    <Html position={TAG_POS} zIndexRange={TAG_Z_RANGE} pointerEvents="none" wrapperClass="ofc-anchor">
      <RoomPlaque {...props} />
    </Html>
  );
});

interface RoomViewProps {
  placement: RoomPlacement;
  /** null = lobby (no hay salas hoy) */
  room: OfficeRoom | null;
  /** compatibilidad: el encendido de lamparas sigue al ambiente global con la transicion de D5 */
  lampsOn?: boolean;
  labels: boolean;
  /** el personaje del lider esta (o va) en esta sala: la etiqueta del lider la lleva el, no el escritorio */
  leadHere?: boolean;
  /** 0 = la sala; >= 1 = su anexo (sin lider; ver annex.ts) */
  annex?: number;
}

/** con memo: el snapshot nuevo solo re-renderiza las salas que cambiaron (store: misma identidad si no) */
export const RoomView = memo(function RoomView({ placement, room, labels, leadHere = false, annex = 0 }: RoomViewProps) {
  const closed = room ? !room.open : false;
  const occupants = useMemo(() => deskOccupants(room, annex), [room, annex]);
  const view = useMemo(() => annexView(room, annex), [room, annex]);
  const leadId = annex === 0 ? (room?.lead.id ?? null) : null;
  // sin el usuario en la silla, la tarjeta del lider solo aparece al pasar el puntero o al elegirlo
  const leadShown = useOfficeStore((s) => leadId !== null && (s.hoveredAgentId === leadId || s.selectedAgentId === leadId));
  // el anexo lleva la decoracion, la alfombra y el estilo de su sala (el estilo sale del lugar de la sala)
  const { decor, rug } = decorOf(ownerOf(placement.id));
  const theme = themeOfSlot(room?.slot ?? placement.slot);
  const geo = roomGeometry(decor, rug, theme);
  const m = geo.meshes;
  // el rayo del puntero cruza esta malla en cada movimiento: su arbol de cajas se arma en un momento libre
  useEffect(() => prepareRaycast(m.toon), [m.toon]);
  const placementId = placement.id;
  const roomId = room?.id ?? null;
  // numero y color de la sala, iguales en la lista y el panel (el anexo lleva los de su sala)
  const identitySlot = room ? (room.slot ?? placement.slot) : null;
  const identity = useMemo(() => (identitySlot === null ? undefined : roomIdentity({ slot: identitySlot })), [identitySlot]);
  const selected = useOfficeStore((s) => roomId !== null && s.selectedRoomId === roomId);

  // manejadores estables: con la sala re-renderizada, R3F no tiene que volver a enganchar los eventos
  const onDoubleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      markRoomDoubleClick();
      useOfficeStore.getState().focusRoom(placementId);
    },
    [placementId],
  );

  // un clic (sin arrastrar la camara) abre el panel de la sala; el anexo abre el de su sala. Agentes y
  // escritorios ocupados cortan el evento antes y abren el suyo
  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!roomId || e.delta > 6) return;
      e.stopPropagation();
      useOfficeStore.getState().selectRoom(roomId);
    },
    [roomId],
  );

  // el puntero sobre la sala (o su anexo) la resalta tambien en la lista; sin cursor de mano: el piso es
  // casi toda la escena y arrastrar para panear es lo normal
  const onPointerOver = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!roomId) return;
      e.stopPropagation();
      useOfficeStore.getState().hoverRoom(roomId);
    },
    [roomId],
  );
  const onPointerOut = useCallback(() => {
    if (roomId) useOfficeStore.getState().hoverRoom(null, roomId);
  }, [roomId]);

  // el rotulo lleva la camara y abre el panel de la sala, igual que la lista
  const onFocus = useCallback(() => {
    useOfficeStore.getState().focusRoom(placementId);
    if (roomId) useOfficeStore.getState().selectRoom(roomId);
  }, [placementId, roomId]);

  const subtitle = room ? (room.projectName !== room.title ? room.projectName : null) : 'Sin agentes trabajando hoy';
  const signTitle = room ? (annex > 0 ? annexLabel(annex) : `Sala ${placement.slot + 1}`) : 'Lobby';
  const signSub = room ? room.projectName : 'Sin agentes';
  const plaqueTitle = room ? (annex > 0 ? `${annexLabel(annex)} · ${room.title}` : room.title) : 'Lobby';
  // un anexo solo se ve trabajando si trabaja alguien suyo
  const busy = !room ? false : annex > 0 ? (view?.subagents.some((a) => a.status === 'working') ?? false) : room.busy || roomStats(room).working > 0;
  // sin el usuario en la sala, la espera y la alerta del lider se anuncian en el rotulo (nunca en un anexo)
  const { alert: roomAlert, leadAlert, waiting } = plaqueSignals(room, leadHere, annex);

  // tarjeta del lider en su escritorio: la misma mientras el lider no cambie (Desk tiene memo)
  const lead = room?.lead ?? null;
  const leadCard = useMemo(
    () => (labels && lead && annex === 0 && !leadHere && leadShown ? <AgentCard agent={lead} /> : null),
    [labels, lead, annex, leadHere, leadShown],
  );

  const haloOf = (index: number, occupant: OfficeAgent | undefined): DeskHalo => {
    if (closed || !occupant || occupant.status === 'done') return null;
    if (occupant.alert) return 'alert';
    return index === 0 && waiting ? 'waiting' : null;
  };

  return (
    <group position={[placement.center.x, PLATFORM_H, placement.center.z]}>
      {m.toon ? (
        <mesh
          geometry={m.toon}
          material={closed ? MAT.toonClosed : MAT.toon}
          castShadow
          receiveShadow
          raycast={fastRaycast}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ) : null}
      {m.brick ? <mesh geometry={m.brick} material={closed ? MAT.brickClosed : MAT.brick} castShadow receiveShadow /> : null}
      {m.lit ? <mesh geometry={m.lit} material={closed ? MAT.litClosed : MAT.lit} receiveShadow /> : null}
      {m.floor ? (
        <mesh
          geometry={m.floor}
          material={closed ? FLOOR_MAT[theme.floor].closed : FLOOR_MAT[theme.floor].open}
          receiveShadow
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ) : null}
      {m.sky ? <mesh geometry={m.sky} material={closed ? MAT.skyClosed : MAT.sky} /> : null}
      {m.bulb ? <mesh geometry={m.bulb} material={closed ? MAT.bulbDark : MAT.bulbLit} /> : null}
      {m.glowLamp && !closed ? <LightPools geometry={m.glowLamp} kind="lamp" /> : null}
      {m.moon && !closed ? <LightPools geometry={m.moon} kind="moon" /> : null}
      <StringLights geometry={geo.stringLights} closed={closed} />
      <Foliage geometry={geo.foliage} closed={closed} />
      <Steam sources={geo.steam} closed={closed} />
      <Dust closed={closed} cones={geo.cones} />
      <DoorLeaf worldX={placement.center.x} worldZ={placement.center.z} closed={closed} theme={theme} />
      <SignFace title={signTitle} subtitle={signSub} closed={closed} />
      <RoomLight closed={closed} busy={busy} alert={roomAlert?.level ?? null} theme={theme.id} />
      {room && annex === 0 ? <FlowBoard room={room} closed={closed} /> : null}
      {DESKS.map((spec) => {
        const occupant = occupants.get(spec.index);
        return (
          <Desk
            key={spec.index}
            spec={spec}
            screen={screenModeOf(occupant, closed)}
            closed={closed}
            selectId={occupant?.id ?? null}
            label={spec.kind === 'lead' ? leadCard : null}
            halo={haloOf(spec.index, occupant)}
          />
        );
      })}
      {labels ? (
        <RoomTag
          title={plaqueTitle}
          subtitle={subtitle}
          closed={closed}
          busy={busy}
          lastActivityAt={room?.lastActivityAt ?? null}
          alert={roomAlert}
          leadAlert={leadAlert}
          waiting={waiting}
          identity={identity}
          selected={selected}
          onFocus={onFocus}
        />
      ) : null}
    </group>
  );
});
