// Exterior del diorama (lo que une las salas se lee como una plaza nocturna, discreta y
// sin competir con los estilos de las salas):
// - cada sala se para sobre su acera de losetas claras, con cordon apenas alzado, linea de sombra al frente y a la
//   derecha y el cordon rebajado frente a la puerta;
// - las calles (pasillos) van en adoquines de cesteria; en cada cruce, rosa de los vientos o tapa de registro;
// - farolas bajas en cruces alternos, con charco de luz calido (solo con las lamparas encendidas) y un charquito;
// - jardinera con seto y luces de escalon en los bordes que dan a la camara; bolardos con luz al borde izquierdo;
// - la maquina expendedora, la banca y las plantas de siempre, y alguna hoja suelta en las aceras.
// Nada solido pisa los carriles del lider (laneX / hallZ y la entrada a cada puerta, ver buildOfficeNav): lo
// prueba web/test/exterior.test.ts. Todo lo estatico en pocas mallas; lo vivo (luces, charcos, halos) aparte.

import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute, BoxGeometry } from 'three';
import { Buckets, KitGeo, kshade, M4 } from './builder';
import { DOOR, HALL_D, type OfficeLayout, PITCH_X, type Rect, ROOM_FOOTPRINT, type RoomPlacement, type Vec2 } from './layout';
import { MAT } from './materials';
import { LIT_UV } from './textures';
import { hash1, type PalKey } from './world/kit';
import { mergeFoliage, type PlantKind, type PlantSpot, plantSpot, pot, type PotStyle } from './world/plants';
import { Foliage, LightPools } from './world/RoomLife';

type BaseBucket = 'toon' | 'hall' | 'walk' | 'lit' | 'emis' | 'bulb' | 'pool';

// ---------------------------------------------------------------- medidas del exterior

/** losetas de la acera alrededor de ROOM_FOOTPRINT (8 texeles) */
const SIDEWALK_W = 0.25;
/** cordon por fuera de las losetas (2 texeles) */
const CURB_W = 0.0625;
/** alturas: losetas, cordon, calcos sobre la calle y charcos de luz */
const SIDEWALK_Y = 0.012;
const CURB_Y = 0.028;
const DECAL_Y = 0.003;
const POOL_Y = 0.031;
/** jardinera con seto en los bordes que dan a la camara (frente y derecha de cada franja) */
const PLANTER_W = 0.24;
/** la farola queda fuera de la esquina del cordon: no tapa el contorno de sala seleccionada */
const LAMP_OUT = 0.07;
const LAMP_H = 1.58;

/** medidas que comparten el contorno de seleccion y las pruebas */
export const EXTERIOR = {
  /** ancho de la acera con su cordon, desde ROOM_FOOTPRINT */
  ring: SIDEWALK_W + CURB_W,
  curbY: CURB_Y,
  poolY: POOL_Y,
  /** el rebaje del cordon frente a la puerta sobra esto a cada lado del hueco (DOOR.openMin..openMax) */
  doorCut: 0.08,
  /** radio de lo solido que se para en la calle */
  lampR: 0.08,
  bollardR: 0.05,
} as const;

const RING = EXTERIOR.ring;

// ---------------------------------------------------------------- plan (puro, sin three)

export interface Crossing extends Vec2 {
  kind: 'compass' | 'manhole';
}

export interface ExteriorPlan {
  /** caja exterior de la acera (con cordon) de cada lugar del mapa */
  sidewalks: { room: RoomPlacement; outer: Rect }[];
  /** loseta de cada cruce de calles, centrada en la calle vertical */
  crossings: Crossing[];
  lamps: Vec2[];
  bollards: Vec2[];
  planters: { rect: Rect; along: 'x' | 'z' }[];
  puddle: Vec2 | null;
}

/**
 * Donde va cada cosa del exterior. Un cruce por sala: el de su carril vertical con el pasillo de su fila. Las
 * farolas van en los cruces con (col + fila) par, en la esquina de adelante a la izquierda de la sala: bajas, para
 * que el farol no tape la sala de la izquierda.
 */
export function exteriorPlan(layout: OfficeLayout): ExteriorPlan {
  const F = ROOM_FOOTPRINT;
  const B = layout.bounds;
  const rects = layout.rowRects;
  const sidewalks: ExteriorPlan['sidewalks'] = [];
  const crossings: Crossing[] = [];
  const lamps: Vec2[] = [];
  for (const room of layout.rooms) {
    const { x: cx, z: cz } = room.center;
    sidewalks.push({ room, outer: { minX: cx + F.minX - RING, maxX: cx + F.maxX + RING, minZ: cz + F.minZ - RING, maxZ: cz + F.maxZ + RING } });
    const z = layout.hallZ[room.row];
    if (z === undefined) continue;
    // la calle vertical va de la acera de la sala de la izquierda (o del borde de la losa) a la de esta sala
    const right = cx + F.minX - RING;
    const left = room.col > 0 ? cx - PITCH_X + F.maxX + RING : B.minX;
    const even = (room.col + room.row) % 2 === 0;
    crossings.push({ x: (left + right) / 2, z, kind: even ? 'compass' : 'manhole' });
    if (even) lamps.push({ x: cx + F.minX - RING - LAMP_OUT, z: cz + F.maxZ + RING + LAMP_OUT });
  }

  const planters: ExteriorPlan['planters'] = [];
  rects.forEach((R, r) => {
    const next = rects[r + 1];
    const from = next?.maxX ?? R.minX;
    const front = from < R.maxX;
    // el frente que no tapa la fila de abajo; si hay fila abajo, arranca en la esquina de su jardinera derecha
    if (front) planters.push({ rect: { minX: next ? from - PLANTER_W : from, maxX: R.maxX, minZ: R.maxZ - PLANTER_W, maxZ: R.maxZ }, along: 'x' });
    planters.push({ rect: { minX: R.maxX - PLANTER_W, maxX: R.maxX, minZ: R.minZ, maxZ: R.maxZ - (front ? PLANTER_W : 0) }, along: 'z' });
  });

  // bolardos al borde izquierdo, sin la banca ni la monstera de la primera sala
  const first = layout.rooms.find((r) => r.col === 0 && r.row === 0);
  const benchZ = first ? first.center.z : null;
  const bollards: Vec2[] = [];
  for (let z = B.minZ + 1.1; z < B.maxZ - 0.6; z += 1.2) {
    if (benchZ !== null && z > benchZ - 1.95 && z < benchZ + 0.95) continue;
    bollards.push({ x: B.minX + 0.12, z });
  }

  const lamp = lamps[0];
  return { sidewalks, crossings, lamps, bollards, planters, puddle: lamp ? { x: lamp.x + 1.0, z: lamp.z + 0.45 } : null };
}

// ---------------------------------------------------------------- piezas

/** acera de una sala: losetas en anillo, cordon (rebajado en la puerta) y linea de sombra al frente y a la derecha */
function sidewalk(b: Buckets<BaseBucket>, room: RoomPlacement): void {
  const F = ROOM_FOOTPRINT;
  const { x: cx, z: cz } = room.center;
  const x0 = cx + F.minX;
  const x1 = cx + F.maxX;
  const z0 = cz + F.minZ;
  const z1 = cz + F.maxZ;
  const s = SIDEWALK_W;
  const k = RING;
  const W = b.geo('walk');
  // la esquina de adelante a la derecha (la que ve la camara) empieza con loseta entera
  const ux = x1 + s;
  const vz = z1 + s;
  const slabs = (ax: number, az: number, bx: number, bz: number) =>
    W.qy(ax, az, bx, bz, SIDEWALK_Y, '#ffffff', { uvRect: [(ax - ux) / 2, (vz - bz) / 2, (bx - ux) / 2, (vz - az) / 2] });
  slabs(x0 - s, z1, x1 + s, z1 + s);
  slabs(x0 - s, z0 - s, x1 + s, z0);
  slabs(x0 - s, z0, x0, z1);
  slabs(x1, z0, x1 + s, z1);

  const T = b.geo('toon');
  const curb = { top: 0.12, jitter: 0.03, sharp: true };
  T.box(x0 - k, 0, z1 + s, x1 + k, CURB_Y, z1 + k, 'stone', curb);
  T.box(x0 - k, 0, z0 - k, x1 + k, CURB_Y, z0 - s, 'stone', curb);
  T.box(x1 + s, 0, z0 - s, x1 + k, CURB_Y, z1 + s, 'stone', curb);
  // lado de la puerta: el cordon se corta donde se entra
  const d0 = cz + DOOR.openMin - EXTERIOR.doorCut;
  const d1 = cz + DOOR.openMax + EXTERIOR.doorCut;
  T.box(x0 - k, 0, z0 - s, x0 - s, CURB_Y, d0, 'stone', curb);
  T.box(x0 - k, 0, d1, x0 - s, CURB_Y, z1 + s, 'stone', curb);

  const SH = 0.035;
  const shade = '#1A1B3C';
  T.qy(x0 - k, z1 + k, x1 + k + SH, z1 + k + SH, DECAL_Y, shade);
  T.qy(x1 + k, z0 - k, x1 + k + SH, z1 + k, DECAL_Y, shade);

  // un par de hojas sueltas en la acera de adelante
  const LEAVES: readonly PalKey[] = ['terra', 'mustard', 'olive'];
  for (let i = 0; i < 2; i++) {
    const h = hash1(room.slot * 13.7 + i * 5.1 + 0.3);
    const lx = x0 + 0.6 + h * (x1 - x0 - 1.2);
    const lz = z1 + 0.05 + hash1(room.slot * 7.3 + i * 2.9) * (s - 0.1);
    T.boxC(lx, SIDEWALK_Y + 0.003, lz, 0.07, 0.004, 0.04, LEAVES[(room.slot + i) % LEAVES.length] ?? 'terra', { ry: h * Math.PI });
  }
}

/** loseta del cruce */
function crossing(b: Buckets<BaseBucket>, c: Crossing): void {
  const half = c.kind === 'compass' ? 0.5 : 0.28;
  const uv = c.kind === 'compass' ? LIT_UV.compass : LIT_UV.manhole;
  b.geo('lit').qy(c.x - half, c.z - half, c.x + half, c.z + half, DECAL_Y, '#ffffff', { uvRect: uv });
}

/** farola baja: base, poste, farol de vidrio calido con techo, y su charco de luz */
function streetLamp(b: Buckets<BaseBucket>, x: number, z: number): void {
  const T = b.geo('toon');
  T.cyl(x, 0, z, 0.075, 0.065, 0.07, 'steel', 8);
  T.cyl(x, 0.07, z, 0.032, 0.026, LAMP_H - 0.3, 'steel', 6);
  const y0 = LAMP_H - 0.23;
  T.cyl(x, y0 - 0.03, z, 0.05, 0.05, 0.03, 'steelL', 6);
  b.geo('bulb').box(x - 0.055, y0, z - 0.055, x + 0.055, y0 + 0.14, z + 0.055, '#FFC98A');
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    T.box(x + sx * 0.062 - 0.012, y0, z + sz * 0.062 - 0.012, x + sx * 0.062 + 0.012, y0 + 0.14, z + sz * 0.062 + 0.012, 'steel');
  }
  T.box(x - 0.085, y0 + 0.14, z - 0.085, x + 0.085, y0 + 0.165, z + 0.085, 'steel', { top: 0.1 });
  T.box(x - 0.045, y0 + 0.165, z - 0.045, x + 0.045, y0 + 0.2, z + 0.045, 'steel', { top: 0.1 });
  b.geo('pool').qy(x - 1.15, z - 1.15, x + 1.15, z + 1.15, POOL_Y, kshade('amber', 0.24));
}

/** charquito en la calle: mancha azul noche con un brillo de luna y el reflejo de la farola */
function puddle(b: Buckets<BaseBucket>, p: Vec2): void {
  const T = b.geo('toon');
  const y = DECAL_Y + 0.001;
  const c = '#26335E';
  T.qy(p.x - 0.24, p.z - 0.07, p.x + 0.26, p.z + 0.07, y, c);
  T.qy(p.x - 0.14, p.z - 0.12, p.x + 0.1, p.z + 0.12, y, c);
  T.qy(p.x + 0.1, p.z - 0.1, p.x + 0.32, p.z + 0.03, y, c);
  T.qy(p.x - 0.12, p.z - 0.06, p.x + 0.02, p.z - 0.035, y + 0.001, '#5E74B8');
  b.geo('bulb').qy(p.x + 0.06, p.z + 0.015, p.x + 0.15, p.z + 0.045, y + 0.001, kshade('amber', 0.8));
}

const PAL_HEDGE = [kshade('jungle', 1), kshade('fern', 0.8)] as const;

/** jardinera de piedra con seto bajo por tramos de alto distinto */
function planter(b: Buckets<BaseBucket>, R: Rect, along: 'x' | 'z', seed: number): void {
  const T = b.geo('toon');
  T.box(R.minX, 0, R.minZ, R.maxX, 0.07, R.maxZ, '#4A4968', { top: 0.12, jitter: 0.02 });
  const inset = 0.035;
  const len = along === 'x' ? R.maxX - R.minX : R.maxZ - R.minZ;
  const n = Math.max(1, Math.round(len / 0.42));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const h = 0.1 + hash1(seed + i * 3.3) * 0.06;
    const color = i % 2 ? PAL_HEDGE[0] : PAL_HEDGE[1];
    const a = i * step;
    if (along === 'x') T.box(R.minX + a, 0.07, R.minZ + inset, R.minX + a + step, 0.07 + h, R.maxZ - inset, color, { top: 0.18, jitter: 0.05 });
    else T.box(R.minX + inset, 0.07, R.minZ + a, R.maxX - inset, 0.07 + h, R.minZ + a + step, color, { top: 0.18, jitter: 0.05 });
  }
}

function plantAt(b: Buckets<BaseBucket>, plants: PlantSpot[], kind: PlantKind, style: PotStyle, x: number, z: number, ry: number, s = 1): void {
  let top = 0;
  b.place(M4(x, 0, z, ry), () => {
    top = pot(b.geo('toon'), style, 0.16, 0.28, 'teal');
  });
  plants.push(plantSpot(kind, x, top, z, ry, s));
}

/** plantas de los extremos de pasillo: bajas, para no tapar las salas de adelante */
const HALL_PLANTS: readonly [PlantKind, PotStyle][] = [
  ['palm', 'basket'],
  ['snake', 'glaze'],
  ['fern', 'terra'],
];

// ---------------------------------------------------------------- luces que respiran

interface GuideBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** cabezas de los bolardos y luces de escalon de las jardineras: respiran en ola (MAT.guideLights) */
function guideGeometry(boxes: readonly GuideBox[]): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  boxes.forEach((g, i) => {
    const box = new BoxGeometry(g.w, g.h, g.d).toNonIndexed();
    box.translate(g.x, g.y, g.z);
    const p = box.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      pos.push(p.getX(k), p.getY(k), p.getZ(k));
      col.push(1, 1, 1);
      idx.push(i);
    }
    box.dispose();
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aIdx', new Float32BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------- armado

interface BaseBuild {
  meshes: Partial<Record<BaseBucket, BufferGeometry>>;
  guides: BufferGeometry;
  vendingPool: BufferGeometry | null;
  vendingGlow: [number, number, number] | null;
  /** halo de cada farol */
  lampGlows: [number, number, number][];
  /** follaje de las plantas de pasillo en una malla */
  foliage: BufferGeometry | null;
}

function buildBase(layout: OfficeLayout): BaseBuild {
  const { bounds: B } = layout;
  const plan = exteriorPlan(layout);
  const b = new Buckets<BaseBucket>(77);
  const T = b.geo('toon');
  const plants: PlantSpot[] = [];
  const guides: GuideBox[] = [];

  // losa del diorama (una franja por fila que termina en su ultima sala) con la calle de adoquines encima
  const rects = layout.rowRects;
  for (const R of rects) {
    T.box(R.minX - 0.05, -0.95, R.minZ - 0.05, R.maxX + 0.05, -0.8, R.maxZ + 0.05, '#3F3D44', { sharp: true });
    T.box(R.minX, -0.8, R.minZ, R.maxX, -0.001, R.maxZ, '#85828A', { sharp: true });
    b.geo('hall').qy(R.minX, R.minZ, R.maxX, R.maxZ, 0, '#ffffff', { uvRect: [R.minX / 2, -R.maxZ / 2, R.maxX / 2, -R.minZ / 2] });
  }

  for (const s of plan.sidewalks) sidewalk(b, s.room);
  for (const c of plan.crossings) crossing(b, c);
  for (const l of plan.lamps) streetLamp(b, l.x, l.z);
  if (plan.puddle) puddle(b, plan.puddle);

  // bolardos bajos con luz en la cabeza (borde izquierdo)
  for (const p of plan.bollards) {
    T.cyl(p.x, 0, p.z, 0.045, 0.04, 0.2, 'steel', 6);
    T.box(p.x - 0.045, 0.23, p.z - 0.045, p.x + 0.045, 0.245, p.z + 0.045, 'steel', { top: 0.1 });
    guides.push({ x: p.x, y: 0.215, z: p.z, w: 0.07, h: 0.03, d: 0.07 });
  }

  // jardineras con luces de escalon en la cara que ve la camara
  plan.planters.forEach(({ rect: R, along }, i) => {
    planter(b, R, along, i * 17.3 + 1);
    if (along === 'x') for (let x = R.minX + 0.5; x < R.maxX - 0.3; x += 1.5) guides.push({ x, y: 0.035, z: R.maxZ + 0.004, w: 0.1, h: 0.022, d: 0.01 });
    else for (let z = R.minZ + 0.6; z < R.maxZ - 0.3; z += 1.5) guides.push({ x: R.maxX + 0.004, y: 0.035, z, w: 0.01, h: 0.022, d: 0.1 });
  });

  // maquina expendedora al fondo del primer pasillo (nadie camina ahi)
  let vendingPool: BufferGeometry | null = null;
  let vendingGlow: [number, number, number] | null = null;
  const first = layout.rooms.find((r) => r.col === 0 && r.row === 0);
  if (first) {
    const x0 = B.minX + 0.05;
    const x1 = x0 + 0.45;
    const z0 = B.minZ + 0.2;
    const z1 = z0 + 0.65;
    T.box(x0, 0, z0, x1, 1.3, z1, 'night', { top: 0.1 });
    T.box(x1, 1.12, z0 + 0.04, x1 + 0.02, 1.26, z1 - 0.04, 'neon');
    T.box(x1, 0.12, z0 + 0.1, x1 + 0.03, 0.3, z1 - 0.1, 'ink');
    const E = b.geo('emis');
    E.box(x1, 0.42, z0 + 0.06, x1 + 0.005, 1.08, z1 - 0.2, kshade('cyan', 0.55));
    const goods: PalKey[] = ['amber', 'neon', 'cream', 'teal'];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        E.box(x1 + 0.006, 0.5 + r * 0.15, z0 + 0.1 + c * 0.12, x1 + 0.01, 0.58 + r * 0.15, z0 + 0.18 + c * 0.12, goods[(r + c) % 4] ?? 'amber');
      }
    }
    E.box(x1 + 0.006, 0.5, z1 - 0.16, x1 + 0.01, 0.62, z1 - 0.08, 'ember');
    const zc = (z0 + z1) / 2;
    vendingGlow = [x1 + 0.2, 0.8, zc];
    vendingPool = new KitGeo(4).qy(x1 + 0.05, zc - 0.7, x1 + 1.45, zc + 0.7, 0.008, '#ffffff').build();

    // banca con cojin y una planta (costado del primer pasillo, antes de la puerta)
    const bx = B.minX + 0.25;
    const bz0 = first.center.z - 1.8;
    const bz1 = first.center.z - 0.5;
    T.box(bx - 0.18, 0, bz0, bx + 0.18, 0.36, bz1, 'steel', { top: 0.06 });
    T.box(bx - 0.16, 0.36, bz0 + 0.05, bx + 0.16, 0.41, bz1 - 0.05, 'plum');
    T.boxC(bx, 0.44, bz0 + 0.42, 0.2, 0.06, 0.25, 'teal', { ry: 0.3 });
    plantAt(b, plants, 'monstera', 'terra', B.minX + 0.3, first.center.z + 0.7, 0.37, 0.9);

  }

  // plantas en los extremos derechos de cada pasillo y un ficus en la esquina del fondo
  layout.hallZ.forEach((z, r) => {
    const [kind, style] = HALL_PLANTS[r % HALL_PLANTS.length] ?? ['palm', 'basket'];
    plantAt(b, plants, kind, style, (rects[r]?.maxX ?? B.maxX) - 0.45, z + HALL_D / 2 - 0.45, 1.1 + r * 0.7);
  });
  plantAt(b, plants, 'ficus', 'stone', (rects[0]?.maxX ?? B.maxX) - 0.45, B.minZ + 0.45, 2.9);

  return {
    meshes: b.build(),
    guides: guideGeometry(guides),
    vendingPool,
    vendingGlow,
    lampGlows: plan.lamps.map((l) => [l.x, LAMP_H - 0.16, l.z]),
    foliage: mergeFoliage(plants),
  };
}

export function OfficeBase({ layout }: { layout: OfficeLayout }) {
  const base = useMemo(() => buildBase(layout), [layout]);
  useEffect(
    () => () => {
      for (const g of Object.values(base.meshes)) g?.dispose();
      base.guides.dispose();
      base.vendingPool?.dispose();
      base.foliage?.dispose();
    },
    [base],
  );
  const m = base.meshes;
  return (
    <group>
      {m.toon ? <mesh geometry={m.toon} material={MAT.toon} castShadow receiveShadow /> : null}
      {m.hall ? <mesh geometry={m.hall} material={MAT.hall} receiveShadow /> : null}
      {m.walk ? <mesh geometry={m.walk} material={MAT.sidewalk} receiveShadow /> : null}
      {m.lit ? <mesh geometry={m.lit} material={MAT.lit} receiveShadow /> : null}
      {m.emis ? <mesh geometry={m.emis} material={MAT.emissive} /> : null}
      {m.bulb ? <mesh geometry={m.bulb} material={MAT.bulbLit} /> : null}
      {m.pool ? <LightPools geometry={m.pool} kind="lamp" /> : null}
      {base.lampGlows.map((p, i) => (
        <sprite key={i} material={MAT.lampGlow} position={p} scale={[0.9, 0.9, 1]} />
      ))}
      <mesh geometry={base.guides} material={MAT.guideLights} />
      {base.vendingPool ? <mesh geometry={base.vendingPool} material={MAT.vendingPool} /> : null}
      {base.vendingGlow ? <sprite material={MAT.vendingGlow} position={base.vendingGlow} scale={[1.2, 1.4, 1]} /> : null}
      <Foliage geometry={base.foliage} closed={false} />
    </group>
  );
}
