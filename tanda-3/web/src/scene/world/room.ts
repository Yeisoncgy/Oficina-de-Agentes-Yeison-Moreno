// Arma la sala del Kit 3D (buildRoom) con la distribucion v2: toda la geometria estatica fusionada en
// una malla por material (toon, lit, piso, cielo, bombillas, charcos de lampara y de luna). Se cachea
// por decoracion, alfombra y estilo (themes.ts), asi 12 salas comparten a lo sumo 27 juegos de geometria.
// Todas las salas traen las zonas (zones.ts): banco de laboratorio y estanteria en la pared izquierda,
// carrito de cafe y mesa de reunion frente al ventanal, mesa de revision en el margen derecho.
// Lo que se mueve (follaje fusionado, hoja de la puerta, vapor, polvo en los conos de luz, focos de la
// guirnalda) se describe aparte.

import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import { Buckets, type KitColor, M4 } from '../builder';
import { DESKS, DOOR, FLOOR_LAMP, LEAD_DESK_SIZE, PROPS, ROOM_D, ROOM_W, WALL_H, WALL_T } from '../layout';
import {
  BOOKSHELF,
  COFFEE_CART,
  LAB_BENCH,
  MEETING_SEAT_Z,
  MEETING_SEATS_X,
  MEETING_TABLE,
  REVIEW_TABLE,
} from '../zones';
import { type DecorId, DIM } from './kit';
import {
  type Bucket,
  bookshelf,
  chair,
  coffeeCart,
  corkboard,
  DESK_ACCENT,
  DOOR_W,
  doorFrame,
  deskLamp,
  floorLamp,
  LEAD_LAMP,
  labBench,
  lampBulb,
  leadDesk,
  meetingChair,
  meetingTable,
  painting,
  REVIEW_LAMP,
  reviewTable,
  roomSignFrame,
  rug,
  wallClock,
  wallPendant,
  wallRun,
  waterDispenser,
  windowPiece,
  WORKER_LAMP,
  workerDesk,
} from './pieces';
import { ivy, mergeFoliage, type PlantKind, type PlantSpot, plantSpot, pot, type PotStyle } from './plants';
import type { RoomTheme } from './themes';

const HW = ROOM_W / 2;
const HD = ROOM_D / 2;
const L = Math.PI / 2;

/** cono de luz de una lampara (vertice en la bombilla, se abre hacia abajo): ahi flota el polvo */
export interface LightCone {
  x: number;
  y: number;
  z: number;
  /** alto del cono */
  h: number;
  /** radio de la base */
  r: number;
}

export interface RoomGeometry {
  meshes: Partial<Record<Bucket, BufferGeometry>>;
  /** follaje de todas las plantas de la sala en una malla (se mece en el shader) */
  foliage: BufferGeometry | null;
  /** fuentes de vapor (tazas y cafetera), locales a la sala */
  steam: [number, number, number][];
  /** conos de luz de las lamparas, locales a la sala */
  cones: LightCone[];
  /** guirnalda de focos sobre la pared del fondo (atributo aIdx por foco) */
  stringLights: BufferGeometry;
}

const cache = new Map<string, RoomGeometry>();

interface PotOpts {
  y?: number;
  ry?: number;
  /** escala del follaje */
  s?: number;
  r?: number;
  h?: number;
  color?: KitColor;
}

/** maceta en el balde toon + follaje de la especie sobre la tierra */
function potted(b: Buckets<Bucket>, plants: PlantSpot[], kind: PlantKind, style: PotStyle, x: number, z: number, o: PotOpts = {}): void {
  const y = o.y ?? 0;
  const ry = o.ry ?? 0;
  let top = 0;
  b.place(M4(x, y, z, ry), () => {
    top = pot(b.geo('toon'), style, o.r, o.h, o.color);
  });
  plants.push(plantSpot(kind, x, y + top, z, ry, o.s ?? 1));
}

function coneOf(p: [number, number, number], h: number, r: number): LightCone {
  return { x: p[0], y: p[1], z: p[2], h, r };
}

/** puntos de la guirnalda: 15 focos de lado a lado, colgando en dos ondas */
export const STRING_BULBS = 15;

const STRING_Z = -HD + 0.12;

function stringY(t: number, drop: number): number {
  return WALL_H - drop - Math.sin(t * Math.PI * 2) * 0.1;
}

function stringLightsGeometry(): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < STRING_BULBS; i++) {
    const t = i / (STRING_BULBS - 1);
    const box = new BoxGeometry(0.035, 0.035, 0.035).toNonIndexed();
    box.translate(-HW + 0.05 + t * 6.9, stringY(t, 0.04), STRING_Z);
    const p = box.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      pos.push(p.getX(k), p.getY(k), p.getZ(k));
      idx.push(i);
      col.push(1, 1, 1);
    }
    box.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('aIdx', new Float32BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Geometria estatica de una sala (piso de la sala en y = 0), cacheada por decoracion, alfombra y estilo */
export function roomGeometry(decor: DecorId, rugVariant: DecorId, th: RoomTheme): RoomGeometry {
  const key = `${decor}:${rugVariant}:${th.id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const b = new Buckets<Bucket>(decor * 101 + rugVariant * 7 + 1);
  const plants: PlantSpot[] = [];
  const steam: [number, number, number][] = [];
  const cones: LightCone[] = [];
  const T = b.geo('toon');
  const FH = DIM.FLOOR_H;

  // plataforma y piso (la textura la pone el material del estilo)
  T.box(-HW - WALL_T, -FH, -HD - WALL_T, HW, -0.002, HD, th.trim);
  b.geo('floor').qy(-HW, -HD, HW, HD, 0, '#ffffff', { uvRect: [-HW / 2, -HD / 2, HW / 2, HD / 2] });

  // paredes: fondo con ventanal, izquierda con puerta; cada una con su tira de luz al pie
  const win = PROPS.window;
  b.place(M4(0, 0, -HD), () => wallRun(b, -HW - WALL_T, HW, [{ a0: win.x0, a1: win.x1, y0: win.y0, y1: win.y1 }], th.neonBack, th));
  b.place(M4(-HW, 0, 0, L), () =>
    wallRun(b, -HD, HD, [{ a0: -(DOOR.z + DOOR_W / 2), a1: -(DOOR.z - DOOR_W / 2), y0: 0, y1: DOOR.height }], th.neonLeft, th),
  );
  b.place(M4((win.x0 + win.x1) / 2, win.y0, -HD), () => windowPiece(b, win.x1 - win.x0, win.y1 - win.y0, th));
  b.place(M4(-HW, 0, DOOR.z, L), () => doorFrame(b, DOOR_W, DOOR.height, th));
  b.place(M4(PROPS.sign.x, PROPS.sign.y, PROPS.sign.z, L), () => roomSignFrame(b, th));
  b.place(M4(PROPS.clock.x, PROPS.clock.y, -HD), () => wallClock(b, th));
  const r = PROPS.rug;
  b.place(M4((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2), () => rug(b, rugVariant, r.maxX - r.minX, r.maxZ - r.minZ, th));

  // alambre de la guirnalda (los focos son una malla aparte que respira)
  for (let i = 1; i < STRING_BULBS; i++) {
    const t0 = (i - 1) / (STRING_BULBS - 1);
    const t1 = i / (STRING_BULBS - 1);
    const x0 = -HW + 0.05 + t0 * 6.9;
    const x1 = -HW + 0.05 + t1 * 6.9;
    const y0 = stringY(t0, 0.02);
    const y1 = stringY(t1, 0.02);
    const len = Math.hypot(x1 - x0, y1 - y0);
    T.boxC((x0 + x1) / 2, (y0 + y1) / 2, STRING_Z, len, 0.008, 0.008, 'ink', { rz: Math.atan2(y1 - y0, x1 - x0) });
  }

  // escritorios, sillas del color del puesto y lamparas (cada una con su nube de polvo)
  for (const d of DESKS) {
    if (d.kind === 'lead') {
      b.place(M4(d.x, 0, d.z), () => {
        const built = leadDesk(b, th);
        for (const [x, y, z] of built.steam) steam.push([d.x + x, y, d.z + z]);
      });
      b.place(M4(d.seat.x, 0, d.seat.z), () => chair(b, true, DESK_ACCENT[0]));
      b.place(M4(d.x + LEAD_LAMP.x, LEAD_DESK_SIZE.h, d.z + LEAD_LAMP.z, LEAD_LAMP.ry), () => deskLamp(b, th));
      const bulb = lampBulb(d.x + LEAD_LAMP.x, LEAD_DESK_SIZE.h, d.z + LEAD_LAMP.z, LEAD_LAMP.ry);
      cones.push(coneOf([bulb.x, bulb.y + 0.1, bulb.z], 0.32, 0.26));
      continue;
    }
    b.place(M4(d.x, 0, d.z), () => {
      const built = workerDesk(b, d.index, th);
      for (const [x, y, z] of built.steam) steam.push([d.x + x, y, d.z + z]);
    });
    b.place(M4(d.seat.x, 0, d.seat.z), () => chair(b, false, DESK_ACCENT[d.index]));
    b.place(M4(d.x + WORKER_LAMP.x, DIM.DESK.h, d.z + WORKER_LAMP.z, WORKER_LAMP.ry), () => deskLamp(b, th));
    const bulb = lampBulb(d.x + WORKER_LAMP.x, DIM.DESK.h, d.z + WORKER_LAMP.z, WORKER_LAMP.ry);
    cones.push(coneOf([bulb.x, bulb.y + 0.1, bulb.z], 0.32, 0.26));
  }

  // colgante de pared entre la esquina y el reloj (todas las salas)
  const pendantX = -2.6;
  b.place(M4(pendantX, 0, -HD), () => {
    const [, y, z] = wallPendant(b, 0.34, 0.3, th);
    cones.push(coneOf([pendantX, y, -HD + z], y - 0.05, 0.5));
  });
  // enredadera entre el reloj y el ventanal
  b.place(M4(0, 0, -HD), () => ivy(b.geo('toon'), -1.55, -0.98, 0.54, 1.45, decor * 13 + 5));

  // zonas (todas las salas; huellas en ZONE_PROPS de zones.ts)
  // laboratorio: banco contra la pared izquierda, del escritorio de lider a la estanteria
  const labZ = (LAB_BENCH.minZ + LAB_BENCH.maxZ) / 2;
  b.place(M4(-HW, 0, labZ, L), () => {
    for (const [x, y, z] of labBench(b, LAB_BENCH.maxZ - LAB_BENCH.minZ, LAB_BENCH.h, th)) steam.push([-HW + z, y, labZ - x]);
  });
  // biblioteca: estanteria de dos cuerpos
  const shelfZ = (BOOKSHELF.minZ + BOOKSHELF.maxZ) / 2;
  b.place(M4(-HW, 0, shelfZ, L), () => bookshelf(b, (BOOKSHELF.maxZ - BOOKSHELF.minZ) / 2, th));
  // rincon de cafe junto a la plaza de cafe del lider
  const cartX = (COFFEE_CART.minX + COFFEE_CART.maxX) / 2;
  b.place(M4(cartX, 0, -HD), () => {
    for (const [x, y, z] of coffeeCart(b, decor === 2, th)) steam.push([cartX + x, y, -HD + z]);
  });
  // mesa de reunion frente al ventanal, sillas del color de los puestos
  const mt = MEETING_TABLE;
  const mx = (mt.minX + mt.maxX) / 2;
  const mz = (mt.minZ + mt.maxZ) / 2;
  b.place(M4(mx, 0, mz), () => {
    for (const [x, y, z] of meetingTable(b, mt.maxX - mt.minX, mt.maxZ - mt.minZ, mt.h, th)) steam.push([mx + x, y, mz + z]);
  });
  MEETING_SEATS_X.forEach((x, i) => {
    b.place(M4(x, 0, MEETING_SEAT_Z), () => meetingChair(b, DESK_ACCENT[(i + 1 + decor) % DESK_ACCENT.length] ?? 'plum', th));
  });
  // mesa de revision en el margen derecho: se revisa de pie mirando a +x (el frente de la mesa va a -x)
  const rt = REVIEW_TABLE;
  const rx = (rt.minX + rt.maxX) / 2;
  const rz = (rt.minZ + rt.maxZ) / 2;
  b.place(M4(rx, 0, rz, -L), () => {
    reviewTable(b, rt.maxZ - rt.minZ, rt.maxX - rt.minX, rt.h, th);
    b.place(M4(REVIEW_LAMP.x, rt.h, REVIEW_LAMP.z, REVIEW_LAMP.ry), () => deskLamp(b, th));
  });
  const reviewBulb = lampBulb(REVIEW_LAMP.x, rt.h, REVIEW_LAMP.z, REVIEW_LAMP.ry);
  cones.push(coneOf([rx - reviewBulb.z, reviewBulb.y + 0.1, rz + reviewBulb.x], 0.32, 0.26));
  // lampara de pie de lectura junto al puesto 6
  b.place(M4(FLOOR_LAMP.x, 0, FLOOR_LAMP.z), () => {
    const [x, y, z] = floorLamp(b, th);
    cones.push(coneOf([FLOOR_LAMP.x + x, y, FLOOR_LAMP.z + z], y - 0.05, 0.55));
  });

  // decoracion: 3 variantes para que las salas no se repitan (huellas en DECOR_PROPS de layout.ts)
  if (decor === 0) {
    // Biblioteca: pothos sobre la estanteria, cuadro junto a la puerta, monstera y lengua de suegra
    potted(b, plants, 'pothos', 'white', -HW + 0.17, shelfZ - 0.05, { y: 1.5, ry: L, r: 0.08, h: 0.12, s: 0.8 });
    b.place(M4(-HW, 0.85, 1.6, L), () => painting(b, 0));
    potted(b, plants, 'monstera', 'terra', -3.2, -2.62, { r: 0.17, h: 0.3 });
    potted(b, plants, 'snake', 'white', 3.25, 2.6, { r: 0.13, h: 0.26 });
  } else if (decor === 1) {
    // Taller: dispensador de agua, corcho con notas junto a la puerta y palmera
    b.place(M4(-3.32, 0, -2.7, 0.3), () => waterDispenser(b));
    b.place(M4(-HW, 0.8, 1.6, L), () => corkboard(b, th));
    potted(b, plants, 'palm', 'basket', 3.2, 2.55, { r: 0.16, h: 0.26 });
    potted(b, plants, 'cactus', 'glaze', -HW + 0.17, shelfZ - 0.25, { y: 1.5, r: 0.07, h: 0.1, s: 0.8, color: 'teal' });
  } else {
    // Cafeteria: carrito con tarta y flores, cuadro junto a la puerta, ficus y helecho
    potted(b, plants, 'flower', 'terra', cartX + 0.34, -HD + 0.1, { y: COFFEE_CART.h, r: 0.06, h: 0.09, s: 0.75 });
    b.place(M4(-HW, 0.85, 1.6, L), () => painting(b, 1));
    potted(b, plants, 'ficus', 'terra', -3.2, -2.62, { r: 0.17, h: 0.3 });
    potted(b, plants, 'fern', 'stone', 3.25, 2.6, { r: 0.13, h: 0.24 });
  }

  // charcos de luna bajo cada hoja del ventanal
  const paneW = (win.x1 - win.x0) / 3;
  for (let i = 0; i < 3; i++) {
    const cx = win.x0 + paneW * (i + 0.5) + 0.2;
    b.geo('moon').qy(cx - 0.45, -2.35 - 0.45, cx + 0.45, -2.35 + 0.45, 0.005, '#ffffff');
  }

  const out: RoomGeometry = { meshes: b.build(), foliage: mergeFoliage(plants), steam, cones, stringLights: stringLightsGeometry() };
  cache.set(key, out);
  return out;
}
