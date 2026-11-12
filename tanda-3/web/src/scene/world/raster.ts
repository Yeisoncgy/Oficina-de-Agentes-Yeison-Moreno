// Lienzo de pixeles por software (sin <canvas>: funciona en node y en las pruebas) y los pintores del
// Kit 3D portados tal cual: microcemento, exterior (adoquines, aceras y cruces), pantallas, cielo en vivo, reloj, alfombras, felpudo,
// cuadros, pizarra, placa, cartel de sala, burbuja y halo. Todo a 1 texel = 1 pixel de arte.

import { Color } from 'three';
import { clamp, hash1, type LightKey, PAL, type PalKey } from './kit';

type RGB = readonly [number, number, number];
export type Paint = PalKey | string;

const rgbCache = new Map<string, RGB>();

function parseHex(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbOf(c: Paint): RGB {
  const hit = rgbCache.get(c);
  if (hit) return hit;
  const hex = c in PAL ? PAL[c as PalKey] : c;
  const rgb = parseHex(hex);
  rgbCache.set(c, rgb);
  return rgb;
}

/** '#rrggbb' (sRGB) de un Color de three */
export function hexOf(c: Color): string {
  return `#${c.getHexString()}`;
}

/** mezcla dos colores en espacio lineal, como el kit (mixHex) */
export function mixHex(a: Paint | Color, b: Paint | Color, t: number): string {
  const ca = a instanceof Color ? a.clone() : new Color(rgbHex(a));
  const cb = b instanceof Color ? b : new Color(rgbHex(b));
  return hexOf(ca.lerp(cb, t));
}

function rgbHex(c: Paint): string {
  return c in PAL ? PAL[c as PalKey] : c;
}

/**
 * Vista de pintura sobre un buffer RGBA. (0, 0) es la esquina superior izquierda, como en un canvas;
 * el buffer guarda la fila 0 abajo (convencion de DataTexture), asi que la y se invierte al escribir.
 */
export class Raster {
  /** equivalente a globalAlpha */
  alpha = 1;

  constructor(
    readonly data: Uint8Array,
    private readonly bw: number,
    private readonly bh: number,
    readonly w: number = bw,
    readonly h: number = bh,
    private readonly ox = 0,
    private readonly oy = 0,
  ) {}

  static create(w: number, h: number): Raster {
    return new Raster(new Uint8Array(w * h * 4), w, h);
  }

  /** subregion (atlas) con recorte propio */
  sub(x: number, y: number, w: number, h: number): Raster {
    return new Raster(this.data, this.bw, this.bh, w, h, this.ox + x, this.oy + y);
  }

  /** fillRect con el color de la paleta (o '#hex') y el alpha actual */
  px(c: Paint, x: number, y: number, w = 1, h = 1): void {
    const [r, g, b] = rgbOf(c);
    this.fill(r, g, b, 255, x, y, w, h);
  }

  /** fillRect con color y alpha explicitos (0..255), mezcla source-over */
  fill(r: number, g: number, b: number, a255: number, x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w));
    const y1 = Math.min(this.h, Math.floor(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const a = (a255 / 255) * this.alpha;
    if (a <= 0) return;
    const d = this.data;
    for (let yy = y0; yy < y1; yy++) {
      const row = (this.bh - 1 - (this.oy + yy)) * this.bw;
      for (let xx = x0; xx < x1; xx++) {
        const i = (row + this.ox + xx) * 4;
        if (a >= 1) {
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = 255;
        } else {
          const da = (d[i + 3] ?? 0) / 255;
          const oa = a + da * (1 - a);
          const k = oa > 0 ? 1 / oa : 0;
          d[i] = Math.round((r * a + (d[i] ?? 0) * da * (1 - a)) * k);
          d[i + 1] = Math.round((g * a + (d[i + 1] ?? 0) * da * (1 - a)) * k);
          d[i + 2] = Math.round((b * a + (d[i + 2] ?? 0) * da * (1 - a)) * k);
          d[i + 3] = Math.round(oa * 255);
        }
      }
    }
  }

  /** deja la region transparente */
  clear(): void {
    const d = this.data;
    for (let yy = 0; yy < this.h; yy++) {
      const row = (this.bh - 1 - (this.oy + yy)) * this.bw;
      for (let xx = 0; xx < this.w; xx++) {
        const i = (row + this.ox + xx) * 4;
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 0;
      }
    }
  }
}

// ---------------------------------------------------------------- fuente 3x5

const FONT: Record<string, string> = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.', E: '### #.. ##. #.. ###',
  F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#', I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.',
  K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###', M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '### #.# #.# #.# ###',
  P: '##. #.# ##. #.. #..', Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#', Y: '#.# #.# .#. .#. .#.',
  Z: '### ..# .#. #.. ###', '0': '### #.# #.# #.# ###', '1': '.#. ##. .#. .#. ###', '2': '##. ..# .#. #.. ###', '3': '##. ..# .#. ..# ##.',
  '4': '#.# #.# ### ..# ..#', '5': '### #.. ##. ..# ##.', '6': '.## #.. ### #.# ###', '7': '### ..# .#. .#. .#.', '8': '### #.# ### #.# ###',
  '9': '### #.# ### ..# ##.', '.': '... ... ... ... .#.', '-': '... ... ### ... ...', ':': '... .#. ... .#. ...', '?': '##. ..# .#. ... .#.',
  '!': '.#. .#. .#. ... .#.',
};

const GLYPHS = new Map<string, boolean[][]>(
  Object.entries(FONT).map(([ch, rows]) => [ch, rows.split(' ').map((r) => [...r].map((c) => c === '#'))]),
);

/** mayusculas sin tildes (la fuente solo tiene A-Z, 0-9 y . - : ? !) */
export const norm = (s: string): string =>
  s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const textW = (s: string, k = 1): number => (norm(s).length * 4 - 1) * k;

/** recorta el texto para que quepa en maxW pixeles */
export function fitText(s: string, maxW: number, k = 1): string {
  let out = norm(s).trim();
  while (out.length > 1 && textW(out, k) > maxW) out = out.slice(0, -1);
  return out.trim();
}

/**
 * Nombre para la placa del escritorio del lider: mayusculas sin tildes y solo lo que la fuente dibuja; lo
 * demas (emojis, otros alfabetos, signos) se cae. Vacio si no queda nada. El largo lo recorta fitText.
 */
export function plateText(name: string): string {
  return [...norm(name)]
    .map((ch) => (GLYPHS.has(ch) ? ch : /\s/u.test(ch) ? ' ' : ''))
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

export function drawText(g: Raster, s: string, x: number, y: number, color: Paint, k = 1): void {
  [...norm(s)].forEach((ch, i) => {
    const glyph = GLYPHS.get(ch);
    if (!glyph) return;
    glyph.forEach((row, ry) =>
      row.forEach((on, rx) => {
        if (on) g.px(color, x + (i * 4 + rx) * k, y + ry * k, k, k);
      }),
    );
  });
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

const bayer = (x: number, y: number): number => BAYER[y & 3]?.[x & 3] ?? 0;

// ---------------------------------------------------------------- pisos

interface CementPalette {
  /** 4 tonos de oscuro a claro */
  tones: readonly [string, string, string, string];
  speckDark: string;
  speckLight: string;
  seam: string;
}

/** Loft: microcemento gris calido */
export const CEMENT_LOFT: CementPalette = {
  tones: ['#837D8F', '#8C8698', '#958FA0', '#9E98A8'],
  speckDark: '#77718A',
  speckLight: '#AAA4B3',
  seam: '#7A7488',
};

/** Japandi: resina color arena, mas clara y casi sin junta */
export const CEMENT_SAND: CementPalette = {
  tones: ['#ADA192', '#B4A999', '#BBB0A1', '#C2B8A9'],
  speckDark: '#A39788',
  speckLight: '#CBC2B4',
  seam: '#AA9E8F',
};

/**
 * Microcemento: nubes suaves (ruido de valor periodico, asi el mosaico no tiene costura) tramadas en 4
 * tonos, motas sueltas y una junta finisima cada 2 unidades.
 */
export function paintMicrocement(g: Raster, w: number, h: number, pal: CementPalette = CEMENT_LOFT): void {
  const MICROCEMENT = pal.tones;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, cell: number, seed: number): number => {
    const nx = w / cell;
    const ny = h / cell;
    const v = (i: number, j: number) => hash1((((i % nx) + nx) % nx) * 17.31 + (((j % ny) + ny) % ny) * 91.7 + seed);
    const i = Math.floor(x / cell);
    const j = Math.floor(y / cell);
    const tx = ease(x / cell - i);
    const ty = ease(y / cell - j);
    const a = v(i, j) + (v(i + 1, j) - v(i, j)) * tx;
    const b = v(i, j + 1) + (v(i + 1, j + 1) - v(i, j + 1)) * tx;
    return a + (b - a) * ty;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = noise(x, y, 32, 3.1) * 0.6 + noise(x, y, 8, 7.7) * 0.4;
      const k = clamp(Math.floor(n * 4 + (bayer(x, y) / 16 - 0.5) * 0.9), 0, 3);
      g.px(MICROCEMENT[k] ?? MICROCEMENT[1], x, y);
    }
  }
  for (let i = 0; i < 70; i++) {
    g.px(hash1(i * 1.9) > 0.5 ? pal.speckDark : pal.speckLight, (hash1(i * 3.7 + 1) * w) | 0, (hash1(i * 5.3 + 2) * h) | 0);
  }
  g.px(pal.seam, 0, 0, w, 1);
  g.px(pal.seam, 0, 0, 1, h);
}

/**
 * Synthwave: piso azul noche con grilla cada media unidad (16 texeles) que se aviva cada unidad, y cruces
 * en morado. Lineas en azul acero y cian apagado: el morado queda solo en los cruces.
 */
export function paintNeonGrid(g: Raster, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) g.px(bayer(x, y) > 11 ? '#1A2140' : '#161C38', x, y);
  }
  for (let i = 0; i < w; i += 16) {
    const major = i % 32 === 0;
    g.px(major ? '#2C7FA6' : '#23355E', i, 0, 1, h);
    g.px(major ? '#2C7FA6' : '#23355E', 0, i, w, 1);
  }
  for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) g.px('#8B5CF6', x, y);
}

// ---------------------------------------------------------------- exterior (calles, aceras y cruces)

/** adoquines de la calle, gris azulado de noche: de mas oscuro a mas claro */
const PAVER_TONES = ['#33355A', '#37395E', '#3B3D62', '#3F4166'] as const;

/**
 * Adoquines de la calle en cesteria: celdas de 16 texeles (0,5 u) con dos adoquines de 16 x 8 que alternan
 * direccion, asi se leen igual en las calles verticales y en las horizontales. Tono por adoquin, junta de 1
 * texel, un canto gastado mas claro y motas sueltas. Periodico: 64 x 64 = 2 x 2 unidades sin costura.
 */
export function paintPavers(g: Raster, w: number, h: number): void {
  const C = 16;
  for (let cy = 0; cy < h; cy += C) {
    for (let cx = 0; cx < w; cx += C) {
      const across = ((cx + cy) / C) % 2 === 0;
      for (let k = 0; k < 2; k++) {
        const x = across ? cx : cx + k * 8;
        const y = across ? cy + k * 8 : cy;
        const bw = across ? C : 8;
        const bh = across ? 8 : C;
        const tone = PAVER_TONES[Math.floor(hash1(x * 3.7 + y * 11.3 + 0.5) * PAVER_TONES.length)] ?? PAVER_TONES[1];
        g.px(tone, x, y, bw, bh);
        g.px('#25264A', x, y, bw, 1);
        g.px('#25264A', x, y, 1, bh);
        g.px('#46486D', x + 1, y + 1, 2, 1);
      }
    }
  }
  for (let i = 0; i < 70; i++) {
    g.px(hash1(i * 2.3) > 0.5 ? '#2D2F52' : '#44466B', (hash1(i * 3.1 + 4) * w) | 0, (hash1(i * 7.7 + 1) * h) | 0);
  }
}

/**
 * Acera: losetas claras de 8 texeles (0,25 u) con junta, tono por loseta, motas y una grieta. 64 x 64 = 2 x 2
 * unidades sin costura. Mas clara que la calle y bastante mas apagada que el piso de las salas.
 */
export function paintSidewalk(g: Raster, w: number, h: number): void {
  const tones = ['#55567A', '#595A7E', '#5D5E82'] as const;
  const S = 8;
  for (let y = 0; y < h; y += S) {
    for (let x = 0; x < w; x += S) {
      g.px(tones[Math.floor(hash1(x * 5.1 + y * 9.7 + 2) * tones.length)] ?? tones[1], x, y, S, S);
      g.px('#47486C', x, y, S, 1);
      g.px('#47486C', x, y, 1, S);
    }
  }
  for (let i = 0; i < 60; i++) {
    g.px(hash1(i * 1.7) > 0.5 ? '#4E4F73' : '#65668A', (hash1(i * 4.3 + 3) * w) | 0, (hash1(i * 6.1 + 5) * h) | 0);
  }
  // una grieta en diagonal dentro de una loseta
  for (let i = 0; i < 5; i++) g.px('#4A4B6F', 42 + i, 19 + (i >> 1), 1, 1);
}

/** loseta de cruce: rosa de los vientos de piedra (32 x 32 = 1 u), norte en ambar apagado */
export function paintCompass(g: Raster, w: number, h: number): void {
  g.px('#3C3E63', 0, 0, w, h);
  g.px('#2A2B50', 0, 0, w, 1);
  g.px('#2A2B50', 0, h - 1, w, 1);
  g.px('#2A2B50', 0, 0, 1, h);
  g.px('#2A2B50', w - 1, 0, 1, h);
  const cx = w / 2 - 0.5;
  const cy = h / 2 - 0.5;
  const R = w / 2 - 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const d = Math.hypot(dx, dy);
      if (d >= R - 1.5 && d < R) g.px('#5E5C83', x, y);
      // puntas de la estrella: rombos a lo largo de cada eje
      const vertical = dy <= R - 2 && dx <= 2.6 * (1 - dy / (R - 1));
      const horizontal = dx <= R - 2 && dy <= 2.6 * (1 - dx / (R - 1));
      if (vertical) g.px(y < cy ? '#B38D5B' : '#8A86A8', x, y);
      else if (horizontal) g.px('#76729A', x, y);
    }
  }
  g.px('#C9BEB3', Math.floor(cx), Math.floor(cy), 2, 2);
}

/** tapa de registro cuadrada (18 x 18): marco de hierro, chapa con relieve en rombos y dos agujeros */
export function paintManhole(g: Raster, w: number, h: number): void {
  g.px('#2A2B48', 0, 0, w, h);
  g.px('#3A3C5E', 2, 2, w - 4, h - 4);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) if ((x + y) % 4 === 0 && (x - y + 64) % 4 === 0) g.px('#4B4D72', x, y);
  }
  g.px('#18192F', 4, (h >> 1) - 1, 2, 1);
  g.px('#18192F', w - 6, (h >> 1) - 1, 2, 1);
}

// ---------------------------------------------------------------- pantallas (24 x 14)

export const SCREEN_W = 24;
export const SCREEN_H = 14;

const CODE_COLS: readonly PalKey[] = ['cyan', 'cyan', 'teal', 'amber', 'neon', 'lavender'];

/** lineas de codigo que suben de a una cada 0,35 s y cursor que parpadea */
export function paintCode(g: Raster, w: number, h: number, t: number, seed: number): void {
  g.px('night', 0, 0, w, h);
  g.px('indigo', 0, 0, w, 1);
  g.px('ember', 1, 0);
  g.px('amber', 3, 0);
  g.px('leaf', 5, 0);
  const L0 = Math.floor(t / 0.35);
  for (let i = 0; i < 6; i++) {
    const L = L0 + i;
    const y = 2 + i * 2;
    let x = 2 + Math.floor(hash1(L * 3.1 + seed) * 3) * 2;
    const n = 1 + Math.floor(hash1(L * 1.7 + seed) * 3);
    for (let k = 0; k < n && x < w - 2; k++) {
      const len = 2 + Math.floor(hash1(L * 7.7 + k * 3 + seed) * 6);
      g.px(CODE_COLS[Math.floor(hash1(L * 5.3 + k + seed) * 6)] ?? 'cyan', x, y, Math.min(len, w - 1 - x), 1);
      x += len + 1;
    }
    if (i === 5 && Math.floor(t * 3) % 2) g.px('cream', Math.min(x, w - 3), y - 1, 2, 2);
  }
}

export function paintDone(g: Raster, w: number, h: number): void {
  g.px('night', 0, 0, w, h);
  g.px('leaf', 0, h - 1, w, 1);
  const check: [number, number][] = [[6, 6], [7, 7], [8, 8], [9, 9], [10, 8], [11, 7], [12, 6], [13, 5], [14, 4], [15, 3], [16, 2]];
  for (const [x, y] of check) g.px('cyan', x, y, 2, 2);
}

export function paintOff(g: Raster, w: number, h: number): void {
  g.px('ink', 0, 0, w, h);
  for (let i = 0; i < 7; i++) {
    g.px('#1E1D3E', 5 + i, 10 - i);
    g.px('#1E1D3E', 8 + i, 10 - i);
  }
}

/** en reposo: lineas tenues y un cursor que parpadea (2 cuadros) */
export function paintIdle(g: Raster, w: number, h: number, cursor: boolean): void {
  g.px('night', 0, 0, w, h);
  g.px('indigo', 0, 0, w, 1);
  g.px('dusk', 2, 3, 9, 1);
  g.px('dusk', 4, 5, 12, 1);
  g.px('dusk', 4, 7, 7, 1);
  g.px('teal', 2, 10, 2, 1);
  if (cursor) g.px('cream', 5, 9, 2, 3);
}

/** pensando: tres puntos que se encienden en secuencia */
export function paintThink(g: Raster, w: number, h: number, lit: number): void {
  g.px('night', 0, 0, w, h);
  g.px('indigo', 0, 0, w, 1);
  for (let i = 0; i < 3; i++) g.px(i < lit ? 'cyan' : 'indigo', 7 + i * 4, 6, 2, 2);
}

// ---------------------------------------------------------------- cielo en vivo (84 x 28, tres hojas de ventana)

export const SKY_W = 84;
export const SKY_H = 28;

/** colores del cielo precalculados para una hora (se recalculan solo cuando cambia la hora) */
export interface SkyPalette {
  W: LightKey['W'];
  bands: string[];
  cloud: string;
  far: string;
  near: string;
}

export function skyPalette(K: LightKey): SkyPalette {
  const B = 6;
  const bands: string[] = [];
  for (let i = 0; i < B; i++) bands.push(hexOf(K.skyBot.clone().lerp(K.skyTop, i / (B - 1))));
  const W = K.W;
  return {
    W,
    bands,
    cloud: mixHex(K.skyBot, 'cream', 0.6),
    far: mixHex('dusk', 'night', 0.35 + W.night * 0.5),
    near: mixHex('dusk', 'ink', 0.45 + W.night * 0.45),
  };
}

export function paintSky(g: Raster, w: number, h: number, S: SkyPalette, t: number): void {
  const W = S.W;
  const B = S.bands.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = (1 - y / (h - 1)) * (B - 1) + bayer(x, y) / 16 - 0.5;
      g.px(S.bands[clamp(Math.round(f), 0, B - 1)] ?? '#000000', x, y);
    }
  }
  if (W.night + W.dusk * 0.3 > 0.25) {
    for (let i = 0; i < 46; i++) {
      const sx = (hash1(i * 4.1) * w) | 0;
      const sy = (hash1(i * 9.3) * h * 0.62) | 0;
      if (Math.sin(t * 1.7 + i * 2.3) > -0.4) {
        g.alpha = clamp(W.night * 1.2);
        g.px('cream', sx, sy);
        g.alpha = 1;
      }
    }
  }
  const dayT = (W.h - 6) / 12;
  if (dayT > -0.05 && dayT < 1.08 && W.night < 0.7) {
    const sx = Math.round(w * (0.08 + 0.84 * dayT));
    const sy = Math.round(h * 0.86 - Math.sin(Math.PI * clamp(dayT)) * h * 0.66);
    const r = W.dusk > 0.4 ? 3.5 : 2.2;
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y <= r * r) g.px(W.dusk > 0.4 ? 'amber' : 'cream', sx + x, sy + y);
  }
  if (W.night > 0.35) {
    const mx = Math.round(w * 0.8);
    const my = 6;
    g.alpha = 0.25;
    for (let y = -6; y <= 6; y++) {
      for (let x = -6; x <= 6; x++) {
        const d = x * x + y * y;
        if (d <= 36 && d > 16) g.px('moon', mx + x, my + y);
      }
    }
    g.alpha = 1;
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9 && (x - 1.5) ** 2 + (y + 1) ** 2 > 5) g.px('cream', mx + x, my + y);
  }
  if (W.day > 0.3) {
    for (let i = 0; i < 3; i++) {
      const cx = Math.round(((hash1(i * 5.1) * w + t * 0.8) % (w + 16)) - 8);
      const cy = 3 + i * 4;
      g.alpha = 0.8 * W.day;
      g.px(S.cloud, cx, cy, 9, 2);
      g.px(S.cloud, cx + 2, cy - 1, 4, 1);
      g.alpha = 1;
    }
  }
  const lit = W.night + W.dusk * 0.5;
  for (let x = 0; x < w; x++) {
    const col = Math.floor(x / 4);
    const bh = Math.floor(h * 0.28 + hash1(col * 7.1) * h * 0.26);
    g.px(S.far, x, h - bh, 1, bh);
  }
  for (let x = 0; x < w; x++) {
    const col = Math.floor(x / 7);
    const lx = x % 7;
    const bh = Math.floor(h * 0.12 + hash1(col * 3.3) * h * 0.36);
    g.px(S.near, x, h - bh, 1, bh);
    if (lit > 0.2 && lx > 0 && lx < 6 && lx % 2 === 1) {
      for (let y = h - bh + 2; y < h - 1; y += 3) {
        if (hash1(col * 13.7 + y * 1.9 + Math.floor(t / 6 + hash1(col + y) * 7)) > 0.55) {
          g.alpha = lit;
          g.px(hash1(col + y * 3) > 0.86 ? 'cyan' : hash1(col * 2 + y) > 0.8 ? 'neon' : 'amber', x, y);
          g.alpha = 1;
        }
      }
    }
    if (lx === 3 && hash1(col * 5.5) > 0.6) {
      g.px(S.near, x, h - bh - 3, 1, 3);
      if (lit > 0.2 && Math.floor(t * 1.5 + col) % 3 === 0) g.px('ember', x, h - bh - 4);
    }
  }
}

// ---------------------------------------------------------------- reloj (24 x 24)

export function paintClock(g: Raster, w: number, h: number, hours: number): void {
  g.px('steel', 0, 0, w, h);
  const c = (w - 1) / 2;
  const R = w / 2 - 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= R) g.px(d > R - 1.2 ? 'ink' : 'cream', x, y);
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = i % 3 ? R - 2.2 : R - 2.6;
    g.px(i % 3 ? 'lavender' : 'ink', Math.round(c + Math.sin(a) * r), Math.round(c - Math.cos(a) * r), 1, 1);
  }
  const hh = ((hours % 24) + 24) % 24;
  const m = (hh % 1) * 60;
  const hr = (Math.floor(hh) % 12) + m / 60;
  const hand = (a: number, len: number, col: PalKey) => {
    for (let s = 0; s <= len; s += 0.4) g.px(col, Math.round(c + Math.sin(a) * s), Math.round(c - Math.cos(a) * s));
  };
  hand((hr / 12) * Math.PI * 2, R * 0.5, 'ink');
  hand((m / 60) * Math.PI * 2, R * 0.78, 'ember');
  g.px('amber', Math.round(c), Math.round(c));
}

// ---------------------------------------------------------------- alfombras, pasillo y felpudo

/** alfombras por estilo (themes.ts): 0-2 loft, 3-4 japandi; synthwave va sin alfombra */
export const RUGS: readonly ((g: Raster, w: number, h: number) => void)[] = [
  // terrazzo: lavanda humo con esquirlas de colores
  (g, w, h) => {
    g.px('dusk', 0, 0, w, h);
    g.px('lavender', 2, 2, w - 4, 1);
    g.px('lavender', 2, h - 3, w - 4, 1);
    g.px('lavender', 2, 2, 1, h - 4);
    g.px('lavender', w - 3, 2, 1, h - 4);
    const chips: PalKey[] = ['cream', 'cream', 'amber', 'teal', 'neon', 'indigo', 'bone'];
    for (let i = 0; i < 520; i++) {
      const x = 5 + ((hash1(i * 2.71) * (w - 11)) | 0);
      const y = 5 + ((hash1(i * 6.13 + 4) * (h - 11)) | 0);
      const c = chips[(hash1(i * 9.7) * chips.length) | 0] ?? 'cream';
      const big = hash1(i * 4.4) > 0.8;
      g.px(c, x, y, big ? 2 : 1, big ? 2 : 1);
    }
  },
  // rayas finas: tinta con lineas indigo y un par de lineas neon cerca de cada punta
  (g, w, h) => {
    g.px('night', 0, 0, w, h);
    for (let y = 6; y < h - 6; y += 5) g.px('indigo', 6, y, w - 12, 1);
    for (const x of [10, 12, w - 13, w - 11]) g.px(x === 12 || x === w - 13 ? 'cyan' : 'neon', x, 4, 1, h - 8);
  },
  // Bauhaus: cuartos de circulo en ciruela, ambar y crema sobre tinta
  (g, w, h) => {
    const cell = 20;
    const cols: PalKey[] = ['plum', 'amber', 'cream', 'teal', 'plum'];
    const x0 = ((w % cell) / 2) | 0;
    const y0 = ((h % cell) / 2) | 0;
    g.px('night', 0, 0, w, h);
    for (let cy = 0; cy * cell + y0 + cell <= h; cy++) {
      for (let cx = 0; cx * cell + x0 + cell <= w; cx++) {
        const s = cy * 31 + cx;
        const c = cols[(hash1(s * 1.37) * cols.length) | 0] ?? 'plum';
        const corner = (hash1(s * 2.9) * 4) | 0;
        const ox = corner & 1 ? cell - 1 : 0;
        const oy = corner & 2 ? cell - 1 : 0;
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            if (Math.hypot(x - ox, y - oy) < cell - 2) g.px(c, x0 + cx * cell + x, y0 + cy * cell + y);
          }
        }
      }
    }
  },
  // 3 · Japandi lino: avena con doble filete y una banda salvia en cada punta
  (g, w, h) => {
    g.px('#CFC3AE', 0, 0, w, h);
    for (let y = 0; y < h; y += 2) for (let x = (y >> 1) % 2; x < w; x += 4) g.px('#C6B9A3', x, y);
    for (const i of [4, 7]) {
      g.px('#9E927E', i, i, w - i * 2, 1);
      g.px('#9E927E', i, h - 1 - i, w - i * 2, 1);
      g.px('#9E927E', i, i, 1, h - i * 2);
      g.px('#9E927E', w - 1 - i, i, 1, h - i * 2);
    }
    g.px('sageD', 14, 12, 6, h - 24);
    g.px('sageD', w - 20, 12, 6, h - 24);
  },
  // 4 · Japandi tatami: rectangulos de paja con borde salvia oscuro
  (g, w, h) => {
    g.px('#557A5E', 0, 0, w, h);
    const tw = 40;
    const th = 20;
    for (let r = 0; r * th < h; r++) {
      for (let c = -1; c * tw < w; c++) {
        const x = c * tw + (r % 2 ? tw / 2 : 0) + 3;
        const y = r * th + 3;
        const wx = Math.max(0, x);
        const ww = Math.min(w - 3, x + tw - 2) - wx;
        if (ww > 0) g.px(hash1(r * 7 + c) > 0.5 ? '#C9BC96' : '#BFB28B', wx, y, ww, th - 2);
      }
    }
  },
];

export function paintDoormat(g: Raster, w: number, h: number): void {
  g.px('steel', 0, 0, w, h);
  g.px('steelL', 1, 1, w - 2, 1);
  g.px('steelL', 1, h - 2, w - 2, 1);
  g.px('steelL', 1, 1, 1, h - 2);
  g.px('steelL', w - 2, 1, 1, h - 2);
  drawText(g, 'HOLA', ((w - textW('HOLA')) / 2) | 0, ((h - 5) / 2) | 0, 'magenta');
}

// ---------------------------------------------------------------- cuadros, pizarra, placa y cartel

export const PAINTINGS: readonly ((g: Raster, w: number, h: number) => void)[] = [
  // luna sobre montanas
  (g, w, h) => {
    for (let y = 0; y < h; y++) g.px(y < 5 ? 'night' : y < 9 ? 'indigo' : 'night', 0, y, w, 1);
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 4) g.px('cream', 17 + x, 4 + y);
    for (let x = 0; x < w; x++) {
      const m = 6 + Math.round(3 * Math.sin(x * 0.5) + 2 * Math.sin(x * 0.23));
      g.px(x % 5 ? 'dusk' : 'lavender', x, 13 - m + 3, 1, m - 2);
    }
    g.px('indigo', 0, 13, w, 5);
    g.px('cream', 16, 14, 3, 1);
    g.px('cream', 17, 16, 2, 1);
    g.px('moon', 4, 15, 4, 1);
  },
  // atardecer con palmera
  (g, w, h) => {
    (['ember', 'amber', 'neon', 'amber', 'ember'] as const).forEach((c, i) => g.px(c, 0, i * 2, w, 2));
    for (let y = -4; y <= 0; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y <= 16) g.px('cream', 12 + x, 10 + y);
    for (let y = 10; y < h; y++) g.px(y % 2 ? 'teal' : 'night', 0, y, w, 1);
    g.px('moss', 3, 4, 1, 8);
    g.px('leaf', 1, 3, 5, 1);
    g.px('leaf', 0, 4, 2, 1);
    g.px('leaf', 5, 4, 2, 1);
  },
];

export function paintWhiteboard(g: Raster): void {
  const w = 56;
  const h = 32;
  g.px('cream', 0, 0, w, h);
  drawText(g, 'PLAN', 3, 3, 'indigo');
  const lines: [number, number, number][] = [[3, 11, 18], [3, 14, 13], [3, 17, 16], [3, 20, 9]];
  for (const [x, y, l] of lines) {
    g.px('indigo', x, y, l, 1);
    g.px('leaf', x + l + 2, y - 1, 1, 1);
    g.px('leaf', x + l + 3, y, 1, 1);
  }
  g.px('ember', 26, 4, 9, 1);
  g.px('ember', 26, 9, 9, 1);
  g.px('ember', 26, 4, 1, 6);
  g.px('ember', 34, 4, 1, 6);
  g.px('ember', 35, 7, 5, 1);
  g.px('ember', 39, 6, 1, 3);
  [5, 9, 7, 12, 10].forEach((b, i) => g.px('teal', 26 + i * 3, 28 - b, 2, b));
  g.px('indigo', 25, 28, 16, 1);
}

export function paintPlate(g: Raster, w: number, h: number, name: string): void {
  g.px('steel', 0, 0, w, h);
  g.px('magenta', 0, 0, w, 1);
  g.px('magenta', 0, h - 1, w, 1);
  g.px('magenta', 0, 0, 1, h);
  g.px('magenta', w - 1, 0, 1, h);
  const text = fitText(plateText(name), w - 4);
  drawText(g, text, ((w - textW(text)) / 2) | 0, 3, 'cream');
}

export const SIGN_W = 64;
export const SIGN_H = 22;

/** cartel de sala: titulo grande, proyecto (o CERRADA) y un led de estado */
export function paintSign(g: Raster, w: number, h: number, title: string, sub: string, closed: boolean): void {
  g.px(closed ? 'ink' : 'night', 0, 0, w, h);
  const bc: PalKey = closed ? 'dusk' : 'amber';
  g.px(bc, 1, 1, w - 2, 1);
  g.px(bc, 1, h - 2, w - 2, 1);
  g.px(bc, 1, 1, 1, h - 2);
  g.px(bc, w - 2, 1, 1, h - 2);
  const t = fitText(title, w - 12, 2);
  drawText(g, t, ((w - 4 - textW(t, 2)) / 2) | 0, 3, closed ? 'lavender' : 'cream', 2);
  if (closed) {
    const s = 'CERRADA';
    const sw = textW(s);
    g.px('ember', ((w - sw) / 2 - 2) | 0, 14, sw + 4, 7);
    drawText(g, s, ((w - sw) / 2) | 0, 15, 'cream');
  } else {
    const s = fitText(sub, w - 6);
    drawText(g, s, ((w - textW(s)) / 2) | 0, 15, 'lavender');
  }
  g.px(closed ? 'ember' : 'leaf', w - 5, 3, 2, 2);
}

// ---------------------------------------------------------------- burbuja y halo

/** burbuja de pensar con n puntos (20 x 14, fondo transparente) */
export function paintBubble(g: Raster, w: number, h: number, n: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((x - 10.5) / 9) ** 2 + ((y - 5.5) / 5.3) ** 2;
      if (d <= 1) g.px(d > 0.72 ? 'ink' : 'cream', x, y);
    }
  }
  g.px('ink', 3, 11, 2, 2);
  g.px('ink', 1, 13, 1, 1);
  for (let i = 0; i < n; i++) g.px('ink', 6 + i * 4, 5, 2, 2);
}

/** halo circular en cuatro anillos (32 x 32, blanco con alpha) para charcos de luz y halos */
export function paintGlow(g: Raster): void {
  const rings: [number, number][] = [[16, 0.18], [12, 0.34], [8, 0.6], [4, 0.95]];
  for (const [r, a] of rings) {
    for (let y = -r; y < r; y++) for (let x = -r; x < r; x++) if (x * x + y * y < r * r) g.fill(255, 255, 255, a * 255, 16 + x, 16 + y, 1, 1);
  }
}
