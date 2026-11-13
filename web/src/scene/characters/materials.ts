// Materiales y texturas compartidos por todo el elenco. Se crean una sola vez por modulo.
//
// - Toon de 3 escalones (TOON_STEPS del kit) con color por vertice.
// - Tinte cian de pantalla (D1 v2): emisivo que solo cae en las caras que miran al frente del
//   personaje (donde esta su monitor) y que late con el tecleo. Como la intensidad cambia por
//   personaje, se usa un juego fijo de materiales escalonados (pasos de pixel) en vez de uno por agente.
// - Variante de sala cerrada: desatura y oscurece (uDesat 0,7 · uDim 0,6 del kit).
// - Variante de alerta viva: tine de rojo al personaje (mas fuerte si es critica). Es otro juego de
//   materiales con su propio programa; los compartidos no se tocan.

import type { LiveAlert } from '@shared/contract';
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DataTexture,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  SpriteMaterial,
  SRGBColorSpace,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { currentHour as sceneHour } from '../daylight';
import { KIT_PAL } from './looks';
import { MOTION, reducedMotion } from './motion';

/** Escalones toon del kit: 27 % · 62 % · 100 % */
export const TOON_STEPS = [70, 158, 255] as const;

function makeGradientMap(): DataTexture {
  const tex = new DataTexture(new Uint8Array(TOON_STEPS), TOON_STEPS.length, 1, RedFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const characterGradient = makeGradientMap();

/** Brillo maximo del tinte de pantalla en la cara (D1: faceGlow 0,34) */
export const FACE_GLOW = 0.34;
/** Niveles del tinte: 0 apagado .. GLOW_LEVELS - 1 al maximo */
export const GLOW_LEVELS = 9;

function patchFront(shader: WebGLProgramParametersWithUniforms, closed: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vFront;')
    .replace('#include <skinnormal_vertex>', '#include <skinnormal_vertex>\n  vFront = normalize(objectNormal).z;');
  let frag = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFront;')
    .replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= smoothstep(0.2, 0.9, vFront);',
    );
  if (closed) {
    frag = frag.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114))), 0.7) * 0.6;`,
    );
  }
  shader.fragmentShader = frag;
}

/** Nivel de la alerta viva del agente (contrato: LiveAlert) */
export type AlertLevel = LiveAlert['level'];

/** Cuanto se tine de rojo el personaje alertado */
const ALERT_TINT: Readonly<Record<AlertLevel, number>> = { warning: 0.3, critical: 0.5 };

/** Empuja el color final hacia el rojo; uAlert va por material, el programa es uno solo */
function patchAlert(shader: WebGLProgramParametersWithUniforms, amount: number): void {
  shader.uniforms.uAlert = { value: amount };
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uAlert;')
    .replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.15, 0.5, 0.45) + vec3(0.08, 0.0, 0.0), uAlert);`,
    );
}

function characterMaterial(glow: number, closed: boolean, alert: AlertLevel | null = null): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true,
    roughness: 0.78,
    metalness: 0,
    emissive: new Color(KIT_PAL.cyan),
    emissiveIntensity: glow,
  });
  m.name = closed ? 'personaje-cerrado' : `personaje-${alert ? `alerta-${alert}` : 'tinte'}-${glow.toFixed(3)}`;
  m.onBeforeCompile = (shader) => {
    patchFront(shader, closed);
    if (alert) patchAlert(shader, ALERT_TINT[alert]);
  };
  m.customProgramCacheKey = () => (closed ? 'personaje-cerrado' : alert ? 'personaje-alerta' : 'personaje');
  return m;
}

const glowAt = (level: number) => (FACE_GLOW * level) / (GLOW_LEVELS - 1);
const glowMats: MeshStandardMaterial[] = Array.from({ length: GLOW_LEVELS }, (_, i) => characterMaterial(glowAt(i), false));
const alertMats: Readonly<Record<AlertLevel, MeshStandardMaterial[]>> = {
  warning: Array.from({ length: GLOW_LEVELS }, (_, i) => characterMaterial(glowAt(i), false, 'warning')),
  critical: Array.from({ length: GLOW_LEVELS }, (_, i) => characterMaterial(glowAt(i), false, 'critical')),
};
const closedMat = characterMaterial(0, true);

/**
 * Material del personaje para un brillo 0..FACE_GLOW (escalonado), con alerta viva o para sala
 * cerrada (la sala cerrada manda: ahi nadie trabaja).
 */
export function characterMaterialFor(glow: number, closed: boolean, alert: AlertLevel | null = null): MeshStandardMaterial {
  if (closed) return closedMat;
  const level = Math.round((Math.max(0, Math.min(FACE_GLOW, glow)) / FACE_GLOW) * (GLOW_LEVELS - 1));
  return (alert ? alertMats[alert] : glowMats)[level] ?? closedMat;
}

/** Nivel de tinte de un material del elenco sin alerta (-1 si es de alerta, de sala cerrada u otro) */
export function glowLevelOf(material: unknown): number {
  return glowMats.findIndex((m) => m === material);
}

/** Alerta de un material del elenco (null si no es de alerta) */
export function alertLevelOf(material: unknown): AlertLevel | null {
  if (alertMats.critical.some((m) => m === material)) return 'critical';
  if (alertMats.warning.some((m) => m === material)) return 'warning';
  return null;
}

// ---------------------------------------------------------------- texturas pixel (sin canvas)

type RGBA = readonly [number, number, number, number];

function hexRgba(hex: string, a = 255): RGBA {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
}

const CLEAR: RGBA = [0, 0, 0, 0];

/** pixel(x, y) con y = 0 arriba; DataTexture guarda la fila 0 abajo */
function pixelTexture(w: number, h: number, pixel: (x: number, y: number) => RGBA): DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = pixel(x, y);
      const i = ((h - 1 - y) * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const INK = hexRgba(KIT_PAL.ink);
const CREAM = hexRgba(KIT_PAL.cream);
const AMBER = hexRgba(KIT_PAL.amber);

/** Burbuja "..." del kit (bubbleTex): elipse crema con borde tinta, cola y n puntos */
export function bubblePixel(n: number): (x: number, y: number) => RGBA {
  return (x, y) => {
    for (let i = 0; i < n; i++) {
      const dx = 6 + i * 4;
      if (x >= dx && x < dx + 2 && y >= 5 && y < 7) return INK;
    }
    if ((x >= 3 && x < 5 && y >= 11 && y < 13) || (x === 1 && y === 13)) return INK;
    const d = ((x - 10.5) / 9) ** 2 + ((y - 5.5) / 5.3) ** 2;
    if (d <= 1) return d > 0.72 ? INK : CREAM;
    return CLEAR;
  };
}

const bubbleFrames = [1, 2, 3].map((n) => pixelTexture(20, 14, bubblePixel(n)));

/** Chispa de aparicion del kit: cruz crema con centro ambar */
function sparkPixel(x: number, y: number): RGBA {
  if (x >= 6 && x < 10 && y >= 6 && y < 10) return CREAM;
  if (x >= 5 && x < 11 && y >= 5 && y < 11) return AMBER;
  if ((x >= 7 && x < 9) || (y >= 7 && y < 9)) return CREAM;
  return CLEAR;
}

const sparkTex = pixelTexture(16, 16, sparkPixel);

export const bubbleMaterial = new SpriteMaterial({ map: bubbleFrames[2] ?? null, alphaTest: 0.5 });
bubbleMaterial.name = 'burbuja-pensando';

function sparkMaterial(opacity: number): SpriteMaterial {
  const m = new SpriteMaterial({
    map: sparkTex,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    opacity,
  });
  m.name = 'chispa';
  return m;
}

/** Chispa en 3 escalones de opacidad (pasos de pixel), compartidos */
const sparkFull = sparkMaterial(1);
const sparkMid = sparkMaterial(0.65);
const sparkLow = sparkMaterial(0.35);

export function sparkMaterialFor(amount: number): SpriteMaterial {
  return amount > 0.66 ? sparkFull : amount > 0.33 ? sparkMid : sparkLow;
}

/** Relleno de un color con contorno de tinta de 1 pixel (tambien en diagonal) */
function outlined(fill: (x: number, y: number) => boolean, color: RGBA): (x: number, y: number) => RGBA {
  return (x, y) => {
    if (fill(x, y)) return color;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (fill(x + dx, y + dy)) return INK;
    }
    return CLEAR;
  };
}

/** "?" de espera: relleno de 6 x 9 con un pixel de margen para el contorno (textura de 8 x 11) */
const QUESTION_FILL = ['.AAAA.', 'AA..AA', '....AA', '...AA.', '..AA..', '..AA..', '......', '..AA..', '..AA..'] as const;

export const questionPixel = outlined((x, y) => QUESTION_FILL[y - 1]?.[x - 1] === 'A', AMBER);

export const questionMaterial = new SpriteMaterial({ map: pixelTexture(8, 11, questionPixel), alphaTest: 0.5 });
questionMaterial.name = 'pregunta';

/** Letras z de dormido, de lado 3, 4 y 5, subiendo en diagonal: [lado, x, y] con y = 0 arriba */
const Z_GLYPHS = [
  [3, 1, 11],
  [4, 5, 6],
  [5, 10, 1],
] as const;

/** zzz con las primeras n letras (textura de 16 x 16) */
export function zzzPixel(n: number): (x: number, y: number) => RGBA {
  return outlined((x, y) => {
    for (let i = 0; i < n; i++) {
      const g = Z_GLYPHS[i];
      if (!g) continue;
      const [s, gx, gy] = g;
      const u = x - gx;
      const v = y - gy;
      if (u >= 0 && v >= 0 && u < s && v < s && (v === 0 || v === s - 1 || u === s - 1 - v)) return true;
    }
    return false;
  }, CREAM);
}

const zzzFrames = [1, 2, 3].map((n) => pixelTexture(16, 16, zzzPixel(n)));

export const zzzMaterial = new SpriteMaterial({ map: zzzFrames[2] ?? null, alphaTest: 0.5 });
zzzMaterial.name = 'zzz';

// ---------------------------------------------------------------- piezas sueltas

/** Sombra de contacto bajo cada personaje (D1 v2) */
export const blobGeometry = new CircleGeometry(0.24, 10).rotateX(-Math.PI / 2);
export const blobMaterial = new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false });
blobMaterial.name = 'sombra-contacto';

export const hitboxMaterial = new MeshBasicMaterial({ visible: false });
export const markerMaterial = new MeshBasicMaterial({ color: KIT_PAL.amber });
markerMaterial.name = 'seleccion';
/** "!" de alerta viva: sus colores van por vertice (rojo con respaldo de tinta) */
export const alertMarkerMaterial = new MeshBasicMaterial({ vertexColors: true });
alertMarkerMaterial.name = 'alerta';

// ---------------------------------------------------------------- reloj compartido

/** Pesos de dia / atardecer / noche del kit (dayWeights) */
export function dayWeights(hourInput: number): { day: number; dusk: number; night: number } {
  const h = ((hourInput % 24) + 24) % 24;
  const s = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const b = (x: number, c: number, w: number) => Math.max(0, 1 - Math.abs(x - c) / w);
  const day = s(5.5, 7.5, h) * (1 - s(17.5, 19.5, h));
  const dusk = Math.max(b(h, 18.6, 1.4), b(h, 6.5, 1.1));
  const night = Math.max(0, 1 - day - dusk * 0.7);
  const sum = day + dusk + night || 1;
  return { day: day / sum, dusk: dusk / sum, night: night / sum };
}

/** Cuanto se nota el cian de pantalla segun la hora (D1: glowNightOnly) */
export function nightGlowAt(hour: number): number {
  const w = dayWeights(hour);
  return Math.max(0.35, w.night + w.dusk * 0.6);
}

const shared = { last: -1, nightGlow: 1, nextHourCheck: 0, frame: -1, zzz: -1 };

/** misma hora que la luz de la escena: la noche lofi por defecto, o la de ?hora */
function currentHour(): number {
  return sceneHour();
}

/**
 * Avanza lo que comparte todo el elenco (cuadros de la burbuja y del zzz, cian segun la hora). Lo
 * llama cada personaje en su frame; solo trabaja una vez por frame.
 */
export function tickCharacters(elapsed: number): void {
  if (elapsed === shared.last) return;
  shared.last = elapsed;
  if (elapsed >= shared.nextHourCheck || elapsed < shared.nextHourCheck - 60) {
    shared.nextHourCheck = elapsed + 20;
    shared.nightGlow = nightGlowAt(currentHour());
  }
  const reduced = reducedMotion();
  const frame = reduced ? 2 : Math.floor(elapsed / MOTION.bubbleFrame) % 3;
  if (frame !== shared.frame) {
    shared.frame = frame;
    bubbleMaterial.map = bubbleFrames[frame] ?? null;
  }
  const zzz = reduced ? 2 : Math.floor(elapsed / MOTION.zzzFrame) % 3;
  if (zzz !== shared.zzz) {
    shared.zzz = zzz;
    zzzMaterial.map = zzzFrames[zzz] ?? null;
  }
}

export function nightGlow(): number {
  return shared.nightGlow;
}
