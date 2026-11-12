// Tablero de fases en la pared del fondo de la sala que corre un flujo (tool Workflow), a la derecha del
// ventanal y sobre la mesa de reunion: un cuadro por fase (hecha, en curso, pendiente, fallo), sin texto.
// El cuadro en curso late; si el lider espera una respuesta por el flujo, la luz de arriba parpadea en
// ambar. Con movimiento reducido todo queda fijo. Sala cerrada: tablero apagado y sin luces.
// Clic (sin arrastrar) = panel de la sala. Sin flujo que mostrar no se dibuja nada.
// El modelo puro esta en flowBoard.ts y la textura en flowBoardTexture.ts. (No se llama FlowBoard.tsx:
// en Windows chocaria en mayusculas con flowBoard.ts.)

import { useEffect, useMemo, useRef } from 'react';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { AdditiveBlending, type BufferGeometry, Color, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { OfficeRoom } from '@shared/contract';
import { useOfficeStore } from '@/state/store';
import { KitGeo } from './builder';
import { reducedMotion } from './characters/motion';
import { BOARD_TEX, boardTiles, flowBoardModel, type TileState } from './flowBoard';
import { boardRect, flowBoardTexture, paintBoard, releaseBoard, retainBoard } from './flowBoardTexture';
import { ROOM_D } from './layout';
import { closedVariant, MAT } from './materials';
import { setSceneCursor } from './sceneEvents';
import { glowTexture } from './textures';
import { useNow } from './useTicker';
import { PAL } from './world/kit';

/**
 * Pared del fondo entre la cortina derecha del ventanal (x 2,59) y el borde abierto de la sala (x 3,6),
 * sobre las sillas de la reunion: desde la camara por defecto nada lo tapa (los respaldos y las cabezas
 * sentadas quedan por debajo de la linea de vista) y no choca con la guirnalda (y >= 1,56).
 */
export const FLOW_BOARD_POS = { x: 3.12, z: -ROOM_D / 2 } as const;
/** cara de la textura (48 x 28 texeles) en coordenadas del tablero, espalda contra la pared en z = 0 */
const FACE = { x0: -0.38, x1: 0.38, y0: 0.92, y1: 0.92 + (0.76 * BOARD_TEX.h) / BOARD_TEX.w, z: 0.036 } as const;
const LAMP = { y: 1.44, z: 0.03 } as const;
export const FLOW_BOARD_NAME = 'flow-board';

const faceMat = new MeshBasicMaterial({ map: flowBoardTexture });
const faceMatClosed = closedVariant(new MeshBasicMaterial({ map: flowBoardTexture }), 'flow-board');
const pulseMat = new MeshBasicMaterial({ color: PAL.cyan, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.3 });
const AMBER = new Color(PAL.amber);
const lampOn = new MeshBasicMaterial({ color: AMBER.clone() });
const lampOff = new MeshBasicMaterial({ color: AMBER.clone().multiplyScalar(0.28) });
const lampGlow = new MeshBasicMaterial({
  map: glowTexture,
  color: PAL.amber,
  blending: AdditiveBlending,
  transparent: true,
  depthWrite: false,
  opacity: 0.6,
});

let frameGeo: BufferGeometry | null = null;

/** marco de metal negro, riel hueso abajo y el soporte de la luz de arriba (la bombilla es aparte) */
function frameGeometry(): BufferGeometry {
  if (frameGeo) return frameGeo;
  const T = new KitGeo(17);
  T.box(FACE.x0 - 0.025, FACE.y0 - 0.025, 0, FACE.x1 + 0.025, FACE.y1 + 0.025, 0.035, 'steel', { top: 0.06 });
  T.box(FACE.x0 - 0.01, FACE.y0 - 0.045, 0, FACE.x1 + 0.01, FACE.y0 - 0.025, 0.05, 'bone');
  T.box(-0.06, FACE.y1 + 0.025, 0, 0.06, FACE.y1 + 0.045, 0.06, 'steel');
  T.box(-0.015, FACE.y1 + 0.045, 0.005, 0.015, LAMP.y - 0.02, 0.025, 'steel');
  frameGeo = T.build();
  return frameGeo;
}

const lampGeo = new PlaneGeometry(0.34, 0.34);
const bulbGeo = new KitGeo(3).box(-0.045, -0.022, -0.025, 0.045, 0.022, 0.025, '#ffffff').build();

/** cuadros en curso, sobre la cara: un plano aditivo encima de cada uno para que lata */
function pulseGeometry(tiles: readonly TileState[]): BufferGeometry | null {
  const rects = boardTiles(tiles.length);
  const T = new KitGeo(5);
  let any = false;
  const sx = (FACE.x1 - FACE.x0) / BOARD_TEX.w;
  const sy = (FACE.y1 - FACE.y0) / BOARD_TEX.h;
  rects.forEach((r, i) => {
    if (tiles[i] !== 'running') return;
    any = true;
    T.qz(FACE.x0 + r.x * sx, FACE.y1 - (r.y + r.h) * sy, FACE.x0 + (r.x + r.w) * sx, FACE.y1 - r.y * sy, FACE.z + 0.003, '#ffffff');
  });
  return any ? T.build() : null;
}

/** latido suave del cuadro en curso y parpadeo de la luz de espera (compartidos por todos los tableros) */
function animateBoards(t: number): void {
  if (reducedMotion()) {
    pulseMat.opacity = 0.28;
    lampOn.color.copy(AMBER);
    lampGlow.opacity = 0.6;
    return;
  }
  pulseMat.opacity = 0.1 + 0.32 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8));
  const on = Math.sin(t * Math.PI * 2 * 1.2) > -0.2 ? 1 : 0.3;
  lampOn.color.copy(AMBER).multiplyScalar(on);
  lampGlow.opacity = 0.65 * on;
}

interface BoardProps {
  roomId: string;
  tiles: TileState[];
  waiting: boolean;
  closed: boolean;
}

function Board({ roomId, tiles, waiting, closed }: BoardProps) {
  const rect = useMemo(() => boardRect(roomId), [roomId]);
  useEffect(() => {
    retainBoard(roomId);
    return () => releaseBoard(roomId);
  }, [roomId]);
  // tiles llega estable (memo por clave): se repinta y se rearma solo cuando cambia algo
  useEffect(() => {
    paintBoard(roomId, { tiles, waiting });
  }, [roomId, tiles, waiting, rect]);
  const face = useMemo(() => (rect ? new KitGeo(5).qz(FACE.x0, FACE.y0, FACE.x1, FACE.y1, FACE.z, '#ffffff', { uvRect: rect }).build() : null), [rect]);
  useEffect(() => () => face?.dispose(), [face]);
  const pulse = useMemo(() => (closed ? null : pulseGeometry(tiles)), [tiles, closed]);
  useEffect(() => () => pulse?.dispose(), [pulse]);
  const hovered = useRef(false);
  useEffect(
    () => () => {
      if (hovered.current) setSceneCursor(false);
    },
    [],
  );

  useFrame(({ clock }) => animateBoards(clock.elapsedTime));

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 6) return;
    e.stopPropagation();
    useOfficeStore.getState().selectRoom(roomId);
  };
  const lit = waiting && !closed;

  return (
    <group
      name={FLOW_BOARD_NAME}
      position={[FLOW_BOARD_POS.x, 0, FLOW_BOARD_POS.z]}
      onClick={onClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        hovered.current = true;
        setSceneCursor(true);
      }}
      onPointerOut={() => {
        hovered.current = false;
        setSceneCursor(false);
      }}
    >
      <mesh geometry={frameGeometry()} material={closed ? MAT.toonClosed : MAT.toon} receiveShadow />
      {face ? <mesh geometry={face} material={closed ? faceMatClosed : faceMat} /> : null}
      {pulse ? <mesh geometry={pulse} material={pulseMat} /> : null}
      <mesh geometry={bulbGeo} material={lit ? lampOn : lampOff} position={[0, LAMP.y, LAMP.z]} />
      {lit ? <mesh geometry={lampGeo} material={lampGlow} position={[0, LAMP.y, LAMP.z + 0.03]} /> : null}
    </group>
  );
}

interface FlowBoardProps {
  room: OfficeRoom;
  closed: boolean;
}

/** tablero de la sala dueña (nunca en un anexo); null sin flujo en curso ni recien terminado */
export function FlowBoard({ room, closed }: FlowBoardProps) {
  const now = useNow();
  const model = useMemo(() => flowBoardModel(room, now), [room, now]);
  // el reloj re-renderiza cada segundo: los cuadros solo cambian de identidad si cambia su contenido
  const tilesKey = model ? model.tiles.join(',') : '';
  const tiles = useMemo(() => (tilesKey ? (tilesKey.split(',') as TileState[]) : []), [tilesKey]);
  if (!model) return null;
  return <Board roomId={room.id} tiles={tiles} waiting={model.waiting} closed={closed} />;
}
