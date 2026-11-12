import { afterEach, describe, expect, it } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import type { Mesh, Object3D, SkinnedMesh, Sprite } from 'three';
import { LEAD_PERSONA } from '@shared/personas';
import { useOfficeStore } from '@/state/store';
import { createActor, placeAt, routeTo } from '@/scene/actors';
import { Character } from '@/scene/Character';
import { nearestCharacterDistance } from '@/scene/characters/presence';
import { BONE_NAMES } from '@/scene/characters/rig';
import { COFFEE_HEADING, deskSpec, localGround, NODE, ROOM_NAV, seatNode } from '@/scene/layout';

// el test-renderer envuelve en act(); React lo exige declarado
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => useOfficeStore.setState({ selectedAgentId: null, hoveredAgentId: null }));

function countMeshes(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) n++;
  });
  return n;
}

function skinnedMeshes(root: Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) out.push(o as SkinnedMesh);
  });
  return out;
}

function findByName<T extends Object3D>(root: Object3D, name: string): T | null {
  let hit: T | null = null;
  root.traverse((o) => {
    if (!hit && o.name === name) hit = o as T;
  });
  return hit;
}

describe('montaje del personaje', () => {
  it('el rig de un personaje sentado se monta y anima sin errores', async () => {
    const desk = deskSpec(2);
    if (!desk) throw new Error('falta el puesto 2');
    const actor = createActor('demo-agente', { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, seatNode(2), { endHeading: desk.heading, sit: true });
    actor.activity = 'typing';
    const renderer = await ReactThreeTestRenderer.create(
      <Character actor={actor} agentType="Explore" offset={{ x: 0, z: 0 }} ground={localGround} selectId="demo-agente" />,
    );
    await renderer.advanceFrames(40, 1 / 60);
    const scene = renderer.scene.instance;
    const [body, ...others] = skinnedMeshes(scene);
    if (!body) throw new Error('no se monto la malla del personaje');
    expect(others).toHaveLength(0);
    expect(body.name).toBe('personaje-elena');
    expect(body.skeleton.bones).toHaveLength(BONE_NAMES.length);
    // malla del cuerpo + sombra de contacto + caja de clic
    expect(countMeshes(scene)).toBe(3);
    const hips = body.skeleton.bones[1];
    expect(hips?.position.y ?? 0).toBeGreaterThan(0.45);
    const bubble = findByName<Sprite>(scene, 'burbuja');
    expect(bubble?.visible).toBe(false);
    // el mundo sabe donde esta (p. ej. para abrir la puerta a su paso)
    expect(nearestCharacterDistance(desk.seat.x, desk.seat.z)).toBeLessThan(1e-6);
    actor.activity = 'thinking';
    await renderer.advanceFrames(40, 1 / 60);
    expect(bubble?.visible).toBe(true);
    await renderer.unmount();
    expect(nearestCharacterDistance(desk.seat.x, desk.seat.z)).toBe(Infinity);
  });

  it('un agente que entra aparece en el pasillo y avanza hacia su puesto', async () => {
    const desk = deskSpec(5);
    if (!desk) throw new Error('falta el puesto 5');
    const spawn = ROOM_NAV.nodes.get(NODE.spawn) ?? { x: 0, z: 0 };
    const actor = createActor('demo-nuevo', spawn);
    actor.lastNode = NODE.spawn;
    actor.phase = 'entering';
    actor.pop = 0;
    actor.appearT = 0;
    routeTo(actor, ROOM_NAV, seatNode(5), { endHeading: desk.heading, sit: true });
    const renderer = await ReactThreeTestRenderer.create(
      <Character actor={actor} agentType="otro-tipo" offset={{ x: 0, z: 0 }} ground={localGround} selectId={null} />,
    );
    await renderer.advanceFrames(2, 1 / 60);
    const body = skinnedMeshes(renderer.scene.instance)[0];
    expect(body?.name).toBe('personaje-generic');
    const root = body?.skeleton.bones[0];
    expect(root?.scale.y ?? 1).toBeLessThan(1);
    await renderer.advanceFrames(60, 1 / 60);
    expect(actor.pop).toBe(1);
    expect(Math.hypot(actor.pos.x - spawn.x, actor.pos.z - spawn.z)).toBeGreaterThan(0.3);
    await renderer.unmount();
  });

  it('el seleccionado lleva flecha y anillo; el clic lo selecciona', async () => {
    const actor = createActor('demo-sel', { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, seatNode(1), { endHeading: deskSpec(1)?.heading ?? 0, sit: true });
    const renderer = await ReactThreeTestRenderer.create(
      <Character actor={actor} agentType="tr-builder" offset={{ x: 0, z: 0 }} ground={localGround} selectId="demo-sel" />,
    );
    await renderer.advanceFrames(2, 1 / 60);
    expect(countMeshes(renderer.scene.instance)).toBe(3);
    const hitbox = renderer.scene.findAll((n) => n.type === 'Mesh' && (n.instance as Mesh).geometry.type === 'BoxGeometry')[0];
    if (!hitbox) throw new Error('falta la caja de clic');
    await renderer.fireEvent(hitbox, 'click', { delta: 0, stopPropagation: () => undefined });
    expect(useOfficeStore.getState().selectedAgentId).toBe('demo-sel');
    await renderer.advanceFrames(2, 1 / 60);
    expect(countMeshes(renderer.scene.instance)).toBe(5);
    await renderer.unmount();
  });

  it('el puntero despliega su etiqueta y se suelta al cambiar de agente o al desmontarse', async () => {
    const actor = createActor('demo-hover', { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, seatNode(6), { endHeading: deskSpec(6)?.heading ?? 0, sit: true });
    const view = (selectId: string) => (
      <Character actor={actor} agentType="lead" offset={{ x: 0, z: 0 }} ground={localGround} selectId={selectId} />
    );
    const hovered = () => useOfficeStore.getState().hoveredAgentId;
    const hitboxOf = () => {
      const box = renderer.scene.findAll((n) => n.type === 'Mesh' && (n.instance as Mesh).geometry.type === 'BoxGeometry')[0];
      if (!box) throw new Error('falta la caja de clic');
      return box;
    };
    const renderer = await ReactThreeTestRenderer.create(view('lider-a'));
    await renderer.fireEvent(hitboxOf(), 'pointerOver', { stopPropagation: () => undefined });
    expect(hovered()).toBe('lider-a');
    // el lider cambia de sala con el puntero encima: no queda desplegada la etiqueta de la sala anterior
    await renderer.update(view('lider-b'));
    expect(hovered()).toBeNull();
    await renderer.fireEvent(hitboxOf(), 'pointerOver', { stopPropagation: () => undefined });
    expect(hovered()).toBe('lider-b');
    // se va con el puntero encima: R3F no emite pointerout, igual se suelta
    await renderer.unmount();
    expect(hovered()).toBeNull();
  });

  it('el lider sin sala toma cafe con la taza en la mano', async () => {
    const actor = createActor(LEAD_PERSONA, { x: 0, z: 0 });
    placeAt(actor, ROOM_NAV, NODE.coffee, { endHeading: COFFEE_HEADING, sit: false });
    actor.activity = 'coffee';
    actor.mug = true;
    const renderer = await ReactThreeTestRenderer.create(
      <Character actor={actor} agentType="lead" offset={{ x: 0, z: 0 }} ground={localGround} selectId={null} />,
    );
    await renderer.advanceFrames(40, 1 / 60);
    const body = skinnedMeshes(renderer.scene.instance)[0];
    expect(body?.name).toBe(`personaje-${LEAD_PERSONA}`);
    const mug = body?.skeleton.bones.find((b) => b.name === 'mug');
    expect(mug?.scale.x).toBe(1);
    // la taza humea
    const steam = findByName<Object3D>(renderer.scene.instance, 'vapor');
    expect(steam?.parent).toBe(mug);
    expect(steam?.visible).toBe(true);
    await renderer.unmount();
  });
});
