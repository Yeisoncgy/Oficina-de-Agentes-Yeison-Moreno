// Lenguaje de movimiento de los personajes (D5): curvas, duraciones y la preferencia de movimiento
// reducido. Funciones puras y sin asignaciones: se llaman en cada frame.

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return (x: number): number => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 20; i++) {
      if (((ax * t + bx) * t + cx) * t < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

/** Curvas con nombre de la especificacion (mismas cubic-bezier que el HUD) */
export const CURVE = {
  /** lo que entra y frena */
  llegar: bezier(0.22, 1, 0.36, 1),
  /** lo que sale y acelera */
  irse: bezier(0.64, 0, 0.78, 0),
  /** cambios de estado y de pose */
  cambiar: bezier(0.65, 0, 0.35, 1),
  /** solo apariciones */
  rebotar: bezier(0.34, 1.56, 0.64, 1),
} as const;

/** Duraciones (s) y medidas (u) de la tabla "1 · Personajes" de D5 */
export const MOTION = {
  /** caminar al puesto y salir */
  walkSpeed: 1.5,
  /** el lider acelera al cruzar la puerta hacia el pasillo */
  hallSpeed: 2.0,
  /** arranque y frenado de 250 ms */
  accel: 6,
  minSpeed: 0.2,
  /** zancada: rad de fase por unidad recorrida (unos 2,9 pasos por segundo a 1,5 u/s) */
  stride: 6,
  bounce: 0.04,
  /** el rumbo mira 0,18 u adelante y atras: las esquinas se redondean solas */
  lookAhead: 0.18,
  /** giros en esquinas: 240 ms por 90 grados */
  turnRate: Math.PI / 2 / 0.24,
  appear: 0.33,
  appearToWalk: 0.15,
  faceFront: 0.25,
  sitDelay: 0.3,
  sit: 0.45,
  stand: 0.4,
  /** salir 450 ms despues de empezar a levantarse */
  standToWalk: 0.45,
  /** el giro hacia la ruta empieza en los ultimos 100 ms de levantarse */
  turnBeforeWalk: 0.1,
  vanish: 0.24,
  /** teclear <-> pensar y demas mezclas de pose */
  poseBlend: 0.35,
  blinkEvery: 3.1,
  blink: 0.13,
  bubbleFrame: 0.4,
  /** zzz de dormido: una letra mas cada 0,6 s (mas lento que la burbuja: respira) */
  zzzFrame: 0.6,
  /** saltito de terminado: retardo, subida, bajada, aterrizaje y cara contenta antes de levantarse */
  hopDelay: 0.25,
  hopUp: 0.16,
  hopDown: 0.2,
  hopHeight: 0.1,
  land: 0.12,
  doneHold: 0.55,
  /** chispa de aparicion */
  spark: 0.7,
} as const;

/** Duracion total de la celebracion de "terminado" antes de levantarse */
export const DONE_TIME = MOTION.hopDelay + MOTION.hopUp + MOTION.hopDown + MOTION.land + MOTION.doneHold;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function bump(x: number, center: number, width: number): number {
  return Math.max(0, 1 - Math.abs(x - center) / width);
}

/** Diferencia angular mas corta de a hacia b, en [-PI, PI] */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/** Tween: 0 antes de start, curva durante dur, 1 despues */
export function tween(time: number, start: number, dur: number, curve: (x: number) => number): number {
  if (dur <= 0) return time >= start ? 1 : 0;
  return curve(clamp01((time - start) / dur));
}

/** Ventana con entrada y salida suaves (ciclos de pose): 0 fuera de [a, b + r] */
export function cycleWindow(c: number, a: number, b: number, r: number): number {
  if (c < a || c >= b + r) return 0;
  if (c < a + r) return CURVE.cambiar((c - a) / r);
  if (c < b) return 1;
  return 1 - CURVE.cambiar((c - b) / r);
}

// ---------------------------------------------------------------- saltito de terminado

/** Altura del saltito (u) a los e segundos de "terminado" */
export function hopLift(e: number): number {
  const x = e - MOTION.hopDelay;
  if (x < 0) return 0;
  if (x < MOTION.hopUp) return MOTION.hopHeight * CURVE.llegar(x / MOTION.hopUp);
  if (x < MOTION.hopUp + MOTION.hopDown) {
    return MOTION.hopHeight * (1 - CURVE.irse((x - MOTION.hopUp) / MOTION.hopDown));
  }
  return 0;
}

/** Aplastamiento al aterrizar (0..1): el cuerpo baja 10 % y se ensancha 5 % */
export function landSquash(e: number): number {
  const x = e - MOTION.hopDelay - MOTION.hopUp - MOTION.hopDown;
  if (x < 0 || x >= MOTION.land) return 0;
  return Math.sin((Math.PI * x) / MOTION.land);
}

/** Brazos arriba durante el saltito (0..1) */
export function armsUp(e: number): number {
  const x = e - MOTION.hopDelay;
  const up = tween(x, -0.04, 0.12, CURVE.llegar);
  const down = tween(x, MOTION.hopUp + MOTION.hopDown - 0.02, 0.18, CURVE.cambiar);
  return up * (1 - down);
}

// ---------------------------------------------------------------- movimiento reducido

let reduced = false;
let forced: boolean | null = null;

function initReducedMotion(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = mq.matches;
    mq.addEventListener?.('change', (e) => {
      reduced = e.matches;
    });
  } catch {
    reduced = false;
  }
}

initReducedMotion();

/** prefers-reduced-motion: se va lo que desplaza, escala o gira; se queda lo que informa */
export function reducedMotion(): boolean {
  return forced ?? reduced;
}

/** Solo para pruebas: fuerza el modo (null = segun el sistema) */
export function forceReducedMotion(value: boolean | null): void {
  forced = value;
}
