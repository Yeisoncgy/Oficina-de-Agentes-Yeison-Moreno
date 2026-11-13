// Ritmo de la escena. El Canvas no dibuja por su cuenta (frameloop "never"): este reloj decide cuando avanza
// un cuadro, y con el avanza TODO (animaciones, etiquetas, camara y el render), asi que bajar el ritmo
// baja de verdad el trabajo del equipo y no solo el dibujo.
// - mientras se usa (puntero sobre la escena, rueda, arrastre, teclas, camara en vuelo): 60 cuadros/s;
// - quieta y con la ventana en primer plano: 30;
// - con la ventana a la vista pero sin foco (se esta trabajando en otra): 20;
// - pestana oculta: nada (el navegador no llama).
// El ritmo no depende de la pantalla: en una de 144 Hz se dibuja uno de cada dos o de cada cinco refrescos,
// siempre con la misma separacion entre cuadros (sin tirones). Si el equipo no llega al ritmo, dibuja todos.

import { useEffect, useRef } from 'react';
import { advance, useFrame } from '@react-three/fiber';
import { Matrix4 } from 'three';

/** cuadros por segundo que se buscan en cada estado */
export const RATE = { active: 60, idle: 30, background: 20 } as const;
export type PaceState = 'activo' | 'reposo' | 'fondo';

/** tras la ultima senal de uso sigue en "activo" este tiempo (ms) */
const ACTIVE_HOLD = 900;
const HZ_WINDOW = 48;

/** lectura en vivo para el gobernador de calidad y para ?perf=1 */
export const perf = {
  /** refresco estimado de la pantalla */
  hz: 60,
  state: 'reposo' as PaceState,
  /** cuadros por segundo que se buscan ahora y los que salen de verdad */
  target: RATE.idle as number,
  fps: 0,
  /** ms entre los dos ultimos cuadros dibujados */
  frameMs: 0,
  /** llamadas de dibujo y triangulos del ultimo cuadro (los llena el revelado) */
  calls: 0,
  triangles: 0,
  /** veces por segundo que se recalcularon las sombras */
  shadowHz: 0,
  /** ms que tardo la tarjeta en un cuadro completo, la ultima vez que se midio (0 = sin medir) */
  costMs: 0,
  /** ?perf=1: mide siempre, aunque la calidad este fijada */
  probe: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('perf') === '1',
};

let activeUntil = 0;

/** hubo uso: la escena va a 60 cuadros/s durante `ms` */
export function markActive(ms: number = ACTIVE_HOLD): void {
  const until = (typeof performance === 'undefined' ? 0 : performance.now()) + ms;
  if (until > activeUntil) activeUntil = until;
}

/**
 * Toca dibujar: paso al menos el intervalo del ritmo buscado, con media pantalla de tolerancia (asi cae
 * siempre en el refresco mas cercano y la separacion entre cuadros es pareja: en 144 Hz, uno de cada dos
 * para 60 y uno de cada cinco para 30). Si el equipo va lento, cada refresco llega tarde y se dibujan todos.
 */
export function frameDue(elapsedMs: number, rate: number, hz: number): boolean {
  return elapsedMs >= 1000 / rate - 500 / hz;
}

/** refresco de la pantalla a partir de los ultimos intervalos entre refrescos (ms) */
export function estimateHz(intervals: readonly number[]): number {
  if (intervals.length < 8) return 60;
  const sorted = [...intervals].sort((a, b) => a - b);
  // un percentil bajo: los cuadros lentos alargan intervalos, nunca los acortan
  const ms = sorted[Math.floor(sorted.length * 0.25)] ?? 16.7;
  return Math.min(240, Math.max(24, 1000 / Math.max(1, ms)));
}

/**
 * Arranca el reloj de la escena. `root` es el contenedor de la escena: el puntero, la rueda y el arrastre
 * sobre el cuentan como uso. Devuelve la funcion que lo detiene.
 */
export function startPacer(root: HTMLElement | null): () => void {
  let raf = 0;
  let start = -1;
  let last = 0;
  let lastDraw = 0;
  let tick = 0;
  const intervals: number[] = [];

  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    if (start < 0) start = t;
    if (last > 0) {
      const d = t - last;
      if (d > 0 && d < 1000) {
        intervals.push(d);
        if (intervals.length > HZ_WINDOW) intervals.shift();
        if (tick % 24 === 0) perf.hz = estimateHz(intervals);
      }
    }
    last = t;
    tick += 1;

    const state: PaceState = t < activeUntil ? 'activo' : document.hasFocus() ? 'reposo' : 'fondo';
    const rate = state === 'activo' ? RATE.active : state === 'reposo' ? RATE.idle : RATE.background;
    perf.state = state;
    perf.target = rate;
    if (lastDraw > 0 && !frameDue(t - lastDraw, rate, perf.hz)) return;

    if (lastDraw > 0) {
      perf.frameMs = t - lastDraw;
      perf.fps += (1000 / Math.max(1, perf.frameMs) - perf.fps) * 0.1;
    }
    lastDraw = t;
    advance((t - start) / 1000);
  };

  const use = () => markActive();
  const opts = { passive: true } as const;
  root?.addEventListener('pointermove', use, opts);
  root?.addEventListener('pointerdown', use, opts);
  root?.addEventListener('wheel', use, opts);
  window.addEventListener('keydown', use, opts);
  window.addEventListener('resize', use, opts);
  // el primer segundo va completo: carga, primer encuadre y medida del equipo
  markActive(1500);
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    root?.removeEventListener('pointermove', use);
    root?.removeEventListener('pointerdown', use);
    root?.removeEventListener('wheel', use);
    window.removeEventListener('keydown', use);
    window.removeEventListener('resize', use);
  };
}

/** dentro del Canvas: la camara en movimiento (arrastre con inercia, vuelos a una sala) tambien es uso */
export function CameraActivity() {
  const lastCam = useRef(new Matrix4());
  const lastZoom = useRef(0);
  useFrame(({ camera }) => {
    const zoom = (camera as { zoom?: number }).zoom ?? 0;
    if (zoom === lastZoom.current && camera.matrixWorld.equals(lastCam.current)) return;
    lastCam.current.copy(camera.matrixWorld);
    lastZoom.current = zoom;
    markActive();
  }, -2);
  return null;
}

/** arranca y detiene el reloj con el contenedor de la escena */
export function usePacer(root: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !root) return;
    return startPacer(root);
  }, [root, enabled]);
}
