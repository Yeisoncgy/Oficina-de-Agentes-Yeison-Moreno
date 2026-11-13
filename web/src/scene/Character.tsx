// Personaje del elenco (kit 3D) animado por codigo. Lee su estado de un Actor mutable en cada frame
// (caminar, sentarse, teclear, pensar, mirar alrededor, pizarra, cafe, leer, laboratorio, reunion,
// revision, dormir, esperar, saltito de "termine", aparecer y desaparecer) y mezcla las poses con los
// tiempos de D5 sin re-renderizar React. Con alerta viva se tine de rojo y lleva un "!" que late.
// Una SkinnedMesh por personaje (1 draw call) + sombra de contacto; nada se asigna por frame.

import { memo, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group, Mesh } from 'three';
import { useOfficeStore } from '@/state/store';
import { type Actor, HOP_TIME, isTraveling, stepActor } from './actors';
import { castIdFor } from './characters/looks';
import {
  alertGeometry,
  alertOffset,
  ARROW_Y,
  arrowGeometry,
  type HeadSprite,
  hitboxGeometry,
  LABEL_Y,
  ringGeometry,
  viewAzimuth,
} from './characters/markers';
import {
  type AlertLevel,
  alertMarkerMaterial,
  blobGeometry,
  blobMaterial,
  characterMaterialFor,
  FACE_GLOW,
  hitboxMaterial,
  markerMaterial,
  nightGlow,
  tickCharacters,
} from './characters/materials';
import { armsUp, bump, clamp01, CURVE, cycleWindow, hopLift, landSquash, MOTION, reducedMotion } from './characters/motion';
import { applyPose, blinkAt, createPoseState, type Expression } from './characters/poses';
import { type Presence, registerPresence, unregisterPresence } from './characters/presence';
import { createRig, SIT_LIFT } from './characters/rig';
import { createSteam } from './characters/steam';
import type { Vec2 } from './layout';
import { useAgentHover } from './useAgentHover';
import { reportWalker } from './world/doors';

export interface CharacterProps {
  actor: Actor;
  agentType: string;
  /** persona unica asignada por el server (define el personaje); sin ella se usa el tipo */
  persona?: string;
  /** centro de la sala (las posiciones del actor son locales a ella); el lider usa el origen */
  offset: Vec2;
  /** altura del piso en coordenadas del actor */
  ground: (x: number, z: number) => number;
  /** agente a seleccionar con clic */
  selectId: string | null;
  label?: ReactNode;
  /** flecha y anillo cuando esta seleccionado (al lider ya lo marca su escritorio) */
  showArrow?: boolean;
  dim?: boolean;
  /** alerta viva del agente (OfficeAgent.alert.level): tinte rojo y "!" sobre la cabeza */
  alert?: AlertLevel | null;
  onGone?: (id: string) => void;
}

/**
 * Estado del personaje en el ancla de su tarjeta (atributo data-pose, para el CSS del HUD):
 * walk = caminando (D5: solo lleva la etiqueta) · seated / stand = en su lugar ·
 * done = celebrando "termine" · leave = se levanta y sale (la tarjeta se va en 180 ms) · gone.
 */
export type LabelPose = 'walk' | 'stand' | 'seated' | 'done' | 'leave' | 'gone';

const CARD_LEAVE = 'opacity 180ms cubic-bezier(0.64, 0, 0.78, 0)';

interface Blend {
  /** pesos lineales (0..1) que avanzan en 350 ms; la curva se aplica al leerlos */
  type: number;
  think: number;
  idle: number;
  board: number;
  coffee: number;
  read: number;
  lab: number;
  meet: number;
  review: number;
  sleep: number;
  wait: number;
  groundY: number;
  placed: boolean;
  gone: boolean;
  labelPose: LabelPose | null;
  labelEl: HTMLDivElement | null;
  /** corrimiento del "!" en el cuadro anterior (alertOffset) */
  alertX: number;
}

/** burbuja o "?" del cuadro en curso; se reusa para no asignar nada por frame */
const HEAD_SPRITE: HeadSprite = { x: 0, halfW: 0 };
/** latido del "!": la critica late mas rapido y mas grande */
const ALERT_PULSE: Readonly<Record<AlertLevel, { rate: number; amount: number }>> = {
  warning: { rate: 2.5, amount: 0.1 },
  critical: { rate: 5, amount: 0.2 },
};

function toward(v: number, on: boolean, step: number): number {
  return on ? Math.min(1, v + step) : Math.max(0, v - step);
}

function shown(v: number, reduced: boolean): number {
  return reduced ? (v >= 0.5 ? 1 : 0) : CURVE.cambiar(v);
}

/** con memo: el elenco le pasa props estables (tarjeta memorizada por agente) y solo cambia cuando cambia su agente */
export const Character = memo(function Character({
  actor,
  agentType,
  persona,
  offset,
  ground,
  selectId,
  label,
  showArrow = true,
  dim = false,
  alert = null,
  onGone,
}: CharacterProps) {
  const castId = castIdFor(persona ?? agentType);
  const rig = useMemo(() => createRig(castId), [castId]);
  const isLead = agentType === 'lead';
  // cualquiera puede tomar cafe: la taza humea en la mano de quien la tenga
  const steam = useMemo(() => createSteam(), []);
  const root = useRef<Group>(null);
  const blob = useRef<Mesh>(null);
  const hitbox = useRef<Mesh>(null);
  const arrow = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const alertMark = useRef<Mesh>(null);
  const labelAnchor = useRef<Group>(null);
  const labelEl = useRef<HTMLDivElement>(null);
  const presence = useRef<Presence | null>(null);
  const pose = useRef(createPoseState());
  const blend = useRef<Blend>({
    type: 0,
    think: 0,
    idle: 0,
    board: 0,
    coffee: 0,
    read: 0,
    lab: 0,
    meet: 0,
    review: 0,
    sleep: 0,
    wait: 0,
    groundY: 0,
    placed: false,
    gone: false,
    labelPose: null,
    labelEl: null,
    alertX: 0,
  });
  const selected = useOfficeStore((s) => selectId !== null && s.selectedAgentId === selectId);
  const hover = useAgentHover(selectId);

  useEffect(() => () => rig.dispose(), [rig]);
  useEffect(() => {
    const mug = rig.b.mug;
    mug.add(steam.points);
    return () => {
      mug.remove(steam.points);
      steam.dispose();
    };
  }, [rig, steam]);
  useEffect(() => {
    const p = registerPresence();
    presence.current = p;
    return () => {
      unregisterPresence(p);
      presence.current = null;
    };
  }, []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const clock = state.clock.elapsedTime;
    tickCharacters(clock);
    const a = actor;
    stepActor(a, dt);
    const r = root.current;
    if (!r) return;
    const w = blend.current;
    const here = presence.current;
    if (a.phase === 'gone') {
      r.visible = false;
      if (here) here.active = false;
      if (!w.gone) {
        w.gone = true;
        onGone?.(a.id);
      }
      return;
    }
    r.visible = true;
    const reduced = reducedMotion();
    const p = pose.current;
    // cada agente con su fase: parpadeos, miradas y tecleo nunca van sincronizados
    const t = clock + a.seed * 37;

    const gy = ground(a.pos.x, a.pos.z);
    w.groundY = w.placed ? w.groundY + (gy - w.groundY) * Math.min(1, dt * 16) : gy;
    w.placed = true;
    r.position.set(offset.x + a.pos.x, w.groundY, offset.z + a.pos.z);
    r.rotation.y = a.heading;

    // pesos de pose: solo trabaja quieto en su lugar; cada cambio tarda 350 ms (curva "cambiar")
    const stationary = !isTraveling(a) && a.speed === 0;
    if (!stationary) reportWalker(offset.x + a.pos.x, offset.z + a.pos.z);
    const seated = a.sit > 0.5;
    const act = a.activity;
    const step = dt / MOTION.poseBlend;
    w.type = toward(w.type, stationary && act === 'typing' && a.wantSit && seated, step);
    w.board = toward(w.board, stationary && act === 'typing' && !a.wantSit, step);
    w.think = toward(w.think, stationary && act === 'thinking', step);
    w.idle = toward(w.idle, stationary && act === 'idle' && seated, step);
    w.coffee = toward(w.coffee, stationary && act === 'coffee', step);
    w.read = toward(w.read, stationary && act === 'reading', step);
    w.lab = toward(w.lab, stationary && act === 'lab', step);
    w.meet = toward(w.meet, stationary && act === 'meeting', step);
    w.review = toward(w.review, stationary && act === 'reviewing', step);
    w.sleep = toward(w.sleep, stationary && act === 'sleeping', step);
    w.wait = toward(w.wait, stationary && act === 'waiting', step);
    p.type = shown(w.type, reduced);
    p.board = shown(w.board, reduced);
    p.think = shown(w.think, reduced);
    p.coffee = shown(w.coffee, reduced);
    p.read = shown(w.read, reduced);
    p.lab = shown(w.lab, reduced);
    p.meet = shown(w.meet, reduced);
    p.review = shown(w.review, reduced);
    p.sleep = shown(w.sleep, reduced);
    p.wait = shown(w.wait, reduced);
    const idleSeat = shown(w.idle, reduced);
    // el lider sin turno: mira alrededor y cada tanto se echa atras y sonrie (D1)
    const cycle = ((t % 15) + 15) % 15;
    const lean = isLead ? cycleWindow(cycle, 8, 11, 0.35) : 0;
    p.lean = idleSeat * lean;
    p.look = idleSeat * (1 - lean);

    p.walk = a.walkBlend;
    p.phase = a.walkPhase;
    p.sit = a.sit;

    // saltito de "termine" (en su lugar, antes de levantarse)
    const celebrating = a.hop > 0 && a.speed === 0 && !reduced;
    const e = HOP_TIME - a.hop;
    p.hop = celebrating ? hopLift(e) : 0;
    p.squash = celebrating ? landSquash(e) : 0;
    p.armsUp = celebrating ? armsUp(e) : 0;

    // aparecer (rebotar + giro + chispa) y desaparecer caminando (irse + chispa)
    p.stretch = 0;
    if (a.phase === 'vanishing') {
      p.scale = 1 - CURVE.irse(1 - a.pop);
      p.spin = 0;
      p.spark = reduced ? 0 : bump(a.vanishT, MOTION.vanish - 0.04, 0.2);
    } else {
      p.scale = a.pop >= 1 ? 1 : Math.max(0.001, CURVE.rebotar(a.pop));
      p.spin = a.pop >= 1 || reduced ? 0 : (1 - a.pop) * Math.PI * 2;
      p.spark = !reduced && a.appearT >= 0 && a.appearT < MOTION.spark ? 1 - a.appearT / MOTION.spark : 0;
    }

    let expr: Expression = 'neutral';
    const leaving = a.phase === 'leaving' || a.phase === 'vanishing';
    if (act === 'done' && leaving && (a.hop > 0 || a.sitLin > 0)) expr = 'happy';
    else if (a.appearT >= 0.5 && a.appearT < 1.6) expr = 'happy';
    else if (isLead && idleSeat > 0.5 && cycle > 9.2 && cycle < 10.4) expr = 'happy';
    else if (p.sleep > 0.5) expr = 'sleep';
    else if (p.think > 0.5) expr = 'think';
    else if (p.type > 0.5 || p.board > 0.5 || p.read > 0.5 || p.lab > 0.5 || p.review > 0.5) expr = 'focus';
    p.expr = expr;
    p.blink = !reduced && blinkAt(t);
    p.bubble = p.think > 0.6 && p.scale > 0.5;
    p.question = p.wait > 0.6 && p.scale > 0.5;
    p.zzz = p.sleep > 0.6 && p.scale > 0.5;
    p.mug = a.mug || p.coffee > 0.01;
    p.marker = p.board > 0.01;
    p.motion = reduced ? 0 : 1;
    applyPose(rig, p, t);
    steam.update(t, p.mug && !reduced && p.scale > 0.5);

    // tinte cian de pantalla: solo tecleando ya sentado; late +-15 % y se nota mas de noche
    const typing = p.type * clamp01((a.sit - 0.8) / 0.2);
    const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(clock * 13 + a.seed * 10);
    const mat = characterMaterialFor(typing * FACE_GLOW * nightGlow() * pulse, dim, alert);
    if (rig.mesh.material !== mat) rig.mesh.material = mat;

    const lift = a.sit * SIT_LIFT;
    if (blob.current) {
      const k = p.scale * (1 - Math.min(0.5, p.hop * 2.5));
      blob.current.visible = k > 0.02;
      blob.current.scale.setScalar(Math.max(0.001, k));
    }
    if (hitbox.current) hitbox.current.position.y = 0.6 + lift;
    if (labelAnchor.current) labelAnchor.current.position.y = LABEL_Y + lift + p.hop;
    // flecha y "!" miran a la camara tal como este girada ahora (el giro llega a +-85 grados)
    const view = viewAzimuth(state.camera.quaternion);
    const facing = view - a.heading;
    if (arrow.current) {
      arrow.current.position.y = ARROW_Y + lift + p.hop + (reduced ? 0 : Math.abs(Math.sin(clock * 4)) * 0.08);
      arrow.current.rotation.y = facing;
    }
    if (ring.current) ring.current.scale.setScalar(reduced ? 1 : 1 + 0.06 * Math.sin(clock * 4));
    // "!" a la altura de la flecha: a su lado si esta puesta y lejos de la burbuja o el "?" (alertOffset)
    const mark = alertMark.current;
    if (mark && alert) {
      const beat = ALERT_PULSE[alert];
      const sprite = p.bubble ? rig.bubble : p.question ? rig.question : null;
      if (sprite) {
        sprite.updateWorldMatrix(true, false);
        const s = sprite.matrixWorld.elements;
        const o = r.matrixWorld.elements;
        HEAD_SPRITE.x = (s[12] - o[12]) * Math.cos(view) - (s[14] - o[14]) * Math.sin(view);
        HEAD_SPRITE.halfW = Math.hypot(s[0], s[1], s[2]) / 2;
      }
      const side = alertOffset(selected && showArrow, sprite ? HEAD_SPRITE : null, w.alertX, reduced ? 0 : beat.amount);
      w.alertX = side;
      mark.position.set(side * Math.cos(facing), ARROW_Y + lift + p.hop, -side * Math.sin(facing));
      mark.rotation.y = facing;
      mark.scale.setScalar(reduced ? 1 : 1 + beat.amount * Math.abs(Math.sin(clock * beat.rate)));
    }

    const labelPose: LabelPose =
      a.phase === 'vanishing'
        ? 'gone'
        : a.phase === 'leaving'
          ? a.hop > 0
            ? 'done'
            : 'leave'
          : !stationary
            ? 'walk'
            : seated
              ? 'seated'
              : 'stand';
    const el = labelEl.current;
    if (el && (w.labelPose !== labelPose || w.labelEl !== el)) {
      w.labelPose = labelPose;
      w.labelEl = el;
      el.dataset.pose = labelPose;
      const away = labelPose === 'leave' || labelPose === 'gone';
      el.style.transition = away && !reduced ? CARD_LEAVE : '';
      el.style.opacity = away ? '0' : '';
      el.style.display = labelPose === 'gone' ? 'none' : '';
    }
    if (here) {
      here.x = r.position.x;
      here.z = r.position.z;
      here.active = p.scale > 0.05;
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!selectId || e.delta > 6) return;
    e.stopPropagation();
    useOfficeStore.getState().selectAgent(selectId);
  };
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    if (!selectId) return;
    e.stopPropagation();
    hover.over();
  };

  return (
    <group ref={root}>
      <primitive object={rig.mesh} dispose={null} />
      <mesh ref={blob} geometry={blobGeometry} material={blobMaterial} position={[0, 0.014, 0]} renderOrder={1} />
      <mesh
        ref={hitbox}
        geometry={hitboxGeometry}
        material={hitboxMaterial}
        position={[0, 0.6, 0]}
        scale={[0.62, 1.2, 0.56]}
        onClick={onClick}
        onPointerOver={onOver}
        onPointerOut={hover.out}
      />
      {selected && showArrow ? (
        <>
          <mesh ref={arrow} geometry={arrowGeometry} material={markerMaterial} position={[0, ARROW_Y, 0]} />
          <mesh ref={ring} geometry={ringGeometry} material={markerMaterial} position={[0, 0.02, 0]} />
        </>
      ) : null}
      {alert ? (
        <mesh ref={alertMark} geometry={alertGeometry} material={alertMarkerMaterial} position={[0, ARROW_Y, 0]} />
      ) : null}
      {label ? (
        <group ref={labelAnchor} position={[0, LABEL_Y, 0]}>
          <Html ref={labelEl} zIndexRange={[30, 10]} pointerEvents="none" wrapperClass="ofc-anchor">
            {label}
          </Html>
        </group>
      ) : null}
    </group>
  );
});
