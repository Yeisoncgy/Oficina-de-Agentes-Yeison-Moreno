// Textura del tablero de fases (FlowBoard.tsx): un atlas propio con una region por sala, que se repinta
// solo cuando cambia su clave (cuadros + espera). Mismo patron que los carteles de sala en textures.ts:
// la region se suelta al desmontar y se recicla cuando hace falta lugar. Sin texto.

import { STATE } from '@/theme';
import { BOARD_TEX, boardKey, boardTiles, type FlowBoardModel, type TileRect, type TileState } from './flowBoard';
import { Atlas, type Region, type UvRect } from './textures';
import { mixHex, type Paint, type Raster } from './world/raster';

const atlas = new Atlas(256);
export const flowBoardTexture = atlas.px.tex;

interface BoardSlot {
  region: Region;
  /** clave pintada ('' = todavia sin pintar) */
  key: string;
  refs: number;
}

const slots = new Map<string, BoardSlot>();

function newRegion(): Region | null {
  try {
    return atlas.region(BOARD_TEX.w, BOARD_TEX.h);
  } catch {
    // atlas lleno (mas de 40 tableros): se recicla el de una sala que ya no lo usa
    for (const [id, slot] of slots) {
      if (slot.refs > 0) continue;
      slots.delete(id);
      return slot.region;
    }
    return null;
  }
}

/** region del tablero de la sala (la misma mientras exista); null si no queda lugar */
export function boardRect(roomId: string): UvRect | null {
  const hit = slots.get(roomId);
  if (hit) return hit.region.rect;
  const region = newRegion();
  if (!region) return null;
  slots.set(roomId, { region, key: '', refs: 0 });
  return region.rect;
}

/** la sala usa su tablero (desde un efecto) */
export function retainBoard(roomId: string): void {
  const slot = slots.get(roomId);
  if (slot) slot.refs++;
}

/** la sala dejo de usarlo: sin usuarios, la region se recicla cuando haga falta lugar */
export function releaseBoard(roomId: string): void {
  const slot = slots.get(roomId);
  if (slot) slot.refs = Math.max(0, slot.refs - 1);
}

/** pinta el tablero de la sala si cambio su clave; true si repinto */
export function paintBoard(roomId: string, model: Pick<FlowBoardModel, 'tiles' | 'waiting'>): boolean {
  const slot = slots.get(roomId);
  if (!slot) return false;
  const key = boardKey(model);
  if (slot.key === key) return false;
  slot.key = key;
  atlas.paint(slot.region, (g) => paintFlowBoard(g, model.tiles, model.waiting));
  return true;
}

// ---------------------------------------------------------------- pintura

const CHECK = ['......#', '.....#.', '#...#..', '.#.#...', '..#....'];
const CROSS = ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'];
const PLAY = ['#..', '##.', '###', '##.', '#..'];

const FAIL_FILL = mixHex('ink', STATE.error, 0.3);
const RUN_FILL = mixHex('teal', 'night', 0.25);

function sprite(g: Raster, rows: readonly string[], t: TileRect, color: Paint): void {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const x0 = t.x + Math.floor((t.w - w) / 2);
  const y0 = t.y + Math.floor((t.h - h) / 2);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') g.px(color, x0 + x, y0 + y);
  });
}

function framed(g: Raster, t: TileRect, border: Paint, fill: Paint): void {
  g.px(border, t.x, t.y, t.w, t.h);
  g.px(fill, t.x + 1, t.y + 1, t.w - 2, t.h - 2);
}

function paintTile(g: Raster, t: TileRect, state: TileState): void {
  if (state === 'done') {
    framed(g, t, 'leaf', 'moss');
    sprite(g, CHECK, t, STATE.done);
  } else if (state === 'running') {
    framed(g, t, 'cyan', RUN_FILL);
    sprite(g, PLAY, t, 'cyan');
  } else if (state === 'failed') {
    framed(g, t, STATE.error, FAIL_FILL);
    sprite(g, CROSS, t, STATE.error);
  } else {
    framed(g, t, 'indigo', 'night');
    g.px('indigo', t.x + Math.floor(t.w / 2) - 1, t.y + Math.floor(t.h / 2) - 1, 2, 2);
  }
}

/**
 * Tablero: fondo grafito con borde de tinta, franja de arriba (ambar si el lider espera una respuesta),
 * los cuadros de las fases y una linea que une los vecinos de cada fila.
 */
export function paintFlowBoard(g: Raster, tiles: readonly TileState[], waiting: boolean): void {
  const { w, h } = BOARD_TEX;
  g.px('ink', 0, 0, w, h);
  g.px('graphite', 1, 1, w - 2, h - 2);
  g.px(waiting ? 'amber' : 'night', 1, 1, w - 2, 2);
  g.px(waiting ? 'cream' : 'dusk', 4, 1, 1, 2);
  g.px(waiting ? 'cream' : 'dusk', w - 5, 1, 1, 2);
  const rects = boardTiles(tiles.length);
  rects.forEach((t, i) => {
    const next = rects[i + 1];
    if (next && next.y === t.y) {
      const done = tiles[i] === 'done';
      g.px(done ? 'leaf' : 'dusk', t.x + t.w, t.y + Math.floor(t.h / 2) - 1, next.x - t.x - t.w, 2);
    }
    paintTile(g, t, tiles[i] ?? 'pending');
  });
}
