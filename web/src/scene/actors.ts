// Estado de cada personaje en escena. Vive en objetos mutables (refs) para que un snapshot nuevo
// no reinicie las animaciones: el snapshot solo cambia destinos y actividad; el movimiento lo
// avanza stepActor en cada frame, con los tiempos del lenguaje de movimiento (D5):
//   aparecer 330 ms (rebotar) -> caminar a 1,5 u/s con arranque y frenado de 250 ms, rumbo que mira
//   0,18 u adelante y atras -> al llegar gira al frente en 250 ms -> 300 ms despues se sienta en 450 ms.
//   Al terminar: saltito desde la silla, levantarse en 400 ms, salir 450 ms despues y desaparecer
//   en 240 ms sin dejar de caminar, ya en el pasillo.
// stepActor no asigna memoria.

import { CURVE, DONE_TIME, lerpAngle, MOTION, reducedMotion, angleDelta as delta } from './characters/motion';
import type { NavGraph, Vec2 } from './layout';
import { distance, findPath, nearestNode, pathLength, pathPoints } from './layout';

/**
 * Lo que hace el personaje quieto en su lugar (cada una con su pose, ver characters/poses.ts):
 * typing / thinking / idle / done en el escritorio · coffee: taza en la mano · reading: libro abierto ·
 * lab: matraz en el banco · meeting: conversando · reviewing: inclinado con lupa · sleeping: cabeza
 * abajo + zzz · waiting: de pie, pie inquieto + "?".
 */
export type Activity =
  | 'typing'
  | 'thinking'
  | 'idle'
  | 'done'
  | 'coffee'
  | 'reading'
  | 'lab'
  | 'meeting'
  | 'reviewing'
  | 'sleeping'
  | 'waiting';
export type Phase = 'entering' | 'present' | 'leaving' | 'vanishing' | 'gone';

export interface Actor {
  id: string;
  pos: Vec2;
  heading: number;
  /** puntos por recorrer y sus nodos; routeIdx = siguiente punto */
  route: Vec2[];
  routeIds: string[];
  routeIdx: number;
  /** distancia desde el inicio de la ruta hasta cada punto */
  routeCum: number[];
  /** velocidad de crucero del tramo que llega a cada punto */
  routeSpeed: number[];
  /** donde estaba al trazar la ruta */
  routeStart: Vec2;
  /** recorrido y largo total de la ruta */
  routeDist: number;
  routeLen: number;
  /** ultimo nodo alcanzado (para recalcular rutas sin atravesar muebles) */
  lastNode: string | null;
  targetNode: string | null;
  /** hacia donde mirar al llegar */
  endHeading: number | null;
  wantSit: boolean;
  /** 0 de pie · 1 sentado (con curva) */
  sit: number;
  /** avance lineal de sentarse (0..1) */
  sitLin: number;
  /** escala de aparicion (0..1 lineal; al desaparecer baja de 1 a 0) */
  pop: number;
  /** segundos desde que empezo a aparecer (-1 = aparecio sin animacion) */
  appearT: number;
  /** segundos desde que empezo a desaparecer */
  vanishT: number;
  moving: boolean;
  /** velocidad actual (u/s) */
  speed: number;
  /** fase de la zancada (rad): 6 rad por unidad recorrida */
  walkPhase: number;
  /** 0..1 cuanto camina (velocidad / 0,6) */
  walkBlend: number;
  moveHeading: number;
  phase: Phase;
  activity: Activity;
  /** con la taza en la mano aunque no este tomando cafe (el lider camino a la cafetera); se lee en cada frame */
  mug: boolean;
  /** segundos que quedan de la celebracion de "termine" (saltito y cara contenta) */
  hop: number;
  /** espera antes de echar a andar (tras aparecer o levantarse) */
  delay: number;
  /** segundos quieto desde que llego */
  arrivedT: number;
  /** rumbo al llegar (desde ahi gira al frente) */
  turnFrom: number;
  /** 0..1 estable por id: desfasa parpadeos y miradas */
  seed: number;
}

export const WALK_SPEED = MOTION.walkSpeed;
/** celebracion completa de "termine" antes de levantarse */
export const HOP_TIME = DONE_TIME;
/** la chispa de desaparecer termina un poco despues de la escala */
const VANISH_TAIL = 0.12;
/** ya asentado: no anima el giro al frente */
const SETTLED = 10;

export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

export function createActor(id: string, pos: Vec2, heading = 0): Actor {
  return {
    id,
    pos: { x: pos.x, z: pos.z },
    heading,
    route: [],
    routeIds: [],
    routeIdx: 0,
    routeCum: [],
    routeSpeed: [],
    routeStart: { x: pos.x, z: pos.z },
    routeDist: 0,
    routeLen: 0,
    lastNode: null,
    targetNode: null,
    endHeading: null,
    wantSit: false,
    sit: 0,
    sitLin: 0,
    pop: 1,
    appearT: -1,
    vanishT: 0,
    moving: false,
    speed: 0,
    walkPhase: 0,
    walkBlend: 0,
    moveHeading: heading,
    phase: 'present',
    activity: 'idle',
    mug: false,
    hop: 0,
    delay: 0,
    arrivedT: SETTLED,
    turnFrom: heading,
    seed: hashSeed(id),
  };
}

/** Diferencia angular mas corta de a hacia b, en [-PI, PI] */
export function angleDelta(a: number, b: number): number {
  return delta(a, b);
}

function approachAngle(current: number, target: number, maxStep: number): number {
  const d = delta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export interface Destination {
  endHeading: number | null;
  sit: boolean;
}

/** Deja al actor quieto en un punto, sin ruta */
export function stopAt(a: Actor, p: Vec2): void {
  a.pos.x = p.x;
  a.pos.z = p.z;
  a.route = [];
  a.routeIds = [];
  a.routeIdx = 0;
  a.routeCum = [];
  a.routeSpeed = [];
  a.routeStart = { x: p.x, z: p.z };
  a.routeDist = 0;
  a.routeLen = 0;
  a.speed = 0;
  a.moving = false;
  a.walkBlend = 0;
}

/** Teletransporta al nodo (primer pintado o cambio brusco de distribucion) */
export function placeAt(a: Actor, g: NavGraph, nodeId: string, dest: Destination): boolean {
  const p = g.nodes.get(nodeId);
  if (!p) return false;
  stopAt(a, p);
  a.lastNode = nodeId;
  a.targetNode = nodeId;
  a.endHeading = dest.endHeading;
  a.wantSit = dest.sit;
  a.sitLin = dest.sit ? 1 : 0;
  a.sit = a.sitLin;
  a.delay = 0;
  a.arrivedT = SETTLED;
  if (dest.endHeading !== null) {
    a.heading = dest.endHeading;
    a.moveHeading = dest.endHeading;
  }
  a.turnFrom = a.heading;
  return true;
}

/**
 * Traza una ruta desde donde esta el actor hasta un nodo. Parte del ultimo nodo alcanzado o del
 * siguiente de su ruta actual (el que salga mas corto), asi nunca corta camino atravesando muebles.
 * Conserva la velocidad actual: cambiar de destino a mitad de camino no frena en seco.
 */
export function routeTo(a: Actor, g: NavGraph, targetId: string, dest: Destination): boolean {
  const candidates: string[] = [];
  if (a.lastNode && g.nodes.has(a.lastNode)) candidates.push(a.lastNode);
  const next = a.routeIds[a.routeIdx];
  if (next !== undefined && next !== a.lastNode && g.nodes.has(next)) candidates.push(next);
  if (candidates.length === 0) {
    const near = nearestNode(g, a.pos);
    if (near) candidates.push(near);
  }
  let best: { ids: string[]; cost: number } | null = null;
  for (const start of candidates) {
    const ids = findPath(g, start, targetId);
    const startPos = g.nodes.get(start);
    if (!ids || !startPos) continue;
    const cost = distance(a.pos, startPos) + pathLength(pathPoints(g, ids));
    if (!best || cost < best.cost) best = { ids, cost };
  }
  if (!best) return false;
  const route = pathPoints(g, best.ids);
  const cum: number[] = [];
  let total = 0;
  let prev: Vec2 = a.pos;
  for (const p of route) {
    total += distance(prev, p);
    cum.push(total);
    prev = p;
  }
  a.routeIds = best.ids;
  a.route = route;
  a.routeCum = cum;
  a.routeSpeed = route.map(() => WALK_SPEED);
  a.routeStart = { x: a.pos.x, z: a.pos.z };
  a.routeDist = 0;
  a.routeLen = total;
  a.routeIdx = 0;
  a.targetNode = targetId;
  a.endHeading = dest.endHeading;
  a.wantSit = dest.sit;
  return true;
}

/** Velocidad de crucero por tramo (el lider acelera en los pasillos) */
export function setRouteSpeeds(a: Actor, speedFor: (from: Vec2, to: Vec2) => number): void {
  for (let i = 0; i < a.route.length; i++) {
    const to = a.route[i];
    const from = i === 0 ? a.routeStart : a.route[i - 1];
    if (to && from) a.routeSpeed[i] = speedFor(from, to);
  }
}

export function isTraveling(a: Actor): boolean {
  return a.routeIdx < a.route.length;
}

/** Punto de la ruta a la distancia d desde su inicio (escribe en out) */
function pointOnRoute(a: Actor, d: number, out: Vec2): Vec2 {
  let px = a.routeStart.x;
  let pz = a.routeStart.z;
  let pc = 0;
  for (let i = 0; i < a.route.length; i++) {
    const p = a.route[i];
    const c = a.routeCum[i] ?? pc;
    if (!p) break;
    if (d <= c) {
      const k = c - pc > 1e-9 ? (d - pc) / (c - pc) : 1;
      out.x = px + (p.x - px) * k;
      out.z = pz + (p.z - pz) * k;
      return out;
    }
    px = p.x;
    pz = p.z;
    pc = c;
  }
  out.x = px;
  out.z = pz;
  return out;
}

const behind: Vec2 = { x: 0, z: 0 };
const ahead: Vec2 = { x: 0, z: 0 };

/** Rumbo de la ruta en d: mira 0,18 u atras y adelante, asi las esquinas se redondean solas */
function routeHeading(a: Actor, d: number, fallback: number): number {
  const L = a.routeLen;
  const la = MOTION.lookAhead;
  pointOnRoute(a, Math.max(0, Math.min(L - 2 * la, d - la)), behind);
  pointOnRoute(a, Math.min(L, Math.max(2 * la, d + la)), ahead);
  const dx = ahead.x - behind.x;
  const dz = ahead.z - behind.z;
  if (dx * dx + dz * dz < 1e-8) return fallback;
  return Math.atan2(dx, dz);
}

function turnTowardRoute(a: Actor, dt: number): void {
  a.moveHeading = routeHeading(a, a.routeDist, a.heading);
  a.heading = approachAngle(a.heading, a.moveHeading, dt * MOTION.turnRate);
}

/** Tiempo aproximado hasta el final de la ruta, contando el frenado */
function timeToEnd(a: Actor): number {
  const rem = Math.max(0, a.routeLen - a.routeDist);
  const v = Math.max(a.speed, MOTION.minSpeed);
  const brake = (v * v) / (2 * MOTION.accel);
  if (rem <= brake) return Math.sqrt((2 * rem) / MOTION.accel);
  return v / MOTION.accel + (rem - brake) / v;
}

function startVanish(a: Actor): void {
  a.phase = 'vanishing';
  a.vanishT = 0;
}

function arrive(a: Actor): void {
  a.speed = 0;
  a.moving = false;
  a.delay = 0;
  a.arrivedT = 0;
  a.turnFrom = a.heading;
  if (a.phase === 'entering') a.phase = 'present';
  else if (a.phase === 'leaving') startVanish(a);
}

/** Movimiento reducido: sin caminatas ni giros, el agente aparece donde va */
function finishRouteNow(a: Actor): void {
  const last = a.route[a.route.length - 1];
  if (last) {
    a.pos.x = last.x;
    a.pos.z = last.z;
  }
  a.lastNode = a.routeIds[a.routeIds.length - 1] ?? a.lastNode;
  a.routeIdx = a.route.length;
  a.routeDist = a.routeLen;
  a.hop = 0;
  a.sitLin = a.wantSit ? 1 : 0;
  a.sit = a.sitLin;
  if (a.endHeading !== null) a.heading = a.endHeading;
  arrive(a);
  a.arrivedT = SETTLED;
}

function travel(a: Actor, dt: number): void {
  // 1. celebra en su lugar (sentado o de pie) antes de irse
  if (a.hop > 0) {
    if (a.speed > 0) {
      a.hop = 0;
    } else {
      a.hop = Math.max(0, a.hop - dt);
      a.moving = false;
      return;
    }
  }
  // 2. se levanta; en los ultimos 100 ms empieza a girar hacia la ruta
  if (a.sitLin > 0) {
    a.sitLin = Math.max(0, a.sitLin - dt / MOTION.stand);
    a.sit = CURVE.cambiar(a.sitLin);
    if (a.sitLin * MOTION.stand <= MOTION.turnBeforeWalk) turnTowardRoute(a, dt);
    if (a.sitLin === 0) a.delay = Math.max(a.delay, MOTION.standToWalk - MOTION.stand);
    a.speed = 0;
    a.moving = false;
    return;
  }
  // 3. espera corta (tras aparecer o levantarse) ya girando hacia la ruta
  if (a.delay > 0) {
    a.delay = Math.max(0, a.delay - dt);
    turnTowardRoute(a, dt);
    a.speed = 0;
    a.moving = false;
    return;
  }
  // 4. camina: arranca y cambia de crucero a 6 u/s2; frena siguiendo v = sqrt(2 a d) hasta el final
  const cruise = a.routeSpeed[a.routeIdx] ?? WALK_SPEED;
  const rem = Math.max(0, a.routeLen - a.routeDist);
  const maxDv = MOTION.accel * dt;
  let v = a.speed < cruise ? Math.min(cruise, a.speed + maxDv) : Math.max(cruise, a.speed - maxDv);
  v = Math.min(v, Math.max(MOTION.minSpeed, Math.sqrt(2 * MOTION.accel * rem)));
  a.speed = v;
  const ds = Math.min(rem, v * dt);
  a.routeDist += ds;
  while (a.routeIdx < a.route.length && (a.routeCum[a.routeIdx] ?? 0) <= a.routeDist + 1e-9) {
    a.lastNode = a.routeIds[a.routeIdx] ?? a.lastNode;
    a.routeIdx++;
  }
  pointOnRoute(a, a.routeDist, a.pos);
  a.walkPhase += ds * MOTION.stride;
  a.moving = true;
  turnTowardRoute(a, dt);
  if (!isTraveling(a)) {
    const last = a.route[a.route.length - 1];
    if (last) {
      a.pos.x = last.x;
      a.pos.z = last.z;
    }
    arrive(a);
    return;
  }
  if (a.phase === 'leaving' && timeToEnd(a) <= MOTION.vanish) startVanish(a);
}

function settle(a: Actor, dt: number): void {
  a.speed = 0;
  a.moving = false;
  if (a.arrivedT < SETTLED) a.arrivedT += dt;
  if (a.endHeading !== null) {
    if (a.arrivedT >= MOTION.faceFront) a.heading = a.endHeading;
    else a.heading = lerpAngle(a.turnFrom, a.endHeading, CURVE.cambiar(a.arrivedT / MOTION.faceFront));
  }
  if (a.wantSit) {
    if (a.arrivedT >= MOTION.sitDelay) a.sitLin = Math.min(1, a.sitLin + dt / MOTION.sit);
  } else {
    a.sitLin = Math.max(0, a.sitLin - dt / MOTION.stand);
  }
  a.sit = CURVE.cambiar(a.sitLin);
  if (a.hop > 0) a.hop = Math.max(0, a.hop - dt);
}

/** Avanza un frame: aparecer, celebrar, levantarse, caminar, girar al frente, sentarse, desaparecer */
export function stepActor(a: Actor, dt: number): void {
  if (a.phase === 'gone') return;
  const reduced = reducedMotion();
  if (a.appearT >= 0) a.appearT = a.appearT > 2 ? -1 : a.appearT + dt;
  if (a.phase === 'vanishing') {
    a.vanishT += dt;
    a.pop = reduced ? 0 : Math.max(0, 1 - a.vanishT / MOTION.vanish);
    if (reduced || a.vanishT >= MOTION.vanish + VANISH_TAIL) {
      a.phase = 'gone';
      a.moving = false;
      a.speed = 0;
      a.walkBlend = 0;
      return;
    }
  } else if (a.pop < 1) {
    a.pop = reduced ? 1 : Math.min(1, a.pop + dt / MOTION.appear);
  }
  if (reduced && isTraveling(a)) finishRouteNow(a);
  if (isTraveling(a)) travel(a, dt);
  else settle(a, dt);
  a.walkBlend = Math.min(1, a.speed / 0.6);
}
