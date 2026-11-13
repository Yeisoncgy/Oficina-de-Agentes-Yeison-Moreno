// Revelado "cinematografico" de la escena. Toma el control del render (prioridad 1) y encadena:
// 1. la escena en un buffer HDR con antialias (MSAA);
// 2. en calidad alta, oclusion ambiental (GTAO) a media resolucion: la sombra suave donde las cosas se
//    tocan, que es lo que hace que los muebles parezcan apoyados y no pegados;
// 3. un solo pase final: desenfoque de miniatura hacia arriba y abajo del encuadre, vineta, mapeo de tonos
//    ACES y espacio de color de pantalla.
// El cielo es el fondo de la escena (skyBackground) y lo pinta scene/sky: un cielo con nubes de volumen
// (banco de cumulos abajo, cirros arriba) iluminadas segun la hora, y estrellas finas de noche.
//
// Rendimiento (tiene que verse bien sin comerse el equipo; va a quedar siempre abierta):
// - el ritmo lo lleva scene/pacer.tsx: 60 cuadros/s mientras se usa, 30 quieta, 20 sin foco;
// - las sombras solo se recalculan cuando alguien camina (hasta SHADOW_HZ veces por segundo) y, si no,
//   SHADOW_IDLE_HZ veces por segundo: mover la camara no las cambia, porque el sol no se mueve;
// - gobernador: cada tanto mide lo que tarda de verdad un cuadro en la tarjeta grafica y, si no
//   alcanza, baja un nivel de calidad (scene/quality.ts). Nunca vuelve a subir solo, para no oscilar.
// ?calidad=alta|media|baja fija el nivel · ?fx=0 apaga el revelado (render directo).

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  ACESFilmicToneMapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  type Object3D,
  RGBAFormat,
  type Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { type DayState, useDayState } from './daylight';
import { perf } from './pacer';
import { SKY_H, SKY_W, type SkyDay, skyPainter } from './sky';
import { getQualityMode, lowerQuality, QUALITY, useQuality } from './quality';

export { QUALITY, type Quality } from './quality';

/** la oclusion se calcula a esta fraccion de la resolucion (es una sombra suave: no necesita mas) */
export const AO_SCALE = 0.5;
/** veces por segundo que se recalculan las sombras mientras alguien camina */
export const SHADOW_HZ = 18;
/** y cuando nadie camina (alcanza para puertas, brazos y cambios de luz) */
export const SHADOW_IDLE_HZ = 3;
/**
 * Gobernador: cada `every` cuadros mide uno completo en la tarjeta; con `samples` medidas, si la mediana
 * pasa de `slowMs` (no alcanza para ~45 cuadros/s) baja un nivel; si aguanta, mide cada vez menos seguido
 * (hasta cada `relaxed` cuadros).
 */
export const GOVERNOR = { warmup: 45, every: 40, relaxed: 640, samples: 5, slowMs: 22 } as const;

/** desenfoque de miniatura: radio maximo en px CSS y franja nitida (fraccion del alto) */
export const TILT = { blur: 2.2, sharp: 0.25 } as const;

const FINISH = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new Vector2(1, 1) },
    uBlur: { value: 0 },
    uSharp: { value: TILT.sharp },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  // termina con los trozos de three para mapeo de tonos y espacio de color: al ser el ultimo pase (va a
  // pantalla) el renderer le pone ACES y sRGB, igual que a cualquier material
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uBlur;
    uniform float uSharp;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // miniatura: nitido en la franja central y cada vez mas suave hacia arriba y abajo
      float r = uBlur * smoothstep(uSharp, 0.52, abs(vUv.y - 0.52));
      if (r > 0.3) {
        vec3 acc = c;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.7853982;
          vec2 d = vec2(cos(a), sin(a)) * uTexel * r;
          acc += texture2D(tDiffuse, vUv + d).rgb + texture2D(tDiffuse, vUv + d * 0.5).rgb;
        }
        c = acc / 17.0;
      }
      vec2 v = vUv - 0.5;
      c *= 1.0 - 0.26 * smoothstep(0.38, 0.98, length(v * vec2(1.1, 1.0)));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      // grano minimo: rompe las bandas de los degradados oscuros del cielo
      gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    }
  `,
};

// ---------------------------------------------------------------- cielo

const skyData = new Uint8Array(SKY_W * SKY_H * 4);
/** fondo de la escena: se repinta cuando cambia la hora (una vez por minuto como mucho) */
export const skyBackground = new DataTexture(skyData, SKY_W, SKY_H, RGBAFormat);
skyBackground.colorSpace = SRGBColorSpace;
skyBackground.magFilter = LinearFilter;
skyBackground.minFilter = LinearFilter;
skyBackground.generateMipmaps = false;

/** pinta el cielo de la hora con el fondo elegido (scene/sky): la fila 0 es el borde de abajo de la pantalla */
export function paintSky(data: Uint8Array, day: SkyDay): void {
  skyPainter().paint(data, SKY_W, SKY_H, day);
}

export function updateSky(day: DayState): void {
  paintSky(skyData, day);
  skyBackground.needsUpdate = true;
}

// ---------------------------------------------------------------- pases

/** halos, charcos de luz y vapor no tienen cuerpo: no deben proyectar oclusion */
function bodiless(o: Object3D): boolean {
  const m = (o as { material?: { transparent?: boolean; depthWrite?: boolean } }).material;
  return (o as { isSprite?: boolean }).isSprite === true || (m !== undefined && m.transparent === true && m.depthWrite === false);
}

// firma de por donde andan los personajes: si no cambia, las sombras de este cuadro son las del anterior
let walkersSum = 0;
function addWalker(o: Object3D): void {
  const bone = (o as { skeleton?: { bones: Object3D[] } }).skeleton?.bones[0];
  if (!bone) return;
  const e = bone.matrixWorld.elements;
  // solo el plano del piso y redondeado: respirar o teclear no cuenta, caminar si
  walkersSum += Math.round((e[12] ?? 0) * 40) * 3 + Math.round((e[14] ?? 0) * 40) * 7 + 1;
}

export function walkersSignature(scene: Scene): number {
  walkersSum = 0;
  scene.traverseVisible(addWalker);
  return walkersSum;
}

const probePixel = new Uint8Array(4);

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function CinePipeline() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const setDpr = useThree((s) => s.setDpr);
  const day = useDayState();
  const quality = useQuality();
  const composer = useRef<EffectComposer | null>(null);
  const tick = useRef({ frames: 0, lastShadow: -1, lastCheck: -1, walkers: 0, shadows: 0, shadowT: 0, costs: [] as number[], every: GOVERNOR.every as number, next: GOVERNOR.warmup as number });

  useEffect(() => updateSky(day), [day]);

  useEffect(() => {
    const device = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    setDpr(Math.min(device, QUALITY[quality].dpr));
  }, [quality, setDpr]);

  // la luz cambio (hora, modo): las sombras se recalculan ya
  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
  }, [gl, day, quality]);

  useEffect(() => {
    const q = QUALITY[quality];
    const toneMapping = gl.toneMapping;
    const autoUpdate = gl.shadowMap.autoUpdate;
    const autoReset = gl.info.autoReset;
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = 1;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    gl.info.autoReset = false;
    const target = new WebGLRenderTarget(size.width * dpr, size.height * dpr, { type: HalfFloatType, samples: q.samples });
    const fx = new EffectComposer(gl, target);
    fx.setPixelRatio(dpr);
    fx.setSize(size.width, size.height);
    fx.addPass(new RenderPass(scene, camera));

    if (q.ao) {
      const ao = new GTAOPass(scene, camera, size.width, size.height);
      ao.updateGtaoMaterial({ radius: 0.42, distanceExponent: 1.5, thickness: 1.1, scale: 1.2, samples: 8 });
      ao.blendIntensity = 0.9;
      const setSize = ao.setSize.bind(ao);
      ao.setSize = (w: number, h: number) => setSize(Math.max(1, Math.ceil(w * AO_SCALE)), Math.max(1, Math.ceil(h * AO_SCALE)));
      const render = ao.render.bind(ao);
      const hidden: Object3D[] = [];
      ao.render = (...args: Parameters<typeof render>) => {
        hidden.length = 0;
        scene.traverseVisible((o) => {
          if (bodiless(o)) hidden.push(o);
        });
        for (const o of hidden) o.visible = false;
        try {
          render(...args);
        } finally {
          for (const o of hidden) o.visible = true;
        }
      };
      fx.addPass(ao);
    }
    const finish = new ShaderPass(FINISH);
    finish.uniforms.uTexel?.value.set(1 / (size.width * dpr), 1 / (size.height * dpr));
    if (finish.uniforms.uBlur) finish.uniforms.uBlur.value = q.tilt ? TILT.blur * dpr : 0;
    fx.addPass(finish);
    composer.current = fx;
    tick.current.frames = 0;
    tick.current.costs.length = 0;
    tick.current.every = GOVERNOR.every;
    tick.current.next = GOVERNOR.warmup;
    return () => {
      composer.current = null;
      gl.toneMapping = toneMapping;
      gl.shadowMap.autoUpdate = autoUpdate;
      gl.info.autoReset = autoReset;
      fx.dispose();
      target.dispose();
    };
  }, [gl, scene, camera, size.width, size.height, dpr, quality]);

  useFrame((state) => {
    const fx = composer.current;
    if (!fx) {
      state.gl.render(state.scene, state.camera);
      return;
    }
    const t = tick.current;
    const now = state.clock.elapsedTime;
    t.frames += 1;

    // sombras: a SHADOW_HZ mientras alguien camina; si no, SHADOW_IDLE_HZ
    if (now - t.lastCheck >= 1 / SHADOW_HZ) {
      t.lastCheck = now;
      const walkers = walkersSignature(state.scene);
      if (walkers !== t.walkers || now - t.lastShadow >= 1 / SHADOW_IDLE_HZ) {
        t.walkers = walkers;
        t.lastShadow = now;
        t.shadows += 1;
        state.gl.shadowMap.needsUpdate = true;
      }
    }
    if (now - t.shadowT >= 1) {
      perf.shadowHz = t.shadows / (now - t.shadowT);
      t.shadows = 0;
      t.shadowT = now;
    }

    // gobernador: de vez en cuando se espera a que la tarjeta termine el cuadro para saber cuanto tarda
    const governs = getQualityMode() === 'auto' && quality !== 'baja';
    const measure = (governs || perf.probe) && t.frames >= t.next;
    if (measure) t.next = t.frames + t.every;
    const t0 = measure ? performance.now() : 0;
    state.gl.info.reset();
    fx.render();
    perf.calls = state.gl.info.render.calls;
    perf.triangles = state.gl.info.render.triangles;
    if (measure) {
      // leer un pixel obliga a esperar a que la tarjeta termine (gl.finish no espera en Chrome)
      const ctx = state.gl.getContext();
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, probePixel);
      perf.costMs = performance.now() - t0;
      if (governs) t.costs.push(perf.costMs);
      if (t.costs.length >= GOVERNOR.samples) {
        const slow = median(t.costs) > GOVERNOR.slowMs;
        t.costs.length = 0;
        if (slow) lowerQuality();
        // el equipo aguanta este nivel: se mide cada vez menos (medir obliga a esperar a la tarjeta)
        else t.every = Math.min(GOVERNOR.relaxed, t.every * 2);
      }
    }
  }, 1);
  return null;
}
