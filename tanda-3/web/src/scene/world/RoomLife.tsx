// Microdetalles de vida que no dependen de personajes (D1 / D5): plantas que se mecen, vapor de las
// tazas y la cafetera, polvo que flota en los conos de las lamparas y en el haz del ventanal, guirnalda
// que respira y la puerta que se abre al paso. Cada uno es 1 draw call y se anima sin asignaciones por frame.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, Color, Float32BufferAttribute, type Group, type Mesh, type Points } from 'three';
import { DOOR, PROPS, ROOM_D, ROOM_W, WALL_T } from '../layout';
import { MAT } from '../materials';
import { AMBIENT } from './ambient';
import { DOOR_CLOSED, DOOR_OPEN, walkerOpen } from './doors';
import { hash1, PAL } from './kit';
import { DOOR_W, doorLeafGeometry } from './pieces';
import type { RoomTheme } from './themes';
import type { LightCone } from './room';

const HW = ROOM_W / 2;
const HD = ROOM_D / 2;

// ---------------------------------------------------------------- plantas

/** follaje fusionado de una sala o de los pasillos: el vaiven de cada planta lo hace el shader (MAT.foliage) */
export function Foliage({ geometry, closed }: { geometry: BufferGeometry | null; closed: boolean }) {
  if (!geometry) return null;
  return <mesh geometry={geometry} material={closed ? MAT.foliageClosed : MAT.foliage} castShadow receiveShadow />;
}

// ---------------------------------------------------------------- vapor

const STEAM_PER_SOURCE = 6;
const steamColor = new Color(PAL.cream);

/** vapor de tazas y cafetera: 6 particulas por fuente, 2,2 s de vida, sube 0,35 con vaiven de 0,03 */
export function Steam({ sources, closed }: { sources: readonly [number, number, number][]; closed: boolean }) {
  const geometry = useMemo(() => {
    const n = Math.max(1, sources.length * STEAM_PER_SOURCE);
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  }, [sources]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const points = useRef<Points>(null);

  useFrame(() => {
    const pts = points.current;
    if (!pts) return;
    const off = closed || AMBIENT.reduced;
    pts.visible = !off && sources.length > 0;
    if (!pts.visible) return;
    const t = AMBIENT.t;
    const P = geometry.getAttribute('position');
    const C = geometry.getAttribute('color');
    for (let si = 0; si < sources.length; si++) {
      const s = sources[si];
      if (!s) continue;
      for (let j = 0; j < STEAM_PER_SOURCE; j++) {
        const i = si * STEAM_PER_SOURCE + j;
        const life = (((t * 0.45 + j / STEAM_PER_SOURCE + si * 0.37) % 1) + 1) % 1;
        P.setXYZ(i, s[0] + Math.sin(life * 6 + j + si) * 0.03, s[1] + life * 0.35, s[2] + Math.cos(life * 5 + j) * 0.02);
        const a = 0.55 * Math.sin(life * Math.PI);
        C.setXYZ(i, steamColor.r * a, steamColor.g * a, steamColor.b * a);
      }
    }
    P.needsUpdate = true;
    C.needsUpdate = true;
  });

  return <points ref={points} geometry={geometry} material={MAT.steam} frustumCulled={false} />;
}

// ---------------------------------------------------------------- polvo en la luz

/** motas del haz del ventanal (sol de dia, luna de noche) */
const BEAM_DUST = 60;
/** motas por cono de lampara */
const CONE_DUST = 7;
const beamColor = new Color(PAL.cream);
const moonColor = new Color(PAL.moon).lerp(new Color('#ffffff'), 0.35);
const lampColor = new Color(PAL.cream).lerp(new Color(PAL.amber), 0.35);
const win = PROPS.window;

/**
 * Polvo que flota en la luz, sin asignaciones por frame:
 * - en cada cono de lampara (motas que giran despacio y bajan dentro del cono), con el encendido;
 * - en el haz que entra por el ventanal: dorado con el sol, azul palido con la luna.
 */
export function Dust({ closed, cones }: { closed: boolean; cones: readonly LightCone[] }) {
  const total = BEAM_DUST + cones.length * CONE_DUST;
  const { geometry, seeds } = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(total * 3), 3));
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(total * 3), 3));
    const s = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      s[i * 3] = hash1(i * 1.1);
      s[i * 3 + 1] = hash1(i * 2.3);
      s[i * 3 + 2] = hash1(i * 3.7);
    }
    return { geometry: g, seeds: s };
  }, [total]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const points = useRef<Points>(null);

  useFrame(() => {
    const pts = points.current;
    if (!pts) return;
    const lampK = closed || AMBIENT.reduced ? 0 : AMBIENT.lamp;
    const sunK = closed || AMBIENT.reduced ? 0 : AMBIENT.sun;
    const moonK = closed || AMBIENT.reduced ? 0 : AMBIENT.moon * 0.7;
    pts.visible = lampK > 0.02 || sunK > 0.02 || moonK > 0.02;
    if (!pts.visible) return;
    const t = AMBIENT.t;
    const sd = AMBIENT.sunDir;
    const beamK = Math.max(sunK, moonK);
    const cr = sunK >= moonK ? beamColor.r : moonColor.r;
    const cg = sunK >= moonK ? beamColor.g : moonColor.g;
    const cb = sunK >= moonK ? beamColor.b : moonColor.b;
    const P = geometry.getAttribute('position');
    const C = geometry.getAttribute('color');
    for (let i = 0; i < BEAM_DUST; i++) {
      const x = -3.2 + (seeds[i * 3] ?? 0) * 6.4 + Math.sin(t * 0.15 + i) * 0.25;
      const y = 0.2 + (seeds[i * 3 + 1] ?? 0) * 1.4 + Math.sin(t * 0.1 + i * 1.7) * 0.15;
      const z = -2.9 + (seeds[i * 3 + 2] ?? 0) * 4.5 + Math.cos(t * 0.12 + i * 0.9) * 0.2;
      P.setXYZ(i, x, y, z);
      let lit = 0;
      const tb = (-HD - 0.1 - z) / (sd.z || -0.001);
      if (tb > 0) {
        const hx = x + sd.x * tb;
        const hy = y + sd.y * tb;
        if (hx > win.x0 && hx < win.x1 && hy > win.y0 && hy < win.y1) lit = 1;
      }
      const a = lit * beamK * (0.5 + 0.5 * Math.sin(t * 2 + i * 3.1));
      C.setXYZ(i, cr * a, cg * a, cb * a);
    }
    for (let c = 0; c < cones.length; c++) {
      const cone = cones[c];
      if (!cone) continue;
      for (let j = 0; j < CONE_DUST; j++) {
        const i = BEAM_DUST + c * CONE_DUST + j;
        const sa = seeds[i * 3] ?? 0;
        const sb = seeds[i * 3 + 1] ?? 0;
        const sc = seeds[i * 3 + 2] ?? 0;
        // baja despacio por el cono y vuelve a aparecer arriba; gira alrededor del eje de la luz
        const f = (sb + t * (0.025 + sc * 0.02)) % 1;
        const rad = cone.r * (0.15 + f * 0.85) * (0.35 + sc * 0.65);
        const ang = sa * 6.283 + t * (0.12 + sa * 0.1);
        P.setXYZ(i, cone.x + Math.cos(ang) * rad, cone.y - f * cone.h + Math.sin(t * 0.7 + i) * 0.015, cone.z + Math.sin(ang) * rad);
        const a = lampK * Math.sin(f * Math.PI) * (0.45 + 0.55 * Math.sin(t * 1.6 + i * 2.3) ** 2);
        C.setXYZ(i, lampColor.r * a, lampColor.g * a, lampColor.b * a);
      }
    }
    P.needsUpdate = true;
    C.needsUpdate = true;
  });

  return <points ref={points} geometry={geometry} material={MAT.dust} frustumCulled={false} />;
}

// ---------------------------------------------------------------- puerta

/** hoja de la puerta: cerrada a 13 grados, abierta a 77 cuando un personaje camina cerca (D5) */
export function DoorLeaf({
  worldX,
  worldZ,
  closed,
  theme,
}: {
  worldX: number;
  worldZ: number;
  closed: boolean;
  theme: RoomTheme;
}) {
  const hinge = useRef<Group>(null);
  const angle = useRef(DOOR_CLOSED);
  const doorX = worldX - HW - WALL_T / 2;
  const doorZ = worldZ + DOOR.z;
  useFrame((_, rawDt) => {
    const g = hinge.current;
    if (!g) return;
    const open = walkerOpen(doorX, doorZ);
    const e = open * open * (3 - 2 * open);
    const target = DOOR_CLOSED + (DOOR_OPEN - DOOR_CLOSED) * e;
    if (AMBIENT.reduced) angle.current = target;
    else angle.current += (target - angle.current) * Math.min(1, Math.min(rawDt, 0.1) * 8);
    g.rotation.y = Math.PI / 2 - angle.current;
  });
  return (
    <group ref={hinge} position={[-HW - 0.03, 0, DOOR.z + DOOR_W / 2]} rotation={[0, Math.PI / 2 - DOOR_CLOSED, 0]}>
      <mesh geometry={doorLeafGeometry(DOOR_W, DOOR.height, theme)} material={closed ? MAT.toonClosed : MAT.toon} castShadow receiveShadow />
    </group>
  );
}

// ---------------------------------------------------------------- charcos de luz

/** charcos aditivos que solo se dibujan cuando hay luz: de lampara o de luna */
export function LightPools({ geometry, kind }: { geometry: BufferGeometry; kind: 'lamp' | 'moon' }) {
  const mesh = useRef<Mesh>(null);
  useFrame(() => {
    if (mesh.current) mesh.current.visible = (kind === 'lamp' ? AMBIENT.lamp : AMBIENT.moon) > 0.01;
  });
  return <mesh ref={mesh} geometry={geometry} material={kind === 'lamp' ? MAT.glowLamp : MAT.moonPool} />;
}

// ---------------------------------------------------------------- guirnalda

export function StringLights({ geometry, closed }: { geometry: BufferGeometry; closed: boolean }) {
  return <mesh geometry={geometry} material={closed ? MAT.stringLightsClosed : MAT.stringLights} />;
}
