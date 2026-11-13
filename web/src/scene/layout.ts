// Distribucion de la oficina: salas en grilla, puestos, puertas, pasillos y grafo de caminos.
// Todo es puro (sin three ni React) para poder probarlo.
//
// Ejes: la camara mira desde +x +z hacia el origen. Cada sala tiene paredes al fondo (-z) y a la
// izquierda (-x); los lados +x y +z quedan abiertos para ver dentro. La puerta esta en la pared
// izquierda, junto a la esquina delantera, y da a un pasillo vertical; delante de cada fila de salas
// corre un pasillo horizontal. Los agentes caminan por carriles en esos pasillos.
//
// Distribucion v2 ("Estudio nocturno v2"): los agentes se sientan DETRAS de su escritorio y miran a
// la camara (+z), asi se les ven las caras; el monitor queda del lado de la camara mirando al agente.
// Dentro de la sala se camina por un corredor junto a la pared izquierda (WALKWAY_X), un pasillo
// delante de los escritorios (fila de la puerta), uno entre las dos filas (MID_AISLE_Z) y otro detras
// (BACK_AISLE_Z); a cada silla se llega por el hueco entre escritorios.

import { MEETING_BACK_Z, MEETING_LANE_X, REVIEW_LANE_X, RIGHT_LANE_X, ZONE_LIST, ZONE_PROPS, type ZoneLane } from './zones';

export interface Vec2 {
  x: number;
  z: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const ROOM_W = 7.2;
export const ROOM_D = 6;
export const WALL_T = 0.2;
export const WALL_H = 1.6;
export const CORRIDOR_W = 2;
export const HALL_D = 2.4;
/** alto del piso de la sala sobre el piso del pasillo */
export const PLATFORM_H = 0.06;
export const PITCH_X = CORRIDOR_W + WALL_T + ROOM_W;
export const PITCH_Z = WALL_T + ROOM_D + HALL_D;

/** alto de la cubierta de los escritorios (sobre el piso de la sala) */
export const DESK_H = 0.75;
/** alto del asiento de las sillas (sobre el piso de la sala); la cadera sentada queda a SEAT_H + 0.05 */
export const SEAT_H = 0.45;

const HALF_W = ROOM_W / 2;
const HALF_D = ROOM_D / 2;
const RIGHT_MARGIN = 1.1;
const BACK_MARGIN = 0.6;

/** carril del pasillo vertical (lejos de la pared que lo tapa), local a la sala */
export const LANE_X = -(HALF_W + WALL_T + CORRIDOR_W) + 0.55;
/** carril del pasillo horizontal: por el centro del pasillo delante de la fila, local a la sala */
export const HALL_Z = HALF_D + HALL_D / 2;
/** hueco de la puerta en la pared izquierda */
export const DOOR = { z: 2.51, openMin: 2.1, openMax: 2.92, height: 1.25 } as const;
/** corredor interior junto a la pared izquierda (a la izquierda del escritorio de lider) */
export const WALKWAY_X = -2.75;
export const MID_AISLE_Z = 0.62;
export const BACK_AISLE_Z = -1.32;

/** mirando hacia la pared del fondo (-z) */
export const FACE_BACK = Math.PI;
/** mirando hacia la pared izquierda (-x) */
export const FACE_LEFT = -Math.PI / 2;
/** mirando a la camara (+z) */
export const FACE_FRONT = 0;
/** v2: todo agente sentado mira a la camara */
export const SEAT_HEADING = FACE_FRONT;
/** de pie en el desborde, mirando hacia la pared izquierda */
export const OVERFLOW_HEADING = FACE_LEFT;
/** el lider con su taza frente al ventanal, girado hacia la camara (kit: spots.coffee.rotY) */
export const COFFEE_HEADING = 0.45;

/** seatOffset: z del asiento respecto del centro del escritorio (negativo = detras, v2) */
export const DESK_SIZE = { w: 1.2, d: 0.62, h: DESK_H, seatOffset: -0.52 } as const;
export const LEAD_DESK_SIZE = { x: -1.5, z: -2.0, w: 1.9, d: 0.75, h: DESK_H, seatOffset: -0.58 } as const;
export const DESK_ROWS_Z = [-0.25, 1.75] as const;
export const DESK_COLS_X = [-0.9, 0.75, 2.4] as const;
/** carril de acceso a cada silla: centro del hueco entre escritorios */
const SIDE_DX = -0.825;

/**
 * Desborde: de pie para subagentes sin escritorio (deskIndex -1) o sin plaza libre en su zona. Huecos
 * que dejan las zonas (zones.ts): junto al laboratorio, a la derecha del puesto 3 y junto a la biblioteca.
 */
export const OVERFLOW_SLOTS: readonly Vec2[] = [
  { x: -2.25, z: -0.9 },
  { x: 3.36, z: -0.35 },
  { x: 2.95, z: -1.0 },
  { x: -2.25, z: 1.0 },
];
/** carril por el que se llega a cada lugar de desborde */
export const OVERFLOW_LANES: readonly ZoneLane[] = ['walkway', 'right', 'back', 'walkway'];
/** donde toma cafe el lider cuando no hay sala con su ultimo prompt */
export const COFFEE_SPOT: Vec2 = { x: 1.0, z: -2.3 };

/** Muebles comunes a todas las salas (coordenadas locales, piso de la sala en y = 0) */
export const PROPS = {
  /** ventanal de tres hojas en la pared del fondo */
  window: { x0: -0.4, x1: 2.2, y0: 0.62, y1: 1.5 },
  clock: { x: -2.0, y: 1.3 },
  /** alfombra bajo los puestos */
  rug: { minX: -1.8, maxX: 3.3, minZ: -1.2, maxZ: 2.65 },
  /**
   * hoja de la puerta abierta (77 grados), bisagra en la jamba delantera (x -3,63, z 2,92): lo que
   * ocupa dentro de la sala (la bisagra queda embutida en la pared)
   */
  doorLeaf: { minX: -HALF_W, maxX: -2.82, minZ: 2.67, maxZ: DOOR.openMax },
  /** cartel de sala sobre la pared, encima de la puerta */
  sign: { x: -HALF_W - WALL_T / 2 + 0.015, y: WALL_H + 0.04, z: DOOR.z },
} as const;

/** lampara de pie de lectura (todas las decoraciones): margen derecho, junto al puesto 6 */
export const FLOOR_LAMP: Vec2 = { x: 3.35, z: 1.85 };
const FLOOR_LAMP_RECT: Rect = rectAround(FLOOR_LAMP.x, FLOOR_LAMP.z, 0.32, 0.32);

/**
 * Muebles de piso propios de cada decoracion (0 Biblioteca, 1 Taller, 2 Cafeteria); los arma world/room.ts.
 * Los de las zonas (banco, estanteria, cafe, reunion, revision) son de todas: ZONE_PROPS en zones.ts.
 */
export const DECOR_PROPS: readonly { name: string; rect: Rect }[][] = [
  [
    { name: 'plant-corner', rect: { minX: -3.4, maxX: -3.0, minZ: -2.82, maxZ: -2.42 } },
    { name: 'plant-front', rect: { minX: 3.1, maxX: 3.4, minZ: 2.45, maxZ: 2.75 } },
    { name: 'floor-lamp', rect: FLOOR_LAMP_RECT },
  ],
  [
    { name: 'water-dispenser', rect: { minX: -3.54, maxX: -3.1, minZ: -2.92, maxZ: -2.48 } },
    { name: 'plant-front', rect: { minX: 3.0, maxX: 3.4, minZ: 2.35, maxZ: 2.75 } },
    { name: 'floor-lamp', rect: FLOOR_LAMP_RECT },
  ],
  [
    { name: 'plant-corner', rect: { minX: -3.4, maxX: -3.0, minZ: -2.82, maxZ: -2.42 } },
    { name: 'plant-front', rect: { minX: 3.1, maxX: 3.4, minZ: 2.45, maxZ: 2.75 } },
    { name: 'floor-lamp', rect: FLOOR_LAMP_RECT },
  ],
];

/** interior de la sala (sin paredes) */
export const ROOM_INTERIOR: Rect = { minX: -HALF_W, maxX: HALF_W, minZ: -HALF_D, maxZ: HALF_D };
/** plataforma de la sala con sus paredes */
export const ROOM_FOOTPRINT: Rect = { minX: -HALF_W - WALL_T, maxX: HALF_W, minZ: -HALF_D - WALL_T, maxZ: HALF_D };

export function insideRect(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---------------------------------------------------------------- puestos

export interface DeskSpec {
  /** 0 = escritorio de lider, 1..6 = puestos */
  index: number;
  kind: 'lead' | 'worker';
  x: number;
  z: number;
  w: number;
  d: number;
  /** donde queda la cadera del agente sentado */
  seat: Vec2;
  /** punto de pie junto a la silla desde donde se desliza al asiento */
  side: Vec2;
  /** hacia donde mira el agente sentado (v2: a la camara) */
  heading: number;
}

function buildDesks(): DeskSpec[] {
  const lead = LEAD_DESK_SIZE;
  const leadSeatZ = lead.z + lead.seatOffset;
  const list: DeskSpec[] = [
    {
      index: 0,
      kind: 'lead',
      x: lead.x,
      z: lead.z,
      w: lead.w,
      d: lead.d,
      seat: { x: lead.x, z: leadSeatZ },
      side: { x: WALKWAY_X, z: leadSeatZ },
      heading: SEAT_HEADING,
    },
  ];
  DESK_ROWS_Z.forEach((z, row) => {
    DESK_COLS_X.forEach((x, col) => {
      const seatZ = z + DESK_SIZE.seatOffset;
      list.push({
        index: 1 + row * 3 + col,
        kind: 'worker',
        x,
        z,
        w: DESK_SIZE.w,
        d: DESK_SIZE.d,
        seat: { x, z: seatZ },
        side: { x: x + SIDE_DX, z: seatZ },
        heading: SEAT_HEADING,
      });
    });
  });
  return list;
}

export const DESKS: readonly DeskSpec[] = buildDesks();

export function deskSpec(index: number): DeskSpec | undefined {
  return DESKS.find((d) => d.index === index);
}

export function rectAround(x: number, z: number, w: number, d: number): Rect {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}

/** silla del kit girada hacia la camara: asiento +-0.21, respaldo detras (hasta -0.3) */
export function chairRect(d: DeskSpec): Rect {
  const half = d.kind === 'lead' ? 0.29 : 0.25;
  return { minX: d.seat.x - half, maxX: d.seat.x + half, minZ: d.seat.z - 0.3, maxZ: d.seat.z + 0.22 };
}

/** paredes de la sala (locales). La pared izquierda tiene el hueco de la puerta. */
export const WALL_RECTS: readonly Rect[] = [
  { minX: -HALF_W - WALL_T, maxX: HALF_W, minZ: -HALF_D - WALL_T, maxZ: -HALF_D },
  { minX: -HALF_W - WALL_T, maxX: -HALF_W, minZ: -HALF_D - WALL_T, maxZ: DOOR.openMin },
  { minX: -HALF_W - WALL_T, maxX: -HALF_W, minZ: DOOR.openMax, maxZ: HALF_D },
];

export interface Obstacle {
  name: string;
  rect: Rect;
}

/** Todo lo que un agente no deberia atravesar dentro de una sala con la decoracion dada (locales) */
export function roomObstacles(decor = 0): Obstacle[] {
  const list: Obstacle[] = [];
  for (const d of DESKS) {
    list.push({ name: `desk:${d.index}`, rect: rectAround(d.x, d.z, d.w, d.d) });
    list.push({ name: `chair:${d.index}`, rect: chairRect(d) });
  }
  WALL_RECTS.forEach((rect, i) => list.push({ name: `wall:${i}`, rect }));
  list.push({ name: 'door-leaf', rect: PROPS.doorLeaf });
  for (const p of ZONE_PROPS) list.push({ name: p.name, rect: p.rect });
  for (const p of DECOR_PROPS[decor] ?? []) list.push({ name: p.name, rect: p.rect });
  return list;
}

// ---------------------------------------------------------------- grafo de caminos

export interface NavGraph {
  nodes: Map<string, Vec2>;
  edges: Map<string, Set<string>>;
}

export function createGraph(): NavGraph {
  return { nodes: new Map(), edges: new Map() };
}

export function addNode(g: NavGraph, id: string, p: Vec2): void {
  g.nodes.set(id, { x: p.x, z: p.z });
  if (!g.edges.has(id)) g.edges.set(id, new Set());
}

export function link(g: NavGraph, a: string, b: string): void {
  const ea = g.edges.get(a);
  const eb = g.edges.get(b);
  if (!ea || !eb) throw new Error(`Nodo de navegacion inexistente: ${ea ? b : a}`);
  ea.add(b);
  eb.add(a);
}

function chain(g: NavGraph, ids: readonly string[]): void {
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1];
    const b = ids[i];
    if (a !== undefined && b !== undefined) link(g, a, b);
  }
}

export const NODE = {
  spawn: 'spawn',
  lane: 'lane',
  doorOut: 'door-out',
  doorIn: 'door-in',
  coffee: 'coffee',
} as const;

export const seatNode = (deskIndex: number): string => `seat:${deskIndex}`;
export const sideNode = (deskIndex: number): string => `side:${deskIndex}`;
export const slotNode = (slot: number): string => `slot:${slot}`;

/** punto donde una plaza toca su carril: un tramo recto por un eje */
function viaOf(lane: ZoneLane, p: Vec2): Vec2 {
  switch (lane) {
    case 'walkway':
      return { x: WALKWAY_X, z: p.z };
    case 'back':
      return { x: p.x, z: BACK_AISLE_Z };
    case 'right':
      return { x: RIGHT_LANE_X, z: p.z };
    case 'review':
      return { x: REVIEW_LANE_X, z: p.z };
    case 'meetingBack':
      return { x: p.x, z: MEETING_BACK_Z };
  }
}

/**
 * Carriles: corredor de la pared izquierda (de la puerta al escritorio de lider), pasillo de adelante,
 * del medio (hasta el carril de revision) y de atras (hasta el margen derecho), carril de revision,
 * carril del margen derecho, bajada a la reunion y pasillo detras de sus sillas. Cada plaza (zonas y
 * desborde) cuelga de su carril con un tramo recto; cada carril une en orden todo lo que cae sobre el.
 */
function buildRoomNav(): NavGraph {
  const g = createGraph();
  addNode(g, NODE.spawn, { x: LANE_X, z: HALL_Z });
  addNode(g, NODE.lane, { x: LANE_X, z: DOOR.z });
  addNode(g, NODE.doorOut, { x: -HALF_W - WALL_T - 0.55, z: DOOR.z });
  addNode(g, NODE.doorIn, { x: -HALF_W + 0.4, z: DOOR.z });
  chain(g, [NODE.spawn, NODE.lane, NODE.doorOut, NODE.doorIn]);

  // nodos interiores por posicion: dos cosas en el mismo punto comparten nodo
  const byPos = new Map<string, string>();
  const put = (id: string, p: Vec2): string => {
    const key = `${p.x.toFixed(3)}|${p.z.toFixed(3)}`;
    const hit = byPos.get(key);
    if (hit !== undefined) return hit;
    addNode(g, id, p);
    byPos.set(key, id);
    return id;
  };
  const along = (axis: 'x' | 'z', value: number) => {
    const other = axis === 'x' ? 'z' : 'x';
    const ids = [...byPos.values()].filter((id) => Math.abs((g.nodes.get(id)?.[axis] ?? NaN) - value) < 1e-6);
    ids.sort((a, b) => (g.nodes.get(a)?.[other] ?? 0) - (g.nodes.get(b)?.[other] ?? 0));
    chain(g, ids);
  };

  const leadSeatZ = LEAD_DESK_SIZE.z + LEAD_DESK_SIZE.seatOffset;
  put('walk:front', { x: WALKWAY_X, z: DOOR.z });
  put('walk:mid', { x: WALKWAY_X, z: MID_AISLE_Z });
  put('walk:back', { x: WALKWAY_X, z: BACK_AISLE_Z });
  put(sideNode(0), { x: WALKWAY_X, z: leadSeatZ });
  link(g, NODE.doorIn, 'walk:front');
  DESK_COLS_X.forEach((x, col) => {
    put(`front:${col}`, { x: x + SIDE_DX, z: DOOR.z });
    put(`mid:${col}`, { x: x + SIDE_DX, z: MID_AISLE_Z });
  });
  put('back:coffee', { x: COFFEE_SPOT.x, z: BACK_AISLE_Z });
  // cruces de los carriles de las zonas
  put('mid:review', { x: REVIEW_LANE_X, z: MID_AISLE_Z });
  put('back:right', { x: RIGHT_LANE_X, z: BACK_AISLE_Z });
  put('back:meet', { x: MEETING_LANE_X, z: BACK_AISLE_Z });
  put('meet:corner', { x: MEETING_LANE_X, z: MEETING_BACK_Z });

  for (const d of DESKS) {
    put(seatNode(d.index), d.seat);
    if (d.kind === 'lead') {
      link(g, sideNode(0), seatNode(0));
      continue;
    }
    // ambas filas se alcanzan desde el pasillo del medio por el hueco a la izquierda del escritorio
    const col = (d.index - 1) % 3;
    put(sideNode(d.index), d.side);
    link(g, `mid:${col}`, sideNode(d.index));
    link(g, sideNode(d.index), seatNode(d.index));
  }
  // el hueco de cada columna tambien une el pasillo de adelante con el del medio
  DESK_COLS_X.forEach((_, col) => link(g, `front:${col}`, sideNode(4 + col)));

  // plazas de las zonas (la de cafe del lider es NODE.coffee) y lugares de desborde
  const hops: { id: string; p: Vec2; lane: ZoneLane }[] = [
    ...ZONE_LIST.flatMap((zone) => zone.plazas.map((p) => ({ id: p.node, p, lane: p.lane }))),
    ...OVERFLOW_SLOTS.map((p, i) => ({ id: slotNode(i), p, lane: OVERFLOW_LANES[i] ?? 'walkway' })),
  ];
  for (const h of hops) {
    const id = put(h.id, h.p);
    const via = put(`via:${h.id}`, viaOf(h.lane, h.p));
    if (via !== id) link(g, via, id);
  }

  along('x', WALKWAY_X);
  along('z', DOOR.z);
  along('z', MID_AISLE_Z);
  along('z', BACK_AISLE_Z);
  along('x', REVIEW_LANE_X);
  along('x', RIGHT_LANE_X);
  along('x', MEETING_LANE_X);
  along('z', MEETING_BACK_Z);
  return g;
}

/** Grafo de caminos de una sala (local; igual para todas las salas y decoraciones) */
export const ROOM_NAV: NavGraph = buildRoomNav();

/** Dijkstra sobre el grafo; null si no hay camino */
export function findPath(g: NavGraph, from: string, to: string): string[] | null {
  if (!g.nodes.has(from) || !g.nodes.has(to)) return null;
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    const p = g.nodes.get(cur);
    if (!p) return null;
    for (const nb of g.edges.get(cur) ?? []) {
      const q = g.nodes.get(nb);
      if (!q || done.has(nb)) continue;
      const nd = best + distance(p, q);
      if (nd < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, nd);
        prev.set(nb, cur);
      }
    }
  }
  const path = [to];
  let c = to;
  while (c !== from) {
    const p = prev.get(c);
    if (p === undefined) return null;
    path.push(p);
    c = p;
  }
  return path.reverse();
}

export function pathPoints(g: NavGraph, ids: readonly string[]): Vec2[] {
  const out: Vec2[] = [];
  for (const id of ids) {
    const p = g.nodes.get(id);
    if (p) out.push({ x: p.x, z: p.z });
  }
  return out;
}

export function pathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += distance(a, b);
  }
  return total;
}

export function nearestNode(g: NavGraph, p: Vec2): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, q] of g.nodes) {
    const d = distance(p, q);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------- oficina

export interface RoomPlacement {
  id: string;
  slot: number;
  col: number;
  row: number;
  /** centro del interior de la sala, en coordenadas de mundo */
  center: Vec2;
}

export interface OfficeLayout {
  cols: number;
  rows: number;
  rooms: RoomPlacement[];
  byId: Map<string, RoomPlacement>;
  /** caja de la oficina (pasillos incluidos); la losa real son las franjas de rowRects */
  bounds: Rect;
  /** franja de losa de cada fila: termina en la ultima sala de la fila (sin espacio vacio de oficina) */
  rowRects: Rect[];
  /** salas de cada fila (seguidas desde la columna 0) */
  rowCols: number[];
  /** salas de cada columna (seguidas desde la fila 0) */
  colRows: number[];
  /** x del carril de cada pasillo vertical */
  laneX: number[];
  /** z del carril de cada pasillo horizontal */
  hallZ: number[];
  /** cambia cuando cambia la grilla o una sala se mueve */
  key: string;
}

/**
 * Celda fija de cada lugar, sin importar cuantas salas haya (asi una sala nunca cambia de sitio). La grilla
 * crece a lo ancho y luego a lo alto: 1x1, 2x1, 2x2, 3x2, 3x3, 4x3... Lugares 0-3 = 2x2, 4-5 = tercera
 * columna, 6-8 = tercera fila.
 */
export function cellOf(slot: number): { col: number; row: number } {
  const s = Math.max(0, Math.floor(slot));
  if (s === 0) return { col: 0, row: 0 };
  let w = 1;
  let h = 1;
  let start = 1;
  for (;;) {
    if (w === h) {
      if (s < start + h) return { col: w, row: s - start };
      start += h;
      w++;
    } else {
      if (s < start + w) return { col: s - start, row: h };
      start += w;
      h++;
    }
  }
}

/**
 * Lugar de cada sala, sin huecos (0..N-1) y en el mismo orden relativo. `fixed` es el que asigna el server
 * (se guarda en la DB) y manda; sin el (demo) vale el que ya tenia en esta pagina. Las nuevas van al final;
 * si una sala sale, las que venian despues avanzan un lugar.
 */
export function assignSlots(
  prev: ReadonlyMap<string, number>,
  ids: readonly string[],
  fixed: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const unique = ids.filter((id, i) => ids.indexOf(id) === i);
  const rank = (id: string) => fixed.get(id) ?? prev.get(id);
  const known = unique.filter((id) => rank(id) !== undefined).sort((a, b) => (rank(a) ?? 0) - (rank(b) ?? 0));
  const fresh = unique.filter((id) => rank(id) === undefined);
  return new Map([...known, ...fresh].map((id, i) => [id, i]));
}

/**
 * Salas en las celdas de cellOf segun su orden (aunque lleguen lugares con huecos, se usan en orden). Las
 * celdas de cada fila y de cada columna quedan seguidas desde 0; la losa y los pasillos solo cubren esas
 * celdas (rowCols / colRows), asi no aparece espacio vacio de oficina.
 */
export function computeLayout(slots: ReadonlyMap<string, number>): OfficeLayout {
  const entries = [...slots.entries()].sort((a, b) => a[1] - b[1]);
  const cells = entries.map(([id], i) => ({ id, slot: i, ...cellOf(i) }));
  const cols = Math.max(1, cells.reduce((m, c) => Math.max(m, c.col + 1), 1));
  const rows = Math.max(1, cells.reduce((m, c) => Math.max(m, c.row + 1), 1));
  const rowCols = Array.from({ length: rows }, (_, r) => Math.max(1, cells.filter((c) => c.row === r).length));
  const colRows = Array.from({ length: cols }, (_, c) => Math.max(1, cells.filter((x) => x.col === c).length));
  const raw: Rect = {
    minX: -HALF_W - WALL_T - CORRIDOR_W,
    maxX: (cols - 1) * PITCH_X + HALF_W + RIGHT_MARGIN,
    minZ: -HALF_D - WALL_T - BACK_MARGIN,
    maxZ: (rows - 1) * PITCH_Z + HALF_D + HALL_D,
  };
  const ox = -(raw.minX + raw.maxX) / 2;
  const oz = -(raw.minZ + raw.maxZ) / 2;
  const rooms: RoomPlacement[] = cells.map((c) => ({
    id: c.id,
    slot: c.slot,
    col: c.col,
    row: c.row,
    center: { x: c.col * PITCH_X + ox, z: c.row * PITCH_Z + oz },
  }));
  const laneX = Array.from({ length: cols }, (_, c) => c * PITCH_X + ox + LANE_X);
  const hallZ = Array.from({ length: rows }, (_, r) => r * PITCH_Z + oz + HALL_Z);
  const bounds = { minX: raw.minX + ox, maxX: raw.maxX + ox, minZ: raw.minZ + oz, maxZ: raw.maxZ + oz };
  // una franja de losa por fila: desde el borde izquierdo hasta la ultima sala de esa fila (+ margen)
  const rowRects = rowCols.map((n, r) => ({
    minX: bounds.minX,
    maxX: (n - 1) * PITCH_X + ox + HALF_W + RIGHT_MARGIN,
    minZ: r === 0 ? bounds.minZ : (r - 1) * PITCH_Z + oz + HALF_D + HALL_D,
    maxZ: r * PITCH_Z + oz + HALF_D + HALL_D,
  }));
  return {
    cols,
    rows,
    rooms,
    byId: new Map(rooms.map((r) => [r.id, r])),
    bounds,
    rowRects,
    rowCols,
    colRows,
    laneX,
    hallZ,
    key: `${cols}x${rows}|${rooms.map((r) => `${r.id}@${r.slot}`).join(',')}`,
  };
}

export function toWorld(room: RoomPlacement, p: Vec2): Vec2 {
  return { x: room.center.x + p.x, z: room.center.z + p.z };
}

export function toWorldRect(room: RoomPlacement, r: Rect): Rect {
  return {
    minX: r.minX + room.center.x,
    maxX: r.maxX + room.center.x,
    minZ: r.minZ + room.center.z,
    maxZ: r.maxZ + room.center.z,
  };
}

export const officeNode = (roomId: string, local: string): string => `${roomId}|${local}`;
export const laneNode = (col: number, row: number): string => `I:${col}:${row}`;

/**
 * Grafo de toda la oficina (lo usa el lider para ir de una sala a otra): los grafos de cada sala
 * (sin su nodo de aparicion) unidos por los carriles de los pasillos.
 */
export function buildOfficeNav(layout: OfficeLayout): NavGraph {
  const g = createGraph();
  for (const room of layout.rooms) {
    for (const [id, p] of ROOM_NAV.nodes) {
      if (id !== NODE.spawn) addNode(g, officeNode(room.id, id), toWorld(room, p));
    }
    for (const [a, set] of ROOM_NAV.edges) {
      if (a === NODE.spawn) continue;
      for (const b of set) if (b !== NODE.spawn) link(g, officeNode(room.id, a), officeNode(room.id, b));
    }
  }
  // cruces de pasillo solo donde hay sala: sin celda, ahi no hay losa y el lider caminaria en el aire
  const hasCell = (c: number, r: number) => r < (layout.colRows[c] ?? 0);
  layout.laneX.forEach((x, c) =>
    layout.hallZ.forEach((z, r) => {
      if (hasCell(c, r)) addNode(g, laneNode(c, r), { x, z });
    }),
  );
  for (let c = 0; c < layout.cols; c++) {
    const column = layout.rooms.filter((r) => r.col === c).map((r) => officeNode(r.id, NODE.lane));
    for (let r = 0; r < layout.rows; r++) if (hasCell(c, r)) column.push(laneNode(c, r));
    column.sort((a, b) => (g.nodes.get(a)?.z ?? 0) - (g.nodes.get(b)?.z ?? 0));
    chain(g, column);
  }
  for (let r = 0; r < layout.rows; r++) {
    chain(g, layout.laneX.flatMap((_, c) => (hasCell(c, r) ? [laneNode(c, r)] : [])));
  }
  return g;
}

/** altura del piso en un punto local a una sala */
export function localGround(x: number, z: number): number {
  return insideRect(ROOM_FOOTPRINT, x, z) ? PLATFORM_H : 0;
}

/** altura del piso en un punto del mundo */
export function worldGround(layout: OfficeLayout, x: number, z: number): number {
  for (const room of layout.rooms) {
    if (insideRect(ROOM_FOOTPRINT, x - room.center.x, z - room.center.z)) return PLATFORM_H;
  }
  return 0;
}
