// Estado de ambiente compartido por toda la oficina, avanzado una sola vez por frame:
// reloj de escena, encendido de lamparas con la transicion de D5 (pasos al anochecer, fundido al
// amanecer) y preferencia de movimiento reducido. Sin asignaciones por frame.

import { CURVE, flickerOn } from './kit';

export interface AmbientState {
  /** segundos de escena (congelado en 0 con movimiento reducido) */
  t: number;
  /** segundos reales, para transiciones que igual deben terminar */
  clock: number;
  lampsOn: boolean;
  /** momento del ultimo cambio de lamparas (reloj real) */
  lampSince: number;
  /** 0..1 nivel de las lamparas con la curva de D5 */
  lamp: number;
  /** 0.35 de dia · 1 de noche: fuerza de lampara del kit para la luz puntual */
  lampI: number;
  /** 0.35..1 fuerza de halos de pantalla (mas de noche) */
  glowNight: number;
  /** peso de noche + parte del atardecer: charcos de luna */
  moon: number;
  /** peso de dia + parte del atardecer: polvo en la luz */
  sun: number;
  /** direccion unitaria hacia el sol o la luna */
  sunDir: { x: number; y: number; z: number };
  reduced: boolean;
  initialized: boolean;
}

export const AMBIENT: AmbientState = {
  t: 0,
  clock: 0,
  lampsOn: false,
  lampSince: -99,
  lamp: 0,
  lampI: 1,
  glowNight: 1,
  moon: 0,
  sun: 0,
  sunDir: { x: -0.3, y: 0.8, z: -0.5 },
  reduced: false,
  initialized: false,
};

let media: MediaQueryList | null = null;

function readReduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!media) {
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      AMBIENT.reduced = media?.matches ?? false;
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  }
  return media.matches;
}

/** nivel de lampara de un foco de la guirnalda: la ola avanza 70 ms por foco al encender */
export function lampWave(i: number): number {
  return lampLevelAt(AMBIENT.clock - AMBIENT.lampSince - i * 0.07);
}

function lampLevelAt(e: number): number {
  if (AMBIENT.reduced) return AMBIENT.lampsOn ? 1 : 0;
  if (AMBIENT.lampsOn) return flickerOn(e);
  return 1 - CURVE.irse(Math.min(1, Math.max(0, e / 0.4)));
}

interface DayInput {
  lampsOn: boolean;
  lampI: number;
  glowNight: number;
  night: number;
  dusk: number;
  daylight: number;
  sunDirection: { x: number; y: number; z: number };
}

/** avanza el ambiente; clock = segundos reales desde que arranco la escena */
export function updateAmbient(clock: number, day: DayInput): void {
  const a = AMBIENT;
  if (!a.initialized) {
    a.initialized = true;
    a.reduced = readReduced();
    a.lampsOn = day.lampsOn;
    a.lampSince = clock - 10;
  } else if (day.lampsOn !== a.lampsOn) {
    a.lampsOn = day.lampsOn;
    a.lampSince = clock;
  }
  a.clock = clock;
  a.t = a.reduced ? 0 : clock;
  a.lamp = lampLevelAt(clock - a.lampSince);
  a.lampI = day.lampI;
  a.glowNight = day.glowNight;
  a.moon = day.night + day.dusk * 0.3;
  a.sun = day.daylight + day.dusk * 0.6;
  a.sunDir.x = day.sunDirection.x;
  a.sunDir.y = day.sunDirection.y;
  a.sunDir.z = day.sunDirection.z;
}
