// Materiales compartidos por toda la escena (se crean una vez por modulo), segun el Kit 3D:
// un toon de 3 escalones para todo lo estatico con color por vertice, uno por atlas de texturas,
// basicos para pantallas y cielo, aditivos para halos y charcos de luz, y puntos para vapor y polvo.
// Las variantes "Closed" son la sala cerrada: desaturada al 70 % y al 60 % de luz (luz apagada).

import {
  AdditiveBlending,
  Color,
  DataTexture,
  type Material,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  PointsMaterial,
  RedFormat,
  SpriteMaterial,
  type Texture,
} from 'three';
import type { DayState } from './daylight';
import {
  bubbleTextures,
  glowTexture,
  litAtlas,
  paintClockAt,
  cementTexture,
  gridTexture,
  sandTexture,
  screenTextures,
  setSkyKey,
  signTexture,
  skyTexture,
  tickCode,
  tickSky,
  paversTexture,
  sidewalkTexture,
} from './textures';
import { AMBIENT } from './world/ambient';
import { PAL, TOON_STEPS } from './world/kit';

/** rampa toon de 3 escalones: 28 % · 62 % · 100 % */
function makeGradientMap(): DataTexture {
  const tex = new DataTexture(new Uint8Array(TOON_STEPS), TOON_STEPS.length, 1, RedFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const gradientMap = makeGradientMap();

const CLOSED_FRAG = `#include <dithering_fragment>
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114))), 0.7) * 0.6;`;

/** sala cerrada: color apagado (desatura 70 % y deja 60 % de luz) */
export function closedVariant<T extends Material>(m: T, key: string): T {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', CLOSED_FRAG);
  };
  m.customProgramCacheKey = () => `closed-${key}`;
  return m;
}

function toon(map?: Texture): MeshToonMaterial {
  return new MeshToonMaterial({ color: '#ffffff', vertexColors: true, map: map ?? null, gradientMap });
}

// ---------------------------------------------------------------- follaje que se mece

const SWAY = { uSwayTime: { value: 0 } };

/**
 * Toon del follaje fusionado (world/plants.ts): cada vertice gira alrededor del pivote de su planta,
 * primero en z y luego en x, igual que el vaiven por grupo que tenia el kit (rotation.z / rotation.x).
 */
function foliageMaterial(closed: boolean): MeshToonMaterial {
  const m = toon();
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
const lampGlow = halo(PAL.amber, 0.5);

export const MAT = {
  toon: toon(),
  toonClosed: closedVariant(toon(), 'toon'),
  /** follaje fusionado de una sala o de los pasillos: se mece en el shader */
  foliage: foliageMaterial(false),
  foliageClosed: foliageMaterial(true),
  lit: toon(litAtlas),
  litClosed: closedVariant(toon(litAtlas), 'lit'),
  sign: toon(signTexture),
  signClosed: closedVariant(toon(signTexture), 'sign'),
  /** pisos de sala, uno por estilo (themes.ts) */
  cement: toon(cementTexture),
  cementClosed: closedVariant(toon(cementTexture), 'cement'),
  sand: toon(sandTexture),
  sandClosed: closedVariant(toon(sandTexture), 'sand'),
  grid: toon(gridTexture),
  gridClosed: closedVariant(toon(gridTexture), 'grid'),
  /** exterior: adoquines de las calles y losetas de las aceras */
  hall: toon(paversTexture),
  sidewalk: toon(sidewalkTexture),
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
  /** charcos de luz de las lamparas (color por vertice) */
  glowLamp: additive('#ffffff', 1, true),
  /** charcos azules de la luna bajo el ventanal */
  moonPool: additive(PAL.moon, 0.14),
  /** halo de la luz de cada lampara */
  lampGlow,
  /** halo generico de pantalla (los escritorios crean el suyo para animarlo) */
  screenGlow: halo(PAL.cyan, 0.22),
  /** paneles que brillan siempre (maquina expendedora) */
  emissive: new MeshBasicMaterial({ color: '#ffffff', vertexColors: true }),
  /** cian de la maquina expendedora del pasillo */
  vendingGlow: halo(PAL.cyan, 0.4),
  vendingPool: additive(PAL.cyan, 0.25),
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
  MAT.glowLamp.opacity = lamp * (0.93 + 0.07 * Math.sin(t * 3.1));
  lampGlow.opacity = 0.5 * lamp;
  MAT.moonPool.opacity = 0.14 * a.moon * (0.93 + 0.07 * Math.sin(t * 3.1 + 2));

  SWAY.uSwayTime.value = t;
  TWINKLE.uTime.value = t;
  TWINKLE.uSince.value = a.clock - a.lampSince;
  TWINKLE.uOn.value = a.lampsOn ? 1 : 0;
  TWINKLE.uLampI.value = a.lampI;
  TWINKLE.uReduced.value = a.reduced ? 1 : 0;
}
