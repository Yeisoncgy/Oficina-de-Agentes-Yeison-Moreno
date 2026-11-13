// Fondo "cielo": cielo de verdad con nubes de volumen, detras de la oficina.
// - degradado con dispersion (mas claro y calido hacia el horizonte, abajo) y resplandor ancho del sol o la luna;
// - banco de cumulos abajo y hacia los lados (la losa de la oficina flota por encima), en filas que se tapan
//   unas a otras; nubes medias sueltas a los lados; cirros finos arriba. El centro queda despejado;
// - cada capa es un campo de densidad (ruido fractal) iluminado en direccion al sol: borde claro de su lado,
//   panza en sombra suave.
// Todo se calcula a media resolucion (el cielo no tiene detalle fino y la textura se ve estirada y suavizada)
// y se sube con interpolacion; las estrellas van despues, a resolucion completa.
// Todo varia de forma continua con daylight, dusk, night, stars y hour.

import { clamp01, hash, hash2, put, smoothstep, type SkyDay, type SkyPainter } from './shared';

/** la textura se estira a toda la ventana: las formas se calculan en proporcion de pantalla (16:9) */
const ASPECT = 16 / 9;

// ---------------------------------------------------------------- ruido (tabla, sin asignar memoria)

const NT = new Float32Array(256 * 256);
for (let i = 0; i < NT.length; i++) NT[i] = hash2(i & 255, i >> 8);

/** ruido de valor 0..1 con interpolacion quintica (sin escalones de rejilla) */
function noise(x: number, y: number): number {
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  let fx = x - xf;
  let fy = y - yf;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = xf & 255;
  const y0 = (yf & 255) << 8;
  const x1 = (x0 + 1) & 255;
  const y1 = (y0 + 256) & 65280;
  const a = NT[y0 + x0] as number;
  const b = NT[y0 + x1] as number;
  const c = NT[y1 + x0] as number;
  const d = NT[y1 + x1] as number;
  const ab = a + (b - a) * fx;
  return ab + (c + (d - c) * fx - ab) * fy;
}

/** fractal 0..1 con giro entre octavas (no se notan los ejes de la rejilla) */
function fbm(x: number, y: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise(x, y);
    n += a;
    const nx = 1.6 * x + 1.2 * y + 5.3;
    y = -1.2 * x + 1.6 * y + 1.7;
    x = nx;
    a *= 0.5;
  }
  return s / n;
}

/** fractal "mullido" 0..1: |2n-1| deja lobulos redondos separados por pliegues en V (coliflor de cumulo) */
function billow(x: number, y: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 2 * noise(x, y) - 1;
    s += a * (v < 0 ? -v : v);
    n += a;
    const nx = 1.6 * x + 1.2 * y + 2.9;
    y = -1.2 * x + 1.6 * y + 8.3;
    x = nx;
    a *= 0.5;
  }
  return s / n;
}

// ---------------------------------------------------------------- lineal -> sRGB rapido

const LUT_N = 4096;
const LUT = new Float32Array(LUT_N + 2);
for (let i = 0; i <= LUT_N + 1; i++) {
  const v = Math.min(1, i / LUT_N);
  LUT[i] = 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
}
function toSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const f = v * LUT_N;
  const i = f | 0;
  const a = LUT[i] as number;
  return a + ((LUT[i + 1] as number) - a) * (f - i);
}

// ---------------------------------------------------------------- memoria del modulo

let CW = 0;
let CH = 0;
/** densidad de la capa que se esta pintando (media resolucion) */
let dens = new Float32Array(0);
/** nubes compuestas, premultiplicadas: r, g, b, alfa (media resolucion, lineal) */
let cloud = new Float32Array(0);
/** imagen final a media resolucion, ya en sRGB 0..255 */
let out = new Float32Array(0);
/** por columna/fila de la textura: celda de media resolucion y peso de interpolacion */
let colI = new Int32Array(0);
let colF = new Float32Array(0);
let rowI = new Int32Array(0);
let rowF = new Float32Array(0);
/** filas del banco de cumulos y altura de su borde de arriba por columna */
const ROWS = 5;
let topArr = new Float32Array(0);
let texW = 0;
let texH = 0;

function ensure(w: number, h: number): void {
  if (w === texW && h === texH) return;
  texW = w;
  texH = h;
  CW = Math.max(2, Math.ceil(w / 2));
  CH = Math.max(2, Math.ceil(h / 2));
  dens = new Float32Array(CW * CH);
  cloud = new Float32Array(CW * CH * 4);
  out = new Float32Array(CW * CH * 3);
  topArr = new Float32Array(ROWS * CW);
  colI = new Int32Array(w);
  colF = new Float32Array(w);
  rowI = new Int32Array(h);
  rowF = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    const g = Math.min(CW - 1.0001, Math.max(0, ((x + 0.5) * CW) / w - 0.5));
    colI[x] = Math.floor(g);
    colF[x] = g - Math.floor(g);
  }
  for (let y = 0; y < h; y++) {
    const g = Math.min(CH - 1.0001, Math.max(0, ((y + 0.5) * CH) / h - 0.5));
    rowI[y] = Math.floor(g);
    rowF[y] = g - Math.floor(g);
  }
}

/** densidad interpolada en coordenadas de celda; fuera del borde sigue la del borde */
function sampleDens(gx: number, gy: number): number {
  const x = gx < 0 ? 0 : gx > CW - 1.001 ? CW - 1.001 : gx;
  const y = gy < 0 ? 0 : gy > CH - 1.001 ? CH - 1.001 : gy;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * CW + x0;
  const a = dens[i] as number;
  const b = dens[i + 1] as number;
  const c = dens[i + CW] as number;
  const d = dens[i + CW + 1] as number;
  const ab = a + (b - a) * fx;
  return ab + (c + (d - c) * fx - ab) * fy;
}

// ---------------------------------------------------------------- colores

interface Rgb {
  r: number;
  g: number;
  b: number;
}
const rgb = (): Rgb => ({ r: 0, g: 0, b: 0 });
function setMix(o: Rgb, a: Rgb, b: Rgb, t: number): Rgb {
  o.r = a.r + (b.r - a.r) * t;
  o.g = a.g + (b.g - a.g) * t;
  o.b = a.b + (b.b - a.b) * t;
  return o;
}
function copy(o: Rgb, a: { r: number; g: number; b: number }): Rgb {
  o.r = a.r;
  o.g = a.g;
  o.b = a.b;
  return o;
}
/** sRGB 0..255 a lineal */
function lin(r: number, g: number, b: number): Rgb {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return { r: f(r), g: f(g), b: f(b) };
}
/** mezcla por los tres pesos de la hora: dia, atardecer, noche */
function blend3(o: Rgb, day: Rgb, dusk: Rgb, night: Rgb, wd: number, wk: number, wn: number): Rgb {
  const s = wd + wk + wn || 1;
  o.r = (day.r * wd + dusk.r * wk + night.r * wn) / s;
  o.g = (day.g * wd + dusk.g * wk + night.g * wn) / s;
  o.b = (day.b * wd + dusk.b * wk + night.b * wn) / s;
  return o;
}

/** paleta fija (lineal) */
const P = {
  white: lin(255, 255, 255),
  dawnGold: lin(255, 200, 138),
  duskOrange: lin(255, 146, 92),
  duskPink: lin(232, 136, 150),
  dayLit: lin(255, 253, 248),
  dayShade: lin(174, 190, 216),
  dawnShade: lin(170, 168, 196),
  duskShade: lin(128, 104, 142),
  duskUnder: lin(255, 132, 110),
  nightLit: lin(48, 58, 92),
  nightShade: lin(17, 21, 40),
  mauve: lin(96, 80, 132),
  twilight: lin(96, 64, 106),
  moonGlow: lin(110, 132, 190),
};

/** colores de trabajo (lineal), se recalculan en cada pintado */
const C = {
  zenith: rgb(),
  horizon: rgb(),
  belt: rgb(),
  pale: rgb(),
  sun: rgb(),
  lit: rgb(),
  shade: rgb(),
  haze: rgb(),
  a: rgb(),
  b: rgb(),
};

// ---------------------------------------------------------------- una capa de nubes

interface Shade {
  /** paso hacia la luz, en celdas */
  lx: number;
  ly: number;
  steps: number;
  /** cuanto apaga cada muestra de densidad en el camino a la luz */
  absorb: number;
  /** densidad para opacidad completa */
  solid: number;
  alpha: number;
  /** mezcla con el color del horizonte (lejania) */
  haze: number;
  lit: Rgb;
  shade: Rgb;
  /** 0..1 cuanto se oscurece la panza (lo que tiene nube encima) */
  belly: number;
}

const S: Shade = { lx: 0, ly: 0, steps: 0, absorb: 0, solid: 1, alpha: 1, haze: 0, lit: rgb(), shade: rgb(), belly: 0 };

/** ilumina la densidad de `dens` (filas y0..y1) y la compone por delante de lo ya pintado en `cloud` */
function shadeLayer(s: Shade, y0: number, y1: number): void {
  const lo = Math.max(0, y0);
  const hi = Math.min(CH, y1);
  const hz = C.haze;
  const up1 = Math.max(2, Math.round(CH * 0.012));
  const up2 = up1 * 3;
  for (let cy = lo; cy < hi; cy++) {
    for (let cx = 0; cx < CW; cx++) {
      const i = cy * CW + cx;
      const d = dens[i] as number;
      if (d <= 0.001) continue;
      let sum = 0;
      let px = cx;
      let py = cy;
      for (let k = 0; k < s.steps; k++) {
        px += s.lx;
        py += s.ly;
        const v = sampleDens(px, py);
        sum += v > 1 ? 1 : v;
      }
      const t = Math.exp(-s.absorb * sum);
      // panza: lo que tiene nube encima queda en sombra suave aunque la luz entre de lado
      const above = sampleDens(cx, cy + up1) + sampleDens(cx, cy + up2);
      const light = t * (1 - s.belly * (above > 1.6 ? 1 : above * 0.625));
      let r = s.shade.r + (s.lit.r - s.shade.r) * light;
      let g = s.shade.g + (s.lit.g - s.shade.g) * light;
      let b = s.shade.b + (s.lit.b - s.shade.b) * light;
      r += (hz.r - r) * s.haze;
      g += (hz.g - g) * s.haze;
      b += (hz.b - b) * s.haze;
      const e = d >= s.solid ? 1 : d / s.solid;
      const a = e * e * (3 - 2 * e) * s.alpha;
      const j = i * 4;
      const keep = 1 - a;
      cloud[j] = r * a + (cloud[j] as number) * keep;
      cloud[j + 1] = g * a + (cloud[j + 1] as number) * keep;
      cloud[j + 2] = b * a + (cloud[j + 2] as number) * keep;
      cloud[j + 3] = a + (cloud[j + 3] as number) * keep;
    }
  }
}

/** nubes medias sueltas a los lados: u del centro, v de la base, medio ancho (u) y alto (v) */
const MID: readonly (readonly [number, number, number, number])[] = [
  [0.07, 0.5, 0.1, 0.07],
  [0.17, 0.64, 0.06, 0.045],
  [0.035, 0.77, 0.06, 0.035],
  [0.93, 0.55, 0.1, 0.07],
  [0.84, 0.68, 0.06, 0.04],
  [0.975, 0.8, 0.05, 0.03],
];

// ---------------------------------------------------------------- pintado

function paint(data: Uint8Array, w: number, h: number, day: SkyDay): void {
  ensure(w, h);
  const hour = ((day.hour % 24) + 24) % 24;
  const wd = day.daylight;
  const wk = day.dusk;
  const wn = day.night;
  const sunW = clamp01(1 - wn);
  // manana dorada y tarde calida, continuas con la hora (de noche no pesan)
  const golden = hour < 3 ? 0 : 1 - smoothstep(7.5, 13.5, hour);
  const evening = smoothstep(13.5, 18.5, hour);
  const warm = clamp01(Math.max(golden * 0.8, evening * 0.5, wk)) * sunW;
  const pm = smoothstep(11, 14, hour);

  // sol: sale por la izquierda, a mediodia pasa por arriba (fuera de cuadro) y se pone por la derecha
  const p = Math.max(-1.3, Math.min(1.3, (hour - 12.75) / 6.25));
  const q = Math.tanh(p * 2.2) / Math.tanh(2.2);
  const sunU = 0.5 + 0.6 * q;
  const sunV = 0.42 + 0.85 * (1 - Math.min(1, q * q));
  // luna fuera de cuadro, arriba a la derecha
  const moonU = 1.1;
  const moonV = 1.1;

  // ---- colores de la hora
  copy(C.zenith, day.skyTop);
  copy(C.horizon, day.skyBottom);
  // crepusculo con el sol ya bajo el horizonte: el horizonte tira a rosa malva, no a pardo
  setMix(C.horizon, C.horizon, P.twilight, 0.6 * smoothstep(0.3, 0.7, wn) * (1 - smoothstep(0.6, 1, wn)));
  setMix(C.zenith, C.zenith, P.mauve, 0.4 * wk * pm);
  setMix(C.belt, P.dawnGold, P.duskPink, pm);
  setMix(C.sun, P.dawnGold, P.duskOrange, pm);
  setMix(C.sun, P.dayLit, C.sun, Math.min(1, warm * 1.2));
  // luz de las nubes; filo dorado por la manana y calido por la tarde
  setMix(C.b, P.dawnGold, P.duskOrange, pm);
  blend3(C.lit, P.dayLit, C.b, P.nightLit, wd, wk, wn);
  setMix(C.lit, C.lit, C.b, warm * 0.6);
  setMix(C.a, P.dawnShade, P.duskShade, pm);
  blend3(C.shade, P.dayShade, C.a, P.nightShade, wd, wk, wn);
  setMix(C.shade, C.shade, P.dawnShade, golden * 0.4 * wd);
  // azul palido de la luz dispersa (de dia) y color de la lejania
  const paleW = 0.75 * wd;
  setMix(C.pale, C.zenith, P.white, 0.42);
  setMix(C.haze, C.horizon, C.zenith, 0.2);
  setMix(C.haze, C.haze, C.pale, 0.6 * wd);

  // direccion hacia la luz (pantalla: x a la derecha, y hacia arriba)
  const sx = (sunU - 0.5) * ASPECT;
  const sy = sunV - 0.3;
  const mx = (moonU - 0.5) * ASPECT;
  const my = moonV - 0.3;
  const sl = Math.hypot(sx, sy);
  const ml = Math.hypot(mx, my);
  let lx = (sx / sl) * sunW + (mx / ml) * wn;
  let ly = (sy / sl) * sunW + (my / ml) * wn;
  const ll = Math.hypot(lx, ly) || 1;
  lx /= ll;
  ly /= ll;
  // al atardecer el sol queda por debajo de las nubes altas: les enciende la panza
  const lyHigh = ly * (1 - 0.9 * wk) - 0.55 * wk;
  const lhl = Math.hypot(lx, lyHigh) || 1;

  const cs = CH / 256; // pasos de la luz proporcionales al tamano
  const sxScale = ASPECT / CW;
  const syScale = 1 / CH;
  cloud.fill(0);

  // ---- cirros: hebras largas y rotas arriba
  dens.fill(0);
  const cirY0 = Math.floor(CH * 0.64);
  for (let cy = cirY0; cy < CH; cy++) {
    const Y = (cy + 0.5) * syScale;
    const band = smoothstep(0.64, 0.82, Y);
    for (let cx = 0; cx < CW; cx++) {
      const X = (cx + 0.5) * sxScale;
      const Yt = Y + (X - 0.9) * 0.07;
      const patch = smoothstep(0.42, 0.68, fbm(X * 1.3 + 20.5, Yt * 3.2 + 4.1, 2));
      if (patch <= 0) continue;
      const warp = noise(X * 1.7 + 3.1, Yt * 2.4 + 7.4);
      const n = fbm(X * 1.6 + warp * 0.9, Yt * 40 + warp * 3.2, 4);
      dens[cy * CW + cx] = Math.max(0, (n - 0.52) * 3.6) * patch * band;
    }
  }
  S.lx = (lx / lhl) * 2 * cs;
  S.ly = (lyHigh / lhl) * 2 * cs;
  S.steps = 2;
  S.absorb = 0.7;
  S.solid = 0.55;
  S.alpha = 0.24 + 0.08 * (1 - wd);
  S.haze = 0.12;
  setMix(S.lit, C.lit, P.duskUnder, 0.6 * wk);
  setMix(S.shade, C.shade, C.zenith, 0.45);
  S.belly = 0;
  shadeLayer(S, cirY0, CH);

  // ---- nubes medias sueltas a los lados: cumulos con la base plana
  dens.fill(0);
  let midLo = CH;
  let midHi = 0;
  for (let k = 0; k < MID.length; k++) {
    const m = MID[k];
    if (!m) continue;
    const [u, base, rw, tall] = m;
    const x0 = Math.max(0, Math.floor((u - rw * 1.25) * CW));
    const x1 = Math.min(CW, Math.ceil((u + rw * 1.25) * CW));
    const y0 = Math.max(0, Math.floor((base - 0.012) * CH));
    const y1 = Math.min(CH, Math.ceil((base + tall * 1.35 + 0.02) * CH));
    midLo = Math.min(midLo, y0);
    midHi = Math.max(midHi, y1);
    for (let cy = y0; cy < y1; cy++) {
      const Y = (cy + 0.5) * syScale;
      const flat = smoothstep(base - 0.012, base + 0.03, Y);
      if (flat <= 0) continue;
      for (let cx = x0; cx < x1; cx++) {
        const X = (cx + 0.5) * sxScale;
        const ex = ((cx + 0.5) / CW - u) / rw;
        const prof = 1 - ex * ex;
        const top = base + (prof > 0 ? tall * prof ** 0.7 * (0.35 + 1.3 * fbm(X * 7 + k * 3.1, k * 9.7, 3)) : -0.02);
        const rel = top - Y;
        if (rel < -0.04) continue;
        const n = billow(X * 11 + k * 17.3, Y * 15 + k * 7.1, 5);
        const dv = (rel * 13 + (n - 0.42) * 1.1) * flat;
        if (dv > 0) dens[cy * CW + cx] = dv;
      }
    }
  }
  S.lx = (lx / lhl) * 2 * cs;
  S.ly = (lyHigh / lhl) * 2 * cs;
  S.steps = 5;
  S.absorb = 0.6;
  S.solid = 0.32;
  S.alpha = 0.84;
  S.haze = 0.4;
  setMix(S.lit, C.lit, P.duskUnder, 0.35 * wk);
  setMix(S.shade, C.shade, C.horizon, 0.12);
  S.belly = 0.45;
  if (midHi > midLo) shadeLayer(S, midLo, midHi);

  // ---- banco de cumulos: filas de la mas lejana (mas alta, pequena y brumosa) a la mas cercana
  for (let r = 0; r < ROWS; r++) {
    const near = r / (ROWS - 1);
    const cTop = 0.17 - 0.12 * near;
    const eTop = 0.45 - 0.25 * near;
    const amp = 0.022 + 0.035 * near;
    const row = topArr.subarray(r * CW, (r + 1) * CW);
    for (let cx = 0; cx < CW; cx++) {
      const X = (cx + 0.5) * sxScale;
      const side = Math.abs((cx + 0.5) / CW - 0.5) * 2;
      // ondulacion del borde y, de vez en cuando, un cumulo que se levanta mas que los demas
      const tower = smoothstep(0.56, 0.78, noise(X * 2.6 + r * 5.9, r * 2.7 + 11.5));
      row[cx] =
        cTop + (eTop - cTop) * smoothstep(0.3, 1.02, side) + amp * (fbm(X * 2.4 + r * 7.7, r * 3.3 + 0.5, 2) - 0.5) * 2 + tower * (0.025 + 0.03 * near);
    }
  }
  for (let r = 0; r < ROWS; r++) {
    dens.fill(0);
    const near = r / (ROWS - 1);
    const f = 10 - 6 * near;
    const gain = 1.9 * f;
    // las filas lejanas se ven pequenas: con menos octavas alcanza
    const oct = r < 2 ? 4 : 5;
    const row = topArr.subarray(r * CW, (r + 1) * CW);
    let yLo = CH;
    let yHi = 0;
    for (let cx = 0; cx < CW; cx++) {
      const X = (cx + 0.5) * sxScale;
      const top = row[cx] as number;
      // lo que queda tapado por la fila de delante no se calcula
      const cut = r < ROWS - 1 ? (topArr[(r + 1) * CW + cx] as number) - 0.08 : -1;
      const c0 = Math.max(0, Math.floor(cut * CH));
      const c1 = Math.min(CH, Math.ceil((top + 0.05) * CH));
      if (c0 < yLo) yLo = c0;
      if (c1 > yHi) yHi = c1;
      for (let cy = c0; cy < c1; cy++) {
        const Y = (cy + 0.5) * syScale;
        const n = billow(X * f + r * 13.1, Y * f * 1.7 + r * 5.3, oct);
        const dv = (top - Y) * gain + (n - 0.4) * 1.3;
        if (dv > 0) dens[cy * CW + cx] = dv;
      }
    }
    S.lx = lx * 2.6 * cs;
    S.ly = ly * 2.6 * cs;
    S.steps = 6;
    S.absorb = 0.4;
    S.solid = 0.2;
    S.alpha = 1;
    S.haze = 0.42 * (1 - near) ** 1.5 + 0.04;
    copy(S.lit, C.lit);
    setMix(S.shade, C.shade, C.horizon, 0.08 * (1 - near));
    S.belly = 0.4;
    if (yHi > yLo) shadeLayer(S, yLo, yHi);
  }

  // ---- cielo + resplandores + via lactea + nubes, a media resolucion
  const sunStr = sunW * (0.05 + 0.5 * warm);
  const moonStr = wn * 0.045;
  const mw = day.stars * (1 - wd) * 0.9;
  // de noche la claridad del horizonte queda mas pegada abajo
  const horizonK = 2.4 + 2.2 * wn;
  for (let cy = 0; cy < CH; cy++) {
    const t = (cy + 0.5) * syScale;
    // dispersion: el horizonte (abajo) aclara rapido; el cenit se abre hacia arriba
    const g = 1 - (1 - t) ** horizonK;
    let br = C.horizon.r + (C.zenith.r - C.horizon.r) * g;
    let bg = C.horizon.g + (C.zenith.g - C.horizon.g) * g;
    let bb = C.horizon.b + (C.zenith.b - C.horizon.b) * g;
    // de dia, entre el horizonte calido y el azul hay un azul palido (luz dispersa), no un gris
    const paleK = paleW * Math.exp(-(((t - 0.3) / 0.22) ** 2));
    br += (C.pale.r - br) * paleK;
    bg += (C.pale.g - bg) * paleK;
    bb += (C.pale.b - bb) * paleK;
    // franja calida entre el horizonte y el azul (amanecer y atardecer)
    const beltK = Math.exp(-(((t - 0.4) / 0.2) ** 2)) * 0.5 * wk;
    br += (C.belt.r - br) * beltK;
    bg += (C.belt.g - bg) * beltK;
    bb += (C.belt.b - bb) * beltK;
    const dys = t - sunV;
    const dym = t - moonV;
    const mwRow = mw > 0.01 ? mw * smoothstep(0.5, 0.78, t) : 0;
    for (let cx = 0; cx < CW; cx++) {
      const X = (cx + 0.5) * sxScale;
      const dxs = X - sunU * ASPECT;
      const ds = dxs * dxs + dys * dys;
      const gs = sunStr * (0.55 / (1 + ds * 10) + 0.45 / (1 + ds * 1.5));
      const dxm = X - moonU * ASPECT;
      const gm = moonStr / (1 + (dxm * dxm + dym * dym) * 2.5);
      let r = br + C.sun.r * gs + P.moonGlow.r * gm;
      let gg = bg + C.sun.g * gs + P.moonGlow.g * gm;
      let b = bb + C.sun.b * gs + P.moonGlow.b * gm;
      if (mwRow > 0) {
        // via lactea: banda tenue en diagonal por arriba
        const dl = (t - 0.97 + (X - 0.3) * 0.3) / 0.1;
        const band = Math.exp(-dl * dl);
        if (band > 0.02) {
          const k = band * mwRow * (0.3 + 1.3 * Math.max(0, fbm(X * 7 + 1.3, t * 7 + 4.2, 3) - 0.38)) * 0.02;
          r += k * 0.9;
          gg += k * 0.95;
          b += k * 1.3;
        }
      }
      const j = (cy * CW + cx) * 4;
      const al = cloud[j + 3] as number;
      const keep = 1 - al;
      const o = (cy * CW + cx) * 3;
      out[o] = toSrgb(r * keep + (cloud[j] as number));
      out[o + 1] = toSrgb(gg * keep + (cloud[j + 1] as number));
      out[o + 2] = toSrgb(b * keep + (cloud[j + 2] as number));
    }
  }

  // ---- a resolucion completa (bilineal) con grano
  for (let y = 0; y < h; y++) {
    const ry = rowI[y] as number;
    const fy = rowF[y] as number;
    for (let x = 0; x < w; x++) {
      const fx = colF[x] as number;
      const a = (ry * CW + (colI[x] as number)) * 3;
      const c = a + CW * 3;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      put(
        data,
        w,
        x,
        y,
        (out[a] as number) * w00 + (out[a + 3] as number) * w10 + (out[c] as number) * w01 + (out[c + 3] as number) * w11,
        (out[a + 1] as number) * w00 + (out[a + 4] as number) * w10 + (out[c + 1] as number) * w01 + (out[c + 4] as number) * w11,
        (out[a + 2] as number) * w00 + (out[a + 5] as number) * w10 + (out[c + 2] as number) * w01 + (out[c + 5] as number) * w11,
      );
    }
  }

  // ---- estrellas: finas, solo en la parte alta, tapadas por las nubes
  const vis = day.stars * (1 - wd) ** 1.5;
  if (vis > 0.002) {
    const count = Math.round(320 * ((w * h) / (1024 * 512)));
    for (let s = 0; s < count; s++) {
      const fy = 0.36 + 0.64 * Math.sqrt(hash(s * 7.7 + 2));
      const x = Math.floor(hash(s * 3.1 + 1) * w);
      const y = Math.min(h - 1, Math.floor(fy * h));
      const cxI = Math.min(CW - 1, Math.floor((x * CW) / w));
      const cyI = Math.min(CH - 1, Math.floor((y * CH) / h));
      const cover = cloud[(cyI * CW + cxI) * 4 + 3] as number;
      const mag = hash(s * 5.3 + 3);
      const a = (0.1 + 0.62 * mag * mag) * vis * smoothstep(0.36, 0.6, fy) * (1 - cover);
      if (a <= 0.003) continue;
      const tint = hash(s * 9.7 + 5);
      const tr = tint < 0.3 ? 255 : 232;
      const tb = tint < 0.3 ? 212 : 255;
      const i = (y * w + x) * 4;
      data[i] = Math.round((data[i] as number) + (tr - (data[i] as number)) * a);
      data[i + 1] = Math.round((data[i + 1] as number) + (240 - (data[i + 1] as number)) * a);
      data[i + 2] = Math.round((data[i + 2] as number) + (tb - (data[i + 2] as number)) * a);
    }
  }
}

export const painter: SkyPainter = { name: 'cielo', label: 'Cielo con nubes', paint };
