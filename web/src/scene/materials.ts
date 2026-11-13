// Materiales compartidos por toda la escena (se crean una vez por modulo), en el estilo "Loft
// cinematografico": materiales fisicos (PBR) con color por vertice para todo lo estatico, y superficies
// procedurales calculadas en el shader a partir de la posicion en el mundo (ladrillo, tablones de madera,
// concreto y losetas), asi se ven nitidas con cualquier zoom y no dependen de texturas. Pantallas y
// bombillas son basicos (emiten su color), y los halos y charcos de luz, aditivos y muy contenidos: la luz
// de verdad la ponen las lamparas (Lighting.tsx y Room.tsx).
// Las variantes "Closed" son la sala cerrada: la luz apagada y el azul de la luna.

import {
  AdditiveBlending,
  Color,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  SpriteMaterial,
  type Texture,
} from 'three';
import type { DayState } from './daylight';
import {
  bubbleTextures,
  glowTexture,
  litAtlas,
  paintClockAt,
  screenTextures,
  setSkyKey,
  signTexture,
  skyTexture,
  tickCode,
  tickSky,
} from './textures';
import { AMBIENT } from './world/ambient';
import { PAL } from './world/kit';

// la luz de la sala esta apagada, pero no queda gris: la tine el azul de la luna que entra por el ventanal
const CLOSED_FRAG = `#include <dithering_fragment>
      gl_FragColor.rgb = mix(gl_FragColor.rgb, dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114)) * vec3(0.7, 0.86, 1.4), 0.6) * 1.0;`;

/** sala cerrada: luz apagada (la lampara no enciende) y el color tira al azul de la luna */
export function closedVariant<T extends Material>(m: T, key: string): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', CLOSED_FRAG);
  };
  m.customProgramCacheKey = () => `closed-${key}`;
  return m;
}

/** material fisico mate con color por vertice: muebles, paredes lisas, losa */
function solid(map?: Texture, roughness = 0.86): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: '#ffffff', vertexColors: true, map: map ?? null, roughness, metalness: 0 });
}

// ---------------------------------------------------------------- superficies procedurales

const NOISE = /* glsl */ `
float h11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Dibuja una superficie en el shader a partir de la posicion (vWp) y la normal (vWn) en el mundo. \`body\`
 * modifica diffuseColor.rgb; \`key\` distingue el programa en la cache de three.
 */
function procedural(color: string, roughness: number, key: string, body: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, vertexColors: true, roughness, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vWn;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWn = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWp;\nvarying vec3 vWn;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`);
  };
  m.customProgramCacheKey = () => `proc-${key}`;
  return m;
}

/** ladrillo visto en aparejo a soga: hiladas de 9 cm, ladrillos de 24 cm, junta hundida y tono por pieza */
const BRICK = /* glsl */ `
  if (abs(vWn.y) < 0.5) {
    vec2 p = abs(vWn.x) > 0.5 ? vWp.zy : vWp.xy;
    float row = floor(p.y / 0.09);
    float u = p.x / 0.24 + mod(row, 2.0) * 0.5;
    vec2 id = vec2(floor(u), row);
    vec2 f = vec2(fract(u), fract(p.y / 0.09));
    float joint = clamp(step(f.x, 0.04) + step(0.96, f.x) + step(f.y, 0.1) + step(0.9, f.y), 0.0, 1.0);
    float h = h21(id);
    vec3 brick = diffuseColor.rgb * (0.8 + 0.4 * h);
    brick = mix(brick, brick * vec3(1.16, 0.88, 0.82), step(0.84, h21(id + 7.3)));
    brick *= 0.94 + 0.12 * vnoise(p * 34.0);
    diffuseColor.rgb = mix(brick, diffuseColor.rgb * 0.45 + 0.035, joint);
  }
`;

/** tablones: 15 cm de ancho, largos distintos por hilada, tono por tablon y veta fina */
const PLANKS = /* glsl */ `
  if (vWn.y > 0.5) {
    float row = floor(vWp.z / 0.15);
    float u = vWp.x / 1.25 + h11(row) * 7.0;
    float h = h21(vec2(floor(u), row));
    vec3 c = diffuseColor.rgb * (0.84 + 0.32 * h);
    c *= 0.95 + 0.1 * vnoise(vec2(vWp.x * 7.0 + h * 31.0, vWp.z * 70.0));
    float seam = clamp(step(fract(vWp.z / 0.15), 0.035) + step(fract(u) * 1.25, 0.012), 0.0, 1.0);
    diffuseColor.rgb = mix(c, c * 0.5, seam);
  }
`;

/** espiga: tablillas de 45 x 9 cm en zigzag */
const HERRINGBONE = /* glsl */ `
  if (vWn.y > 0.5) {
    vec2 q = vec2(vWp.x + vWp.z, vWp.x - vWp.z) * 0.7071;
    float col = floor(q.x / 0.36);
    float odd = mod(col, 2.0);
    float v = (odd > 0.5 ? q.y : -q.y) + q.x;
    float row = floor(v / 0.09);
    float h = h21(vec2(col, row));
    vec3 c = diffuseColor.rgb * (0.86 + 0.28 * h);
    c *= 0.96 + 0.08 * vnoise(vec2(v * 60.0, q.x * 8.0 + h * 20.0));
    float seam = clamp(step(fract(q.x / 0.36), 0.03) + step(fract(v / 0.09), 0.07), 0.0, 1.0);
    diffuseColor.rgb = mix(c, c * 0.52, seam);
  }
`;

/** concreto en losas: \`uSlab\` metros de lado, nubes suaves y junta fina */
const concrete = (slab: string) => /* glsl */ `
  if (vWn.y > 0.5) {
    vec2 q = vWp.xz / ${slab};
    float h = h21(floor(q));
    vec3 c = diffuseColor.rgb * (0.93 + 0.1 * h);
    c *= 0.92 + 0.16 * vnoise(vWp.xz * 2.2) * vnoise(vWp.xz * 9.0 + 3.0);
    vec2 f = fract(q);
    float seam = clamp(step(f.x, 0.012 / ${slab}) + step(f.y, 0.012 / ${slab}), 0.0, 1.0);
    diffuseColor.rgb = mix(c, c * 0.62, seam);
  } else {
    diffuseColor.rgb *= 0.9 + 0.14 * vnoise(vWp.xy * 5.0 + vWp.zy * 5.0);
  }
`;

// ---------------------------------------------------------------- follaje que se mece

const SWAY = { uSwayTime: { value: 0 } };

/**
 * Follaje fusionado (world/plants.ts): cada vertice gira alrededor del pivote de su planta, primero en z
 * y luego en x, igual que el vaiven por grupo que tenia el kit (rotation.z / rotation.x).
 */
function foliageMaterial(closed: boolean): MeshStandardMaterial {
  const m = solid(undefined, 0.9);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SWAY);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aPivot;
attribute vec3 aSway;
uniform float uSwayTime;
vec3 swayRot(vec3 v) {
  float az = sin(uSwayTime * aSway.y + aSway.z) * aSway.x;
  float ax = sin(uSwayTime * aSway.y * 0.7 + aSway.z * 2.0) * aSway.x * 0.7;
  float cz = cos(az);
  float sz = sin(az);
  v = vec3(v.x * cz - v.y * sz, v.x * sz + v.y * cz, v.z);
  float cx = cos(ax);
  float sx = sin(ax);
  return vec3(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
}`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = swayRot(objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = aPivot + swayRot(transformed - aPivot);');
    if (closed) shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', CLOSED_FRAG);
  };
  m.customProgramCacheKey = () => (closed ? 'foliage-closed' : 'foliage');
  return m;
}

function additive(color: string, opacity: number, vertexColors = false): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: glowTexture,
    color,
    vertexColors,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity,
  });
}

function halo(color: string, opacity: number): SpriteMaterial {
  return new SpriteMaterial({ map: glowTexture, color, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity });
}

function points(size: number): PointsMaterial {
  return new PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, blending: AdditiveBlending, transparent: true, depthWrite: false });
}

// ---------------------------------------------------------------- focos que respiran (guirnalda y luces del exterior)

const linear = (hex: string) => new Color(hex);

const TWINKLE = {
  uTime: { value: 0 },
  uSince: { value: 10 },
  uOn: { value: 0 },
  uLampI: { value: 1 },
  uReduced: { value: 0 },
  uWarm: { value: linear('#FFC98A') },
  uCream: { value: linear(PAL.cream) },
  uAmber: { value: linear(PAL.amber) },
};

const TWINKLE_COMMON = /* glsl */ `
uniform float uTime;
uniform float uSince;
uniform float uOn;
uniform float uLampI;
uniform float uReduced;
uniform vec3 uWarm;
uniform vec3 uCream;
uniform vec3 uAmber;
varying float vIdx;
float flickOn(float e) { return e < 0.0 ? 0.0 : e < 0.06 ? 0.7 : e < 0.12 ? 0.15 : e < 0.18 ? 0.85 : 1.0; }
`;

/** string: guirnalda que se enciende en ola (70 ms por foco) y respira · guide: bolardos y luces de las jardineras en ola */
function twinkleMaterial(kind: 'string' | 'guide'): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: '#ffffff', vertexColors: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, TWINKLE);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aIdx;\nvarying float vIdx;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvIdx = aIdx;');
    const body =
      kind === 'string'
        ? `{
          float e = uSince - vIdx * 0.07;
          float sw = uReduced > 0.5 ? uOn : (uOn > 0.5 ? flickOn(e) : 1.0 - pow(clamp(uSince / 0.4, 0.0, 1.0), 3.0));
          float k = sw * uLampI;
          vec3 lit = uWarm * (0.7 + 0.3 * sin(uTime * 2.0 + vIdx * 1.7));
          diffuseColor.rgb *= mix(uCream * 0.9, lit, step(0.2, k));
        }`
        : `{
          diffuseColor.rgb *= uAmber * (0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * 1.4 - vIdx * 0.6)));
        }`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TWINKLE_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`);
  };
  m.customProgramCacheKey = () => `twinkle-${kind}`;
  return m;
}

// ---------------------------------------------------------------- catalogo

const basic = (color: string) => new MeshBasicMaterial({ color });

const sky = new MeshBasicMaterial({ map: skyTexture });
const skyClosed = new MeshBasicMaterial({ map: skyTexture, color: new Color(0.75, 0.75, 0.75) });
const bulbLit = new MeshBasicMaterial({ color: '#ffffff', vertexColors: true });
const bulbDark = new MeshBasicMaterial({ color: new Color(0.3, 0.3, 0.3), vertexColors: true });
/** halo de cada lampara: apenas un velo, la luz de verdad la da la lampara */
const LAMP_HALO = 0.14;
const lampGlow = halo(PAL.amber, LAMP_HALO);

export const MAT = {
  toon: solid(),
  toonClosed: closedVariant(solid(), 'solid'),
  /** pared de ladrillo visto (el color de la hilada sale del color por vertice del estilo) */
  brick: procedural('#ffffff', 0.92, 'brick', BRICK),
  brickClosed: closedVariant(procedural('#ffffff', 0.92, 'brick', BRICK), 'brick'),
  /** follaje fusionado de una sala o de los pasillos: se mece en el shader */
  foliage: foliageMaterial(false),
  foliageClosed: foliageMaterial(true),
  lit: solid(litAtlas),
  litClosed: closedVariant(solid(litAtlas), 'lit'),
  sign: solid(signTexture),
  signClosed: closedVariant(solid(signTexture), 'sign'),
  /** pisos de sala, uno por variante (themes.ts): nogal en tablones, roble en espiga y concreto pulido */
  cement: procedural('#8A5B3D', 0.62, 'planks', PLANKS),
  cementClosed: closedVariant(procedural('#8A5B3D', 0.62, 'planks', PLANKS), 'planks'),
  sand: procedural('#C39B6E', 0.62, 'herringbone', HERRINGBONE),
  sandClosed: closedVariant(procedural('#C39B6E', 0.62, 'herringbone', HERRINGBONE), 'herringbone'),
  grid: procedural('#6F6D75', 0.42, 'polished', concrete('1.8')),
  gridClosed: closedVariant(procedural('#6F6D75', 0.42, 'polished', concrete('1.8')), 'polished'),
  /** exterior: concreto de los pasillos y losetas claras alrededor de cada sala */
  hall: procedural('#7B7880', 0.9, 'hall', concrete('1.2')),
  sidewalk: procedural('#A29FA6', 0.9, 'sidewalk', concrete('0.5')),
  sky,
  skyClosed,
  glass: sky,
  glassClosed: skyClosed,
  /** bombillas y focos emisivos: su brillo sigue al encendido de las lamparas */
  bulbLit,
  bulbDark,
  bulbOn: bulbLit,
  bulbOff: bulbDark,
  bulbClosed: bulbDark,
  /** charcos de luz de las lamparas (color por vertice): un velo sobre la luz real */
  glowLamp: additive('#ffffff', 1, true),
  /** charcos azules de la luna bajo el ventanal */
  moonPool: additive(PAL.moon, 0.06),
  /** halo de la luz de cada lampara */
  lampGlow,
  /** halo generico de pantalla (los escritorios crean el suyo para animarlo) */
  screenGlow: halo(PAL.cyan, 0.1),
  /** paneles que brillan siempre (maquina expendedora) */
  emissive: new MeshBasicMaterial({ color: '#ffffff', vertexColors: true }),
  /** luz de la maquina expendedora del pasillo */
  vendingGlow: halo(PAL.cyan, 0.14),
  vendingPool: additive(PAL.cyan, 0.08),
  stringLights: twinkleMaterial('string'),
  stringLightsClosed: new MeshBasicMaterial({ color: new Color(PAL.cream).multiplyScalar(0.25), vertexColors: true }),
  guideLights: twinkleMaterial('guide'),
  steam: points(3),
  dust: points(2),
  arrow: basic(PAL.amber),
  hands: basic(PAL.ink),
  hitbox: new MeshBasicMaterial({ visible: false }),
  bubble: new SpriteMaterial({ map: bubbleTextures[0] ?? null, alphaTest: 0.5 }),
};

// ---------------------------------------------------------------- pantallas

export type ScreenMode = 'off' | 'code' | 'think' | 'idle' | 'done';

const screenMats = {
  code: screenTextures.code.map((p) => new MeshBasicMaterial({ map: p.tex })),
  think: new MeshBasicMaterial({ map: screenTextures.think[0] ?? null }),
  idle: new MeshBasicMaterial({ map: screenTextures.idle[0] ?? null }),
  done: new MeshBasicMaterial({ map: screenTextures.done }),
  off: new MeshBasicMaterial({ map: screenTextures.off }),
  closed: new MeshBasicMaterial({ color: new Color(PAL.ink).multiplyScalar(0.3) }),
};

export function screenMaterial(mode: ScreenMode, variant: number, closed = false): MeshBasicMaterial {
  if (closed) return screenMats.closed;
  if (mode === 'code') return screenMats.code[variant % screenMats.code.length] ?? screenMats.off;
  return screenMats[mode];
}

// ---------------------------------------------------------------- hora y animacion

let dayKey = -1;

/** la hora cambio (una vez por minuto): cielo de las ventanas y reloj de pared */
export function applyDay(day: DayState): void {
  const key = Math.round(day.hour * 60) * 1440 + Math.round(day.clockHour * 60);
  if (key === dayKey) return;
  dayKey = key;
  setSkyKey(day.key, AMBIENT.clock);
  paintClockAt(day.clockHour);
}

/**
 * Anima todo lo compartido por la oficina en una sola llamada por frame (despues de updateAmbient):
 * codigo de las pantallas, cielo, cuadros de "pensando" y reposo, parpadeo de pantallas, bombillas,
 * charcos de luz, luna y focos.
 */
export function animateWorld(): void {
  const a = AMBIENT;
  const t = a.t;
  tickCode(a.reduced ? 0 : a.clock);
  tickSky(a.clock);

  const thinkFrame = a.reduced ? 2 : Math.floor(a.clock / 0.4) % 3;
  const think = screenTextures.think[thinkFrame] ?? null;
  if (screenMats.think.map !== think) screenMats.think.map = think;
  const bubble = bubbleTextures[thinkFrame] ?? null;
  if (MAT.bubble.map !== bubble) MAT.bubble.map = bubble;
  const idle = screenTextures.idle[a.reduced ? 0 : Math.floor(a.clock / 0.6) % 2] ?? null;
  if (screenMats.idle.map !== idle) screenMats.idle.map = idle;

  const flicker = 0.93 + 0.07 * Math.sin(t * 9);
  for (const m of screenMats.code) m.color.setScalar(flicker);

  const lamp = a.lamp;
  bulbLit.color.setScalar(0.3 + 0.7 * lamp);
  MAT.glowLamp.opacity = 0.22 * lamp;
  lampGlow.opacity = LAMP_HALO * lamp;
  MAT.moonPool.opacity = 0.06 * a.moon;

  SWAY.uSwayTime.value = t;
  TWINKLE.uTime.value = t;
  TWINKLE.uSince.value = a.clock - a.lampSince;
  TWINKLE.uOn.value = a.lampsOn ? 1 : 0;
  TWINKLE.uLampI.value = a.lampI;
  TWINKLE.uReduced.value = a.reduced ? 1 : 0;
}
