import { afterEach, describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { type RootState, useThree } from '@react-three/fiber';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import {
  type Camera,
  type Mesh,
  type Object3D,
  OrthographicCamera,
  Quaternion,
  type SkinnedMesh,
  Vector3,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import type { OfficeAgent, OfficeRoom } from '@shared/contract';
import { LEAD_PERSONA } from '@shared/personas';
import { useOfficeStore } from '@/state/store';
import { AGENT_LOOKS, PALETTE } from '@/theme';
import { spriteGrid } from '@/lib/sprite';
import { type Activity, type Actor, createActor, HOP_TIME, isTraveling, placeAt, routeTo, stepActor } from '@/scene/actors';
import { Character, type CharacterProps } from '@/scene/Character';
import { CAST, castIdFor, castLook, KIT_PAL } from '@/scene/characters/looks';
import { AZIMUTH_RANGE, BASE_AZIMUTH, BASE_POLAR, cameraOffset } from '@/scene/CameraRig';
import { ALERT_HALF_W, ALERT_SIDE, alertOffset, arrowGeometry, viewAzimuth } from '@/scene/characters/markers';
import { ZONES } from '@/scene/zones';
import {
  alertLevelOf,
  alertMarkerMaterial,
  characterMaterialFor,
  FACE_GLOW,
  glowLevelOf,
  GLOW_LEVELS,
  nightGlowAt,
  questionPixel,
  zzzPixel,
} from '@/scene/characters/materials';
import { armsUp, CURVE, DONE_TIME, forceReducedMotion, hopLift, landSquash, MOTION } from '@/scene/characters/motion';
import { animateCharacter, applyPose, createPoseState, poseAt, POSES, type PoseId } from '@/scene/characters/poses';
import { BONE_NAMES, characterTriangles, createRig, type CharacterRig } from '@/scene/characters/rig';
import { createCrew, createLead, leadTarget, reconcileCrew, updateLead } from '@/scene/crew';
import {
  assignSlots,
  buildOfficeNav,
  computeLayout,
  deskSpec,
  localGround,
  NODE,
  officeNode,
  ROOM_NAV,
  seatNode,
  worldGround,
} from '@/scene/layout';

// el test-renderer envuelve en act(); React lo exige declarado
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  forceReducedMotion(null);
  useOfficeStore.setState({ selectedAgentId: null, hoveredAgentId: null });
});

/** diferencia entre dos angulos, en [0, pi] */
function angleGap(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function finiteRig(rig: CharacterRig): boolean {
  rig.mesh.updateMatrixWorld(true);
  return rig.bones.every((bn) => {
    const e = bn.matrixWorld.elements;
    return e.every((v) => Number.isFinite(v));
  });
}

describe('elenco: agentType -> personaje', () => {
  it('cada tipo conocido tiene su personaje y el resto usa el generico', () => {
    expect(castIdFor('lead')).toBe(LEAD_PERSONA);
    expect(castIdFor('tr-builder')).toBe('bruno');
    expect(castIdFor('Explore')).toBe('elena');
    expect(castIdFor('tr-explorer')).toBe('marco');
    expect(castIdFor('tr-docs')).toBe('dora');
    expect(castIdFor('Plan')).toBe('paula');
    expect(castIdFor('general-purpose')).toBe('gael');
    expect(castIdFor('claude-code-guide')).toBe('guido');
    expect(castIdFor('otro-tipo')).toBe('generic');
    expect(castIdFor('')).toBe('generic');
    expect(castIdFor('constructor')).toBe('generic');
    expect(castIdFor('toString')).toBe('generic');
  });

  it('los colores salen tal cual de la paleta del kit', () => {
    const palette = new Set<string>(Object.values(KIT_PAL));
    for (const c of CAST) {
      const look = castLook(c.id);
      for (const hex of [look.shirt, look.pants, look.skin, look.hairC, look.acc2]) expect(palette.has(hex)).toBe(true);
    }
    // el lead conserva su aspecto de siempre (sudadera y camiseta ember), se llame como se llame
    expect(castLook(LEAD_PERSONA)).toMatchObject({ acc: 'hoodie', hair: 'messy', shirt: '#D9673B' });
    expect(castLook('bruno').acc).toBe('hardhat');
    expect(castLook('elena').hair).toBe('ponytail');
    expect(castLook('generic').acc).toBe('badge');
  });
});

describe('rig del personaje', () => {
  it('cada personaje cabe en el presupuesto de triangulos y tiene skinning rigido valido', () => {
    for (const c of CAST) {
      expect(characterTriangles(c.id)).toBeLessThanOrEqual(600);
      const rig = createRig(c.id);
      const geo = rig.mesh.geometry;
      const si = geo.getAttribute('skinIndex');
      const sw = geo.getAttribute('skinWeight');
      expect(si.count).toBe(geo.getAttribute('position').count);
      for (let i = 0; i < si.count; i++) {
        expect(si.getX(i)).toBeLessThan(BONE_NAMES.length);
        expect(sw.getX(i)).toBe(1);
      }
      expect(rig.bones).toHaveLength(BONE_NAMES.length);
      expect(rig.mesh.skeleton.bones).toHaveLength(BONE_NAMES.length);
      rig.dispose();
    }
  });

  it('las instancias del mismo personaje comparten geometria y material', () => {
    const a = createRig('bruno');
    const b = createRig('bruno');
    expect(a.mesh.geometry).toBe(b.mesh.geometry);
    expect(a.mesh.material).toBe(b.mesh.material);
    expect(a.bones[0]).not.toBe(b.bones[0]);
  });

  it('cada pose del kit produce transformaciones finitas en todo el elenco', () => {
    for (const c of CAST) {
      const rig = createRig(c.id);
      for (const pose of POSES) {
        for (const t of [0, 0.13, 0.4, 0.77, 1.2, 1.5, 2.05, 3.3, 4.49, 7.9, 123.4]) {
          animateCharacter(rig, pose.id, t);
          expect(finiteRig(rig)).toBe(true);
        }
      }
    }
  });

  it('la mezcla de poses tambien es finita en cualquier combinacion', () => {
    const rig = createRig('paula');
    const s = createPoseState();
    const keys = ['walk', 'sit', 'type', 'think', 'look', 'lean', 'board', 'coffee', 'armsUp', 'squash'] as const;
    for (let i = 0; i < 64; i++) {
      keys.forEach((k, j) => {
        s[k] = ((i >> (j % 6)) & 1) * ((j % 3) + 1) * 0.37;
      });
      s.phase = i * 0.7;
      s.hop = (i % 3) * 0.05;
      s.scale = (i % 4) / 3;
      s.mug = i % 2 === 0;
      s.marker = i % 3 === 0;
      s.expr = (['neutral', 'focus', 'happy', 'think'] as const)[i % 4] ?? 'neutral';
      applyPose(rig, s, i * 0.31);
      expect(finiteRig(rig)).toBe(true);
    }
  });

  it('pensar muestra la burbuja; teclear no; terminado pone cara contenta', () => {
    const rig = createRig('elena');
    animateCharacter(rig, 'think', 1);
    expect(rig.bubble.visible).toBe(true);
    animateCharacter(rig, 'type', 1);
    expect(rig.bubble.visible).toBe(false);
    animateCharacter(rig, 'done', 0.5);
    expect(rig.b.eyesHappy.scale.x).toBe(1);
    expect(rig.b.eyes.scale.x).toBeLessThan(0.01);
    animateCharacter(rig, 'whiteboard', 1);
    expect(rig.b.marker.scale.x).toBe(1);
    expect(rig.b.mug.scale.x).toBeLessThan(0.01);
  });
});

describe('lenguaje de movimiento (D5)', () => {
  it('las curvas empiezan en 0, terminan en 1 y rebotar se pasa de 1', () => {
    for (const c of Object.values(CURVE)) {
      expect(c(0)).toBe(0);
      expect(c(1)).toBe(1);
    }
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => CURVE.rebotar(i / 50)));
    expect(peak).toBeGreaterThan(1.05);
  });

  it('el saltito sube 0,10 u, aterriza aplastando y termina antes de levantarse', () => {
    const samples = Array.from({ length: 200 }, (_, i) => (i / 200) * DONE_TIME);
    expect(Math.max(...samples.map(hopLift))).toBeCloseTo(MOTION.hopHeight, 2);
    expect(Math.max(...samples.map(landSquash))).toBeGreaterThan(0.9);
    expect(Math.max(...samples.map(armsUp))).toBeGreaterThan(0.9);
    expect(hopLift(DONE_TIME)).toBe(0);
    expect(armsUp(DONE_TIME)).toBe(0);
    expect(HOP_TIME).toBe(DONE_TIME);
  });

  it('un agente camina a 1,5 u/s con arranque suave, gira al frente y se sienta en su puesto', () => {
    const desk = deskSpec(4);
    if (!desk) throw new Error('falta el puesto 4');
    const actor = createActor('a1', ROOM_NAV.nodes.get(NODE.spawn) ?? { x: 0, z: 0 });
    actor.lastNode = NODE.spawn;
    expect(routeTo(actor, ROOM_NAV, seatNode(4), { endHeading: desk.heading, sit: true })).toBe(true);
    const dt = 1 / 60;
    let maxSpeed = 0;
    let prevSpeed = 0;
    let maxAccel = 0;
    for (let i = 0; i < 60 * 20; i++) {
      stepActor(actor, dt);
      maxSpeed = Math.max(maxSpeed, actor.speed);
      maxAccel = Math.max(maxAccel, Math.abs(actor.speed - prevSpeed) / dt);
      prevSpeed = actor.speed;
    }
    expect(maxSpeed).toBeLessThanOrEqual(MOTION.walkSpeed + 1e-9);
    expect(maxSpeed).toBeGreaterThan(MOTION.walkSpeed - 0.01);
    // al llegar la velocidad cae a 0 de golpe (ya casi quieto); el resto respeta 6 u/s2
    expect(maxAccel).toBeLessThanOrEqual(MOTION.accel * 1.01 + MOTION.minSpeed / dt);
    expect(actor.pos.x).toBeCloseTo(desk.seat.x, 6);
    expect(actor.pos.z).toBeCloseTo(desk.seat.z, 6);
    expect(actor.sit).toBe(1);
    expect(Math.cos(actor.heading - desk.heading)).toBeGreaterThan(0.999);
  });

  it('funciona con cualquier puesto y rumbo que venga del layout', () => {
    for (let index = 0; index <= 6; index++) {
      const desk = deskSpec(index);
      if (!desk) continue;
      const actor = createActor(`p${index}`, { x: 0, z: 0 });
      placeAt(actor, ROOM_NAV, seatNode(index), { endHeading: desk.heading, sit: true });
      for (let i = 0; i < 30; i++) stepActor(actor, 1 / 60);
      expect(actor.pos.x).toBeCloseTo(desk.seat.x, 6);
      expect(actor.pos.z).toBeCloseTo(desk.seat.z, 6);
      expect(actor.heading).toBeCloseTo(desk.heading, 6);
      expect(actor.sit).toBe(1);
    }
  });

  it('al terminar celebra en la silla, se levanta, sale y desaparece en el pasillo', () => {
    const desk = deskSpec(2);
    if (!desk) throw new Error('falta el puesto 2');
    const actor = createActor('a2', { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, seatNode(2), { endHeading: desk.heading, sit: true });
    actor.phase = 'leaving';
    actor.hop = HOP_TIME;
    expect(routeTo(actor, ROOM_NAV, NODE.spawn, { endHeading: null, sit: false })).toBe(true);
    const dt = 1 / 60;
    // durante la celebracion sigue sentado en su lugar
    for (let i = 0; i < Math.floor((HOP_TIME - 0.05) / dt); i++) stepActor(actor, dt);
    expect(actor.sit).toBe(1);
    expect(actor.pos.x).toBeCloseTo(desk.seat.x, 6);
    let sawVanishWhileWalking = false;
    const phaseOf = (a: Actor): Actor['phase'] => a.phase;
    for (let i = 0; i < 60 * 30 && phaseOf(actor) !== 'gone'; i++) {
      stepActor(actor, dt);
      if (phaseOf(actor) === 'vanishing' && isTraveling(actor)) sawVanishWhileWalking = true;
    }
    expect(phaseOf(actor)).toBe('gone');
    expect(sawVanishWhileWalking).toBe(true);
    const spawn = ROOM_NAV.nodes.get(NODE.spawn);
    expect(actor.pos.x).toBeCloseTo(spawn?.x ?? NaN, 6);
  });

  it('con movimiento reducido no hay caminatas: aparece directo en su puesto', () => {
    forceReducedMotion(true);
    const actor = createActor('a3', ROOM_NAV.nodes.get(NODE.spawn) ?? { x: 0, z: 0 });
    actor.lastNode = NODE.spawn;
    routeTo(actor, ROOM_NAV, seatNode(1), { endHeading: deskSpec(1)?.heading ?? 0, sit: true });
    stepActor(actor, 1 / 60);
    const seat = ROOM_NAV.nodes.get(seatNode(1));
    expect(actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(actor.sit).toBe(1);
    expect(isTraveling(actor)).toBe(false);
  });
});

describe('snapshots y tripulacion', () => {
  const agent = (id: string, deskIndex: number, status: OfficeAgent['status'] = 'working', action = false): OfficeAgent => ({
    id,
    kind: 'subagent',
    agentType: 'Explore',
    displayName: 'Agente de prueba',
    status,
    task: null,
    action: action ? { tool: 'Read', label: 'Leyendo un archivo de prueba', startedAt: new Date(0).toISOString() } : null,
    model: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
    deskIndex,
  });
  const room = (subagents: OfficeAgent[]): OfficeRoom => ({
    id: 'r1',
    projectName: 'demo',
    title: 'demo',
    cwd: '/demo',
    open: true,
    busy: true,
    lastActivityAt: new Date(0).toISOString(),
    lead: { ...agent('lead', 0), kind: 'lead', agentType: 'lead' },
    subagents,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
  });

  it('un snapshot nuevo no reinicia la animacion: solo cambia la actividad', () => {
    const crew = createCrew();
    const placed = new Set(['r1']);
    reconcileCrew(crew, [room([agent('a', 3)])], placed);
    reconcileCrew(crew, [room([agent('a', 3), agent('b', 5)])], placed);
    const b = crew.members.get('b')?.actor;
    if (!b) throw new Error('falta b');
    for (let i = 0; i < 40; i++) stepActor(b, 1 / 60);
    const before = { x: b.pos.x, z: b.pos.z, speed: b.speed, phase: b.walkPhase };
    expect(reconcileCrew(crew, [room([agent('a', 3, 'working', true), agent('b', 5, 'working', true)])], placed)).toBe(false);
    expect(crew.members.get('b')?.actor).toBe(b);
    expect(b.pos.x).toBe(before.x);
    expect(b.pos.z).toBe(before.z);
    expect(b.speed).toBe(before.speed);
    expect(b.walkPhase).toBe(before.phase);
    expect(b.activity).toBe('typing');
    expect(crew.members.get('a')?.actor.activity).toBe('typing');
  });

  it('entra por el pasillo con escala 0 y espera 150 ms antes de caminar', () => {
    const crew = createCrew();
    const placed = new Set(['r1']);
    reconcileCrew(crew, [room([])], placed);
    reconcileCrew(crew, [room([agent('n', 6)])], placed);
    const n = crew.members.get('n')?.actor;
    if (!n) throw new Error('falta n');
    expect(n.phase).toBe('entering');
    expect(n.pop).toBe(0);
    const spawn = ROOM_NAV.nodes.get(NODE.spawn);
    stepActor(n, 0.1);
    expect(n.pos.x).toBeCloseTo(spawn?.x ?? NaN, 6);
    expect(n.pos.z).toBeCloseTo(spawn?.z ?? NaN, 6);
    for (let i = 0; i < 20; i++) stepActor(n, 1 / 60);
    expect(n.pop).toBe(1);
    expect(n.speed).toBeGreaterThan(0);
  });

  it('el lider se sienta mirando segun el layout y acelera a 2 u/s en los pasillos', () => {
    const layout = computeLayout(assignSlots(new Map(), ['sala-0', 'sala-1', 'sala-2']));
    const g = buildOfficeNav(layout);
    const ctl = createLead();
    updateLead(ctl, layout, g, leadTarget(layout, 'sala-0'));
    expect(ctl.actor.heading).toBeCloseTo(deskSpec(0)?.heading ?? NaN, 6);
    updateLead(ctl, layout, g, leadTarget(layout, 'sala-2'));
    const speeds = ctl.actor.routeSpeed;
    expect(speeds).toContain(MOTION.hallSpeed);
    expect(speeds).toContain(MOTION.walkSpeed);
    // los tramos rapidos van por fuera de las salas
    ctl.actor.route.forEach((p, i) => {
      if (speeds[i] === MOTION.hallSpeed) expect(worldGround(layout, p.x, p.z)).toBe(0);
    });
    let maxSpeed = 0;
    for (let i = 0; i < 60 * 40; i++) {
      stepActor(ctl.actor, 1 / 60);
      maxSpeed = Math.max(maxSpeed, ctl.actor.speed);
    }
    expect(maxSpeed).toBeGreaterThan(MOTION.walkSpeed + 0.2);
    const seat = g.nodes.get(officeNode('sala-2', seatNode(0)));
    expect(ctl.actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(ctl.actor.sit).toBe(1);
  });
});

describe('tinte de pantalla', () => {
  it('se escalona en niveles compartidos y la sala cerrada no brilla', () => {
    expect(glowLevelOf(characterMaterialFor(0, false))).toBe(0);
    expect(glowLevelOf(characterMaterialFor(FACE_GLOW, false))).toBe(GLOW_LEVELS - 1);
    expect(characterMaterialFor(FACE_GLOW * 0.5, false)).toBe(characterMaterialFor(FACE_GLOW * 0.51, false));
    expect(glowLevelOf(characterMaterialFor(FACE_GLOW, true))).toBe(-1);
  });

  it('de noche el cian se nota mas que de dia', () => {
    expect(nightGlowAt(23)).toBeGreaterThan(nightGlowAt(12));
    expect(nightGlowAt(12)).toBeCloseTo(0.35, 2);
  });
});

// ---------------------------------------------------------------- actividades, alertas y accesorios

/** huesos que dan la silueta y la utileria de las manos */
const SIGNATURE_BONES = ['hips', 'torso', 'head', 'armL', 'armR', 'legL', 'legR', 'book', 'flask', 'lens', 'mug'] as const;

/** Silueta de una pose: transformaciones de los huesos + carteles visibles (burbuja, "?", zzz) */
function signature(bones: readonly Object3D[], signs: readonly boolean[]): number[] {
  const out: number[] = [];
  for (const name of SIGNATURE_BONES) {
    const bn = bones.find((b) => b.name === name);
    if (!bn) throw new Error(`falta el hueso ${name}`);
    out.push(bn.position.y, bn.rotation.x, bn.rotation.y, bn.rotation.z, bn.scale.x);
  }
  for (const on of signs) out.push(on ? 1 : 0);
  return out;
}

const differ = (a: readonly number[], b: readonly number[]): boolean =>
  a.length !== b.length || a.some((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) > 0.02);

function findByName(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name === name) hit = o;
  });
  return hit;
}

function fakeShader(): WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <skinnormal_vertex>',
    fragmentShader: '#include <common>\n#include <emissivemap_fragment>\n#include <dithering_fragment>',
  };
  return shader as unknown as WebGLProgramParametersWithUniforms;
}

const NO_RENDERER = null as unknown as WebGLRenderer;

describe('poses de las zonas de la sala', () => {
  const ZONE_POSES: readonly PoseId[] = ['idle', 'type', 'think', 'coffee', 'read', 'lab', 'meeting', 'review', 'sleep', 'wait'];
  const sigOf = (rig: CharacterRig) => signature(rig.bones, [rig.bubble.visible, rig.question.visible, rig.zzz.visible]);

  it('cada pose se distingue de todas las demas', () => {
    const rig = createRig('gael');
    const sigs = ZONE_POSES.map((id) => {
      animateCharacter(rig, id, 1.3);
      return sigOf(rig);
    });
    ZONE_POSES.forEach((a, i) =>
      ZONE_POSES.forEach((b, j) => {
        if (j > i) expect(differ(sigs[i] ?? [], sigs[j] ?? []), `${a} vs ${b}`).toBe(true);
      }),
    );
  });

  it('cada una lleva su utileria y su cartel, y nada ajeno', () => {
    const rig = createRig('lucia');
    const shown = () => ({
      book: rig.b.book.scale.x > 0.5,
      flask: rig.b.flask.scale.x > 0.5,
      lens: rig.b.lens.scale.x > 0.5,
      mug: rig.b.mug.scale.x > 0.5,
      bubble: rig.bubble.visible,
      question: rig.question.visible,
      zzz: rig.zzz.visible,
    });
    const none = { book: false, flask: false, lens: false, mug: false, bubble: false, question: false, zzz: false };
    const cases: readonly [PoseId, Partial<typeof none>][] = [
      ['read', { book: true }],
      ['lab', { flask: true }],
      ['review', { lens: true }],
      ['coffee', { mug: true }],
      ['sleep', { zzz: true }],
      ['wait', { question: true }],
      ['think', { bubble: true }],
      ['meeting', {}],
      ['type', {}],
    ];
    for (const [pose, on] of cases) {
      animateCharacter(rig, pose, 2);
      expect(shown(), pose).toEqual({ ...none, ...on });
    }
  });

  it('la silueta se lee de lejos', () => {
    const rig = createRig('bruno');
    const upOf = (bone: Object3D) => {
      rig.mesh.updateMatrixWorld(true);
      return new Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new Quaternion())).y;
    };
    // dormido: echado sobre el escritorio con los ojos cerrados
    animateCharacter(rig, 'sleep', 2);
    expect(rig.b.torso.rotation.x).toBeGreaterThan(0.5);
    expect(rig.b.head.rotation.x).toBeGreaterThan(0.4);
    expect(rig.b.eyes.scale.y).toBeLessThan(0.2);
    // revision: inclinado con la lupa horizontal sobre la mesa
    animateCharacter(rig, 'review', 2);
    expect(rig.b.torso.rotation.x).toBeGreaterThan(0.25);
    expect(rig.b.head.rotation.x).toBeGreaterThan(0.3);
    expect(upOf(rig.b.lens)).toBeGreaterThan(0.85);
    // laboratorio: matraz en alto y derecho
    animateCharacter(rig, 'lab', 2);
    expect(rig.b.armR.rotation.x).toBeLessThan(-1.5);
    expect(upOf(rig.b.flask)).toBeGreaterThan(0.9);
    // leer: las dos manos adelante sosteniendo el libro y la cabeza baja
    animateCharacter(rig, 'read', 2);
    expect(rig.b.armL.rotation.x).toBeLessThan(-0.8);
    expect(rig.b.armR.rotation.x).toBeLessThan(-0.8);
    expect(rig.b.head.rotation.x).toBeGreaterThan(0.25);
    // esperar: brazos cruzados al pecho
    animateCharacter(rig, 'wait', 2);
    expect(rig.b.armL.rotation.y).toBeLessThan(-0.8);
    expect(rig.b.armR.rotation.y).toBeGreaterThan(0.8);
  });

  it('esperando mueve el pie y conversando gesticula; con movimiento reducido se quedan quietos', () => {
    const rig = createRig('iris');
    const range = (pose: PoseId, read: () => number, motion: number) => {
      // un ciclo completo del gesto (3,7 s) con paso menor que el golpecito del pie
      const values = Array.from({ length: 40 }, (_, i) => i * 0.1).map((t) => {
        const s = poseAt(createPoseState(), pose, t);
        s.motion = motion;
        applyPose(rig, s, t);
        return read();
      });
      return Math.max(...values) - Math.min(...values);
    };
    expect(range('wait', () => rig.b.legR.rotation.x, 1)).toBeGreaterThan(0.1);
    expect(range('meeting', () => rig.b.armR.rotation.x, 1)).toBeGreaterThan(0.3);
    expect(range('wait', () => rig.b.legR.rotation.x, 0)).toBe(0);
    expect(range('meeting', () => rig.b.armR.rotation.x, 0)).toBe(0);
  });

  it('la mezcla con las poses nuevas tambien es finita', () => {
    const rig = createRig('tomas');
    const s = createPoseState();
    const keys = ['sit', 'read', 'lab', 'meet', 'review', 'sleep', 'wait', 'coffee', 'walk', 'type'] as const;
    for (let i = 0; i < 64; i++) {
      keys.forEach((k, j) => {
        s[k] = ((i >> (j % 6)) & 1) * ((j % 3) + 1) * 0.37;
      });
      s.phase = i * 0.7;
      s.question = i % 2 === 0;
      s.zzz = i % 3 === 0;
      s.motion = i % 5 === 0 ? 0 : 1;
      s.expr = (['neutral', 'focus', 'happy', 'think', 'sleep'] as const)[i % 5] ?? 'neutral';
      applyPose(rig, s, i * 0.31);
      expect(finiteRig(rig)).toBe(true);
    }
  });

  it('el "?" y el zzz son pixel art con contorno de tinta; el zzz suma una letra por cuadro', () => {
    const cream = (px: (x: number, y: number) => readonly number[]) => {
      let n = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (px(x, y)[0] === 0xff && px(x, y)[1] === 0xe3) n++;
      return n;
    };
    expect(cream(zzzPixel(1))).toBeLessThan(cream(zzzPixel(2)));
    expect(cream(zzzPixel(2))).toBeLessThan(cream(zzzPixel(3)));
    const q = new Set<string>();
    for (let y = 0; y < 11; y++) for (let x = 0; x < 8; x++) q.add(questionPixel(x, y).join(','));
    expect(q).toEqual(new Set(['0,0,0,0', '20,19,43,255', '245,169,74,255']));
  });
});

describe('alertas vivas', () => {
  it('el alertado usa su propio material rojo; los compartidos no se tocan', () => {
    const plain = characterMaterialFor(0, false);
    const warning = characterMaterialFor(0, false, 'warning');
    const critical = characterMaterialFor(FACE_GLOW, false, 'critical');
    expect(warning).not.toBe(plain);
    expect(alertLevelOf(warning)).toBe('warning');
    expect(alertLevelOf(critical)).toBe('critical');
    expect(alertLevelOf(plain)).toBeNull();
    expect(glowLevelOf(critical)).toBe(-1);
    // conserva el tinte de pantalla por escalones y su programa es otro
    expect(critical.emissiveIntensity).toBeCloseTo(FACE_GLOW, 6);
    expect(characterMaterialFor(FACE_GLOW * 0.5, false, 'critical')).toBe(characterMaterialFor(FACE_GLOW * 0.51, false, 'critical'));
    expect(warning.customProgramCacheKey()).toBe('personaje-alerta');
    expect(critical.customProgramCacheKey()).toBe('personaje-alerta');
    expect(plain.customProgramCacheKey()).toBe('personaje');
    // la sala cerrada manda
    expect(characterMaterialFor(0, true, 'critical')).toBe(characterMaterialFor(0, true));

    const red = fakeShader();
    critical.onBeforeCompile(red, NO_RENDERER);
    expect(red.fragmentShader).toContain('uniform float uAlert;');
    const soft = fakeShader();
    warning.onBeforeCompile(soft, NO_RENDERER);
    const amount = (s: WebGLProgramParametersWithUniforms) => Number(s.uniforms.uAlert?.value);
    expect(amount(red)).toBeGreaterThan(amount(soft));
    expect(amount(soft)).toBeGreaterThan(0);
    const clean = fakeShader();
    plain.onBeforeCompile(clean, NO_RENDERER);
    expect(clean.fragmentShader).not.toContain('uAlert');
    expect(clean.uniforms.uAlert).toBeUndefined();
    expect(plain.color.getHexString()).toBe('ffffff');
  });
});

describe('personaje en escena: actividades y alertas', () => {
  const meshCount = (root: Object3D) => {
    let n = 0;
    root.traverse((o) => {
      if ((o as Mesh).isMesh) n++;
    });
    return n;
  };
  const bodyOf = (root: Object3D): SkinnedMesh => {
    let hit: SkinnedMesh | null = null;
    root.traverse((o) => {
      if (!hit && (o as SkinnedMesh).isSkinnedMesh) hit = o as SkinnedMesh;
    });
    if (!hit) throw new Error('no se monto la malla del personaje');
    return hit;
  };
  const markOf = (root: Object3D): Mesh | null => {
    let hit: Mesh | null = null;
    root.traverse((o) => {
      if (!hit && (o as Mesh).isMesh && (o as Mesh).material === alertMarkerMaterial) hit = o as Mesh;
    });
    return hit;
  };
  const placed = (activity: Activity, sit: boolean): Actor => {
    const actor = createActor('actividad', { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, sit ? seatNode(2) : NODE.coffee, { endHeading: sit ? (deskSpec(2)?.heading ?? 0) : 0, sit });
    actor.activity = activity;
    return actor;
  };
  const view = (actor: Actor, props: Partial<CharacterProps> = {}) =>
    createElement(Character, {
      actor,
      agentType: 'general-purpose',
      offset: { x: 0, z: 0 },
      ground: localGround,
      selectId: actor.id,
      ...props,
    });

  it('cada actividad produce una pose distinta, sentado o de pie segun el destino', async () => {
    const cases: readonly [Activity, boolean][] = [
      ['typing', true],
      ['thinking', true],
      ['meeting', true],
      ['sleeping', true],
      ['coffee', false],
      ['reading', false],
      ['lab', false],
      ['reviewing', false],
      ['waiting', false],
      ['meeting', false],
    ];
    const sigs: number[][] = [];
    for (const [activity, sit] of cases) {
      const renderer = await ReactThreeTestRenderer.create(view(placed(activity, sit)));
      await renderer.advanceFrames(40, 1 / 60);
      const scene = renderer.scene.instance;
      const signs = ['burbuja', 'pregunta', 'zzz'].map((n) => findByName(scene, n)?.visible === true);
      sigs.push(signature(bodyOf(scene).skeleton.bones, signs));
      await renderer.unmount();
    }
    const label = ([a, sit]: readonly [Activity, boolean]) => `${a} ${sit ? 'sentado' : 'de pie'}`;
    cases.forEach((a, i) =>
      cases.forEach((b, j) => {
        if (j > i) expect(differ(sigs[i] ?? [], sigs[j] ?? []), `${label(a)} vs ${label(b)}`).toBe(true);
      }),
    );
  });

  it('cualquier agente toma cafe con la taza humeante', async () => {
    const renderer = await ReactThreeTestRenderer.create(view(placed('coffee', false)));
    await renderer.advanceFrames(40, 1 / 60);
    const body = bodyOf(renderer.scene.instance);
    expect(body.name).toBe('personaje-gael');
    const mug = body.skeleton.bones.find((b) => b.name === 'mug');
    expect(mug?.scale.x).toBe(1);
    const steam = findByName(renderer.scene.instance, 'vapor');
    expect(steam?.parent).toBe(mug);
    expect(steam?.visible).toBe(true);
    await renderer.unmount();
  });

  it('con alerta se tine de rojo y lleva un "!"; al apagarse vuelve a su material', async () => {
    const actor = placed('typing', true);
    const renderer = await ReactThreeTestRenderer.create(view(actor, { alert: 'critical' }));
    await renderer.advanceFrames(20, 1 / 60);
    const scene = renderer.scene.instance;
    const body = bodyOf(scene);
    expect(alertLevelOf(body.material)).toBe('critical');
    // cuerpo + sombra + caja de clic + "!"
    expect(meshCount(scene)).toBe(4);
    const mark = markOf(scene);
    if (!mark) throw new Error('falta el "!"');
    expect(mark.position.y).toBeGreaterThan(1.3);
    expect(Math.hypot(mark.position.x, mark.position.z)).toBeLessThan(1e-9);
    await renderer.update(view(actor, { alert: 'warning' }));
    await renderer.advanceFrames(2, 1 / 60);
    expect(alertLevelOf(body.material)).toBe('warning');
    await renderer.update(view(actor, { alert: null }));
    await renderer.advanceFrames(2, 1 / 60);
    expect(alertLevelOf(body.material)).toBeNull();
    expect(markOf(scene)).toBeNull();
    expect(meshCount(scene)).toBe(3);
    await renderer.unmount();
  });

  it('seleccionado, el "!" se corre al lado de la flecha; con movimiento reducido no late', async () => {
    forceReducedMotion(true);
    const actor = placed('waiting', false);
    useOfficeStore.setState({ selectedAgentId: actor.id });
    const renderer = await ReactThreeTestRenderer.create(view(actor, { alert: 'critical' }));
    await renderer.advanceFrames(40, 1 / 60);
    const scene = renderer.scene.instance;
    // cuerpo + sombra + caja de clic + flecha + anillo + "!"
    expect(meshCount(scene)).toBe(6);
    const mark = markOf(scene);
    if (!mark) throw new Error('falta el "!"');
    expect(Math.hypot(mark.position.x, mark.position.z)).toBeCloseTo(ALERT_SIDE, 6);
    expect(mark.scale.x).toBe(1);
    expect(findByName(scene, 'pregunta')?.visible).toBe(true);
    await renderer.unmount();
  });

  // --- el "!" frente a la camara girada: cajas en el espacio de la vista (ortografica: x, y = pantalla) ---
  interface Box {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  let three: RootState | null = null;
  const Grab = () => {
    three = useThree();
    return null;
  };
  const mount = async (actor: Actor, props: Partial<CharacterProps>) => {
    three = null;
    const renderer = await ReactThreeTestRenderer.create(
      createElement(Fragment, null, createElement(Grab), view(actor, props)),
      { orthographic: true },
    );
    await renderer.advanceFrames(40, 1 / 60);
    const st = three as RootState | null;
    if (!st) throw new Error('sin estado de R3F');
    return { renderer, st };
  };
  const orbit = (st: RootState, az: number) => {
    st.camera.position.copy(cameraOffset(az, BASE_POLAR, 20));
    st.camera.lookAt(0, 0, 0);
    st.camera.updateMatrixWorld();
  };
  const ORBIT: readonly number[] = Array.from({ length: 17 }, (_, i) => BASE_AZIMUTH - AZIMUTH_RANGE + (i * AZIMUTH_RANGE) / 8);
  const meshBox = (mesh: Mesh, camera: Camera): Box => {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) throw new Error('sin caja');
    const box: Box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const x of [bb.min.x, bb.max.x])
      for (const y of [bb.min.y, bb.max.y])
        for (const z of [bb.min.z, bb.max.z]) {
          const v = new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
          box.x0 = Math.min(box.x0, v.x);
          box.x1 = Math.max(box.x1, v.x);
          box.y0 = Math.min(box.y0, v.y);
          box.y1 = Math.max(box.y1, v.y);
        }
    return box;
  };
  const spriteBox = (sprite: Object3D, camera: Camera): Box => {
    const e = sprite.matrixWorld.elements;
    const c = new Vector3().setFromMatrixPosition(sprite.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    const hw = Math.hypot(e[0], e[1], e[2]) / 2;
    const hh = Math.hypot(e[4], e[5], e[6]) / 2;
    return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh };
  };
  const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const arrowOf = (root: Object3D): Mesh | null => {
    let hit: Mesh | null = null;
    root.traverse((o) => {
      if (!hit && (o as Mesh).isMesh && (o as Mesh).geometry === arrowGeometry) hit = o as Mesh;
    });
    return hit;
  };

  it('el "!" no pisa la burbuja, el "?" ni la flecha con la camara girada ni con el vaiven de la cabeza', async () => {
    const doorHeading = ZONES.door.plazas[0]?.heading;
    if (doorHeading === undefined) throw new Error('sin plaza en la puerta');
    const atDoor = (): Actor => {
      const actor = createActor('puerta', { x: 0, z: 0 });
      placeAt(actor, ROOM_NAV, NODE.coffee, { endHeading: doorHeading, sit: false });
      actor.activity = 'waiting';
      return actor;
    };
    const cases: readonly { name: string; actor: () => Actor; sprite: string; props: Partial<CharacterProps> }[] = [
      { name: 'pensando en su puesto', actor: () => placed('thinking', true), sprite: 'burbuja', props: {} },
      { name: 'esperando en la puerta', actor: atDoor, sprite: 'pregunta', props: {} },
      { name: 'el lider en la puerta', actor: atDoor, sprite: 'pregunta', props: { agentType: 'lead', showArrow: false } },
    ];
    for (const c of cases) {
      for (const selected of [false, true]) {
        const actor = c.actor();
        useOfficeStore.setState({ selectedAgentId: selected ? actor.id : null });
        const { renderer, st } = await mount(actor, { alert: 'critical', ...c.props });
        const scene = renderer.scene.instance;
        const sprite = findByName(scene, c.sprite);
        const mark = markOf(scene);
        if (!sprite || !mark) throw new Error(`${c.name}: falta el sprite o el "!"`);
        const arrowMesh = arrowOf(scene);
        expect(arrowMesh !== null, c.name).toBe(selected && c.props.showArrow !== false);
        // a la misma altura que el sprite: solo el corrimiento de lado los separa
        let sameHeight = 0;
        for (const az of ORBIT) {
          orbit(st, az);
          for (let k = 0; k < 12; k++) {
            st.clock.elapsedTime = k * 1.1;
            await renderer.advanceFrames(1, 1 / 60);
            scene.updateMatrixWorld(true);
            const label = `${c.name}${selected ? ' (elegido)' : ''} a ${Math.round((az * 180) / Math.PI)} grados, t=${k}`;
            expect(sprite.visible, label).toBe(true);
            const bang = meshBox(mark, st.camera);
            const head = spriteBox(sprite, st.camera);
            if (bang.y0 < head.y1 && head.y0 < bang.y1) sameHeight++;
            expect(overlap(bang, head), `${label}: "!" sobre el sprite`).toBe(false);
            if (arrowMesh) expect(overlap(bang, meshBox(arrowMesh, st.camera)), `${label}: "!" sobre la flecha`).toBe(false);
          }
        }
        expect(sameHeight, c.name).toBeGreaterThan(ORBIT.length * 6);
        await renderer.unmount();
      }
    }
  });

  it('flecha y "!" miran a la camara girada y el "!" sigue a la derecha de la flecha', async () => {
    const actor = placed('typing', true);
    useOfficeStore.setState({ selectedAgentId: actor.id });
    const { renderer, st } = await mount(actor, { alert: 'warning' });
    const scene = renderer.scene.instance;
    const mark = markOf(scene);
    const arrowMesh = arrowOf(scene);
    if (!mark || !arrowMesh) throw new Error('falta el "!" o la flecha');
    for (const az of ORBIT) {
      orbit(st, az);
      await renderer.advanceFrames(1, 1 / 60);
      scene.updateMatrixWorld(true);
      const deg = `${Math.round((az * 180) / Math.PI)} grados`;
      for (const m of [mark, arrowMesh]) {
        const e = m.matrixWorld.elements;
        expect(angleGap(Math.atan2(e[8], e[10]), az), deg).toBeLessThan(1e-6);
      }
      const bang = meshBox(mark, st.camera);
      const arrowBox = meshBox(arrowMesh, st.camera);
      expect(overlap(bang, arrowBox), deg).toBe(false);
      expect((bang.x0 + bang.x1) / 2 - (arrowBox.x0 + arrowBox.x1) / 2, deg).toBeCloseTo(ALERT_SIDE, 6);
    }
    await renderer.unmount();
  });
});

describe('lado del "!" de alerta', () => {
  it('viewAzimuth lee el giro de la camara desde su cuaternion', () => {
    const cam = new OrthographicCamera();
    for (const az of [BASE_AZIMUTH - AZIMUTH_RANGE, 0, BASE_AZIMUTH, 1.2, BASE_AZIMUTH + AZIMUTH_RANGE]) {
      cam.position.copy(cameraOffset(az, BASE_POLAR, 20));
      cam.lookAt(0, 0, 0);
      expect(angleGap(viewAzimuth(cam.quaternion), az)).toBeLessThan(1e-9);
    }
  });

  it('sin sprite: al lado de la flecha o centrado; con sprite: al otro lado y sin pisarlo', () => {
    expect(alertOffset(true, null, 0)).toBe(ALERT_SIDE);
    expect(alertOffset(false, null, ALERT_SIDE)).toBe(0);
    const bubble = { x: 0.26, halfW: 0.17 };
    expect(alertOffset(false, bubble, 0)).toBe(-ALERT_SIDE);
    expect(alertOffset(true, bubble, ALERT_SIDE)).toBe(-ALERT_SIDE);
    expect(alertOffset(true, { x: -0.2, halfW: 0.1 }, 0)).toBe(ALERT_SIDE);
    // casi centrado: se aleja lo necesario, y el vaiven no lo hace saltar de lado
    const pulse = 0.2;
    const clear = (x: number, side: number, halfW: number) => Math.abs(side - x) - halfW - ALERT_HALF_W * (1 + pulse);
    const right = alertOffset(true, { x: 0.02, halfW: 0.17 }, ALERT_SIDE, pulse);
    expect(right).toBeGreaterThan(0);
    expect(clear(0.02, right, 0.17)).toBeGreaterThan(0);
    const left = alertOffset(true, { x: 0.02, halfW: 0.17 }, -ALERT_SIDE, pulse);
    expect(left).toBeLessThan(0);
    expect(clear(0.02, left, 0.17)).toBeGreaterThan(0);
    // ya claramente de su lado: cambia
    expect(alertOffset(true, { x: 0.12, halfW: 0.17 }, ALERT_SIDE, pulse)).toBeLessThan(0);
  });
});

describe('Tomas (pruebas) y Sara (seguridad)', () => {
  it('llevan bata y chaqueta de seguridad dentro del presupuesto de triangulos', () => {
    expect(castIdFor('tester')).toBe('tomas');
    expect(castIdFor('security')).toBe('sara');
    expect(castLook('tomas').acc).toBe('labcoat');
    expect(castLook('sara').acc).toBe('security');
    for (const id of ['tomas', 'sara']) {
      expect(characterTriangles(id)).toBeLessThanOrEqual(600);
      const rig = createRig(id);
      for (const pose of POSES) {
        animateCharacter(rig, pose.id, 1.7);
        expect(finiteRig(rig)).toBe(true);
      }
      rig.dispose();
    }
  });

  it('sus retratos llevan la prenda encima de la camiseta', () => {
    const tester = AGENT_LOOKS.tester;
    const security = AGENT_LOOKS.security;
    if (!tester || !security) throw new Error('faltan los looks de pruebas y seguridad');
    expect(tester.accessory).toBe('labcoat');
    expect(security.accessory).toBe('security');
    const t = spriteGrid(tester);
    expect(t[14]?.[3]).toBe(PALETTE.cream);
    expect(t[13]?.[7]).toBe(tester.shirt);
    expect(t[13]?.[11]).toBe(PALETTE.teal);
    expect(t[5]?.[5]).toBe(tester.accent);
    const s = spriteGrid(security);
    expect(s[14]?.[3]).toBe(PALETTE.indigo);
    expect(s[13]?.[7]).toBe(security.shirt);
    expect(s[14]?.[11]).toBe(security.accent);
    expect(s[8]?.[2]).toBe(security.accent);
  });
});
