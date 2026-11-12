// Tres estilos de sala: Loft lofi, Japandi suave y Synthwave. Cada estilo decide los
// materiales (paredes, cubiertas, estructura), el piso, los neones, las alfombras y el color de la luz; la
// distribucion y las decoraciones (Biblioteca, Taller, Cafeteria) son las mismas en los tres.
// Reparto: cada bloque de tres lugares del mapa lleva los tres estilos en un orden sorteado por bloque, asi
// que se ve al azar pero dos salas vecinas nunca repiten. Funciones puras, probadas en web/test/scene.test.ts.

import type { KitColor } from '../builder';
import { hash1 } from './kit';

export type ThemeId = 'loft' | 'japandi' | 'synth';
export type FloorKind = 'cement' | 'sand' | 'grid';

export interface RoomTheme {
  id: ThemeId;
  floor: FloorKind;
  wall: KitColor;
  /** franja baja de la pared */
  wallLow: KitColor;
  /** tapa y zocalo de las paredes, marcos de puerta y ventana, cartel y reloj */
  trim: KitColor;
  /** cubiertas y paneles de los muebles */
  top: KitColor;
  topD: KitColor;
  /** patas y estructuras */
  frame: KitColor;
  frameL: KitColor;
  /** pantalla de las lamparas de brazo */
  shade: KitColor;
  curtain: KitColor;
  door: KitColor;
  /** tira al pie de la pared del fondo y de la izquierda, y cuanto tine el piso */
  neonBack: KitColor;
  neonLeft: KitColor;
  neonGlow: number;
  /** tira bajo el canto de los escritorios (null = sin tira) */
  deskNeon: KitColor | null;
  leadNeon: KitColor | null;
  windowNeon: KitColor | null;
  /** farol de papel de la pared */
  lantern: KitColor;
  /** charcos de las lamparas */
  pool: KitColor;
  /** alfombras del estilo (indices de RUGS en raster.ts) */
  rugs: readonly number[];
  rugBase: KitColor;
  /** luz puntual de la sala */
  light: string;
}

export const THEMES: Readonly<Record<ThemeId, RoomTheme>> = {
  // hueso y metal negro sobre microcemento, neon magenta y cian de acento
  loft: {
    id: 'loft',
    floor: 'cement',
    wall: 'wall',
    wallLow: 'wallLow',
    trim: 'steel',
    top: 'bone',
    topD: 'boneD',
    frame: 'steel',
    frameL: 'steelL',
    shade: 'steelL',
    curtain: 'plum',
    door: 'bone',
    neonBack: 'magenta',
    neonLeft: 'cyan',
    neonGlow: 0.26,
    deskNeon: 'magenta',
    leadNeon: 'cyan',
    windowNeon: 'cyan',
    lantern: '#FFE2BD',
    pool: 'amber',
    rugs: [0, 1, 2],
    rugBase: 'steel',
    light: '#FFB25A',
  },
  // arena, blanco roto, salvia y lino: calma, luz calida y casi sin neon
  japandi: {
    id: 'japandi',
    floor: 'sand',
    wall: '#8A809F',
    wallLow: '#6F6788',
    trim: '#B3A696',
    top: '#EFE6D8',
    topD: '#D6CBBB',
    frame: '#8C8174',
    frameL: '#A89C8F',
    shade: '#E8DCC8',
    curtain: 'linen',
    door: 'sage',
    neonBack: '#FFD9A8',
    neonLeft: '#FFD9A8',
    neonGlow: 0.16,
    deskNeon: null,
    leadNeon: null,
    windowNeon: null,
    lantern: '#FFEBD1',
    pool: 'amber',
    rugs: [3, 4],
    rugBase: '#B3A696',
    light: '#FFC98A',
  },
  // azul medianoche, grafito y cromo sobre piso con grilla, sin alfombra (el violeta
  // de base se veia demasiado morado). El morado queda de acento: tira del fondo, escritorio del lider, cruces
  // del piso y la franja baja de la pared. Luz de atardecer para que no tina todo de lila.
  synth: {
    id: 'synth',
    floor: 'grid',
    wall: '#1F2B4D',
    wallLow: '#2A1650',
    trim: '#0C1124',
    top: '#2A2F42',
    topD: '#394057',
    frame: '#B8BEDD',
    frameL: '#8990B5',
    shade: '#2A2F42',
    curtain: '#243A63',
    door: '#2A2F42',
    neonBack: '#8B5CF6',
    neonLeft: 'cyan',
    neonGlow: 0.32,
    deskNeon: 'cyan',
    leadNeon: '#8B5CF6',
    windowNeon: 'cyan',
    lantern: '#FFB59A',
    pool: '#FFB08A',
    rugs: [],
    rugBase: '#0C1124',
    light: '#FFA88C',
  },
};

const ORDERS: readonly (readonly ThemeId[])[] = [
  ['loft', 'japandi', 'synth'],
  ['loft', 'synth', 'japandi'],
  ['japandi', 'loft', 'synth'],
  ['japandi', 'synth', 'loft'],
  ['synth', 'loft', 'japandi'],
  ['synth', 'japandi', 'loft'],
];

/** estilo del lugar del mapa: los tres por bloque de tres lugares, en un orden sorteado por bloque */
export function themeOfSlot(slot: number): RoomTheme {
  const s = Math.max(0, Math.floor(slot));
  const block = Math.floor(s / 3);
  const order = ORDERS[Math.floor(hash1(block * 7.3 + 1.1) * ORDERS.length)] ?? ORDERS[0];
  return THEMES[order?.[s % 3] ?? 'loft'];
}
