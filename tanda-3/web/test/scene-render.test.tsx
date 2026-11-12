import { afterEach, describe, expect, it } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { type Intersection, type Mesh, type MeshBasicMaterial, type Object3D, Raycaster, type SkinnedMesh } from 'three';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import { mapIds } from '@/scene/annex';
import { Desk } from '@/scene/Desk';
import { FLOW_BOARD_NAME } from '@/scene/PhaseBoard';
import { assignSlots, computeLayout, deskSpec } from '@/scene/layout';
import { createMockSnapshot } from '@/scene/mock';
import { Office } from '@/scene/OfficeScene';
import { RoomView } from '@/scene/Room';
import { frameRects, ROOM_HIGHLIGHT_NAME, RoomHighlight } from '@/scene/RoomHighlight';
import { litAtlas, paintLeadPlate } from '@/scene/textures';
import { useOfficeStore } from '@/state/store';

const NOW = Date.UTC(2026, 0, 1, 10, 0, 30);

// el test-renderer envuelve en act(); React lo exige declarado
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// El montaje de un personaje suelto se prueba en characters-render.test.tsx
describe('montaje de la escena', () => {
  it('una sala con datos de la demo genera sus mallas sin errores', async () => {
    const snap = createMockSnapshot(NOW);
    const room = snap.rooms[0];
    if (!room) throw new Error('la demo no trae salas');
    const layout = computeLayout(assignSlots(new Map(), snap.rooms.map((r) => r.id)));
    const placement = layout.byId.get(room.id);
    if (!placement) throw new Error('sala sin lugar');
    const renderer = await ReactThreeTestRenderer.create(
      <RoomView placement={placement} room={room} lampsOn labels={false} />,
    );
    await renderer.advanceFrames(3, 1 / 60);
    expect(countMeshes(renderer.scene.instance)).toBeGreaterThan(20);
    await renderer.unmount();
  });

  it('la sala con un flujo monta el tablero de fases; sin flujo o en un anexo, no', async () => {
    const snap = createMockSnapshot(NOW);
    const room = snap.rooms.find((r) => (r.workflows ?? []).some((w) => w.status === 'running'));
    if (!room) throw new Error('la demo no trae un flujo en curso');
    const layout = computeLayout(assignSlots(new Map(), snap.rooms.map((r) => r.id)));
    const placement = layout.byId.get(room.id);
    if (!placement) throw new Error('sala sin lugar');
    const renderer = await ReactThreeTestRenderer.create(<RoomView placement={placement} room={room} labels={false} />);
    await renderer.advanceFrames(3, 1 / 60);
    expect(renderer.scene.instance.getObjectByName(FLOW_BOARD_NAME)).toBeDefined();
    await renderer.update(<RoomView placement={placement} room={{ ...room, workflows: [] }} labels={false} />);
    await renderer.advanceFrames(2, 1 / 60);
    expect(renderer.scene.instance.getObjectByName(FLOW_BOARD_NAME)).toBeUndefined();
    await renderer.update(<RoomView placement={placement} room={room} labels={false} annex={1} />);
    await renderer.advanceFrames(2, 1 / 60);
    expect(renderer.scene.instance.getObjectByName(FLOW_BOARD_NAME)).toBeUndefined();
    await renderer.unmount();
  });

  it('un escritorio de lider tiene dos pantallas', async () => {
    const spec = deskSpec(0);
    if (!spec) throw new Error('falta el escritorio de lider');
    const renderer = await ReactThreeTestRenderer.create(
      <Desk spec={spec} screen="code" lampsOn closed={false} selectId={null} />,
    );
    const planes = renderer.scene.findAll((n) => n.type === 'Mesh' && (n.instance as Mesh).geometry.type === 'PlaneGeometry');
    expect(planes).toHaveLength(2);
    await renderer.unmount();
  });

  it('la oficina completa de la demo se monta y los personajes caminan', async () => {
    const snap = createMockSnapshot(NOW);
    const renderer = await ReactThreeTestRenderer.create(
      <Office snapshot={snap} pixel={null} labels={false} controls={false} />,
    );
    await renderer.advanceFrames(30, 1 / 30);
    const visibleAgents = snap.rooms.reduce((n, r) => n + r.subagents.filter((a) => a.status !== 'done').length, 0);
    // un personaje por subagente activo + el lider, cada uno en una sola malla
    expect(skinnedMeshes(renderer.scene.instance)).toHaveLength(visibleAgents + 1);
    // cada personaje = cuerpo + sombra + caja de clic; el mundo (fusionado) suma al menos sus 3 salas
    expect(countMeshes(renderer.scene.instance)).toBeGreaterThan(3 * (visibleAgents + 1) + 3);
    // cambia la sala del lider: debe seguir montando sin errores
    await renderer.update(<Office snapshot={createMockSnapshot(NOW + 45_000)} pixel={null} labels={false} controls={false} />);
    await renderer.advanceFrames(30, 1 / 30);
    await renderer.unmount();
  });

  it('la oficina dibuja el contorno de la sala con el panel abierto', async () => {
    const snap = createMockSnapshot(NOW);
    const room = snap.rooms[0];
    if (!room) throw new Error('la demo no trae salas');
    useOfficeStore.setState({ selectedRoomId: room.id, hoveredRoomId: null });
    try {
      const renderer = await ReactThreeTestRenderer.create(
        <Office snapshot={snap} pixel={null} labels={false} controls={false} />,
      );
      await renderer.advanceFrames(2, 1 / 30);
      expect(renderer.scene.instance.getObjectByName(`${ROOM_HIGHLIGHT_NAME}:selected`)).toBeDefined();
      await renderer.unmount();
    } finally {
      useOfficeStore.setState({ selectedRoomId: null });
    }
  });

  it('la placa del escritorio del lider sigue al nombre que elige el usuario', async () => {
    /** true si la placa ya muestra ese nombre: repintarlo con el mismo texto no toca la textura */
    const plateShows = (name: string): boolean => {
      const version = litAtlas.version;
      paintLeadPlate(name);
      return litAtlas.version === version;
    };
    const snap = createMockSnapshot(NOW);
    const renderer = await ReactThreeTestRenderer.create(
      <Office snapshot={{ ...snap, leadName: 'Ana' }} pixel={null} labels={false} controls={false} />,
    );
    await renderer.advanceFrames(2, 1 / 30);
    expect(plateShows('ana')).toBe(true);
    // null = todavia sin nombre: la placa vuelve al por defecto
    await renderer.update(<Office snapshot={{ ...snap, leadName: null }} pixel={null} labels={false} controls={false} />);
    await renderer.advanceFrames(2, 1 / 30);
    expect(plateShows(DEFAULT_LEAD_NAME)).toBe(true);
    await renderer.unmount();
  });
});

describe('contorno de sala en el piso', () => {
  afterEach(() => useOfficeStore.setState({ selectedRoomId: null, hoveredRoomId: null }));

  const setRooms = (selectedRoomId: string | null, hoveredRoomId: string | null) =>
    ReactThreeTestRenderer.act(async () => {
      useOfficeStore.setState({ selectedRoomId, hoveredRoomId });
    });

  it('se dibuja con una sala seleccionada o bajo el puntero, y no sin ella', async () => {
    const snap = createMockSnapshot(NOW);
    const [a, b] = snap.rooms;
    if (!a || !b) throw new Error('la demo trae menos de dos salas');
    const layout = computeLayout(assignSlots(new Map(), mapIds(snap.rooms)));
    const renderer = await ReactThreeTestRenderer.create(<RoomHighlight layout={layout} rooms={snap.rooms} />);
    const frame = (mode: 'selected' | 'hover') => renderer.scene.instance.getObjectByName(`${ROOM_HIGHLIGHT_NAME}:${mode}`);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('selected')).toBeUndefined();
    expect(frame('hover')).toBeUndefined();

    await setRooms(a.id, null);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('selected')).toBeDefined();
    expect(frame('hover')).toBeUndefined();
    // no recibe punteros: no le roba el clic a la sala
    const hits: Intersection[] = [];
    (frame('selected') as Mesh).raycast(new Raycaster(), hits);
    expect(hits).toHaveLength(0);

    await setRooms(a.id, b.id);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('selected')).toBeDefined();
    expect(frame('hover')).toBeDefined();
    expect(((frame('hover') as Mesh).material as MeshBasicMaterial).opacity).toBeLessThan(
      ((frame('selected') as Mesh).material as MeshBasicMaterial).opacity,
    );

    // la sala abierta bajo el puntero: un solo marco
    await setRooms(a.id, a.id);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('hover')).toBeUndefined();

    await setRooms(null, b.id);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('selected')).toBeUndefined();
    expect(frame('hover')).toBeDefined();

    // una sala que ya no esta en el mapa: nada
    await setRooms('sala-que-ya-no-esta', null);
    await renderer.advanceFrames(2, 1 / 30);
    expect(frame('selected')).toBeUndefined();
    expect(frame('hover')).toBeUndefined();
    await renderer.unmount();
  });

  it('cubre la sala y sus anexos', async () => {
    const snap = createMockSnapshot(NOW);
    const [a, b] = snap.rooms;
    if (!a || !b) throw new Error('la demo trae menos de dos salas');
    const layout = computeLayout(assignSlots(new Map(), [a.id, b.id, `${a.id}~anexo1`]));
    await setRooms(a.id, null);
    const renderer = await ReactThreeTestRenderer.create(<RoomHighlight layout={layout} rooms={snap.rooms} />);
    await renderer.advanceFrames(1, 1 / 30);
    const mesh = renderer.scene.instance.getObjectByName(`${ROOM_HIGHLIGHT_NAME}:selected`) as Mesh | undefined;
    // 6 vertices por pieza del marco, un marco por lugar del mapa (sala + anexo)
    expect(mesh?.geometry.getAttribute('position').count).toBe(2 * frameRects().length * 6);
    await renderer.unmount();
  });
});
