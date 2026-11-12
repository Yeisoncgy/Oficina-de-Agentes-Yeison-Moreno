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
 * Paleta A "Estudio nocturno v2": tinta, indigos y violeta de pared, ciruela y ambar, y neones de
 * pantalla. Los tonos del estudio botanico (macetas, cajoneras, verdes de las plantas) van entonados
 * con la noche: saturados a media luz para que la lampara los encienda.
 * v3 "Loft lofi" (menos madera, mas moderno): muebles hueso con metal negro, piso de
 * microcemento y neon magenta/cian al pie de las paredes. La madera (nogal) queda para los cuadros.
 */
export const PAL = {
  ink: '#14132B',
  night: '#232553',
  indigo: '#3A3F7A',
  dusk: '#6B5E9E',
  lavender: '#9A96C4',
  wall: '#5E4486',
  /** franja baja de la pared, un tono mas hondo */
  wallLow: '#47306A',
  /** cubiertas y paneles: blanco hueso calido */
  bone: '#E9E1D6',
  boneD: '#C9BEB3',
  /** metal negro con pintura en polvo (patas, marcos, repisas) */
  steel: '#22233A',
  steelL: '#3A3B58',
  /** neon de las tiras de pared y del canto de los escritorios */
  magenta: '#FF4FAE',
  moon: '#8FA6E8',
  cream: '#FFE3B0',
  amber: '#F5A94A',
  ember: '#D9673B',
  walnut: '#6E4632',
  honey: '#A8704A',
  plum: '#7A3E63',
  leaf: '#5E9A5F',
  moss: '#2C5446',
  cyan: '#6FF0E4',
  teal: '#2FA6A6',
  neon: '#F07BA8',
  skinL: '#F2C19B',
  skinD: '#A86B4C',
  // estudio botanico, entonado con la noche
  paper: '#E8D9BF',
  linen: '#D2BE9C',
  oak: '#8C5A3C',
  birch: '#B98459',
  stone: '#7E7A9C',
  graphite: '#2E3050',
  sage: '#7C9A78',
  sageD: '#557A5E',
  terra: '#B35B3D',
  blush: '#C4847E',
  mustard: '#D39A3C',
  sky: '#6485BF',
  navy: '#2E4470',
  coral: '#E07A5C',
  lilac: '#9B82C9',
  soil: '#3A2820',
  // verdes de las plantas (de mas oscuro a mas claro): musgo y hoja, con brillo calido arriba
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
 * Luz del kit por hora. La oficina vive de noche (daylight.ts, LOFI_HOUR); dia y atardecer solo se ven
 * con ?hora=H. De noche la hemisferica es poca y fria arriba (luna) con un rebote ciruela abajo: el
 * contraste lo pone la luz calida de las lamparas, no un ambiente plano subido.
 */
export const LIGHT: Record<'day' | 'dusk' | 'night', LightPreset> = {
  day: { skyTop: '#8E93C9', skyBot: '#E4D3DE', sun: '#FFE9CC', sunI: 0.8, hemiSky: '#B9B2E0', hemiGround: '#6B5E9E', hemiI: 0.62, lampI: 0.35, stars: 0 },
  dusk: { skyTop: '#3D3A7A', skyBot: '#F29A6B', sun: '#FF9A5C', sunI: 0.65, hemiSky: '#A08CC8', hemiGround: '#5A4A86', hemiI: 0.55, lampI: 0.8, stars: 0.2 },
  night: { skyTop: '#0E0F2A', skyBot: '#2A2760', sun: '#8FA6E8', sunI: 0.34, hemiSky: '#6A6FB8', hemiGround: '#3E2A50', hemiI: 0.46, lampI: 1.0, stars: 1 },
};

/** rampa toon de 3 escalones (28 % · 62 % · 100 %) */
export const TOON_STEPS = [72, 158, 255] as const;
/** fuerza del contorno tinta de 1 px */
export const INK_MIX = 0.9;
/** la unica luz puntual de cada sala: ambar de lampara, el charco calido que da el contraste */
export const LAMP_LIGHT = { color: '#FFB25A', intensity: 4.6, distance: 10, decay: 1.2, pos: [0.6, 2.4, 0.1] } as const;
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
  const el = ((W.night > 0.6 ? 50 : 18 + 40 * Math.sin(Math.PI * dayT)) * Math.PI) / 180;
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
