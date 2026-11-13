// Constantes del Kit 3D (D4) y de la direccion "Estudio nocturno v2" (D1, paleta A), y las curvas de D5.
// Todo lo de la escena sale de aqui: medidas, paleta, luz por hora, escalones toon, tinta, lampara,
// camara y pixel. Funciones puras (sin React), probadas en web/test/scene.test.ts.

import { Color } from 'three';

/** 1 unidad = 1 m, y hacia arriba. Sala 7,2 x 6; el piso de la sala esta FLOOR_H sobre el pasillo. */
export const DIM = {
  ROOM_W: 7.2,
  ROOM_D: 6,
  WALL_H: 1.6,
  WALL_T: 0.2,
  CORRIDOR_W: 2,
  HALL_D: 2.4,
  FLOOR_H: 0.06,
  DESK: { w: 1.2, d: 0.62, h: 0.75 },
  LEAD_DESK: { w: 1.9, d: 0.75, h: 0.75 },
  SEAT_H: 0.45,
  CHAR_H: 1.1,
  SIT_LIFT: 0.19,
} as const;

/**
 * Paleta "Loft cinematografico": ladrillo, madera, acero negro y yeso verde botella, con mostaza,
 * terracota y verde azulado de acento. Es la paleta de la oficina elegida en propuestas/estilos.html.
 * Las claves vienen del kit anterior (asi las piezas no cambian); solo cambian los colores. Ya no hay
 * neones: 'magenta', 'cyan' y 'neon' quedan como acentos mate.
 */
export const PAL = {
  ink: '#14151C',
  night: '#1D2233',
  indigo: '#34405F',
  dusk: '#6B7391',
  lavender: '#A3A9BD',
  /** yeso de la pared lateral */
  wall: '#1F3D3B',
  wallLow: '#9A6A45',
  /** cubiertas claras: crema y roble */
  bone: '#EFE4CF',
  boneD: '#D6C8AE',
  /** acero negro (patas, marcos, perfiles) */
  steel: '#1D1F26',
  steelL: '#3A3D48',
  magenta: '#D9674A',
  moon: '#9DB4E8',
  cream: '#F6E7C4',
  amber: '#E0A93B',
  ember: '#C8553D',
  walnut: '#7A4F36',
  honey: '#B07A4F',
  plum: '#6B3F63',
  leaf: '#4F8F5C',
  moss: '#2A5A3C',
  cyan: '#7FD6C2',
  teal: '#2F8F83',
  neon: '#E7A9A0',
  skinL: '#F0C4A0',
  skinD: '#B07A58',
  paper: '#F1E6D0',
  linen: '#D9C8A8',
  oak: '#B98A5C',
  birch: '#D8B189',
  stone: '#8A878F',
  graphite: '#2A2C36',
  sage: '#8FAE96',
  sageD: '#5F8A70',
  terra: '#C26A4A',
  blush: '#E7A9A0',
  mustard: '#E0A93B',
  sky: '#6F8FC0',
  navy: '#26355A',
  coral: '#E07A5C',
  lilac: '#A495C9',
  soil: '#3A2A20',
  jungle: '#2E5A45',
  fern: '#4E8A55',
  olive: '#6E7E45',
  mint: '#7FAE84',
  lime: '#9DBF5C',
} as const;

export type PalKey = keyof typeof PAL;

interface LightPreset {
  skyTop: string;
  skyBot: string;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  lampI: number;
  stars: number;
}

/**
 * Luz por hora, para materiales fisicos (PBR) con mapeo de tonos ACES. La oficina sigue la hora real
 * (daylight.ts): de dia entra una luz dorada y baja, al atardecer el sol naranja alarga las sombras y de
 * noche queda la luna fria con las lamparas tibias de cada sala. Nada encandila: el contraste lo pone la
 * sombra, no el brillo.
 */
export const LIGHT: Record<'day' | 'dusk' | 'night', LightPreset> = {
  day: { skyTop: '#4F7FC2', skyBot: '#F3DDBE', sun: '#FFDFB8', sunI: 1.15, hemiSky: '#CFDCFF', hemiGround: '#9A8878', hemiI: 0.66, lampI: 0.35, stars: 0 },
  dusk: { skyTop: '#2B2A5A', skyBot: '#F6C27A', sun: '#FF9A5C', sunI: 1.25, hemiSky: '#F6B4A8', hemiGround: '#7A5458', hemiI: 0.52, lampI: 0.8, stars: 0.25 },
  night: { skyTop: '#0A0F24', skyBot: '#2A2444', sun: '#A9BCFF', sunI: 0.7, hemiSky: '#8A9BE0', hemiGround: '#4A3A50', hemiI: 0.56, lampI: 1.0, stars: 1 },
};

/** rampa toon de 3 escalones (28 % · 62 % · 100 %) */
export const TOON_STEPS = [72, 158, 255] as const;
/** fuerza del contorno tinta de 1 px */
export const INK_MIX = 0.9;
/** la unica luz puntual de cada sala: ambar de lampara, el charco calido que da el contraste */
export const LAMP_LIGHT = { color: '#FFD2A0', intensity: 9, distance: 11, decay: 1.5, pos: [0.4, 2.3, 0.2] } as const;
/** camara isometrica verdadera; se gira +-40 grados en azimut */
export const CAMERA = {
  azimuth: Math.PI / 4,
  polar: Math.acos(1 / Math.sqrt(3)),
  distance: 60,
  range: (40 * Math.PI) / 180,
} as const;
/** tamano del pixel de arte por defecto (px CSS); v2 esta pensada para 2 px */
export const KIT_PIXEL = 2;

/** decoraciones de sala: se asignan por hash del id para que nunca cambien */
export const DECOR = ['Biblioteca', 'Taller', 'Cafetería'] as const;
export type DecorId = 0 | 1 | 2;

// ---------------------------------------------------------------- utilidades

export const hash1 = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function hashStr(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h;
}

export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));

export function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export const bump = (x: number, c: number, w: number): number => Math.max(0, 1 - Math.abs(x - c) / w);

/** decoracion (0 Biblioteca, 1 Taller, 2 Cafeteria) y alfombra (0 kilim, 1 rayas, 2 damero) de una sala */
export function decorOf(roomId: string): { decor: DecorId; rug: DecorId } {
  const h = hashStr(roomId);
  return { decor: (h % 3) as DecorId, rug: (Math.floor(h / 3) % 3) as DecorId };
}

// ---------------------------------------------------------------- luz por hora

export interface DayWeights {
  h: number;
  day: number;
  dusk: number;
  night: number;
}

/** pesos dia / atardecer / noche (suman 1) */
export function dayWeights(hour: number): DayWeights {
  const h = ((hour % 24) + 24) % 24;
  const day = smooth(5.5, 7.5, h) * (1 - smooth(17.5, 19.5, h));
  const dusk = Math.max(bump(h, 18.6, 1.4), bump(h, 6.5, 1.1));
  const night = Math.max(0, 1 - day - dusk * 0.7);
  const s = day + dusk + night;
  return { h, day: day / s, dusk: dusk / s, night: night / s };
}

export interface LightKey {
  W: DayWeights;
  skyTop: Color;
  skyBot: Color;
  sun: Color;
  hemiSky: Color;
  hemiGround: Color;
  sunI: number;
  hemiI: number;
  lampI: number;
  stars: number;
}

type ColorKey = 'skyTop' | 'skyBot' | 'sun' | 'hemiSky' | 'hemiGround';
type NumKey = 'sunI' | 'hemiI' | 'lampI' | 'stars';

/** mezcla los tres presets de LIGHT con los pesos de la hora */
export function lightKey(hour: number): LightKey {
  const W = dayWeights(hour);
  const col = (k: ColorKey): Color => {
    const c = new Color(0, 0, 0);
    c.add(new Color(LIGHT.day[k]).multiplyScalar(W.day));
    c.add(new Color(LIGHT.dusk[k]).multiplyScalar(W.dusk));
    c.add(new Color(LIGHT.night[k]).multiplyScalar(W.night));
    return c;
  };
  const num = (k: NumKey): number => LIGHT.day[k] * W.day + LIGHT.dusk[k] * W.dusk + LIGHT.night[k] * W.night;
  return {
    W,
    skyTop: col('skyTop'),
    skyBot: col('skyBot'),
    sun: col('sun'),
    hemiSky: col('hemiSky'),
    hemiGround: col('hemiGround'),
    sunI: num('sunI'),
    hemiI: num('hemiI'),
    lampI: num('lampI'),
    stars: num('stars'),
  };
}

/**
 * Direccion hacia el sol / la luna (unitaria). Siempre entra por detras de la pared del fondo: de dia
 * recorre un arco de 30 a 115 grados; de noche la luna queda fija a 70 grados y 50 de altura.
 */
export function sunDirection(W: DayWeights, out: { x: number; y: number; z: number }): void {
  const dayT = clamp((W.h - 6) / 12);
  const th = ((W.night > 0.6 ? 70 : 30 + 85 * dayT) * Math.PI) / 180;
  const el = ((W.night > 0.6 ? 50 : 30 + 28 * Math.sin(Math.PI * dayT)) * Math.PI) / 180;
  out.x = -Math.cos(th) * Math.cos(el);
  out.y = Math.sin(el);
  out.z = -Math.sin(th) * Math.cos(el);
}

// ---------------------------------------------------------------- curvas de D5

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 22; i++) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

export const CURVE = {
  llegar: bezier(0.22, 1, 0.36, 1),
  irse: bezier(0.64, 0, 0.78, 0),
  cambiar: bezier(0.65, 0, 0.35, 1),
  rebotar: bezier(0.34, 1.56, 0.64, 1),
} as const;

/** encendido "en pasos" de pantallas y lamparas: 70 % -> 15 % -> 85 % -> 100 % en 180 ms */
export function flickerOn(e: number): number {
  if (e < 0) return 0;
  if (e < 0.06) return 0.7;
  if (e < 0.12) return 0.15;
  if (e < 0.18) return 0.85;
  return 1;
}

/** apagado de pantalla: 50 % y apagada en 120 ms */
export function flickerOff(e: number): number {
  if (e < 0) return 1;
  if (e < 0.06) return 0.5;
  return 0;
}
