// Zonas de cada sala: biblioteca, laboratorio, mesa de reunion, mesa de revision, rincon de cafe y la
// plaza de la puerta. Aqui viven sus muebles (huella en el piso), las plazas donde se para o se sienta
// un agente y el carril por el que se llega a cada una con un tramo recto. Todo local a la sala y puro
// (sin three ni React). Las 3 decoraciones comparten las zonas; solo cambia lo cosmetico (world/room.ts).
//
// Mapa (camara desde +x +z): pared izquierda = laboratorio (fondo), biblioteca (centro) y puerta
// (adelante); fondo = rincon de cafe (junto a la plaza de cafe del lider) y mesa de reunion frente al
// ventanal; margen derecho entre las filas = mesa de revision.
//
// Sin imports de valores de layout.ts: layout arma el grafo con estas plazas y un ciclo de imports
// dejaria constantes sin inicializar. Por eso los carriles se nombran (ZoneLane) y layout los resuelve.

import type { AgentPlace } from '@shared/contract';
import type { Rect } from './layout';

export type ZoneId = 'library' | 'lab' | 'meeting' | 'review' | 'door' | 'coffee';

/**
 * Carril desde el que se llega a una plaza con un tramo recto por un eje (layout.ts calcula el punto de
 * paso): walkway = corredor de la pared izquierda (misma z) · back = pasillo de atras (misma x) ·
 * right = carril del margen derecho · review = carril de la mesa de revision · meetingBack = pasillo
 * entre las sillas de la reunion y la pared del fondo (baja del pasillo de atras por MEETING_LANE_X).
 */
export type ZoneLane = 'walkway' | 'back' | 'right' | 'review' | 'meetingBack';

export interface Plaza {
  /** nodo del grafo de la sala (ROOM_NAV) */
  node: string;
  x: number;
  z: number;
  /** hacia donde mira al llegar */
  heading: number;
  /** se sienta (silla) o queda de pie */
  sit: boolean;
  lane: ZoneLane;
  /** mueble donde se sienta (nombre del obstaculo): el ultimo tramo entra en el */
  seat?: string;
}

export interface ZoneSpec {
  id: ZoneId;
  plazas: readonly Plaza[];
  /** plaza reservada para el lider; -1 = el lider nunca va a esta zona */
  lead: number;
}

const HW = 3.6; // ROOM_W / 2
const HD = 3; // ROOM_D / 2

/** x del carril de la mesa de revision (entre la silla del puesto 6 y la mesa) */
export const REVIEW_LANE_X = 2.7;
/** x del carril del margen derecho (del pasillo de atras al desborde junto al puesto 3) */
export const RIGHT_LANE_X = 3.36;
/** x del carril que baja a la reunion (entre la plaza de cafe del lider y la mesa) */
export const MEETING_LANE_X = 1.5;
/** z del pasillo detras de las sillas de la reunion */
export const MEETING_BACK_Z = -2.8;

// ---------------------------------------------------------------- muebles

/** banco de laboratorio contra la pared izquierda, del escritorio de lider a la estanteria */
export const LAB_BENCH = { minX: -HW, maxX: -3.2, minZ: -2.4, maxZ: -0.42, h: 0.56 } as const;
/** estanteria de la biblioteca contra la pared izquierda (0,34 de fondo) */
export const BOOKSHELF = { minX: -HW, maxX: -HW + 0.34, minZ: -0.35, maxZ: 1.05 } as const;
/** carrito de cafe contra la pared del fondo, a la izquierda de la plaza de cafe del lider */
export const COFFEE_CART = { minX: -0.35, maxX: 0.45, minZ: -HD, maxZ: -2.55, h: 0.9 } as const;
/** mesa de reunion frente al ventanal; las sillas van detras, mirando a la camara */
export const MEETING_TABLE = { minX: 1.67, maxX: 3.52, minZ: -2.05, maxZ: -1.65, h: 0.72 } as const;
export const MEETING_SEATS_X = [1.9, 2.37, 2.84, 3.31] as const;
export const MEETING_SEAT_Z = -2.3;
/** silla de la reunion alrededor de su asiento (mirando a +z): respaldo detras */
export const MEETING_CHAIR = { halfW: 0.21, back: 0.24, front: 0.2 } as const;
/** mesa de revision en el margen derecho, entre las dos filas; se revisa de pie mirando a +x */
export const REVIEW_TABLE = { minX: 3.18, maxX: 3.56, minZ: 0.14, maxZ: 1.36, h: 0.56 } as const;
export const REVIEW_SPOTS_Z = [0.3, 0.75, 1.2] as const;
export const REVIEW_SPOT_X = 2.95;

function rectOf(r: Rect): Rect {
  return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ };
}

export function meetingChairRect(x: number): Rect {
  const c = MEETING_CHAIR;
  return { minX: x - c.halfW, maxX: x + c.halfW, minZ: MEETING_SEAT_Z - c.back, maxZ: MEETING_SEAT_Z + c.front };
}

const meetingChairName = (i: number): string => `meeting-chair-${i}`;

/** Muebles de las zonas (iguales en las 3 decoraciones); se suman a roomObstacles */
export const ZONE_PROPS: readonly { name: string; rect: Rect }[] = [
  { name: 'lab-bench', rect: rectOf(LAB_BENCH) },
  { name: 'bookshelf', rect: rectOf(BOOKSHELF) },
  { name: 'coffee-cart', rect: rectOf(COFFEE_CART) },
  { name: 'meeting-table', rect: rectOf(MEETING_TABLE) },
  ...MEETING_SEATS_X.map((x, i) => ({ name: meetingChairName(i), rect: meetingChairRect(x) })),
  { name: 'review-table', rect: rectOf(REVIEW_TABLE) },
];

// ---------------------------------------------------------------- plazas

/** mirando a la pared izquierda, un poco girado hacia la camara */
const LAB_HEADING = -Math.PI / 2 + 0.3;
/** leyendo de espaldas a la estanteria, de cara a la sala */
const READ_HEADING = 0.9;
/** hojeando la estanteria desde el otro lado del corredor */
const BROWSE_HEADING = -Math.PI / 2 + 0.5;
/** esperando junto a la puerta, casi de frente */
const WAIT_HEADING = -0.35;
/** igual que COFFEE_HEADING de layout.ts (el lider con su taza frente al ventanal) */
const COFFEE_HEADING = 0.45;
const FACE_FRONT = 0;
const FACE_RIGHT = Math.PI / 2;

export const zoneNode = (zone: ZoneId, i: number): string => `zone:${zone}:${i}`;

type PlazaDraft = Omit<Plaza, 'node'> & { node?: string };

function zone(id: ZoneId, lead: number, drafts: readonly PlazaDraft[]): ZoneSpec {
  return { id, lead, plazas: drafts.map((p, i) => ({ ...p, node: p.node ?? zoneNode(id, i) })) };
}

const stand = (x: number, z: number, heading: number, lane: ZoneLane): PlazaDraft => ({ x, z, heading, sit: false, lane });

export const ZONES: Readonly<Record<ZoneId, ZoneSpec>> = {
  // el lider en la punta junto a su escritorio; los demas hacia la estanteria
  lab: zone('lab', 0, [-2.15, -1.65, -1.15, -0.65].map((z) => stand(-2.98, z, LAB_HEADING, 'walkway'))),
  library: zone('library', 1, [
    stand(-3.02, -0.1, READ_HEADING, 'walkway'),
    stand(-3.02, 0.4, READ_HEADING, 'walkway'),
    stand(-3.02, 0.9, READ_HEADING, 'walkway'),
    stand(-2.25, 0.15, BROWSE_HEADING, 'walkway'),
  ]),
  // a los dos lados del corredor, junto al hueco de la puerta; el lider el mas cerca
  door: zone('door', 0, [
    stand(-3.1, 2.0, WAIT_HEADING, 'walkway'),
    stand(-3.1, 1.5, WAIT_HEADING, 'walkway'),
    stand(-2.25, 2.0, WAIT_HEADING, 'walkway'),
    stand(-2.25, 1.5, WAIT_HEADING, 'walkway'),
  ]),
  // la plaza del lider es la de siempre (COFFEE_SPOT / NODE.coffee de layout.ts)
  coffee: zone('coffee', 0, [
    { ...stand(1.0, -2.3, COFFEE_HEADING, 'back'), node: 'coffee' },
    stand(-0.1, -2.15, COFFEE_HEADING, 'back'),
    stand(0.5, -2.15, COFFEE_HEADING, 'back'),
  ]),
  meeting: zone(
    'meeting',
    1,
    MEETING_SEATS_X.map((x, i): PlazaDraft => ({
      x,
      z: MEETING_SEAT_Z,
      heading: FACE_FRONT,
      sit: true,
      lane: 'meetingBack',
      seat: meetingChairName(i),
    })),
  ),
  // el lider (orquestador) nunca revisa: sin plaza reservada
  review: zone('review', -1, REVIEW_SPOTS_Z.map((z) => stand(REVIEW_SPOT_X, z, FACE_RIGHT, 'review'))),
};

export const ZONE_LIST: readonly ZoneSpec[] = Object.values(ZONES);

/** zona de un lugar del snapshot; null = su puesto (desk, sleep o sin lugar) */
export function zoneOf(place: AgentPlace | null | undefined): ZoneId | null {
  switch (place) {
    case 'library':
    case 'lab':
    case 'meeting':
    case 'review':
    case 'door':
    case 'coffee':
      return place;
    default:
      return null;
  }
}

/** plaza reservada para el lider en una zona (undefined si el lider no usa esa zona) */
export function leadPlaza(zone: ZoneId): Plaza | undefined {
  const spec = ZONES[zone];
  return spec.lead >= 0 ? spec.plazas[spec.lead] : undefined;
}
