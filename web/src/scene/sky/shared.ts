// Contrato y utilidades de los fondos de cielo (scene/sky). Cada fondo es un archivo de esta carpeta que
// exporta `painter`; scene/sky/index.ts los registra solos y CinePipeline pinta con el elegido.
// La textura es RGBA de 8 bits en sRGB, de w x h; LA FILA 0 ES EL BORDE DE ABAJO DE LA PANTALLA. Se estira a
// toda la ventana (normalmente 16:9), detras de la oficina isometrica, que ocupa el centro.

import type { DayState } from '../daylight';

export const SKY_W = 1024;
export const SKY_H = 512;

/**
 * Lo que un fondo puede leer de la hora. Los colores vienen en lineal (three.Color): pasalos por `srgb8`.
 * daylight + dusk + night suman ~1 y cambian de forma continua con la hora: usa esos pesos (y `hour` para
 * distinguir manana de tarde) en vez de saltos por tramos, asi no hay cambios bruscos de un minuto a otro.
 */
export type SkyDay = Pick<DayState, 'hour' | 'daylight' | 'dusk' | 'night' | 'stars' | 'skyTop' | 'skyBottom' | 'sunColor'>;

export interface SkyPainter {
  /** nombre corto en minusculas, sin espacios: el del archivo y el de ?cielo=nombre */
  name: string;
  /** como se le presenta al usuario */
  label: string;
  /** pinta toda la textura; determinista (sin Math.random ni Date) y sin asignar memoria por pixel */
  paint(data: Uint8Array, w: number, h: number, day: SkyDay): void;
}

/** lineal (0..1) a sRGB de 8 bits, sin redondear (para sumar grano antes de escribir) */
export function srgb8(v: number): number {
  return 255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** azar estable 0..1 a partir de un numero (para repartir cosas: estrellas, nubes) */
export function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** azar estable 0..1 por coordenada entera (grano por pixel, celdas de ruido): sin patrones en rejilla */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** ruido de valor suave 0..1 (una octava) */
export function vnoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let fx = x - x0;
  let fy = y - y0;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
}

/** ruido fractal 0..1: `octaves` octavas de vnoise (cada una al doble de frecuencia y la mitad de peso) */
export function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(fx, fy);
    norm += amp;
    amp *= 0.5;
    fx = fx * 2 + 17.3;
    fy = fy * 2 + 9.1;
  }
  return sum / norm;
}

/** grano de +-0,8 en una tabla de 64 x 64 (sin calcular azar por pixel; a ese nivel no se nota la repeticion) */
const GRAIN = new Float32Array(64 * 64);
for (let i = 0; i < GRAIN.length; i++) GRAIN[i] = (hash2(i & 63, i >> 6) - 0.5) * 1.6;

/** escribe un pixel (valores 0..255 sin redondear) con grano de +-0,8 para que los degradados no hagan bandas */
export function put(data: Uint8Array, w: number, x: number, y: number, r: number, g: number, b: number): void {
  const n = (GRAIN[((y & 63) << 6) | (x & 63)] as number) + 0.5;
  const i = (y * w + x) * 4;
  // Uint8Array trunca: con +0,5 queda redondeado
  let v = r + n;
  data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  v = g + n;
  data[i + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
  v = b + n;
  data[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  data[i + 3] = 255;
}
