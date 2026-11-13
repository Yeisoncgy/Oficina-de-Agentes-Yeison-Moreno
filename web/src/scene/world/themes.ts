// Tres variantes del loft: Ladrillo, Concreto y Cal. Cada una decide la pared del fondo (ladrillo o
// liso), el yeso de la pared lateral, el piso, las cubiertas, la estructura y el color de la luz; la
// distribucion y las decoraciones (Biblioteca, Taller, Cafeteria) son las mismas en las tres.
// Reparto: cada bloque de tres lugares del mapa lleva las tres variantes en un orden sorteado por bloque,
// asi que se ve al azar pero dos salas vecinas nunca repiten. Funciones puras, probadas en
// web/test/scene.test.ts. Los identificadores (loft, japandi, synth) vienen del kit anterior.

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
  /** pared lateral (la de la puerta): yeso pintado */
  wallSide: KitColor;
  /** la pared del fondo es de ladrillo visto (false = lisa) */
  brick: boolean;
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
  // Ladrillo: ladrillo rojo, yeso verde botella, nogal y roble, mostaza y terracota
  loft: {
    id: 'loft',
    floor: 'cement',
    wall: '#8C4A38',
    wallSide: '#1F3D3B',
    brick: true,
    wallLow: '#9A6A45',
    trim: 'steel',
    top: 'birch',
    topD: 'oak',
    frame: 'steel',
    frameL: 'steelL',
    shade: 'mustard',
    curtain: 'linen',
    door: 'teal',
    neonBack: 'honey',
    neonLeft: 'honey',
    neonGlow: 0,
    deskNeon: null,
    leadNeon: null,
    windowNeon: null,
    lantern: '#FFE2BD',
    pool: 'amber',
    rugs: [0, 1, 2],
    rugBase: 'navy',
    light: '#FFD2A0',
  },
  // Concreto: muro de concreto, yeso azul petroleo, roble claro, salvia y crema
  japandi: {
    id: 'japandi',
    floor: 'sand',
    wall: '#7C7A82',
    wallSide: '#22344F',
    brick: false,
    wallLow: '#C9A276',
    trim: '#2A2C36',
    top: '#EFE4CF',
    topD: '#D6C8AE',
    frame: '#2A2C36',
    frameL: '#4A4D5A',
    shade: '#8FAE96',
    curtain: 'linen',
    door: 'sage',
    neonBack: 'birch',
    neonLeft: 'birch',
    neonGlow: 0,
    deskNeon: null,
    leadNeon: null,
    windowNeon: null,
    lantern: '#FFEBD1',
    pool: 'amber',
    rugs: [3, 4],
    rugBase: '#8FAE96',
    light: '#FFDDB8',
  },
  // Cal: ladrillo encalado, yeso terracota, piso de concreto pulido, azul marino y mostaza
  synth: {
    id: 'synth',
    floor: 'grid',
    wall: '#D5C7B4',
    wallSide: '#A9503A',
    brick: true,
    wallLow: '#7A4F36',
    trim: '#1D1F26',
    top: '#7A4F36',
    topD: '#5E3B28',
    frame: '#1D1F26',
    frameL: '#3A3D48',
    shade: '#26355A',
    curtain: '#26355A',
    door: '#26355A',
    neonBack: 'walnut',
    neonLeft: 'walnut',
    neonGlow: 0,
    deskNeon: null,
    leadNeon: null,
    windowNeon: null,
    lantern: '#FFD9B0',
    pool: 'amber',
    rugs: [],
    rugBase: '#26355A',
    light: '#FFC998',
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
