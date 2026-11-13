// Piezas del Kit 3D portadas a codigo real. Cada pieza se arma en su origen (base en y = 0, frente
// hacia +z; las de pared con la espalda contra z = 0) dentro de los baldes de la sala, y la sala las
// coloca con Buckets.place. Unidades: metros.
//
// Cambio v2 (D1): en los escritorios normales el agente se sienta del lado -z mirando a +z (camara);
// el monitor queda del lado de la camara mirando al agente, con post-its en la espalda.

import { BufferGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { type Buckets, type KitColor, KitGeo, kshade, M4 } from '../builder';
import { LIT_UV, type UvRect } from '../textures';
import { DIM, hash1, type PalKey } from './kit';
import { deskPlant } from './plants';
import type { RoomTheme } from './themes';

export type Bucket = 'toon' | 'brick' | 'lit' | 'floor' | 'sky' | 'bulb' | 'glowLamp' | 'moon';
export type B = Buckets<Bucket>;

// ---------------------------------------------------------------- escritorios

/** color de la cajonera y la silla de cada puesto (0 = lider): cada escritorio es de alguien */
export const DESK_ACCENT: readonly PalKey[] = ['plum', 'teal', 'mustard', 'ember', 'dusk', 'sageD', 'moon'];

/**
 * Tira de neon bajo el canto de una cubierta (lado +z, el de la camara) y su reflejo en el piso. Cara
 * de abajo de la cubierta en y = h.
 */
function underGlow(b: B, x0: number, x1: number, z: number, h: number, color: KitColor | null): void {
  if (color === null) return;
  b.geo('bulb').box(x0, h - 0.018, z - 0.03, x1, h, z - 0.018, color);
  b.geo('glowLamp').qy(x0 - 0.1, z - 0.2, x1 + 0.1, z + 0.4, 0.006, kshade(color, 0.22));
}

/** pata de trineo (dos patas y el patin del piso) en el costado x, del color de estructura del estilo */
function sledLeg(T: KitGeo, x: number, z0: number, z1: number, h: number, c: KitColor): void {
  T.box(x - 0.02, 0, z0, x + 0.02, h, z0 + 0.035, c);
  T.box(x - 0.02, 0, z1 - 0.035, x + 0.02, h, z1, c);
  T.box(x - 0.02, 0, z0, x + 0.02, 0.025, z1, c);
  T.box(x - 0.02, h - 0.03, z0, x + 0.02, h, z1, c);
}

/** cubierta sobre patas de trineo, cajonera del color del puesto y neon bajo el canto (si el estilo lo lleva) */
function workerBody(b: B, x0: number, x1: number, z0: number, z1: number, h: number, accent: PalKey, th: RoomTheme): void {
  const T = b.geo('toon');
  T.box(x0, h - 0.035, z0, x1, h, z1, th.top, { jitter: 0.02, top: 0.08 });
  T.box(x0 + 0.03, 0, z0 + 0.05, x0 + 0.42, h - 0.035, z1 - 0.06, kshade(accent, 0.82), { jitter: 0.03, top: 0.06 });
  for (const y of [0.18, 0.4, 0.6]) T.box(x0 + 0.12, y, z1 - 0.06, x0 + 0.33, y + 0.014, z1 - 0.05, th.top);
  sledLeg(T, x1 - 0.06, z0 + 0.04, z1 - 0.04, h - 0.035, th.frame);
  T.box(x0 + 0.42, h - 0.07, z1 - 0.07, x1 - 0.08, h - 0.035, z1 - 0.05, th.frame);
  underGlow(b, x0 + 0.44, x1 - 0.1, z1, h - 0.035, th.deskNeon);
}

/** escritorio de lider: cubierta, dos cajoneras ciruela, faldon y neon bajo el canto (si el estilo lo lleva) */
function leadBody(b: B, x0: number, x1: number, z0: number, z1: number, h: number, th: RoomTheme): void {
  const T = b.geo('toon');
  T.box(x0, h - 0.04, z0, x1, h, z1, th.top, { jitter: 0.02, top: 0.08 });
  T.box(x0 + 0.42, 0.14, z1 - 0.07, x1 - 0.42, h - 0.04, z1 - 0.05, th.frameL);
  const pz0 = z0 + 0.05;
  const pz1 = z1 - 0.06;
  T.box(x0 + 0.03, 0, pz0, x0 + 0.42, h - 0.04, pz1, 'plum', { jitter: 0.03, top: 0.06 });
  T.box(x1 - 0.42, 0, pz0, x1 - 0.03, h - 0.04, pz1, 'plum', { jitter: 0.03, top: 0.06 });
  for (const x of [x0 + 0.12, x1 - 0.33]) T.box(x, 0.5, pz1, x + 0.21, 0.514, pz1 + 0.012, th.top);
  underGlow(b, x0 + 0.44, x1 - 0.44, z1 - 0.02, h - 0.04, th.leadNeon);
}

/** monitor en su marco: base en y 0, pantalla mirando a +z en z = 0 (la pantalla es aparte) */
function monitor(b: B, variant: number): void {
  const T = b.geo('toon');
  T.box(-0.025, 0, -0.07, 0.025, 0.1, -0.04, 'stone');
  T.box(-0.09, 0, -0.11, 0.09, 0.012, 0.0, 'stone');
  T.box(-0.21, 0.08, -0.035, 0.21, 0.32, 0, 'graphite', { top: 0.12 });
  T.box(-0.19, 0.1, -0.04, 0.19, 0.3, -0.035, 'stone');
  // post-its en la espalda (la ve la camara en v2)
  if (variant % 3 === 0) T.box(0.06, 0.2, -0.047, 0.13, 0.27, -0.04, 'neon');
  if (variant % 3 === 1) T.box(-0.14, 0.12, -0.047, -0.07, 0.19, -0.04, 'amber');
  if (variant % 3 === 2) T.box(-0.02, 0.22, -0.047, 0.05, 0.29, -0.04, 'cream');
}

/** pantalla: plano de 0.38 x 0.2 centrado a 0.2 de la base del monitor, 2 mm delante del vidrio */
export const SCREEN_SIZE = { w: 0.38, h: 0.2, y: 0.2, z: 0.002 } as const;

export interface Spot {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/** monitores de cada tipo de escritorio (coordenadas del escritorio; y = base sobre la cubierta) */
export function monitorSpots(kind: 'lead' | 'worker'): Spot[] {
  const { h } = DIM.DESK;
  if (kind === 'worker') return [{ x: 0, y: h, z: DIM.DESK.d / 2 - 0.16, rotY: Math.PI }];
  const z1 = DIM.LEAD_DESK.d / 2;
  return [
    { x: -0.6, y: h, z: z1 - 0.24, rotY: Math.PI - 0.5 },
    { x: 0.6, y: h, z: z1 - 0.24, rotY: Math.PI + 0.5 },
  ];
}

/** pantalla en coordenadas del escritorio (el plano mira hacia donde apunta rotY) */
export function screenSpot(m: Spot): Spot {
  const s = Math.sin(m.rotY);
  const c = Math.cos(m.rotY);
  return { x: m.x + SCREEN_SIZE.z * s, y: m.y + SCREEN_SIZE.y, z: m.z + SCREEN_SIZE.z * c, rotY: m.rotY };
}

/** lampara de brazo: base, brazo, pantalla, bombilla y charco de luz sobre la mesa */
export function deskLamp(b: B, th: RoomTheme): void {
  const T = b.geo('toon');
  T.cyl(0, 0, 0, 0.07, 0.06, 0.025, th.frame, 10);
  T.boxC(0.0, 0.15, 0, 0.022, 0.26, 0.022, th.frame, { rz: -0.12 });
  T.boxC(0.08, 0.28, 0, 0.18, 0.02, 0.02, th.frame, { rz: -0.35 });
  T.cyl(0.16, 0.19, 0, 0.075, 0.035, 0.08, th.shade, 10, { top: 0.1 });
  b.geo('bulb').box(0.135, 0.18, -0.025, 0.185, 0.195, 0.025, 'cream');
  // charco sobre tapete y hojas (y + 0.009), bajo el teclado
  b.geo('glowLamp').qy(-0.09, -0.25, 0.41, 0.25, 0.009, kshade(th.pool, 0.5));
}

/** donde queda la bombilla de una lampara colocada en (x, z) con giro ry, sobre una mesa de alto h */
export function lampBulb(x: number, h: number, z: number, ry: number): Spot {
  return { x: x + 0.16 * Math.cos(ry), y: h + 0.19, z: z - 0.16 * Math.sin(ry), rotY: ry };
}

export const WORKER_LAMP = { x: 0.45, z: 0.12, ry: Math.PI - 0.5 } as const;
export const LEAD_LAMP = { x: -0.85, z: -0.2, ry: 0.3 } as const;

/** taza con asa; devuelve el punto de donde sale el vapor */
function mug(T: KitGeo, x: number, y: number, z: number, body: PalKey, r = 0.04, hgt = 0.085): [number, number, number] {
  T.cyl(x, y, z, r, r, hgt, body, 8);
  T.box(x + r, y + 0.02, z - 0.01, x + r + 0.02, y + hgt - 0.02, z + 0.01, body);
  T.cyl(x, y + hgt - 0.015, z, r - 0.007, r - 0.007, 0.016, kshade('ink', 2), 8);
  return [x, y + hgt + 0.02, z];
}

export interface DeskBuild {
  /** fuentes de vapor en coordenadas del escritorio */
  steam: [number, number, number][];
}

/** escritorio normal (1..6) sin silla ni lampara; cada puesto tiene su desorden (D1 "cada puesto es de alguien") */
export function workerDesk(b: B, index: number, th: RoomTheme): DeskBuild {
  const T = b.geo('toon');
  const { w, d, h } = DIM.DESK;
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  const steam: [number, number, number][] = [];
  workerBody(b, x0, x1, z0, z1, h, DESK_ACCENT[index] ?? 'teal', th);
  T.box(-0.26, h, z0 + 0.03, 0.26, h + 0.005, z0 + 0.23, 'night');
  T.box(-0.2, h + 0.005, z0 + 0.07, 0.2, h + 0.03, z0 + 0.2, 'graphite', { top: 0.1 });
  T.box(-0.33, h, z0 + 0.1, -0.27, h + 0.02, z0 + 0.2, 'paper');
  switch (index) {
    case 3: {
      // planos y caja de herramientas
      T.box(0.2, h, -0.22, 0.54, h + 0.006, 0.06, 'teal');
      T.box(0.23, h + 0.006, -0.18, 0.5, h + 0.008, -0.165, 'cream');
      T.box(0.23, h + 0.006, -0.08, 0.4, h + 0.008, -0.065, 'cream');
      T.box(0.44, h + 0.006, -0.2, 0.455, h + 0.008, 0.03, 'cream');
      T.box(-0.56, h, z1 - 0.27, -0.33, h + 0.1, z1 - 0.1, 'ember', { top: 0.1 });
      T.box(-0.5, h + 0.1, z1 - 0.2, -0.39, h + 0.125, z1 - 0.17, 'ink');
      steam.push(mug(T, -0.42, h, z0 + 0.14, 'cream'));
      break;
    }
    case 4: {
      // mapa y binoculares
      T.box(0.18, h, -0.2, 0.54, h + 0.006, 0.06, 'cream');
      T.box(0.22, h + 0.006, -0.12, 0.38, h + 0.008, -0.105, 'teal');
      T.box(0.3, h + 0.006, -0.08, 0.315, h + 0.008, 0.02, 'ember');
      T.box(0.4, h + 0.006, -0.17, 0.45, h + 0.008, -0.12, 'neon');
      T.box(-0.54, h, z1 - 0.24, -0.44, h + 0.06, z1 - 0.15, 'night');
      T.box(-0.42, h, z1 - 0.24, -0.32, h + 0.06, z1 - 0.15, 'night');
      T.box(-0.45, h + 0.02, z1 - 0.21, -0.41, h + 0.04, z1 - 0.18, 'lavender');
      deskPlant(T, -0.46, h, z0 + 0.12, 'trio');
      break;
    }
    case 6: {
      // globo terraqueo, cuaderno y un cactus
      T.cyl(0.4, h, 0.0, 0.06, 0.06, 0.02, th.frame, 8);
      T.box(0.395, h + 0.02, -0.005, 0.405, h + 0.05, 0.005, th.frame);
      T.ico(0.4, h + 0.12, 0.0, 0.075, 'teal', { jitter: 0.14 });
      T.box(-0.55, h, z0 + 0.05, -0.3, h + 0.03, z0 + 0.25, 'terra');
      T.box(-0.54, h + 0.03, z0 + 0.06, -0.31, h + 0.034, z0 + 0.24, 'cream');
      deskPlant(T, -0.46, h, z1 - 0.1, 'cactus', 'paper');
      break;
    }
    default: {
      // libreta del kit y un detalle por puesto
      T.box(x1 - 0.3, h, z0 + 0.06, x1 - 0.06, h + 0.006, z0 + 0.3, 'cream');
      T.box(x1 - 0.26, h + 0.006, z0 + 0.245, x1 - 0.09, h + 0.008, z0 + 0.26, 'navy');
      if (index === 1) steam.push(mug(T, -0.44, h, z0 + 0.2, 'ember'));
      else if (index === 2) {
        T.box(-0.48, h, z1 - 0.18, -0.32, h + 0.12, z1 - 0.06, 'teal', { top: 0.1 });
        deskPlant(T, -0.47, h, z0 + 0.1, 'succulent', 'terra');
      } else deskPlant(T, -0.46, h, z1 - 0.12, 'sprout', 'blush');
      break;
    }
  }
  b.place(M4(0, h, z1 - 0.16, Math.PI), () => monitor(b, index));
  return { steam };
}

/** escritorio de lider v2: dos monitores hacia el lider, placa con su nombre del lado de la camara */
export function leadDesk(b: B, th: RoomTheme): DeskBuild {
  const T = b.geo('toon');
  const { w, d, h } = DIM.LEAD_DESK;
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  leadBody(b, x0, x1, z0, z1, h, th);
  T.box(-0.3, h, z0 + 0.04, 0.3, h + 0.005, z0 + 0.26, 'night');
  T.box(-0.22, h + 0.005, z0 + 0.07, 0.22, h + 0.03, z0 + 0.2, 'graphite', { top: 0.1 });
  T.box(0.3, h, z0 + 0.08, 0.36, h + 0.02, z0 + 0.18, 'paper');
  const steam = [mug(T, 0.72, h, z0 + 0.16, 'cream', 0.045, 0.09)];
  T.cyl(-0.5, h, z0 + 0.08, 0.04, 0.035, 0.1, 'sage', 8);
  T.box(-0.51, h + 0.1, z0 + 0.07, -0.5, h + 0.16, z0 + 0.08, 'amber');
  T.box(-0.49, h + 0.1, z0 + 0.085, -0.48, h + 0.15, z0 + 0.095, 'neon');
  deskPlant(T, 0.78, h, z1 - 0.12, 'succulent', 'paper');
  T.box(-0.22, h, z1 - 0.1, 0.22, h + 0.1, z1 - 0.06, th.frame);
  b.geo('lit').qz(-0.2, h + 0.02, 0.2, h + 0.08, z1 - 0.059, '#ffffff', { uvRect: LIT_UV.plate });
  for (const m of monitorSpots('lead')) b.place(M4(m.x, m.y, m.z, m.rotY), () => monitor(b, m.x > 0 ? 0 : 1));
  return { steam };
}

/** silla del kit, mirando a +z (respaldo hacia -z); cojin y respaldo del color del puesto */
export function chair(b: B, lead: boolean, color: PalKey = 'plum'): void {
  const T = b.geo('toon');
  const sy = DIM.SEAT_H;
  const bw = lead ? 0.5 : 0.44;
  const bh = lead ? 0.5 : 0.34;
  T.boxC(0, 0.04, 0, 0.5, 0.035, 0.05, 'ink');
  T.boxC(0, 0.04, 0, 0.05, 0.035, 0.5, 'ink');
  for (const [x, z] of [[0.23, 0], [-0.23, 0], [0, 0.23], [0, -0.23]] as const) T.box(x - 0.025, 0, z - 0.025, x + 0.025, 0.03, z + 0.025, 'night');
  T.cyl(0, 0.05, 0, 0.03, 0.03, sy - 0.11, 'ink', 6);
  T.box(-bw / 2, sy - 0.07, -0.21, bw / 2, sy, 0.21, color, { top: 0.08, jitter: 0.03 });
  T.box(-0.03, sy - 0.05, -0.27, 0.03, sy + 0.1, -0.22, 'ink');
  T.box(-bw / 2 + 0.01, sy + 0.05, -0.3, bw / 2 - 0.01, sy + 0.05 + bh, -0.22, kshade(color, 0.85), { top: 0.08, jitter: 0.03 });
  if (lead) {
    T.box(-bw / 2 - 0.04, sy + 0.1, -0.15, -bw / 2, sy + 0.14, 0.14, 'night');
    T.box(bw / 2, sy + 0.1, -0.15, bw / 2 + 0.04, sy + 0.14, 0.14, 'night');
    T.box(-0.14, sy + bh + 0.07, -0.29, 0.14, sy + bh + 0.17, -0.23, color);
  }
}

// ---------------------------------------------------------------- lamparas colgantes

/**
 * Farol de papel colgado de la pared (espalda en z = 0): escuadra, cable, globo de papel que brilla con
 * las lamparas (del color del estilo) y charco en el piso. Devuelve la bombilla (para el polvo en el cono).
 */
export function wallPendant(b: B, out: number, drop: number, th: RoomTheme): [number, number, number] {
  const T = b.geo('toon');
  const top = DIM.WALL_H;
  T.box(-0.015, top - 0.06, 0, 0.015, top - 0.025, out + 0.02, th.frame);
  T.box(-0.015, top - 0.2, 0, 0.015, top - 0.025, 0.02, th.frame);
  const shadeY = top - 0.04 - drop;
  T.box(-0.004, shadeY + 0.12, out - 0.004, 0.004, top - 0.04, out + 0.004, 'ink');
  T.cyl(0, shadeY + 0.11, out, 0.025, 0.025, 0.025, th.frame, 8);
  // globo: dos troncos de cono de papel encendido, con el aro de la estructura
  const L = b.geo('bulb');
  L.cyl(0, shadeY - 0.06, out, 0.07, 0.15, 0.085, kshade(th.lantern, 0.94), 12);
  L.cyl(0, shadeY + 0.025, out, 0.15, 0.07, 0.085, th.lantern, 12);
  T.cyl(0, shadeY + 0.02, out, 0.152, 0.152, 0.01, th.topD, 12);
  b.geo('glowLamp').qy(-0.6, out - 0.55, 0.6, out + 0.65, 0.007, kshade(th.pool, 0.42));
  return [0, shadeY - 0.03, out];
}

/** lampara de pie de lectura (base en el origen): pie del color de estructura, pantalla crema y charco en el piso */
export function floorLamp(b: B, th: RoomTheme): [number, number, number] {
  const T = b.geo('toon');
  T.cyl(0, 0, 0, 0.16, 0.14, 0.04, th.frame, 10);
  T.cyl(0, 0.04, 0, 0.018, 0.018, 1.08, th.frame, 6);
  T.cyl(0, 1.12, 0, 0.2, 0.13, 0.24, 'cream', 12, { top: 0.1 });
  // la luz se escapa por la boca de arriba y por el borde de abajo
  b.geo('bulb').cyl(0, 1.355, 0, 0.12, 0.12, 0.01, 'cream', 12);
  b.geo('bulb').cyl(0, 1.105, 0, 0.19, 0.19, 0.014, 'cream', 12);
  b.geo('glowLamp').qy(-0.75, -0.75, 0.75, 0.75, 0.007, kshade(th.pool, 0.36));
  return [0, 1.1, 0];
}

// ---------------------------------------------------------------- muebles de decoracion

/** estanteria con libros (2 x half de ancho, 1.5 de alto, 0.34 de fondo); espalda en z = 0. Ancha: dos cuerpos */
export function bookshelf(b: B, half: number, th: RoomTheme): void {
  const T = b.geo('toon');
  const W = half;
  const H = 1.5;
  const D = 0.34;
  const split = W > 0.65;
  // estructura del color de estructura del estilo, fondo mas claro y repisas del color de las cubiertas
  T.box(-W, 0, 0, -W + 0.03, H, D, th.frame);
  T.box(W - 0.03, 0, 0, W, H, D, th.frame);
  if (split) T.box(-0.015, 0.08, 0.02, 0.015, H - 0.03, D, th.frame);
  T.box(-W, H - 0.03, 0, W, H, D, th.frame, { top: 0.06 });
  T.box(-W, 0, 0, W, 0.08, D, th.frame);
  T.box(-W + 0.03, 0.08, 0, W - 0.03, H - 0.03, 0.02, th.frameL);
  for (const y of [0.44, 0.8, 1.14]) T.box(-W + 0.03, y, 0.02, W - 0.03, y + 0.025, D, th.top, { top: 0.06 });
  const cols: PalKey[] = ['plum', 'teal', 'amber', 'ember', 'lavender', 'night', 'cream', 'leaf', 'dusk', 'neon'];
  [0.08, 0.47, 0.83, 1.17].forEach((y0, s) => {
    let x = -W + 0.06;
    let i = 0;
    while (x < W - 0.12) {
      const bw = 0.04 + hash1(s * 13 + i * 3.7) * 0.045;
      const bh = 0.18 + hash1(s * 7 + i * 1.3) * 0.1;
      const c = cols[Math.floor(hash1(s * 5 + i * 2.9) * cols.length)] ?? 'plum';
      // el parante del medio no se cruza
      if (split && x < 0.03 && x + bw > -0.03) {
        x = 0.03;
        i++;
        continue;
      }
      if (hash1(s * 3 + i) > 0.88 && x > -0.2 && !(split && x < 0.03 && x + 0.18 > -0.03)) {
        T.boxC(x + 0.09, y0 + bh / 2 - 0.01, 0.17, bw, bh, 0.22, c, { rz: -0.35 });
        x += 0.18;
      } else {
        T.box(x, y0, 0.05, x + bw, y0 + bh, 0.28, c, { top: 0.08 });
        T.box(x + 0.005, y0 + bh * 0.7, 0.281, x + bw - 0.005, y0 + bh * 0.76, 0.283, 'cream');
        x += bw + 0.004;
      }
      if (s === 2 && i === 4 && !(split && x < 0.03 && x + 0.24 > -0.03)) {
        T.box(x + 0.02, y0, 0.06, x + 0.2, y0 + 0.04, 0.28, 'teal');
        T.box(x + 0.03, y0 + 0.04, 0.07, x + 0.19, y0 + 0.08, 0.27, 'ember');
        x += 0.24;
      }
      i++;
    }
  });
  T.cyl(W - 0.25, H, 0.17, 0.05, 0.035, 0.14, 'teal', 8);
  T.ico(-W + 0.3, H + 0.08, 0.17, 0.08, 'moon', { jitter: 0.1 });
  T.box(-W + 0.27, H, 0.14, -W + 0.33, H + 0.02, 0.2, th.frame);
}

// ---------------------------------------------------------------- muebles de las zonas (zones.ts)

/** matraz conico con liquido de color y un brillo que se enciende con las lamparas */
function flask(b: B, x: number, y: number, z: number, liquid: PalKey, s = 1): void {
  const T = b.geo('toon');
  // liquido abajo, vidrio arriba (toon opaco: el liquido va por fuera del vidrio)
  T.cyl(x, y, z, 0.056 * s, 0.039 * s, 0.045 * s, liquid, 8);
  T.cyl(x, y + 0.045 * s, z, 0.038 * s, 0.022 * s, 0.045 * s, 'moon', 8, { top: 0.1 });
  T.cyl(x, y + 0.09 * s, z, 0.016 * s, 0.016 * s, 0.05 * s, 'moon', 6);
  b.geo('bulb').cyl(x, y + 0.045 * s, z, 0.036 * s, 0.036 * s, 0.004, liquid, 8);
}

/**
 * Banco de laboratorio contra la pared (espalda en z = 0, frente a +z, largo en x): gabinete hueso con
 * puertas, cubierta de pizarra a la altura de las manos, repisa de frascos en la pared, matraces, gradilla
 * de tubos, balon sobre un mechero y un microscopio. Devuelve el vapor (del balon).
 */
export function labBench(b: B, len: number, h: number, th: RoomTheme): [number, number, number][] {
  const T = b.geo('toon');
  const hx = len / 2;
  const D = 0.4;
  T.box(-hx + 0.02, 0.06, 0.02, hx - 0.02, h - 0.04, D - 0.03, th.topD);
  T.box(-hx + 0.02, 0, 0.02, hx - 0.02, 0.06, D - 0.05, th.frame);
  for (let x = -hx + 0.05; x < hx - 0.3; x += 0.49) {
    T.box(x, 0.1, D - 0.03, x + 0.45, h - 0.09, D - 0.02, th.top, { jitter: 0.02 });
    T.box(x + 0.08, h - 0.19, D - 0.02, x + 0.37, h - 0.175, D + 0.005, th.frame);
  }
  T.box(-hx, h - 0.04, 0, hx, h, D, 'graphite', { top: 0.14, jitter: 0.02 });
  T.box(-hx, h, 0, hx, h + 0.1, 0.02, 'stone');
  // repisa de pared con frascos
  const shelf = h + 0.42;
  T.box(-hx + 0.08, shelf - 0.025, 0, hx - 0.08, shelf, 0.15, th.top, { top: 0.06 });
  for (const x of [-hx + 0.2, hx - 0.2]) T.box(x - 0.012, shelf - 0.12, 0, x + 0.012, shelf - 0.025, 0.1, th.frame);
  const bottles: PalKey[] = ['teal', 'amber', 'lilac', 'leaf', 'ember', 'moon', 'teal', 'neon'];
  bottles.forEach((c, i) => {
    const x = -hx + 0.18 + (i * (len - 0.36)) / (bottles.length - 1);
    const tall = 0.08 + hash1(i * 4.1) * 0.06;
    T.cyl(x, shelf, 0.075, 0.03, 0.028, tall, c, 8, { top: 0.1 });
    T.cyl(x, shelf + tall, 0.075, 0.014, 0.014, 0.025, 'cream', 6);
  });
  // sobre la cubierta, de un extremo al otro
  flask(b, -hx + 0.18, h, 0.2, 'teal');
  flask(b, -hx + 0.32, h, 0.14, 'neon', 0.8);
  // gradilla con tubos
  const rx = -hx + 0.62;
  T.box(rx - 0.14, h, 0.12, rx + 0.14, h + 0.02, 0.24, th.frame);
  T.box(rx - 0.14, h + 0.08, 0.12, rx + 0.14, h + 0.095, 0.24, th.frame);
  (['lime', 'lilac', 'teal', 'amber'] as const).forEach((c, i) => {
    const x = rx - 0.1 + i * 0.066;
    T.cyl(x, h + 0.01, 0.18, 0.015, 0.015, 0.06, c, 6);
    T.cyl(x, h + 0.07, 0.18, 0.014, 0.014, 0.08, 'moon', 6);
  });
  // balon sobre el mechero, con su soporte
  const bx = 0.05;
  T.cyl(bx, h, 0.2, 0.05, 0.05, 0.02, 'graphite', 8);
  T.cyl(bx, h + 0.02, 0.2, 0.012, 0.012, 0.08, 'stone', 6);
  b.geo('bulb').ico(bx, h + 0.11, 0.2, 0.022, 'amber');
  T.box(bx + 0.1, h, 0.19, bx + 0.115, h + 0.3, 0.21, 'graphite');
  T.box(bx + 0.02, h + 0.2, 0.195, bx + 0.11, h + 0.21, 0.205, 'graphite');
  T.ico(bx, h + 0.2, 0.2, 0.065, 'ember', { top: 0.12 });
  T.cyl(bx, h + 0.25, 0.2, 0.018, 0.018, 0.07, 'moon', 6);
  // vaso de precipitado y microscopio
  T.cyl(0.4, h, 0.22, 0.047, 0.047, 0.05, 'lilac', 8);
  T.cyl(0.4, h + 0.05, 0.22, 0.045, 0.045, 0.05, 'moon', 8, { top: 0.1 });
  const mx = hx - 0.35;
  T.box(mx - 0.08, h, 0.12, mx + 0.08, h + 0.025, 0.28, 'graphite');
  T.box(mx - 0.02, h + 0.025, 0.13, mx + 0.02, h + 0.24, 0.17, 'graphite');
  T.box(mx - 0.06, h + 0.1, 0.16, mx + 0.06, h + 0.115, 0.26, 'stone');
  T.boxC(mx, h + 0.24, 0.2, 0.035, 0.035, 0.16, 'navy', { rx: -0.6 });
  T.cyl(mx, h + 0.12, 0.22, 0.012, 0.012, 0.07, 'stone', 6);
  flask(b, hx - 0.14, h, 0.2, 'lime');
  return [[bx, h + 0.32, 0.2]];
}

/** carrito de cafe contra la pared (espalda en z = 0): cafetera espresso, molino, tazas y frasco de granos */
export function coffeeCart(b: B, deluxe: boolean, th: RoomTheme): [number, number, number][] {
  const T = b.geo('toon');
  const H = 0.86;
  // carro abierto por delante: costados y fondo de estructura, repisas y cubierta del color de las cubiertas
  T.box(-0.4, 0.06, 0, -0.375, H, 0.43, th.frame);
  T.box(0.375, 0.06, 0, 0.4, H, 0.43, th.frame);
  T.box(-0.375, 0.06, 0, 0.375, H, 0.03, th.frameL);
  T.box(-0.375, 0.06, 0, 0.375, 0.1, 0.43, th.topD);
  T.box(-0.375, 0.34, 0.03, 0.375, 0.365, 0.43, th.top, { top: 0.06 });
  T.box(-0.4, 0, 0.02, 0.4, 0.06, 0.4, 'ink');
  T.box(-0.42, H, 0, 0.42, H + 0.035, 0.45, th.top, { top: 0.06 });
  // tazas en la repisa, una lata y un saco de granos abajo
  for (const [x, c] of [[-0.26, 'cream'], [-0.14, 'teal'], [-0.02, 'ember']] as const) T.cyl(x, 0.37, 0.26, 0.04, 0.045, 0.08, c, 8);
  T.cyl(0.2, 0.37, 0.24, 0.07, 0.07, 0.16, 'amber', 10, { top: 0.1 });
  T.box(-0.3, 0.1, 0.08, 0.05, 0.26, 0.36, 'linen', { jitter: 0.06, top: 0.1 });
  // cafetera
  const y = H + 0.04;
  T.box(-0.34, y, 0.05, -0.04, y + 0.3, 0.3, 'night', { top: 0.1 });
  T.box(-0.32, y + 0.2, 0.3, -0.06, y + 0.27, 0.34, 'indigo');
  T.box(-0.22, y + 0.14, 0.3, -0.16, y + 0.2, 0.36, 'ink');
  T.box(-0.3, y, 0.28, -0.08, y + 0.02, 0.4, 'ink');
  T.cyl(-0.19, y + 0.02, 0.35, 0.035, 0.035, 0.065, 'cream', 8);
  b.geo('bulb').box(-0.1, y + 0.24, 0.301, -0.07, y + 0.26, 0.303, 'amber');
  // molino y frasco de granos
  T.cyl(0.08, y, 0.2, 0.07, 0.06, 0.16, 'graphite', 8);
  T.cyl(0.08, y + 0.16, 0.2, 0.04, 0.075, 0.1, 'cream', 8, { top: 0.1 });
  T.cyl(0.27, y, 0.22, 0.052, 0.052, 0.08, 'soil', 8);
  T.cyl(0.27, y + 0.08, 0.22, 0.05, 0.05, 0.04, 'moon', 8, { top: 0.12 });
  T.cyl(0.27, y + 0.12, 0.22, 0.054, 0.054, 0.015, th.frame, 8);
  const steam: [number, number, number][] = [[-0.19, y + 0.12, 0.35]];
  if (deluxe) {
    // cafeteria: tarta en su base y dos tazas mas
    T.cyl(0.26, y, 0.36, 0.02, 0.02, 0.04, 'paper', 6);
    T.cyl(0.26, y + 0.04, 0.36, 0.08, 0.08, 0.012, 'paper', 10);
    T.cyl(0.26, y + 0.052, 0.36, 0.06, 0.06, 0.05, 'blush', 10, { top: 0.12 });
    T.cyl(0.26, y + 0.102, 0.36, 0.062, 0.062, 0.01, 'cream', 10);
    for (const [x, c] of [[0.02, 'ember'], [0.12, 'teal']] as const) {
      T.cyl(x, y, 0.38, 0.035, 0.035, 0.07, c, 8);
      T.box(x + 0.035, y + 0.015, 0.37, x + 0.05, y + 0.055, 0.39, c);
    }
    steam.push([0.02, y + 0.09, 0.38]);
  }
  return steam;
}

/** mesa de reunion (centro en el origen): cubierta sobre patas de trineo, libretas, laptop y tazas */
export function meetingTable(b: B, w: number, d: number, h: number, th: RoomTheme): [number, number, number][] {
  const T = b.geo('toon');
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  T.box(x0, h - 0.04, z0, x1, h, z1, th.top, { jitter: 0.02, top: 0.08 });
  for (const x of [x0 + 0.08, x1 - 0.08]) sledLeg(T, x, z0 + 0.04, z1 - 0.04, h - 0.04, th.frame);
  T.box(x0 + 0.1, h - 0.07, -0.015, x1 - 0.1, h - 0.04, 0.015, th.frame);
  // una libreta frente a cada silla, una laptop y el centro con una planta
  const seats = 4;
  for (let i = 0; i < seats; i++) {
    const x = x0 + ((i + 0.5) * w) / seats;
    T.box(x - 0.1, h, z0 + 0.03, x + 0.06, h + 0.008, z0 + 0.17, i % 2 ? 'paper' : 'cream');
    T.box(x - 0.08, h + 0.008, z0 + 0.14, x + 0.04, h + 0.01, z0 + 0.15, 'navy');
  }
  T.box(-0.62, h, -0.05, -0.34, h + 0.012, 0.13, 'graphite');
  T.box(-0.62, h + 0.012, -0.06, -0.34, h + 0.17, -0.05, 'graphite');
  b.geo('bulb').box(-0.6, h + 0.03, -0.049, -0.36, h + 0.15, -0.047, 'cyan');
  deskPlant(T, 0.05, h, 0.03, 'trio');
  const steam = [mug(T, 0.5, h, 0.06, 'ember'), mug(T, -0.2, h, 0.08, 'cream')];
  return steam;
}

/** silla de la reunion mirando a +z (respaldo hacia -z): varilla de estructura, asiento y respaldo tapizados */
export function meetingChair(b: B, color: PalKey, th: RoomTheme): void {
  const T = b.geo('toon');
  const sy = DIM.SEAT_H;
  for (const x of [-0.16, 0.135]) for (const z of [-0.18, 0.145]) T.box(x, 0, z, x + 0.025, sy - 0.05, z + 0.025, th.frame);
  T.box(-0.18, sy - 0.07, -0.19, 0.18, sy - 0.04, 0.18, th.frame);
  T.box(-0.19, sy - 0.04, -0.2, 0.19, sy + 0.02, 0.19, color, { top: 0.1, jitter: 0.03 });
  T.box(-0.18, sy - 0.03, -0.225, -0.155, sy + 0.34, -0.2, th.frame);
  T.box(0.155, sy - 0.03, -0.225, 0.18, sy + 0.34, -0.2, th.frame);
  T.box(-0.19, sy + 0.14, -0.25, 0.19, sy + 0.38, -0.2, kshade(color, 0.85), { top: 0.1, jitter: 0.03 });
}

/**
 * Mesa de revision baja (se revisa de pie, inclinado con la lupa); centro en el origen, largo en x y frente
 * a +z. Pliegos, carpeta roja, sello y la lupa sobre un plano; la lampara la pone la sala (REVIEW_LAMP).
 */
export function reviewTable(b: B, len: number, d: number, h: number, th: RoomTheme): void {
  const T = b.geo('toon');
  const hx = len / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  T.box(-hx, h - 0.035, z0, hx, h, z1, th.top, { jitter: 0.02, top: 0.08 });
  for (const x of [-hx + 0.06, hx - 0.06]) sledLeg(T, x, z0 + 0.03, z1 - 0.03, h - 0.035, th.frame);
  T.box(-hx + 0.08, 0.12, z0 + 0.03, hx - 0.08, h - 0.08, z0 + 0.05, th.frameL);
  // plano grande con lineas, pliegos apilados, carpeta y sello
  T.box(-0.3, h, z0 + 0.05, 0.25, h + 0.005, z1 - 0.04, 'paper');
  for (const x of [-0.22, -0.08, 0.06, 0.18]) T.box(x, h + 0.005, z0 + 0.09, x + 0.012, h + 0.007, z1 - 0.08, 'sky');
  T.box(-0.26, h + 0.005, 0.02, 0.2, h + 0.007, 0.032, 'sky');
  T.box(0.24, h, z0 + 0.06, 0.4, h + 0.05, z1 - 0.1, 'cream', { top: 0.06 });
  T.box(-0.56, h, z0 + 0.07, -0.37, h + 0.02, z1 - 0.06, 'ember', { top: 0.06 });
  T.cyl(0.32, h + 0.05, 0.0, 0.02, 0.02, 0.04, th.frame, 6);
  T.cyl(0.32, h + 0.05, 0.0, 0.028, 0.028, 0.01, 'plum', 8);
  // lupa sobre el plano
  T.cyl(-0.05, h + 0.005, 0.02, 0.06, 0.06, 0.012, 'amber', 12);
  b.geo('bulb').cyl(-0.05, h + 0.008, 0.02, 0.048, 0.048, 0.012, 'moon', 12);
  T.boxC(0.05, h + 0.012, 0.08, 0.1, 0.018, 0.022, th.frame, { ry: -0.6 });
}

/** lampara de la mesa de revision (coordenadas de la mesa): en la punta de adelante, alumbrando el plano */
export const REVIEW_LAMP = { x: 0.5, z: 0, ry: Math.PI } as const;

/** corcho con notas y fotos (espalda en z = 0, base en y = 0): la pared del taller */
export function corkboard(b: B, th: RoomTheme): void {
  const T = b.geo('toon');
  T.box(-0.35, 0, 0, 0.35, 0.49, 0.025, th.trim, { top: 0.06 });
  T.box(-0.33, 0.02, 0.025, 0.33, 0.47, 0.035, 'birch', { jitter: 0.05 });
  const notes: [number, number, PalKey][] = [
    [-0.22, 0.34, 'neon'],
    [-0.06, 0.36, 'amber'],
    [0.14, 0.33, 'cream'],
    [-0.18, 0.14, 'teal'],
    [0.02, 0.16, 'leaf'],
    [0.2, 0.14, 'amber'],
  ];
  notes.forEach(([x, y, c], i) => {
    T.boxC(x, y, 0.04, 0.11, 0.11, 0.008, c, { rz: (hash1(i * 2.3) - 0.5) * 0.25 });
    T.cyl(x, y + 0.04, 0.046, 0.008, 0.008, 0.008, 'ember', 6, { rx: Math.PI / 2 });
  });
}

export function waterDispenser(b: B): void {
  const T = b.geo('toon');
  T.box(-0.17, 0, -0.17, 0.17, 0.95, 0.17, 'cream', { top: 0.06, jitter: 0.03 });
  T.box(-0.18, 0, -0.18, 0.18, 0.06, 0.18, 'night');
  T.box(-0.12, 0.45, 0.17, 0.12, 0.72, 0.176, 'lavender');
  T.box(-0.1, 0.45, 0.17, 0.1, 0.47, 0.25, 'indigo');
  T.box(-0.075, 0.6, 0.176, -0.035, 0.64, 0.21, 'ember');
  T.box(0.035, 0.6, 0.176, 0.075, 0.64, 0.21, 'teal');
  T.cyl(0, 0.95, 0, 0.05, 0.05, 0.05, 'moon', 8);
  T.cyl(0, 1.0, 0, 0.14, 0.14, 0.32, 'moon', 16, { top: 0.12, jitter: 0.03 });
  T.cyl(0, 1.32, 0, 0.13, 0.06, 0.05, 'moon', 16);
  T.box(0.17, 0.5, -0.05, 0.22, 0.74, 0.05, 'lavender');
  T.cyl(0.195, 0.74, 0, 0.03, 0.035, 0.05, 'cream', 8);
  b.geo('bulb').box(-0.02, 0.76, 0.176, 0.02, 0.78, 0.18, 'cyan');
}

/** cuadro con marco de nogal: el unico acento de madera que quedo en la sala (v3) */
export function painting(b: B, variant: number): void {
  b.geo('toon').box(-0.32, 0, 0, 0.32, 0.48, 0.035, 'walnut', { top: 0.06 });
  const uv = LIT_UV.paintings[variant % 2] ?? LIT_UV.paintings[0];
  if (uv) b.geo('lit').qz(-0.28, 0.04, 0.28, 0.44, 0.036, '#ffffff', { uvRect: uv });
}

/** reloj de pared: origen en el centro de la esfera; la hora la pinta la textura */
export function wallClock(b: B, th: RoomTheme): void {
  const m = new Matrix4().compose(new Vector3(0, 0, 0.02), new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0)), new Vector3(1, 1, 1));
  b.geo('toon').add(new CylinderGeometry(0.19, 0.19, 0.04, 20), m, th.trim);
  b.geo('lit').qz(-0.135, -0.135, 0.135, 0.135, 0.041, '#ffffff', { uvRect: LIT_UV.clock });
}

// ---------------------------------------------------------------- arquitectura

interface Opening {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

function segs(a: number, b: number, holes: [number, number][]): [number, number][] {
  const hs = [...holes].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cur = a;
  for (const [h0, h1] of hs) {
    if (h0 > cur) out.push([cur, h0]);
    cur = Math.max(cur, h1);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

/**
 * Pared a lo largo de x en [x0, x1], cara interior en z = 0 y grosor hacia -z. \`side\` = pared lateral
 * (la de la puerta): yeso pintado con friso de madera listonada. Si no, la del fondo: ladrillo visto (o
 * lisa, segun el estilo) con zocalo de madera. Las dos llevan tapa de acero.
 */
export function wallRun(b: B, x0: number, x1: number, ops: Opening[], side: boolean, th: RoomTheme): void {
  const T = b.geo('toon');
  const H = DIM.WALL_H;
  const WT = DIM.WALL_T;
  const body = !side && th.brick ? b.geo('brick') : T;
  const color = side ? th.wallSide : th.wall;
  const s = [...ops].sort((p, q) => p.a0 - q.a0);
  const put = (a: number, c: number, ya: number, yb: number) => {
    if (c - a > 0.001 && yb - ya > 0.001) body.box(a, ya, -WT, c, yb, 0, color, { jitter: side ? 0.012 : 0, sharp: true });
  };
  let cur = x0;
  for (const o of s) {
    put(cur, o.a0, 0, H);
    put(o.a0, o.a1, 0, o.y0);
    put(o.a0, o.a1, o.y1, H);
    cur = o.a1;
  }
  put(cur, x1, 0, H);
  T.box(x0 - 0.02, H, -WT - 0.02, x1, H + 0.035, 0.02, th.trim, { top: 0.06, sharp: true });
  if (side) {
    // friso de listones de madera hasta media altura, con remate
    for (const [a, c] of segs(x0, x1, s.filter((o) => o.y0 < 0.6).map((o) => [o.a0, o.a1]))) {
      const n = Math.max(1, Math.round((c - a) / 0.09));
      const step = (c - a) / n;
      for (let i = 0; i < n; i++) T.box(a + i * step + 0.012, 0.05, 0, a + (i + 1) * step - 0.012, 0.6, 0.02, th.wallLow, { jitter: 0.05 });
      T.box(a, 0.6, 0, c, 0.63, 0.03, th.wallLow, { top: 0.08 });
    }
  }
  for (const [a, c] of segs(x0, x1, s.filter((o) => o.y0 < 0.1).map((o) => [o.a0, o.a1]))) {
    T.box(a, 0, 0, c, 0.06, 0.022, side ? th.wallLow : th.trim);
  }
}

/** ventanal de tres hojas con cielo vivo, cortinas y riel; origen en el centro inferior del hueco */
export function windowPiece(b: B, w: number, h: number, th: RoomTheme): void {
  const S = b.geo('sky');
  for (let i = 0; i < 3; i++) {
    const a = -w / 2 + (w * i) / 3;
    const c = a + w / 3;
    const uv: UvRect = [i / 3, 0, (i + 1) / 3, 1];
    S.qz(a, 0, c, h, -0.1, '#ffffff', { uvRect: uv });
  }
  // perfil fino del color de remate, repisa del color de las cubiertas y, si el estilo lo lleva, neon
  const T = b.geo('toon');
  T.box(-w / 2 - 0.05, -0.035, -0.2, w / 2 + 0.05, 0, 0.07, th.top, { top: 0.06 });
  T.box(-w / 2 - 0.025, h, -0.2, w / 2 + 0.025, h + 0.025, 0.015, th.trim);
  T.box(-w / 2 - 0.025, 0, -0.08, -w / 2, h, 0.015, th.trim);
  T.box(w / 2, 0, -0.08, w / 2 + 0.025, h, 0.015, th.trim);
  for (const x of [-w / 6, w / 6]) T.box(x - 0.016, 0, -0.12, x + 0.016, h, -0.08, th.trim);
  for (const x of [-w / 3, 0, w / 3]) T.box(x - 0.007, 0, -0.12, x + 0.007, h, -0.09, th.trim);
  T.box(-w / 2, h * 0.58, -0.12, w / 2, h * 0.58 + 0.012, -0.09, th.trim);
  if (th.windowNeon !== null) {
    // los costados quedan tras las cortinas: el neon va arriba y bajo la repisa
    const N = b.geo('bulb');
    N.box(-w / 2 - 0.02, h + 0.025, 0.0, w / 2 + 0.02, h + 0.037, 0.012, th.windowNeon);
    N.box(-w / 2 + 0.04, -0.047, 0.05, w / 2 - 0.04, -0.035, 0.064, th.windowNeon);
  }
  T.box(-w / 2 - 0.42, h + 0.1, 0.05, w / 2 + 0.42, h + 0.12, 0.07, th.frame);
  for (const sx of [-1, 1]) T.cyl(sx * (w / 2 + 0.43), h + 0.09, 0.06, 0.02, 0.02, 0.04, th.frame, 6);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const xa = sx < 0 ? -w / 2 - 0.38 + i * 0.08 : w / 2 - 0.02 + i * 0.08;
      const dz = i % 2 ? 0.07 : 0.1;
      T.box(xa, -0.28, 0.03, xa + 0.08, h + 0.1, dz, i % 2 ? kshade(th.curtain, 0.78) : th.curtain, { jitter: 0.03 });
    }
    T.box(sx < 0 ? -w / 2 - 0.39 : w / 2 - 0.03, 0.2, 0.02, sx < 0 ? -w / 2 + 0.03 : w / 2 + 0.39, 0.25, 0.11, 'amber');
  }
}

export const DOOR_W = 0.82;

/** marco de puerta y felpudo HOLA (la hoja va aparte para poder abrirse); origen en el centro del hueco */
export function doorFrame(b: B, W: number, H: number, th: RoomTheme): void {
  const T = b.geo('toon');
  T.box(-W / 2 - 0.04, 0, -0.22, -W / 2, H + 0.04, 0.025, th.trim);
  T.box(W / 2, 0, -0.22, W / 2 + 0.04, H + 0.04, 0.025, th.trim);
  T.box(-W / 2 - 0.04, H, -0.22, W / 2 + 0.04, H + 0.04, 0.025, th.trim, { top: 0.06 });
  T.box(-0.38, 0, 0.05, 0.38, 0.012, 0.58, 'steel');
  b.geo('lit').qy(-0.38, 0.05, 0.38, 0.58, 0.013, '#ffffff', { uvRect: LIT_UV.doormat });
}

const doorLeafGeo = new Map<string, BufferGeometry>();

/** hoja de puerta con bisagra en el origen: se extiende hacia +x y gira en y (una por estilo) */
export function doorLeafGeometry(W: number, H: number, th: RoomTheme): BufferGeometry {
  const hit = doorLeafGeo.get(th.id);
  if (hit) return hit;
  const L = new KitGeo(9);
  // hoja lisa del color del estilo con mirilla de vidrio esmerilado y manilla larga
  L.box(0, 0, -0.05, W - 0.01, H - 0.01, 0, th.door, { jitter: 0.02 });
  L.box(0.14, 0.78, 0, 0.26, 1.2, 0.008, 'lavender');
  L.box(0.14, 0.78, -0.058, 0.26, 1.2, -0.05, 'lavender');
  L.box(W - 0.12, 0.42, 0, W - 0.09, 0.78, 0.05, th.frame);
  L.box(W - 0.12, 0.42, -0.1, W - 0.09, 0.78, -0.05, th.frame);
  const g = L.build();
  doorLeafGeo.set(th.id, g);
  return g;
}

/** alfombra: base y textura del atlas (una de las del estilo). Un estilo sin alfombras deja el piso a la vista */
export function rug(b: B, variant: number, w: number, d: number, th: RoomTheme): void {
  if (th.rugs.length === 0) return;
  b.geo('toon').box(-w / 2, 0, -d / 2, w / 2, 0.008, d / 2, th.rugBase);
  const uv = LIT_UV.rugs[th.rugs[variant % th.rugs.length] ?? 0] ?? LIT_UV.rugs[0];
  if (uv) b.geo('lit').qy(-w / 2, -d / 2, w / 2, d / 2, 0.009, '#ffffff', { uvRect: uv });
}

/** marco del cartel de sala (la cara con el texto es una malla aparte, una por sala) */
export function roomSignFrame(b: B, th: RoomTheme): void {
  const T = b.geo('toon');
  T.box(-0.5, 0, -0.025, -0.46, 0.08, 0.005, 'ink');
  T.box(0.46, 0, -0.025, 0.5, 0.08, 0.005, 'ink');
  T.box(-0.66, 0.06, -0.03, 0.66, 0.5, 0, th.trim, { top: 0.06 });
}

/** cara del cartel: quad de 1,24 x 0,38 en coordenadas del cartel */
export const SIGN_FACE = { x0: -0.62, y0: 0.09, x1: 0.62, y1: 0.47, z: 0.001 } as const;
