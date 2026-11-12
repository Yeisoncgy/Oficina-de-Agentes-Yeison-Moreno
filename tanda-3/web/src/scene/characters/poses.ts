// Poses del kit 3D (animateCharacter) y de D5, como una mezcla de pesos: la escena real cambia de pose
// con transiciones (teclear <-> pensar en 350 ms, sentarse en 450 ms...) en vez de saltar entre poses
// fijas. applyPose es una funcion del estado y del tiempo: vuelve el rig al reposo y aplica la mezcla.
// No asigna memoria: se llama en cada frame para cada personaje.
// Las poses de las zonas de la sala (leer, laboratorio, reunion, revision, dormir, esperar) se leen a
// la distancia de la camara por su silueta y su utileria, no por detalles de la cara.

import { armsUp, bump, clamp01, CURVE, cycleWindow, hopLift, landSquash, MOTION, smooth } from './motion';
import { sparkMaterialFor } from './materials';
import { type CharacterRig, QUESTION_POS, SIT_LIFT, ZZZ_POS } from './rig';

export type Expression = 'neutral' | 'focus' | 'happy' | 'think' | 'sleep';

export type PoseId =
  | 'idle'
  | 'walk'
  | 'whiteboard'
  | 'coffee'
  | 'sitDown'
  | 'type'
  | 'think'
  | 'lookAround'
  | 'done'
  | 'appear'
  | 'disappear'
  | 'read'
  | 'lab'
  | 'meeting'
  | 'review'
  | 'sleep'
  | 'wait';

/** Poses del kit (mismo orden y nombres) y las de las zonas de la sala */
export const POSES: readonly { id: PoseId; label: string; seated: boolean }[] = [
  { id: 'idle', label: 'Reposo', seated: false },
  { id: 'walk', label: 'Caminar', seated: false },
  { id: 'whiteboard', label: 'Pizarra', seated: false },
  { id: 'coffee', label: 'Cafe', seated: false },
  { id: 'sitDown', label: 'Sentarse', seated: true },
  { id: 'type', label: 'Teclear', seated: true },
  { id: 'think', label: 'Pensar', seated: true },
  { id: 'lookAround', label: 'Mirar alrededor', seated: true },
  { id: 'done', label: 'Terminado', seated: false },
  { id: 'appear', label: 'Aparecer', seated: false },
  { id: 'disappear', label: 'Desaparecer', seated: false },
  { id: 'read', label: 'Leer', seated: false },
  { id: 'lab', label: 'Laboratorio', seated: false },
  { id: 'meeting', label: 'Reunion', seated: true },
  { id: 'review', label: 'Revisar', seated: false },
  { id: 'sleep', label: 'Dormir', seated: true },
  { id: 'wait', label: 'Esperar', seated: false },
];

/** Mezcla de pose de un personaje. Todos los pesos van de 0 a 1. */
export interface PoseState {
  /** caminar (velocidad / 0,6) y fase de la zancada (rad) */
  walk: number;
  phase: number;
  /** 0 de pie · 1 sentado (ya con curva) */
  sit: number;
  type: number;
  think: number;
  /** sentado sin turno: mira alrededor */
  look: number;
  /** el lider se echa atras (D1: "se echa atras y sonrie cada tanto") */
  lean: number;
  /** escribir en la pizarra de pie */
  board: number;
  /** tomar cafe de pie */
  coffee: number;
  /** leer un libro abierto con las dos manos (de pie o sentado) */
  read: number;
  /** laboratorio: matraz en alto con la derecha, la izquierda en el banco */
  lab: number;
  /** reunion: conversa con gestos de las manos (de pie o sentado) */
  meet: number;
  /** revision: inclinado sobre la mesa con la lupa */
  review: number;
  /** dormido: sentado se echa sobre los brazos; de pie cabecea */
  sleep: number;
  /** esperando de pie: brazos cruzados y pie inquieto */
  wait: number;
  /** saltito (u), aterrizaje (0..1) y brazos arriba (0..1) */
  hop: number;
  squash: number;
  armsUp: number;
  /** escala de aparicion / desaparicion y giro de aparicion (rad) */
  scale: number;
  spin: number;
  /** estira hacia arriba al desaparecer (pose del kit) */
  stretch: number;
  expr: Expression;
  blink: boolean;
  bubble: boolean;
  /** "?" de espera y zzz de dormido */
  question: boolean;
  zzz: boolean;
  /** chispa de aparicion / desaparicion 0..1 */
  spark: number;
  mug: boolean;
  marker: boolean;
  /** 1 = oscilaciones normales · 0 = movimiento reducido */
  motion: number;
}

export function createPoseState(): PoseState {
  return {
    walk: 0,
    phase: 0,
    sit: 0,
    type: 0,
    think: 0,
    look: 0,
    lean: 0,
    board: 0,
    coffee: 0,
    read: 0,
    lab: 0,
    meet: 0,
    review: 0,
    sleep: 0,
    wait: 0,
    hop: 0,
    squash: 0,
    armsUp: 0,
    scale: 1,
    spin: 0,
    stretch: 0,
    expr: 'neutral',
    blink: false,
    bubble: false,
    question: false,
    zzz: false,
    spark: 0,
    mug: false,
    marker: false,
    motion: 1,
  };
}

export function resetPoseState(s: PoseState): PoseState {
  s.walk = 0;
  s.phase = 0;
  s.sit = 0;
  s.type = 0;
  s.think = 0;
  s.look = 0;
  s.lean = 0;
  s.board = 0;
  s.coffee = 0;
  s.read = 0;
  s.lab = 0;
  s.meet = 0;
  s.review = 0;
  s.sleep = 0;
  s.wait = 0;
  s.hop = 0;
  s.squash = 0;
  s.armsUp = 0;
  s.scale = 1;
  s.spin = 0;
  s.stretch = 0;
  s.expr = 'neutral';
  s.blink = false;
  s.bubble = false;
  s.question = false;
  s.zzz = false;
  s.spark = 0;
  s.mug = false;
  s.marker = false;
  s.motion = 1;
  return s;
}

/** Mirar alrededor (kit): secuencia de miradas, 1,7 s cada una, con giro suave */
const LOOK_SEQ = [-0.6, 0.15, 0.55, -0.1, 0.35, -0.45] as const;

export function lookAroundYaw(t: number): number {
  const u = t / 1.7;
  const i = Math.floor(u);
  const n = LOOK_SEQ.length;
  const a = LOOK_SEQ[((i % n) + n) % n] ?? 0;
  const b = LOOK_SEQ[(((i + 1) % n) + n) % n] ?? 0;
  const f = smooth(0, 0.35, u - i);
  return a + (b - a) * f;
}

/** Sorbo de cafe (kit): cada 4,5 s sube la taza y la baja */
export function sipAmount(t: number): number {
  const c = (((t % 4.5) + 4.5) % 4.5) / 4.5;
  return smooth(0.55, 0.65, c) * (1 - smooth(0.82, 0.92, c));
}

/** Parpadeo de D5: 130 ms cada 3,1 s (t ya viene desfasado por agente) */
export function blinkAt(t: number): boolean {
  return ((t % MOTION.blinkEvery) + MOTION.blinkEvery) % MOTION.blinkEvery < MOTION.blink;
}

/**
 * Vuelve el rig al reposo y aplica la mezcla s en el tiempo t (segundos, ya desfasado por agente).
 * Formulas del kit (animateCharacter) con los tiempos y amplitudes de D5.
 */
export function applyPose(rig: CharacterRig, s: PoseState, t: number): void {
  const { bones, rest, b } = rig;
  for (let i = 0; i < bones.length; i++) {
    const bn = bones[i];
    const r = rest[i];
    if (!bn || !r) continue;
    bn.position.copy(r);
    bn.rotation.set(0, 0, 0);
    bn.scale.set(1, 1, 1);
  }
  const m = s.motion;
  const W = s.walk;
  const sw = Math.sin(s.phase);
  const cw = Math.cos(s.phase);
  const br = Math.sin(t * 2.2) * m;
  const stand = clamp01(1 - s.sit);
  const busy = s.board + s.coffee + s.think + s.read + s.lab + s.meet + s.review + s.sleep + s.wait;
  const idle = clamp01(1 - W - busy) * stand;
  const sip = s.coffee > 0 ? sipAmount(t) * m : 0;
  const yaw = lookAroundYaw(t) * m;
  // reunion: una mano gesticula y luego la otra · leer: pasa la pagina cada 7 s · revision: barrido de la lupa
  const g1 = 0.5 + 0.5 * Math.sin(t * 1.7) * m;
  const g2 = 0.5 + 0.5 * Math.sin(t * 1.7 + 2.2) * m;
  const page = cycleWindow(((t % 7) + 7) % 7, 6, 6.3, 0.2) * m;
  const scan = Math.sin(t * 0.8) * m;
  // esperando: golpecito del pie · dormido: sentado se echa sobre el escritorio, de pie solo cabecea
  const tap = Math.max(0, Math.sin(t * 7.5)) * m * s.wait * stand;
  const slump = s.sleep * (0.12 + 0.48 * s.sit);
  const pillow = s.sleep * s.sit;

  // raiz: escala desde los pies, saltito y aterrizaje (aplasta 10 %, ensancha 5 %)
  const sc = Math.max(0.001, s.scale);
  const sq = s.squash;
  b.root.position.y = s.hop;
  b.root.rotation.y = s.spin;
  b.root.scale.set(
    sc * (1 + 0.05 * sq) * (1 - 0.35 * s.stretch),
    sc * (1 - 0.1 * sq) * (1 + 0.6 * s.stretch),
    sc * (1 + 0.05 * sq) * (1 - 0.35 * s.stretch),
  );

  // cadera: sube a la silla, rebota al caminar
  b.hips.position.y += SIT_LIFT * s.sit + W * Math.abs(cw) * MOTION.bounce;
  b.hips.position.x += s.board * 0.04 * Math.sin(t * 0.7) * m + s.wait * stand * 0.015 * Math.sin(t * 1.1) * m;
  b.hips.rotation.z = idle * 0.015 * Math.sin(t * 0.6) * m + s.wait * stand * 0.03 * Math.sin(t * 1.1) * m;

  // torso: respiracion (lenta al dormir), inclinado al teclear, leer, revisar o dormir, hacia atras
  // cuando el lider descansa
  b.torso.position.y += (1 - W) * br * 0.006 + s.sleep * 0.008 * Math.sin(t * 1.2) * m;
  b.torso.rotation.x =
    W * 0.06 + s.type * 0.08 - s.lean * s.sit * 0.05 + s.read * 0.04 + s.lab * 0.1 + s.review * 0.3 + slump;
  b.torso.rotation.y =
    W * sw * 0.06 + s.board * 0.08 * Math.sin(t * 1.3) * m + s.look * yaw * 0.25 + s.meet * 0.08 * Math.sin(t * 0.45) * m;

  // cabeza
  b.head.rotation.x =
    s.type * (0.12 + 0.025 * Math.sin(t * 7) * m) +
    s.think * -0.2 +
    s.board * -0.12 +
    s.look * 0.05 * Math.sin(t * 0.8) * m +
    s.lean * 0.05 * Math.sin(t * 0.5) * m +
    idle * 0.04 * Math.sin(t * 0.7) * m -
    s.coffee * 0.16 * sip +
    s.read * (0.32 + 0.03 * Math.sin(t * 0.9) * m) +
    s.lab * 0.12 +
    s.meet * 0.08 * Math.sin(t * 2.6) * m +
    s.review * 0.35 +
    s.sleep * (0.3 + 0.2 * s.sit) -
    s.wait * 0.05;
  b.head.rotation.y =
    s.type * 0.06 * Math.sin(t * 1.3) * m +
    s.think * 0.22 * Math.sin(t * 0.5) * m +
    s.board * 0.1 * Math.sin(t * 1.3) * m +
    s.look * yaw +
    s.lean * 0.55 * Math.sin(t * 0.45) * m +
    idle * 0.15 * Math.sin(t * 0.45) * m * (1 - sip) -
    W * sw * 0.04 +
    s.read * 0.1 * Math.sin(t * 1.1) * m -
    s.lab * 0.3 +
    s.meet * 0.3 * Math.sin(t * 0.45) * m +
    s.review * 0.12 * scan +
    s.wait * yaw * 0.6;
  b.head.rotation.z = s.think * 0.12 + s.sleep * 0.25;

  // piernas: zancada, 83 grados al sentarse, balanceo de pies sentado, golpecito del pie al esperar
  const sitLeg = -1.45 * s.sit;
  const kick = (s.look + s.lean) * s.sit * 0.12 * Math.sin(t * 2.3) * m;
  b.legL.rotation.x = W * sw * 0.7 + sitLeg + kick - 0.3 * s.armsUp * stand;
  b.legR.rotation.x = -W * sw * 0.7 + sitLeg - kick + 0.2 * s.armsUp * stand - 0.22 * tap;

  // brazos (dormido sentado: cruzados sobre el escritorio como almohada; esperando: cruzados al pecho)
  const typeL = -1.35 + 0.1 * Math.sin(t * 18) * m;
  const typeR = -1.35 + 0.1 * Math.sin(t * 18 + 2.1) * m;
  const lap = -0.55 * s.sit * (s.look + s.lean);
  b.armL.rotation.x =
    -W * sw * 0.6 +
    s.type * typeL +
    s.think * -1.0 +
    lap +
    s.armsUp * -2.9 +
    s.read * -1.0 +
    s.lab * (-0.75 + 0.05 * Math.sin(t * 5) * m) +
    s.meet * (-0.35 - 0.4 * g2) +
    s.review * -0.7 +
    pillow * -1.35 +
    s.wait * -1.25;
  b.armR.rotation.x =
    W * sw * 0.6 +
    s.type * typeR +
    s.think * -2.35 +
    lap +
    s.board * (-2.15 + 0.07 * Math.sin(t * 7) * m) +
    s.coffee * (-1.0 - 1.05 * sip) +
    s.armsUp * -2.9 +
    s.read * -1.0 +
    s.lab * -1.9 +
    s.meet * (-0.55 - 0.55 * g1) +
    s.review * -0.95 +
    pillow * -1.35 +
    s.wait * -1.1;
  b.armL.rotation.y =
    s.type * -0.25 + s.think * -0.5 - s.read * 0.35 - s.lab * 0.1 - s.meet * 0.2 - s.review * 0.15 - pillow * 0.75 - s.wait * 0.95;
  b.armR.rotation.y =
    s.type * 0.25 +
    s.think * 0.55 +
    s.board * (0.25 + 0.14 * Math.sin(t * 2.6) * m) +
    s.coffee * (0.1 + 0.4 * sip) +
    s.read * (0.35 + 0.45 * page) +
    s.lab * 0.3 +
    s.meet * 0.2 +
    s.review * (0.25 + 0.18 * scan) +
    pillow * 0.75 +
    s.wait * 0.95;
  b.armL.rotation.z = 0.05 + 0.02 * br * idle + s.board * 0.25 + s.armsUp * 0.35;
  b.armR.rotation.z =
    (-0.05 - 0.02 * br * idle) * (1 - s.coffee) -
    s.armsUp * 0.35 +
    s.lab * 0.08 * Math.sin(t * 3.2) * m -
    s.meet * 0.12 * Math.sin(t * 4.3) * m;
  // la taza queda derecha y se inclina al beber
  b.mug.rotation.x = -b.armR.rotation.x - 0.3 * sip;

  // utileria: crece con su pose (aparece en la mano sin saltar); el matraz queda derecho y se agita,
  // la lupa queda horizontal sobre la mesa y el libro se inclina hacia la cara
  const hidden = 0.001;
  b.book.scale.setScalar(Math.max(hidden, smooth(0.35, 0.85, s.read)));
  b.book.rotation.x = -0.45;
  b.flask.scale.setScalar(Math.max(hidden, smooth(0.35, 0.85, s.lab)));
  b.flask.rotation.x = -b.armR.rotation.x;
  b.flask.rotation.z = 0.3 * Math.sin(t * 3.2) * m;
  b.lens.scale.setScalar(Math.max(hidden, smooth(0.35, 0.85, s.review)));
  b.lens.rotation.x = -b.armR.rotation.x - b.torso.rotation.x;

  // el sombrero salta un poco con el saltito
  b.accessory.position.y += s.hop * 0.5;
  if (rig.hasTail) b.tail.rotation.x = (0.12 * Math.sin(t * 2.4) + W * 0.1 * sw) * m + s.type * 0.05 * Math.sin(t * 9) * m;

  // expresion (dormido: ojos cerrados; conversando: la boca se mueve)
  let expr = s.expr;
  if (expr === 'neutral' && s.coffee > 0.5 && sip > 0.4) expr = 'happy';
  const happy = expr === 'happy';
  const focus = expr === 'focus';
  const asleep = expr === 'sleep';
  if (happy) b.eyes.scale.setScalar(hidden);
  else b.eyesHappy.scale.setScalar(hidden);
  if (!happy) b.eyes.scale.y = s.blink || asleep ? 0.15 : focus ? 0.55 : 1;
  if (expr === 'think') {
    b.eyes.position.y += 0.02;
    b.eyes.position.x += 0.018;
    b.mouth.position.x += 0.03;
  } else if (focus) {
    b.eyes.position.y -= 0.01;
  } else if (asleep) {
    b.eyes.position.y -= 0.02;
  }
  const talk = 1 + s.meet * 1.1 * Math.max(0, Math.sin(t * 9)) * m;
  if (rig.look.acc === 'bowtie') b.mouth.scale.setScalar(hidden);
  else b.mouth.scale.set(happy ? 1.8 : focus || asleep ? 0.6 : 1, (happy ? 1.6 : 1) * talk, 1);
  if (!s.mug) b.mug.scale.setScalar(hidden);
  if (!s.marker) b.marker.scale.setScalar(hidden);

  rig.bubble.visible = s.bubble;
  rig.question.visible = s.question;
  if (s.question) rig.question.position.y = QUESTION_POS.y + 0.03 * Math.sin(t * 3) * m;
  rig.zzz.visible = s.zzz;
  if (s.zzz) rig.zzz.position.y = ZZZ_POS.y + 0.04 * Math.sin(t * 1.2) * m;
  const spark = s.spark > 0.02;
  rig.spark.visible = spark;
  if (spark) {
    rig.spark.scale.setScalar(0.25 + 0.9 * (1 - s.spark));
    const mat = sparkMaterialFor(s.spark);
    if (rig.spark.material !== mat) rig.spark.material = mat;
  }
  rig.mesh.visible = sc > 0.002;
}

/**
 * Llena s con una pose con nombre del kit en el tiempo t (ciclos incluidos). Sirve para galerias,
 * pruebas y para comprobar cada pose por separado; la escena usa la mezcla de Character.
 */
export function poseAt(s: PoseState, pose: PoseId, t: number): PoseState {
  resetPoseState(s);
  switch (pose) {
    case 'walk':
      s.walk = 1;
      s.phase = t * MOTION.walkSpeed * MOTION.stride;
      break;
    case 'whiteboard':
      s.board = 1;
      s.marker = true;
      s.expr = 'focus';
      break;
    case 'coffee':
      s.coffee = 1;
      s.mug = true;
      break;
    case 'sitDown': {
      const c = ((t % 4.4) + 4.4) % 4.4;
      s.sit = c < 0.5 ? 0 : c < 1.3 ? smooth(0.5, 1.3, c) : c < 3.1 ? 1 : c < 3.9 ? 1 - smooth(3.1, 3.9, c) : 0;
      break;
    }
    case 'type':
      s.sit = 1;
      s.type = 1;
      s.expr = 'focus';
      break;
    case 'think':
      s.sit = 1;
      s.think = 1;
      s.expr = 'think';
      s.bubble = true;
      break;
    case 'lookAround':
      s.sit = 1;
      s.look = 1;
      break;
    case 'done': {
      const e = ((t % 1.5) + 1.5) % 1.5;
      s.hop = hopLift(e);
      s.squash = landSquash(e);
      s.armsUp = armsUp(e);
      s.expr = 'happy';
      break;
    }
    case 'appear': {
      const c = ((t % 2.6) + 2.6) % 2.6;
      const k = clamp01(c / MOTION.appear);
      s.scale = k < 1 ? Math.max(0.001, CURVE.rebotar(k)) : 1;
      s.spin = (1 - k) * Math.PI * 2;
      s.spark = c < MOTION.spark ? 1 - c / MOTION.spark : 0;
      s.expr = c > 0.5 && c < 1.6 ? 'happy' : 'neutral';
      break;
    }
    case 'disappear': {
      const c = ((t % 2.6) + 2.6) % 2.6;
      if (c >= 1 && c < 1.2) {
        s.squash = smooth(1, 1.2, c) * 1.5;
      } else if (c >= 1.2 && c < 1.55) {
        const a = (c - 1.2) / 0.35;
        s.scale = 1 - a;
        s.stretch = a;
        s.hop = 0.25 * a;
      } else if (c >= 1.55) {
        s.scale = 0.001;
      }
      s.spark = bump(c, 1.5, 0.25);
      break;
    }
    case 'read':
      s.read = 1;
      s.expr = 'focus';
      break;
    case 'lab':
      s.lab = 1;
      s.expr = 'focus';
      break;
    case 'meeting':
      s.sit = 1;
      s.meet = 1;
      break;
    case 'review':
      s.review = 1;
      s.expr = 'focus';
      break;
    case 'sleep':
      s.sit = 1;
      s.sleep = 1;
      s.expr = 'sleep';
      s.zzz = true;
      break;
    case 'wait':
      s.wait = 1;
      s.question = true;
      break;
    default:
      break;
  }
  s.blink = blinkAt(t);
  return s;
}

const scratch = createPoseState();

/** API del kit: animateCharacter(rig, pose, t). Funcion pura del tiempo. */
export function animateCharacter(rig: CharacterRig, pose: PoseId, t: number): void {
  applyPose(rig, poseAt(scratch, pose, t), t);
}
