// Contorno de sala en el piso (que se vea que sala esta abierta en el panel y cual esta bajo
// el puntero, sin texto). Marco pixel alrededor de la losa de la sala y de sus anexos, en el color propio de la
// sala (roomIdentity): esquinas gruesas tipo seleccion de juego y una banda fina entre ellas.
// - Seleccionada (panel abierto): accent con un pulso suave (fijo con movimiento reducido).
// - Hover (lista o escena): el mismo marco, mas tenue y fijo.
// Va sobre la acera de la sala (OfficeBase), fuera de la losa y apenas por encima del cordon y de los charcos de
// luz: no pisa alfombras ni muebles y no escribe profundidad, asi el pase de contorno de PixelPipeline no le dibuja
// tinta. No recibe punteros.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, Float32BufferAttribute, type Mesh, MeshBasicMaterial } from 'three';
import type { OfficeRoom } from '@shared/contract';
import { roomIdentity } from '@/lib/roomIdentity';
import { useOfficeStore } from '@/state/store';
import { ownerOf } from './annex';
import { reducedMotion } from './characters/motion';
import { type OfficeLayout, type Rect, ROOM_FOOTPRINT, type RoomPlacement } from './layout';

/** nombre del grupo del contorno (pruebas y depuracion) */
export const ROOM_HIGHLIGHT_NAME = 'room-highlight';

export type HighlightMode = 'selected' | 'hover';

/** altura sobre la calle: arriba de la acera (0,012), del cordon (0,028) y del charco de las farolas (0,031) */
export const FRAME_LIFT = 0.036;
const LIFT = FRAME_LIFT;
/** separacion entre la losa de la sala y el marco */
const GAP = 0.08;
/** banda fina entre esquinas */
const BAND = 0.07;
/** grosor y largo de cada brazo de las esquinas */
const CORNER = 0.2;
const ARM = 0.95;

/** opacidad del hover y rango del pulso de la seleccionada */
const HOVER_OPACITY = 0.42;
const SELECTED_BASE = 0.78;
const SELECTED_SWING = 0.2;
/** latidos por segundo del pulso */
const PULSE_HZ = 0.55;

const noRaycast = () => {};

function frameMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    fog: false,
  });
}

/**
 * Un material por modo, de por vida (nunca se libera): si cada marco creaba y liberaba el suyo, al pasar el
 * puntero de una sala a otra el programa de la tarjeta grafica se destruia y se volvia a compilar (un tiron
 * visible en equipos sin tarjeta dedicada). Hay a lo sumo un marco por modo a la vez.
 */
const FRAME_MATERIAL: Readonly<Record<HighlightMode, MeshBasicMaterial>> = {
  selected: frameMaterial(),
  hover: frameMaterial(),
};

/** un triangulo sin area: compila el programa del marco en el primer cuadro, sin dibujar nada */
const WARM_GEOMETRY = new BufferGeometry();
WARM_GEOMETRY.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));

/** se dibuja en el primer cuadro (el programa queda compilado durante la carga) y despues se apaga */
function WarmFrameProgram() {
  const mesh = useRef<Mesh>(null);
  const drawn = useRef(false);
  useFrame(() => {
    const m = mesh.current;
    if (!m || !m.visible) return;
    if (drawn.current) m.visible = false;
    drawn.current = true;
  });
  return (
    <mesh
      ref={mesh}
      geometry={WARM_GEOMETRY}
      material={FRAME_MATERIAL.hover}
      frustumCulled={false}
      renderOrder={2}
      raycast={noRaycast}
    />
  );
}

/**
 * Rectangulos del marco alrededor de una sala (coordenadas locales), sin superponerse: con transparencia, dos
 * piezas encimadas se verian mas fuertes en el cruce.
 */
export function frameRects(footprint: Rect = ROOM_FOOTPRINT): Rect[] {
  const x0 = footprint.minX - GAP;
  const x1 = footprint.maxX + GAP;
  const z0 = footprint.minZ - GAP;
  const z1 = footprint.maxZ + GAP;
  const X0 = x0 - CORNER;
  const X1 = x1 + CORNER;
  const Z0 = z0 - CORNER;
  const Z1 = z1 + CORNER;
  return [
    // brazos a lo ancho (con el cuadro de la esquina)
    { minX: X0, maxX: X0 + ARM, minZ: Z0, maxZ: z0 },
    { minX: X1 - ARM, maxX: X1, minZ: Z0, maxZ: z0 },
    { minX: X0, maxX: X0 + ARM, minZ: z1, maxZ: Z1 },
    { minX: X1 - ARM, maxX: X1, minZ: z1, maxZ: Z1 },
    // brazos a lo hondo (sin el cuadro de la esquina)
    { minX: X0, maxX: x0, minZ: z0, maxZ: Z0 + ARM },
    { minX: x1, maxX: X1, minZ: z0, maxZ: Z0 + ARM },
    { minX: X0, maxX: x0, minZ: Z1 - ARM, maxZ: z1 },
    { minX: x1, maxX: X1, minZ: Z1 - ARM, maxZ: z1 },
    // bandas finas entre esquinas
    { minX: X0 + ARM, maxX: X1 - ARM, minZ: z0 - BAND, maxZ: z0 },
    { minX: X0 + ARM, maxX: X1 - ARM, minZ: z1, maxZ: z1 + BAND },
    { minX: x0 - BAND, maxX: x0, minZ: Z0 + ARM, maxZ: Z1 - ARM },
    { minX: x1, maxX: x1 + BAND, minZ: Z0 + ARM, maxZ: Z1 - ARM },
  ];
}

const ROOM_FRAME = frameRects();

/** una malla con el marco de cada lugar del mapa (sala y anexos), mirando hacia arriba */
function frameGeometry(placements: readonly RoomPlacement[]): BufferGeometry {
  const pos: number[] = [];
  for (const p of placements) {
    for (const r of ROOM_FRAME) {
      const ax = p.center.x + r.minX;
      const bx = p.center.x + r.maxX;
      const az = p.center.z + r.minZ;
      const bz = p.center.z + r.maxZ;
      // dos triangulos en sentido antihorario visto desde arriba (+y)
      pos.push(ax, LIFT, az, ax, LIFT, bz, bx, LIFT, bz, ax, LIFT, az, bx, LIFT, bz, bx, LIFT, az);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

interface FrameProps {
  placements: readonly RoomPlacement[];
  accent: string;
  mode: HighlightMode;
}

function Frame({ placements, accent, mode }: FrameProps) {
  const key = placements.map((p) => `${p.id}@${p.center.x},${p.center.z}`).join('|');
  const geometry = useMemo(() => frameGeometry(placements), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const material = FRAME_MATERIAL[mode];
  useEffect(() => () => geometry.dispose(), [geometry]);
  // antes del primer cuadro: el material es del modo y lo pudo usar otra sala con otro color
  useLayoutEffect(() => {
    material.color.set(accent);
  }, [material, accent]);

  useFrame(({ clock }) => {
    if (mode === 'hover') {
      material.opacity = HOVER_OPACITY;
      return;
    }
    const beat = reducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin(clock.elapsedTime * Math.PI * 2 * PULSE_HZ);
    material.opacity = SELECTED_BASE - SELECTED_SWING / 2 + SELECTED_SWING * beat;
  });

  return (
    <mesh
      name={`${ROOM_HIGHLIGHT_NAME}:${mode}`}
      geometry={geometry}
      material={material}
      renderOrder={2}
      raycast={noRaycast}
      userData={{ mode }}
    />
  );
}

interface RoomHighlightProps {
  layout: OfficeLayout;
  rooms: readonly OfficeRoom[];
}

/** lugares del mapa de una sala (la sala y sus anexos); vacio si la sala ya no esta */
function placementsOf(layout: OfficeLayout, roomId: string): RoomPlacement[] {
  return layout.rooms.filter((p) => ownerOf(p.id) === roomId);
}

/** Contorno de la sala seleccionada y de la sala bajo el puntero. Sin sala (o una que ya no esta), nada */
export function RoomHighlight({ layout, rooms }: RoomHighlightProps) {
  const selectedId = useOfficeStore((s) => s.selectedRoomId);
  const hoveredId = useOfficeStore((s) => s.hoveredRoomId);
  const selected = selectedId === null ? null : ownerOf(selectedId);
  const hovered = hoveredId === null ? null : ownerOf(hoveredId);

  const frame = (roomId: string | null, mode: HighlightMode) => {
    if (roomId === null) return null;
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return null;
    const placements = placementsOf(layout, roomId);
    const home = placements.find((p) => p.id === roomId);
    if (!home) return null;
    // sin slot del server (demo), el lugar del mapa: el mismo numero que el cartel de la pared
    const { accent } = roomIdentity(room, home.slot);
    return <Frame key={`${mode}:${roomId}`} placements={placements} accent={accent} mode={mode} />;
  };

  return (
    <group name={ROOM_HIGHLIGHT_NAME}>
      <WarmFrameProgram />
      {frame(selected, 'selected')}
      {hovered !== selected ? frame(hovered, 'hover') : null}
    </group>
  );
}
