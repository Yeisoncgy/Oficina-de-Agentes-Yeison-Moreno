import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeRoom } from '@shared/contract';
import { createActor, routeTo, stepActor } from '@/scene/actors';
import { createCrew, reconcileCrew, updateLead, leadTarget, createLead } from '@/scene/crew';
import { clockHourNow, currentHour, dayStateAt, getTimeMode, setTimeMode, TIME_MODE_HOUR } from '@/scene/daylight';
import {
  assignSlots,
  buildOfficeNav,
  cellOf,
  chairRect,
  computeLayout,
  DESKS,
  DOOR,
  findPath,
  FACE_BACK,
  insideRect,
  laneNode,
  NODE,
  officeNode,
  OVERFLOW_SLOTS,
  pathPoints,
  type Rect,
  rectAround,
  rectsOverlap,
  ROOM_FOOTPRINT,
  ROOM_INTERIOR,
  ROOM_NAV,
  roomObstacles,
  seatNode,
  slotNode,
  toWorld,
  toWorldRect,
  type Vec2,
  WALL_RECTS,
  WALL_T,
} from '@/scene/layout';
import { createMockSnapshot } from '@/scene/mock';
import { leadPlateText, LIT_UV, litAtlas, paintLeadPlate } from '@/scene/textures';
import { fitText, paintPlate, plateText, Raster, RUGS } from '@/scene/world/raster';
import { THEMES, themeOfSlot } from '@/scene/world/themes';

function layoutFor(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `sala-${i}`);
  return computeLayout(assignSlots(new Map(), ids));
}

/** puntos cada 3 cm a lo largo de un tramo */
function samples(a: Vec2, b: Vec2): Vec2[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.03));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }));
}

function strictlyInside(r: Rect, p: Vec2): boolean {
  return p.x > r.minX + 1e-6 && p.x < r.maxX - 1e-6 && p.z > r.minZ + 1e-6 && p.z < r.maxZ - 1e-6;
}

describe('grilla de salas', () => {
  it('cada lugar tiene una celda fija: la grilla crece a lo ancho y luego a lo alto', () => {
    const cells = Array.from({ length: 12 }, (_, s) => cellOf(s));
    expect(cells).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
      { col: 2, row: 0 },
      { col: 2, row: 1 },
      { col: 0, row: 2 },
      { col: 1, row: 2 },
      { col: 2, row: 2 },
      { col: 3, row: 0 },
      { col: 3, row: 1 },
      { col: 3, row: 2 },
    ]);
    // ninguna celda se repite, tampoco mas alla de 12
    const keys = Array.from({ length: 40 }, (_, s) => `${cellOf(s).col},${cellOf(s).row}`);
    expect(new Set(keys).size).toBe(40);
  });

  it('llegar una sala no mueve a nadie; si una se va, su espacio desaparece y las de despues avanzan', () => {
    const cellsOf = (slots: Map<string, number>) => {
      const layout = computeLayout(slots);
      return new Map(layout.rooms.map((r) => [r.id, `${r.col},${r.row}`]));
    };
    // 4 salas en 2x2; "d" queda abajo a la derecha
    const four = assignSlots(new Map(), ['a', 'b', 'c', 'd']);
    expect(cellsOf(four).get('d')).toBe('1,1');
    // llega una quinta: va a la tercera columna y nadie se mueve, aunque cambie el orden del snapshot
    const five = assignSlots(four, ['e', 'd', 'c', 'b', 'a']);
    expect(cellsOf(five).get('d')).toBe('1,1');
    expect(cellsOf(five).get('e')).toBe('2,0');
    // se archiva "b": no queda hueco; c, d y e avanzan un lugar en el mismo orden
    const gone = assignSlots(five, ['a', 'c', 'd', 'e']);
    expect([...cellsOf(gone).entries()]).toEqual([
      ['a', '0,0'],
      ['c', '1,0'],
      ['d', '0,1'],
      ['e', '1,1'],
    ]);
  });

  it('el orden que manda el server gana sobre el de la pagina', () => {
    const page = assignSlots(new Map(), ['a', 'b']);
    const slots = assignSlots(page, ['a', 'b'], new Map([['a', 3], ['b', 1]]));
    expect(slots.get('b')).toBe(0);
    expect(slots.get('a')).toBe(1);
  });

  it('la losa solo cubre las celdas con sala: con 3 salas no queda el cuarto espacio vacio', () => {
    const layout = layoutFor(3);
    expect(layout.rowCols).toEqual([2, 1]);
    expect(layout.colRows).toEqual([2, 1]);
    const [top, bottom] = layout.rowRects;
    if (!top || !bottom) throw new Error('faltan franjas');
    for (const room of layout.rooms) {
      const f = toWorldRect(room, ROOM_FOOTPRINT);
      const strip = layout.rowRects[room.row];
      expect(strip && f.maxX <= strip.maxX + 1e-9 && f.minZ >= strip.minZ - 1e-9 && f.maxZ <= strip.maxZ + 1e-9).toBe(true);
    }
    // donde iria la cuarta sala (abajo a la derecha) no hay losa
    const missing = { x: (layout.rooms[1]?.center.x ?? 0), z: (layout.rooms[2]?.center.z ?? 0) };
    expect(missing.x).toBeGreaterThan(bottom.maxX);
  });

  it('mantiene el lugar de cada sala aunque cambie el orden del snapshot', () => {
    const first = assignSlots(new Map(), ['a', 'b', 'c']);
    const reordered = assignSlots(first, ['c', 'a', 'b', 'd']);
    expect(reordered.get('a')).toBe(0);
    expect(reordered.get('b')).toBe(1);
    expect(reordered.get('c')).toBe(2);
    expect(reordered.get('d')).toBe(3);
  });

  it('sin huecos: si una sala desaparece las demas se juntan en el mismo orden', () => {
    const slots = assignSlots(assignSlots(new Map(), ['a', 'b', 'c']), ['a', 'c']);
    expect([...slots.entries()]).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  it('las salas no se solapan y quedan dentro de la base, centrada en el origen (tambien con lugares vacios)', () => {
    const withHoles = [
      [0, 3],
      [3, 5, 8],
      [1, 2, 6],
    ].map((list) => computeLayout(new Map(list.map((s) => [`sala-${s}`, s]))));
    for (const layout of [...[1, 2, 3, 4, 5, 6, 7, 9].map(layoutFor), ...withHoles]) {
      const { bounds } = layout;
      expect(Math.abs(bounds.minX + bounds.maxX)).toBeLessThan(1e-9);
      expect(Math.abs(bounds.minZ + bounds.maxZ)).toBeLessThan(1e-9);
      const rects = layout.rooms.map((r) => toWorldRect(r, ROOM_FOOTPRINT));
      rects.forEach((r, i) => {
        expect(r.minX).toBeGreaterThanOrEqual(bounds.minX);
        expect(r.maxX).toBeLessThanOrEqual(bounds.maxX);
        expect(r.minZ).toBeGreaterThanOrEqual(bounds.minZ);
        expect(r.maxZ).toBeLessThanOrEqual(bounds.maxZ);
        rects.slice(i + 1).forEach((other) => expect(rectsOverlap(r, other)).toBe(false));
      });
      layout.laneX.forEach((x) => expect(x).toBeGreaterThan(bounds.minX));
      layout.hallZ.forEach((z) => expect(z).toBeLessThan(bounds.maxZ));
    }
  });
});

describe('puestos y muebles', () => {
  it('hay escritorio de lider y 6 puestos', () => {
    expect(DESKS.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(DESKS.filter((d) => d.kind === 'lead')).toHaveLength(1);
  });

  it('escritorios, sillas, plantas y lamparas no se solapan entre si ni con paredes (las 3 decoraciones)', () => {
    for (const decor of [0, 1, 2]) {
      const obstacles = roomObstacles(decor);
      for (let i = 0; i < obstacles.length; i++) {
        for (let j = i + 1; j < obstacles.length; j++) {
          const a = obstacles[i];
          const b = obstacles[j];
          if (!a || !b) continue;
          const [kindA, idA] = a.name.split(':');
          const [kindB, idB] = b.name.split(':');
          // las paredes se tocan en la esquina; un escritorio y su propia silla pueden rozarse
          if (kindA === 'wall' && kindB === 'wall') continue;
          const ownChair = idA !== undefined && idA === idB && new Set([kindA, kindB]).size === 2 && kindA !== 'wall' && kindB !== 'wall';
          if (ownChair) continue;
          expect(rectsOverlap(a.rect, b.rect), `decor ${decor}: ${a.name} con ${b.name}`).toBe(false);
        }
      }
    }
  });

  it('todo puesto queda dentro del interior de la sala', () => {
    for (const d of DESKS) {
      for (const r of [rectAround(d.x, d.z, d.w, d.d), chairRect(d)]) {
        expect(r.minX).toBeGreaterThanOrEqual(ROOM_INTERIOR.minX);
        expect(r.maxX).toBeLessThanOrEqual(ROOM_INTERIOR.maxX);
        expect(r.minZ).toBeGreaterThanOrEqual(ROOM_INTERIOR.minZ);
        expect(r.maxZ).toBeLessThanOrEqual(ROOM_INTERIOR.maxZ);
      }
    }
  });
});

describe('caminos dentro de la sala', () => {
  const targets = [...DESKS.map((d) => seatNode(d.index)), ...OVERFLOW_SLOTS.map((_, i) => slotNode(i)), NODE.coffee];
  const obstacles = [0, 1, 2].flatMap((decor) => roomObstacles(decor).filter((o) => decor === 0 || !o.name.includes(':')));

  it('desde la puerta se llega a cada puesto, a la pizarra y a la cafetera', () => {
    for (const target of targets) {
      const path = findPath(ROOM_NAV, NODE.spawn, target);
      expect(path, target).not.toBeNull();
      expect(path?.[0]).toBe(NODE.spawn);
      expect(path?.at(-1)).toBe(target);
    }
  });

  it('los caminos son rectos por ejes y no atraviesan muebles ni paredes', () => {
    for (const target of targets) {
      const ids = findPath(ROOM_NAV, NODE.spawn, target) ?? [];
      const points = pathPoints(ROOM_NAV, ids);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (!a || !b) continue;
        const axisAligned = Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.z - b.z) < 1e-9;
        expect(axisAligned, `${ids[i - 1]} -> ${ids[i]}`).toBe(true);
        const lastLeg = i === points.length - 1 && target.startsWith('seat:');
        const ownChair = lastLeg ? `chair:${target.split(':')[1]}` : null;
        for (const p of samples(a, b)) {
          for (const o of obstacles) {
            if (o.name === ownChair) continue;
            expect(strictlyInside(o.rect, p), `${ids[i - 1]} -> ${ids[i]} cruza ${o.name}`).toBe(false);
          }
        }
      }
    }
    // miles de expect: en una laptop cargada pasa de los 5 s por defecto sin que nada este mal
  }, 30_000);

  it('la puerta esta en la pared izquierda y el camino la cruza por el hueco', () => {
    const out = ROOM_NAV.nodes.get(NODE.doorOut);
    const inside = ROOM_NAV.nodes.get(NODE.doorIn);
    expect(out && inside).toBeTruthy();
    if (!out || !inside) return;
    const wallX = ROOM_INTERIOR.minX - WALL_T / 2;
    expect(out.x).toBeLessThan(wallX);
    expect(inside.x).toBeGreaterThan(wallX);
    expect(out.z).toBe(inside.z);
    expect(out.z).toBeGreaterThan(DOOR.openMin);
    expect(out.z).toBeLessThan(DOOR.openMax);
    for (const wall of WALL_RECTS) expect(strictlyInside(wall, { x: wallX, z: out.z })).toBe(false);
  });
});

describe('pasillos de la oficina', () => {
  it('cada puerta desemboca en el carril de su pasillo y la aparicion esta en el cruce de pasillos', () => {
    const layout = layoutFor(6);
    for (const room of layout.rooms) {
      const lane = ROOM_NAV.nodes.get(NODE.lane);
      const spawn = ROOM_NAV.nodes.get(NODE.spawn);
      if (!lane || !spawn) throw new Error('faltan nodos');
      const laneWorld = toWorld(room, lane);
      const spawnWorld = toWorld(room, spawn);
      expect(laneWorld.x).toBeCloseTo(layout.laneX[room.col] ?? NaN, 9);
      expect(spawnWorld.x).toBeCloseTo(layout.laneX[room.col] ?? NaN, 9);
      expect(spawnWorld.z).toBeCloseTo(layout.hallZ[room.row] ?? NaN, 9);
      // el carril vertical queda en el hueco entre la sala de la izquierda y la pared de esta
      const own = toWorldRect(room, ROOM_FOOTPRINT);
      expect(laneWorld.x).toBeLessThan(own.minX);
      const leftNeighbor = layout.rooms.find((r) => r.row === room.row && r.col === room.col - 1);
      if (leftNeighbor) expect(laneWorld.x).toBeGreaterThan(toWorldRect(leftNeighbor, ROOM_FOOTPRINT).maxX);
      // el pasillo horizontal corre delante de la fila, fuera de las salas
      expect(spawnWorld.z).toBeGreaterThan(own.maxZ);
    }
  });

  it('el lider puede ir de cualquier escritorio de lider a cualquier otro sin atravesar paredes', () => {
    const layout = layoutFor(5);
    const g = buildOfficeNav(layout);
    const walls = layout.rooms.flatMap((r) => WALL_RECTS.map((w) => toWorldRect(r, w)));
    for (const a of layout.rooms) {
      for (const b of layout.rooms) {
        const ids = findPath(g, officeNode(a.id, seatNode(0)), officeNode(b.id, seatNode(0)));
        expect(ids, `${a.id} -> ${b.id}`).not.toBeNull();
        const pts = pathPoints(g, ids ?? []);
        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          if (!p0 || !p1) continue;
          for (const p of samples(p0, p1)) for (const w of walls) expect(strictlyInside(w, p)).toBe(false);
        }
      }
    }
    expect(g.nodes.has(laneNode(0, 0))).toBe(true);
    // 25 rutas muestreadas contra todas las paredes: pesada con la maquina cargada
  }, 30_000);

  it('con la losa escalonada (3 y 5 salas) el lider llega de una sala a cualquier otra sin pisar el vacio', () => {
    // lugares con huecos: se usan en orden, asi que quedan 3 salas en L
    const layout = computeLayout(new Map([['sala-0', 0], ['sala-3', 3], ['sala-4', 4]]));
    const g = buildOfficeNav(layout);
    expect(g.nodes.has(laneNode(1, 1))).toBe(false);
    for (const five of [layoutFor(5)]) {
      const g5 = buildOfficeNav(five);
      expect(g5.nodes.has(laneNode(2, 1))).toBe(false);
      for (const a of five.rooms) {
        for (const b of five.rooms) {
          expect(findPath(g5, officeNode(a.id, seatNode(0)), officeNode(b.id, seatNode(0)))).not.toBeNull();
        }
      }
    }
    for (const a of layout.rooms) {
      for (const b of layout.rooms) {
        expect(findPath(g, officeNode(a.id, seatNode(0)), officeNode(b.id, seatNode(0))), `${a.id} -> ${b.id}`).not.toBeNull();
      }
    }
    // busca caminos entre todas las salas de cada tamano de oficina: igual que arriba, tarda en una laptop cargada
  }, 30_000);
});

describe('actores', () => {
  it('un agente camina de la puerta a su silla, se sienta y mira al monitor', () => {
    const actor = createActor('a1', ROOM_NAV.nodes.get(NODE.spawn) ?? { x: 0, z: 0 });
    actor.lastNode = NODE.spawn;
    expect(routeTo(actor, ROOM_NAV, seatNode(5), { endHeading: FACE_BACK, sit: true })).toBe(true);
    for (let i = 0; i < 60 * 20; i++) stepActor(actor, 1 / 60);
    const seat = ROOM_NAV.nodes.get(seatNode(5));
    expect(actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(actor.pos.z).toBeCloseTo(seat?.z ?? NaN, 6);
    expect(actor.sit).toBe(1);
    expect(Math.cos(actor.heading - FACE_BACK)).toBeGreaterThan(0.99);
  });

  const agent = (id: string, deskIndex: number, status: OfficeAgent['status'] = 'working'): OfficeAgent => ({
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: 'Bruno',
    status,
    task: null,
    action: null,
    model: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
    deskIndex,
  });
  const roomWith = (subagents: OfficeAgent[]): OfficeRoom => ({
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

  it('el primer snapshot sienta a todos; los nuevos entran por la puerta; los que terminan salen', () => {
    const crew = createCrew();
    const placed = new Set(['r1']);
    expect(reconcileCrew(crew, [roomWith([agent('a', 1), agent('b', -1)])], placed)).toBe(true);
    expect(crew.members.get('a')?.actor.sit).toBe(1);
    expect(crew.members.get('b')?.targetNode).toBe(slotNode(0));

    reconcileCrew(crew, [roomWith([agent('a', 1), agent('b', -1), agent('c', 2)])], placed);
    const c = crew.members.get('c')?.actor;
    expect(c?.phase).toBe('entering');
    expect(c?.lastNode).toBe(NODE.spawn);

    reconcileCrew(crew, [roomWith([agent('a', 1, 'done'), agent('c', 2)])], placed);
    expect(crew.members.get('a')?.actor.phase).toBe('leaving');
    expect(crew.members.get('a')?.actor.hop).toBeGreaterThan(0);
    expect(crew.members.get('b')?.actor.phase).toBe('leaving');

    // la sala se cierra del todo: sus personajes se quitan sin animacion
    expect(reconcileCrew(crew, [], new Set())).toBe(true);
    expect(crew.members.size).toBe(0);
  });

  it('el lider se sienta en su sala y camina a otra cuando cambia la sala del ultimo prompt', () => {
    const layout = layoutFor(3);
    const g = buildOfficeNav(layout);
    const ctl = createLead();
    updateLead(ctl, layout, g, leadTarget(layout, 'sala-0'));
    expect(ctl.actor.sit).toBe(1);
    updateLead(ctl, layout, g, leadTarget(layout, 'sala-2'));
    expect(ctl.actor.route.length).toBeGreaterThan(4);
    for (let i = 0; i < 60 * 40; i++) stepActor(ctl.actor, 1 / 60);
    const seat = g.nodes.get(officeNode('sala-2', seatNode(0)));
    expect(ctl.actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(ctl.actor.sit).toBe(1);
    // sin sala: sentado en el escritorio de lider de la primera sala, con la taza
    expect(leadTarget(layout, null)).toMatchObject({ node: officeNode('sala-0', seatNode(0)), mug: true, dest: { sit: true } });
  });
});

describe('estilos de sala', () => {
  it('cada bloque de tres lugares lleva los tres estilos y el mismo lugar da siempre el mismo', () => {
    for (let block = 0; block < 8; block++) {
      const ids = [0, 1, 2].map((i) => themeOfSlot(block * 3 + i).id);
      expect(new Set(ids).size).toBe(3);
    }
    expect(themeOfSlot(7).id).toBe(themeOfSlot(7).id);
    expect(themeOfSlot(-1).id).toBe(themeOfSlot(0).id);
  });

  it('las alfombras de cada estilo existen en el atlas', () => {
    for (const th of Object.values(THEMES)) {
      for (const r of th.rugs) {
        expect(RUGS[r]).toBeDefined();
        expect(LIT_UV.rugs[r]).toBeDefined();
      }
    }
  });
});

describe('placa del escritorio del lider', () => {
  const PLATE_W = 48;
  const PLATE_H = 10;

  /** pixeles RGBA de la placa, fila 0 arriba */
  function platePixels(data: Uint8Array, bw: number, bh: number, x: number, y: number): number[] {
    const out: number[] = [];
    for (let py = 0; py < PLATE_H; py++) {
      const row = bh - 1 - (y + py);
      for (let px = 0; px < PLATE_W; px++) {
        const i = (row * bw + x + px) * 4;
        out.push(data[i] ?? -1, data[i + 1] ?? -1, data[i + 2] ?? -1, data[i + 3] ?? -1);
      }
    }
    return out;
  }

  function painted(text: string): number[] {
    const g = Raster.create(PLATE_W, PLATE_H);
    paintPlate(g, PLATE_W, PLATE_H, text);
    return platePixels(g.data, PLATE_W, PLATE_H, 0, 0);
  }

  function inAtlas(): number[] {
    const img = litAtlas.image as { data: Uint8Array; width: number; height: number };
    const [u0, , , v1] = LIT_UV.plate;
    const x = Math.round(u0 * img.width);
    const y = Math.round((1 - v1) * img.height);
    return platePixels(img.data, img.width, img.height, x, y);
  }

  it('la fuente pixel solo tiene A-Z: sin tildes, en mayusculas y sin lo que no sabe dibujar', () => {
    expect(plateText('Líder')).toBe('LIDER');
    expect(plateText('José Ñúñez')).toBe('JOSE NUNEZ');
    expect(plateText('  ana   maría \u{1F41D} ')).toBe('ANA MARIA');
    expect(plateText('Zoë-Ann')).toBe('ZOE-ANN');
    expect(plateText('李小龙')).toBe('');
    // sin nada dibujable queda el nombre por defecto
    expect(leadPlateText('李小龙')).toBe('LIDER');
    expect(leadPlateText('\u{1F41D}')).toBe('LIDER');
    // lo largo lo recorta fitText (48 px de placa, 2 de margen por lado)
    expect(fitText(plateText('Maximiliano Alejandro'), PLATE_W - 4)).toBe('MAXIMILIANO');
    // lo que la fuente no dibuja no ocupa lugar en la placa
    expect(painted('Ana María \u{1F41D}')).toEqual(painted('ANA MARIA'));
  });

  it('se repinta en caliente con el nombre nuevo y solo cuando cambia', () => {
    paintLeadPlate('Líder');
    expect(inAtlas()).toEqual(painted('LIDER'));
    paintLeadPlate('Ana');
    expect(inAtlas()).toEqual(painted('ANA'));
    const version = litAtlas.version;
    // mismo texto en la placa: no toca la textura
    paintLeadPlate('ana');
    expect(litAtlas.version).toBe(version);
    paintLeadPlate('Líder');
    expect(inAtlas()).toEqual(painted('LIDER'));
    expect(litAtlas.version).toBeGreaterThan(version);
  });
});

describe('dia y noche', () => {
  it('mediodia claro sin lamparas; noche con lamparas y estrellas; atardecer calido', () => {
    const noon = dayStateAt(12);
    expect(noon.daylight).toBe(1);
    expect(noon.lampsOn).toBe(false);
    const night = dayStateAt(22);
    expect(night.daylight).toBe(0);
    expect(night.lampsOn).toBe(true);
    expect(night.night).toBeGreaterThan(0.9);
    expect(dayStateAt(18.5).dusk).toBeGreaterThan(0.5);
    expect(dayStateAt(5).lampsOn).toBe(true);
  });

  it('sin ?hora la luz sigue la hora real, o la que fija el control de hora', () => {
    expect(getTimeMode()).toBe('auto');
    expect(currentHour()).toBe(clockHourNow());
    setTimeMode('noche');
    expect(currentHour()).toBe(TIME_MODE_HOUR.noche);
    const night = dayStateAt(currentHour(), 9.5);
    expect(night.lampsOn).toBe(true);
    expect(night.night).toBeGreaterThan(0.9);
    expect(night.stars).toBeGreaterThan(0.9);
    // el reloj de pared no se mueve con el control: marca la hora real
    expect(night.clockHour).toBe(9.5);
    setTimeMode('dia');
    expect(dayStateAt(currentHour()).daylight).toBe(1);
    setTimeMode('atardecer');
    expect(dayStateAt(currentHour()).dusk).toBeGreaterThan(0.5);
    setTimeMode('auto');
    expect(currentHour()).toBe(clockHourNow());
  });
});

describe('snapshot de demostracion', () => {
  it('tiene 3 salas ficticias, una cerrada, y varios estados', () => {
    const snap = createMockSnapshot(Date.UTC(2026, 0, 1, 10, 0, 30));
    expect(snap.rooms).toHaveLength(3);
    expect(snap.rooms.filter((r) => !r.open)).toHaveLength(1);
    const subs = snap.rooms.flatMap((r) => r.subagents);
    const statuses = new Set(subs.map((a) => a.status));
    expect(statuses.has('working')).toBe(true);
    expect(statuses.has('idle')).toBe(true);
    expect(subs.some((a) => a.status === 'working' && a.action === null)).toBe(true);
    for (const a of subs) expect(a.deskIndex === -1 || (a.deskIndex >= 1 && a.deskIndex <= 6)).toBe(true);
    for (const r of snap.rooms) expect(r.cwd.startsWith('/demo')).toBe(true);
    expect(snap.leadRoomId).not.toBeNull();
  });

  it('un agente entra y termina a lo largo del ciclo', () => {
    const base = Date.UTC(2026, 0, 1, 10, 0, 0);
    const at = (s: number) => createMockSnapshot(base + s * 1000).rooms[0]?.subagents.find((a) => a.agentType === 'Plan');
    expect(at(5)).toBeUndefined();
    expect(at(30)?.status).toBe('working');
    expect(at(64)?.status).toBe('done');
    expect(at(80)).toBeUndefined();
  });
});

describe('suelo', () => {
  it('la plataforma de la sala cubre el interior', () => {
    expect(insideRect(ROOM_FOOTPRINT, 0, 0)).toBe(true);
    expect(insideRect(ROOM_FOOTPRINT, ROOM_INTERIOR.minX - 1, 0)).toBe(false);
  });
});
