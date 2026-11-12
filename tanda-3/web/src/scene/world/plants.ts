// Plantas del "Estudio botanico": diez especies de follaje que se mecen, macetas, jardineras, plantas
// de escritorio y enredaderas. Lo estatico (macetas, jardineras, suculentas, enredaderas) va al balde
// toon de la sala; el follaje de todas las plantas de una sala se fusiona en UNA malla y el vaiven lo
// hace el shader (materials.ts, MAT.foliage) con el pivote y el ritmo de cada planta como atributos.

import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Vector3 } from 'three';
import { type KitColor, KitGeo, kshade } from '../builder';
import { clamp, hash1, type PalKey } from './kit';

export type PlantKind = 'monstera' | 'snake' | 'flower' | 'ficus' | 'palm' | 'cactus' | 'pothos' | 'fern' | 'olive' | 'bamboo';

export interface PlantSpot {
  kind: PlantKind;
  /** pivote del vaiven: donde nace el follaje (o de donde cuelga) */
  x: number;
  y: number;
  z: number;
  ry: number;
  /** escala uniforme */
  s: number;
  /** vaiven (rad), velocidad (rad/s) y fase: cada planta a su ritmo (D5: 4-7 s, +-0.03..0.05) */
  amp: number;
  speed: number;
  phase: number;
}

export function plantSpot(kind: PlantKind, x: number, y: number, z: number, ry = 0, s = 1, ampK = 1): PlantSpot {
  const h = hash1(x * 3.7 + z * 1.9 + y * 0.71);
  return { kind, x, y, z, ry, s, amp: (0.03 + h * 0.02) * ampK, speed: 0.9 + hash1(x + z * 5 + y) * 0.6, phase: h * 6.28 };
}

// ---------------------------------------------------------------- follaje

/** fronda arqueada: segmentos que se van doblando hacia afuera; el ancho queda horizontal */
function frond(F: KitGeo, y0: number, ang: number, tilt0: number, droop: number, segs: number, len: number, w0: number, w1: number, color: PalKey): void {
  let px = 0;
  let py = y0;
  let pz = 0;
  for (let i = 0; i < segs; i++) {
    const th = tilt0 + droop * i;
    const dx = Math.sin(th) * Math.cos(ang);
    const dy = Math.cos(th);
    const dz = -Math.sin(th) * Math.sin(ang);
    const w = w0 + ((w1 - w0) * i) / Math.max(1, segs - 1);
    F.boxC(px + (dx * len) / 2, py + (dy * len) / 2, pz + (dz * len) / 2, 0.012, len, w, color, { ry: ang, rz: -th, top: 0.1 });
    px += dx * len;
    py += dy * len;
    pz += dz * len;
  }
}

const GREENS: readonly PalKey[] = ['jungle', 'leaf', 'fern'];

function monstera(F: KitGeo): void {
  F.box(-0.012, 0, -0.012, 0.012, 0.5, 0.012, 'jungle');
  const leaves: [number, number, number, number, PalKey][] = [
    [0, 0.3, 0, 0.2, 'leaf'],
    [0.17, 0.48, 0.05, 0.18, 'jungle'],
    [-0.16, 0.52, -0.02, 0.19, 'leaf'],
    [0.05, 0.72, -0.08, 0.17, 'fern'],
    [-0.07, 0.42, 0.16, 0.16, 'jungle'],
    [0.19, 0.27, -0.12, 0.15, 'leaf'],
    [-0.18, 0.3, -0.14, 0.14, 'fern'],
    [0.03, 0.6, 0.15, 0.15, 'leaf'],
  ];
  leaves.forEach(([x, y, z, r, c], i) => F.ico(x, y, z, r, c, { sy: 0.5, ry: i, rx: i % 2 ? 0.3 : -0.3, jitter: 0.14, top: 0.14 }));
}

function snake(F: KitGeo): void {
  const blades: [number, number, number, number][] = [
    [0, 0, 0.66, 0],
    [0.05, 0.03, 0.52, 0.18],
    [-0.05, 0.02, 0.58, -0.2],
    [0.02, -0.05, 0.44, 0.3],
    [-0.04, -0.04, 0.5, -0.32],
    [0.06, -0.02, 0.38, 0.45],
    [-0.07, 0.05, 0.4, -0.5],
  ];
  const cols: PalKey[] = ['jungle', 'olive', 'fern'];
  blades.forEach(([x, z, hh, r], i) => F.boxC(x, hh / 2, z, 0.06, hh, 0.022, cols[i % 3] ?? 'jungle', { rz: r * 0.5, ry: i * 0.9, top: 0.12 }));
}

function flower(F: KitGeo): void {
  F.ico(0, 0.1, 0, 0.13, 'leaf', { jitter: 0.14, top: 0.14 });
  F.ico(0.07, 0.17, 0.03, 0.08, 'fern', { top: 0.14 });
  F.ico(-0.06, 0.15, -0.04, 0.08, 'jungle', { top: 0.14 });
  const flowers: [number, number, number, PalKey][] = [
    [0.08, 0.2, 0.06, 'neon'],
    [-0.07, 0.18, 0.07, 'amber'],
    [0.0, 0.24, -0.06, 'coral'],
    [-0.1, 0.12, -0.03, 'lilac'],
    [0.11, 0.13, -0.05, 'cream'],
  ];
  for (const [x, y, z, c] of flowers) F.ico(x, y, z, 0.026, c, { top: 0.2 });
}

function ficus(F: KitGeo): void {
  F.cyl(0, 0, 0, 0.028, 0.018, 1.08, 'walnut', 6);
  for (let i = 0; i < 13; i++) {
    const y = 0.42 + i * 0.055;
    const a = i * 2.4;
    const d = 0.1 + (i % 3) * 0.025;
    F.ico(Math.cos(a) * d, y, Math.sin(a) * d, 0.1 + (i % 2) * 0.02, GREENS[i % 3] ?? 'leaf', { sy: 0.45, sx: 0.8, ry: a, rx: 0.4, jitter: 0.12, top: 0.14 });
  }
  F.ico(0, 1.12, 0, 0.11, 'fern', { sy: 0.6, jitter: 0.12, top: 0.14 });
}

function palm(F: KitGeo): void {
  for (const [x, z] of [[0.02, 0], [-0.03, 0.02], [0.01, -0.03]] as const) F.box(x - 0.01, 0, z - 0.01, x + 0.01, 0.42, z + 0.01, 'olive');
  for (let i = 0; i < 9; i++) {
    const ang = i * 0.7 + hash1(i * 3.3) * 0.4;
    frond(F, 0.3 + (i % 3) * 0.06, ang, 0.25 + (i % 3) * 0.15, 0.3, 4, 0.16, 0.15, 0.05, GREENS[i % 3] ?? 'fern');
  }
}

function cactus(F: KitGeo): void {
  F.cyl(0, 0, 0, 0.1, 0.09, 0.85, 'sageD', 8, { jitter: 0.12 });
  F.ico(0, 0.85, 0, 0.09, 'sageD', { sy: 0.7, jitter: 0.1 });
  F.cyl(0.155, 0.42 - 0.065, 0, 0.05, 0.05, 0.13, 'sageD', 8, { rz: Math.PI / 2 });
  F.cyl(0.2, 0.4, 0, 0.05, 0.048, 0.28, 'sageD', 8, { jitter: 0.1 });
  F.ico(0.2, 0.68, 0, 0.048, 'sageD', { sy: 0.7 });
  F.cyl(-0.14, 0.55 - 0.05, 0, 0.045, 0.045, 0.1, 'sageD', 8, { rz: Math.PI / 2 });
  F.cyl(-0.18, 0.53, 0, 0.045, 0.042, 0.22, 'sageD', 8, { jitter: 0.1 });
  F.ico(-0.18, 0.75, 0, 0.043, 'sageD', { sy: 0.7 });
  // costillas claras
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    F.box(Math.cos(a) * 0.095 - 0.006, 0.05, Math.sin(a) * 0.095 - 0.006, Math.cos(a) * 0.095 + 0.006, 0.8, Math.sin(a) * 0.095 + 0.006, 'mint');
  }
  F.ico(0.02, 0.93, 0.03, 0.03, 'coral');
  F.ico(0.2, 0.73, 0.02, 0.025, 'neon');
}

/** pothos colgante: el origen es el borde de la maceta; las guias caen hacia -y (un poco hacia +z) */
function pothos(F: KitGeo): void {
  const top: [number, number, number, PalKey][] = [
    [0.06, 0.03, 0.03, 'leaf'],
    [-0.06, 0.03, 0.02, 'fern'],
    [0, 0.05, -0.03, 'lime'],
    [0.02, 0.02, 0.07, 'leaf'],
    [-0.04, 0.02, -0.05, 'jungle'],
  ];
  for (const [x, y, z, c] of top) F.ico(x, y, z, 0.055, c, { sy: 0.6, jitter: 0.1, top: 0.12 });
  for (let v = 0; v < 6; v++) {
    const a = v * 1.05;
    const vx = Math.cos(a) * 0.09;
    const vz = Math.sin(a) * 0.06 + 0.04;
    const len = 0.32 + hash1(v * 7.7) * 0.28;
    F.boxC(vx, -len / 2, vz, 0.008, len, 0.008, 'jungle');
    for (let k = 1; k * 0.062 < len; k++) {
      const y = -k * 0.062;
      const wx = vx + Math.sin(k * 1.7 + v) * 0.022;
      const c: PalKey = k % 4 === 0 ? 'lime' : k % 2 ? 'leaf' : 'fern';
      F.ico(wx + (k % 2 ? 0.018 : -0.018), y, vz + 0.01, 0.034, c, { sz: 0.45, ry: k, top: 0.12 });
    }
  }
}

function fern(F: KitGeo): void {
  F.ico(0, 0.05, 0, 0.08, 'jungle', { sy: 0.6 });
  const cols: PalKey[] = ['fern', 'leaf', 'lime'];
  for (let i = 0; i < 12; i++) {
    frond(F, 0.04, i * 0.52 + hash1(i * 1.3) * 0.3, 0.3 + (i % 3) * 0.22, 0.38, 3, 0.12, 0.09, 0.04, cols[i % 3] ?? 'fern');
  }
}

function olive(F: KitGeo): void {
  F.cyl(0, 0, 0, 0.05, 0.035, 1.15, 'walnut', 7, { jitter: 0.08 });
  F.boxC(0.1, 1.0, 0, 0.03, 0.3, 0.03, 'walnut', { rz: -0.7 });
  F.boxC(-0.09, 1.08, 0.04, 0.03, 0.28, 0.03, 'walnut', { rz: 0.6 });
  const crowns: [number, number, number, number, PalKey][] = [
    [0, 1.45, 0, 0.3, 'olive'],
    [0.22, 1.28, 0.05, 0.22, 'sageD'],
    [-0.2, 1.35, -0.06, 0.24, 'mint'],
    [0.08, 1.7, -0.05, 0.22, 'olive'],
    [-0.08, 1.58, 0.16, 0.2, 'sageD'],
    [0.14, 1.52, -0.18, 0.2, 'mint'],
  ];
  for (const [x, y, z, r, c] of crowns) F.ico(x, y, z, r, c, { jitter: 0.14, top: 0.14 });
}

function bamboo(F: KitGeo): void {
  const culms: [number, number, number][] = [
    [0.05, 0.02, 2.2],
    [-0.06, 0.04, 1.95],
    [0.0, -0.06, 2.35],
    [-0.03, -0.01, 1.75],
  ];
  culms.forEach(([x, z, h], c) => {
    F.cyl(x, 0, z, 0.022, 0.018, h, 'olive', 6);
    for (let y = 0.3; y < h - 0.1; y += 0.34) F.cyl(x, y, z, 0.026, 0.026, 0.02, 'fern', 6);
    for (let t = 0; t < 6; t++) {
      const y = h * (0.42 + t * 0.1);
      const a = t * 2.1 + c;
      for (let k = 0; k < 3; k++) {
        const aa = a + k * 0.5;
        F.boxC(x + Math.cos(aa) * 0.1, y, z - Math.sin(aa) * 0.1, 0.02, 0.012, 0.2, (['fern', 'lime', 'leaf'] as const)[k] ?? 'fern', {
          ry: aa + Math.PI / 2,
          rx: -0.35,
          top: 0.12,
        });
      }
    }
  });
}

const BUILD: Record<PlantKind, (F: KitGeo) => void> = { monstera, snake, flower, ficus, palm, cactus, pothos, fern, olive, bamboo };
const SEED: Record<PlantKind, number> = { monstera: 31, snake: 32, flower: 33, ficus: 34, palm: 35, cactus: 36, pothos: 37, fern: 38, olive: 39, bamboo: 40 };
const foliageCache = new Map<PlantKind, BufferGeometry>();

/** follaje de una especie en su propio origen (cacheado) */
export function foliageGeometry(kind: PlantKind): BufferGeometry {
  const hit = foliageCache.get(kind);
  if (hit) return hit;
  const F = new KitGeo(SEED[kind]);
  BUILD[kind](F);
  const g = F.build();
  foliageCache.set(kind, g);
  return g;
}

const mv = new Vector3();
const mm = new Matrix4();
const ms = new Vector3();
const mn = new Matrix3();

/**
 * Fusiona el follaje de varias plantas en una sola geometria. Cada vertice lleva el pivote de su planta
 * (aPivot) y su vaiven (aSway = amp, velocidad, fase): el shader lo mece sin tocar la CPU por frame.
 */
export function mergeFoliage(plants: readonly PlantSpot[]): BufferGeometry | null {
  if (plants.length === 0) return null;
  let n = 0;
  for (const p of plants) n += foliageGeometry(p.kind).getAttribute('position').count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const C = new Float32Array(n * 3);
  const PV = new Float32Array(n * 3);
  const SW = new Float32Array(n * 3);
  let o = 0;
  for (const p of plants) {
    const g = foliageGeometry(p.kind);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const col = g.getAttribute('color');
    mm.makeRotationY(p.ry).scale(ms.set(p.s, p.s, p.s)).setPosition(p.x, p.y, p.z);
    mn.getNormalMatrix(mm);
    for (let k = 0; k < pos.count; k++, o++) {
      const i = o * 3;
      mv.fromBufferAttribute(pos, k).applyMatrix4(mm);
      P[i] = mv.x;
      P[i + 1] = mv.y;
      P[i + 2] = mv.z;
      mv.fromBufferAttribute(nor, k).applyMatrix3(mn).normalize();
      N[i] = mv.x;
      N[i + 1] = mv.y;
      N[i + 2] = mv.z;
      C[i] = col.getX(k);
      C[i + 1] = col.getY(k);
      C[i + 2] = col.getZ(k);
      PV[i] = p.x;
      PV[i + 1] = p.y;
      PV[i + 2] = p.z;
      SW[i] = p.amp;
      SW[i + 1] = p.speed;
      SW[i + 2] = p.phase;
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new Float32BufferAttribute(N, 3));
  out.setAttribute('color', new Float32BufferAttribute(C, 3));
  out.setAttribute('aPivot', new Float32BufferAttribute(PV, 3));
  out.setAttribute('aSway', new Float32BufferAttribute(SW, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------- macetas y jardineras (estaticas)

export type PotStyle = 'terra' | 'white' | 'basket' | 'stone' | 'glaze';

/** maceta en su origen (base en y = 0); devuelve la altura de la tierra, donde nace el follaje */
export function pot(T: KitGeo, style: PotStyle, r = 0.15, h = 0.3, color: KitColor = 'sage'): number {
  if (style === 'stone') {
    T.box(-r, 0, -r, r, h, r, 'stone', { jitter: 0.05, top: 0.06 });
    T.box(-r - 0.01, h - 0.03, -r - 0.01, r + 0.01, h, r + 0.01, kshade('stone', 1.06));
    T.box(-r * 0.85, h, -r * 0.85, r * 0.85, h + 0.008, r * 0.85, 'soil');
    return h + 0.008;
  }
  const body: KitColor = style === 'terra' ? 'terra' : style === 'white' ? 'paper' : style === 'basket' ? 'birch' : color;
  const taper = style === 'glaze' ? 0.72 : style === 'white' ? 0.86 : 0.8;
  T.cyl(0, 0, 0, r * taper, r, h, body, 12, { jitter: style === 'basket' ? 0.07 : 0.04, top: 0.06 });
  if (style === 'basket') {
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      const rr = r * (taper + (1 - taper) * (y / h)) + 0.004;
      T.cyl(0, y - 0.012, 0, rr, rr, 0.024, 'oak', 12);
    }
  } else if (style === 'white') {
    const rr = r * (taper + (1 - taper) * 0.2) + 0.003;
    T.cyl(0, h * 0.2 - 0.01, 0, rr, rr, 0.02, 'sage', 12);
  }
  const rim = style === 'white' ? 'paper' : kshade(body, style === 'terra' ? 1.08 : 0.88);
  T.cyl(0, h - 0.035, 0, r * 1.06, r * 1.06, 0.045, rim, 12);
  T.cyl(0, h, 0, r * 0.95, r * 0.95, 0.018, 'soil', 12);
  return h + 0.018;
}

/** jardinera larga (largo en x, frente con listones hacia +z); devuelve la altura de la tierra */
export function planterBox(T: KitGeo, len: number, depth: number, h: number, color: KitColor): number {
  const hx = len / 2;
  const hz = depth / 2;
  T.box(-hx, 0, -hz, hx, h, hz, color, { jitter: 0.03, top: 0.05 });
  for (let x = -hx + 0.08; x < hx - 0.04; x += 0.12) T.box(x, 0.025, hz, x + 0.014, h - 0.03, hz + 0.006, kshade(color, 0.9));
  T.box(-hx - 0.015, h - 0.03, -hz - 0.015, hx + 0.015, h, hz + 0.015, kshade(color, 1.05));
  T.box(-hx + 0.02, h, -hz + 0.02, hx - 0.02, h + 0.014, hz - 0.02, 'soil');
  return h + 0.014;
}

/** maceta colgante de pared: escuadra desde el borde de la pared (y = top, frente en z = 0) y cuerdas */
export function hangingPlanter(T: KitGeo, top: number, drop: number, out = 0.2): number {
  T.box(-0.012, top - 0.05, 0, 0.012, top - 0.02, out + 0.02, 'graphite');
  T.box(-0.012, top - 0.16, 0, 0.012, top - 0.02, 0.02, 'graphite');
  const rimY = top - 0.035 - drop;
  // cuerdas desde la punta de la escuadra hasta tres puntos del borde de la maceta
  for (const [dx, dz] of [[-0.075, -0.04], [0.075, -0.04], [0, 0.07]] as const) {
    const len = Math.hypot(dx, dz, drop);
    T.boxC(dx / 2, top - 0.035 - drop / 2, out + dz / 2, 0.006, len, 0.006, 'linen', { rx: Math.atan2(-dz, drop), rz: Math.asin(dx / len) });
  }
  T.cyl(0, rimY - 0.1, out, 0.06, 0.1, 0.1, 'paper', 10, { top: 0.06 });
  T.cyl(0, rimY - 0.012, out, 0.105, 0.105, 0.02, 'terra', 10);
  return rimY;
}

// ---------------------------------------------------------------- plantas de escritorio y enredaderas

export type DeskPlantKind = 'succulent' | 'cactus' | 'sprout' | 'trio';

/** macetita de escritorio (estatica): suculenta, cactus, brote o trio de suculentas */
export function deskPlant(T: KitGeo, x: number, y: number, z: number, kind: DeskPlantKind, potColor: KitColor = 'terra'): void {
  if (kind === 'trio') {
    deskPlant(T, x - 0.05, y, z, 'succulent', 'paper');
    deskPlant(T, x + 0.04, y, z - 0.03, 'cactus', 'terra');
    deskPlant(T, x + 0.02, y, z + 0.06, 'succulent', 'sage');
    return;
  }
  const r = kind === 'sprout' ? 0.045 : 0.035;
  T.cyl(x, y, z, r * 0.8, r, 0.055, potColor, 8, { jitter: 0.05 });
  T.cyl(x, y + 0.05, z, r + 0.006, r + 0.006, 0.014, kshade(potColor, 0.88), 8);
  const t = y + 0.064;
  if (kind === 'succulent') {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      T.ico(x + Math.cos(a) * 0.022, t + 0.008, z + Math.sin(a) * 0.022, 0.02, i % 2 ? 'mint' : 'sage', { sy: 0.55, top: 0.15 });
    }
    T.ico(x, t + 0.018, z, 0.018, 'mint', { top: 0.15 });
  } else if (kind === 'cactus') {
    T.cyl(x, t - 0.01, z, 0.022, 0.018, 0.085, 'sageD', 7, { jitter: 0.1 });
    T.cyl(x + 0.025, t + 0.03, z, 0.012, 0.011, 0.035, 'sageD', 6);
    T.ico(x, t + 0.078, z, 0.014, 'neon');
  } else {
    T.ico(x, t + 0.05, z, 0.06, 'leaf', { jitter: 0.1, top: 0.14 });
    T.ico(x + 0.035, t + 0.025, z + 0.015, 0.045, 'fern', { jitter: 0.1 });
    T.ico(x - 0.03, t + 0.035, z - 0.015, 0.045, 'jungle', { jitter: 0.1 });
  }
}

/** enredadera sobre una pared local (cara en z = 0 mirando a +z): tallos que suben serpenteando */
export function ivy(T: KitGeo, x0: number, x1: number, y0: number, y1: number, seed: number): void {
  const stems = Math.max(2, Math.round((x1 - x0) / 0.2));
  for (let s = 0; s < stems; s++) {
    let x = x0 + ((s + 0.5) * (x1 - x0)) / stems;
    const top = y1 - hash1(seed + s * 3.1) * (y1 - y0) * 0.4;
    let k = 0;
    for (let y = y0; y < top; y += 0.055, k++) {
      const nx = clamp(x + (hash1(seed + s * 7 + k * 1.3) - 0.5) * 0.05, x0, x1);
      T.boxC((x + nx) / 2, y + 0.028, 0.006, 0.007, 0.06, 0.006, 'jungle', { rz: Math.atan2(nx - x, 0.055) * -1 });
      x = nx;
      const side = k % 2 ? 1 : -1;
      const hc = hash1(seed * 1.7 + s * 5 + k * 2.9);
      const c: PalKey = hc > 0.68 ? 'fern' : hc > 0.3 ? 'leaf' : 'jungle';
      T.ico(x + side * 0.026, y + 0.03, 0.016, 0.032, c, { sz: 0.35, ry: side * 0.3, top: 0.1 });
      if (hc > 0.8) T.ico(x - side * 0.02, y + 0.012, 0.018, 0.024, 'lime', { sz: 0.35 });
    }
  }
}
