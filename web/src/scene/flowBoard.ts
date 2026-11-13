// Tablero de fases en la pared de la sala que corre un flujo (tool Workflow): un cuadro por fase, sin
// texto. Aqui va lo puro y probado: que corrida se muestra, el estado de cada cuadro y donde cae cada
// cuadro en la textura (texeles). La pieza 3D es FlowBoard.tsx.

import type { OfficeRoom, WorkflowPhase, WorkflowRun, WorkflowStatus } from '@shared/contract';
import { awaitsHuman } from '@/lib/workflows';

export type TileState = 'done' | 'running' | 'pending' | 'failed';

export interface FlowBoardModel {
  runId: string;
  /** un cuadro por fase, en orden (a lo sumo FLOW_BOARD_MAX_TILES) */
  tiles: TileState[];
  /** el lider espera una respuesta del usuario por este flujo: luz ambar arriba del tablero */
  waiting: boolean;
  status: WorkflowStatus;
}

/** un flujo que termino sigue en el tablero 10 min, con su estado final */
export const FLOW_BOARD_LINGER_MS = 10 * 60_000;
export const FLOW_BOARD_MAX_TILES = 8;

const timeOf = (iso: string | null): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/** la corrida del tablero: la en curso que arranco mas tarde; si no, la ultima que termino hace < 10 min */
export function pickBoardRun(room: OfficeRoom, nowMs: number): WorkflowRun | null {
  const runs = room.workflows ?? [];
  let best: WorkflowRun | null = null;
  for (const run of runs) {
    if (run.status === 'running' && (!best || timeOf(run.startedAt) > timeOf(best.startedAt))) best = run;
  }
  if (best) return best;
  for (const run of runs) {
    if (!run.endedAt) continue;
    const ended = timeOf(run.endedAt);
    if (nowMs - ended >= FLOW_BOARD_LINGER_MS) continue;
    if (!best || ended > timeOf(best.endedAt)) best = run;
  }
  return best;
}

/**
 * Hasta cuando (ms) el tablero depende del reloj: sin corrida en curso, la ultima que termino deja de mostrarse
 * a los FLOW_BOARD_LINGER_MS. null si el reloj no cambia nada (hay una en curso, o ninguna termino).
 */
export function boardExpiry(room: OfficeRoom): number | null {
  const runs = room.workflows ?? [];
  let last = 0;
  for (const run of runs) {
    if (run.status === 'running') return null;
    if (run.endedAt) last = Math.max(last, timeOf(run.endedAt));
  }
  return last > 0 ? last + FLOW_BOARD_LINGER_MS : null;
}

/** cuadro de una fase: en una corrida que ya no corre, una fase que quedo "en curso" toma el final de la corrida */
function tileOf(phase: WorkflowPhase['status'], run: WorkflowStatus): TileState {
  if (phase !== 'running' || run === 'running') return phase;
  return run === 'done' ? 'done' : 'failed';
}

/** sin fases declaradas: un solo cuadro con el estado de la corrida */
function runTile(status: WorkflowStatus): TileState {
  if (status === 'running') return 'running';
  return status === 'done' ? 'done' : 'failed';
}

/** gravedad para comprimir: falla > en curso > pendiente > hecha */
const RANK: Readonly<Record<TileState, number>> = { done: 0, pending: 1, running: 2, failed: 3 };

/**
 * Mas de `max` fases: se reparten en `max` grupos de fases vecinas (grupo i = fases floor(i*n/max) a
 * floor((i+1)*n/max) - 1; tamanos que difieren en 1) y cada grupo muestra su peor estado
 * (falla > en curso > pendiente > hecha).
 */
export function compressTiles(tiles: readonly TileState[], max = FLOW_BOARD_MAX_TILES): TileState[] {
  if (tiles.length <= max) return [...tiles];
  const out: TileState[] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * tiles.length) / max);
    const to = Math.floor(((i + 1) * tiles.length) / max);
    let worst: TileState = 'done';
    for (const t of tiles.slice(from, to)) if (RANK[t] > RANK[worst]) worst = t;
    out.push(worst);
  }
  return out;
}

/** lo que muestra el tablero de la sala, o null si no hay flujo que mostrar (sin tablero) */
export function flowBoardModel(room: OfficeRoom, nowMs: number): FlowBoardModel | null {
  const run = pickBoardRun(room, nowMs);
  if (!run) return null;
  const raw = run.phases.length > 0 ? run.phases.map((p) => tileOf(p.status, run.status)) : [runTile(run.status)];
  return { runId: run.runId, tiles: compressTiles(raw), waiting: awaitsHuman(run, room), status: run.status };
}

/** clave de pintura: la textura se repinta solo cuando cambia */
export function boardKey(model: Pick<FlowBoardModel, 'tiles' | 'waiting'>): string {
  return `${model.tiles.join(',')}|${model.waiting ? 1 : 0}`;
}

// ---------------------------------------------------------------- disposicion en la textura

/** textura del tablero, 1 texel = 1 pixel de arte (cara de 0,76 x 0,44 en la pared) */
export const BOARD_TEX = { w: 48, h: 28 } as const;

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const INNER = { x: 2, y: 4, w: 44, h: 22 } as const;
const GAP = 2;
const TILE_MAX = 10;

/**
 * Cuadros en la textura (origen arriba a la izquierda): hasta 4 en una fila; de 5 a 8, dos filas que se
 * leen de izquierda a derecha y de arriba abajo. La grilla queda centrada.
 */
export function boardTiles(count: number): TileRect[] {
  const n = Math.max(0, Math.min(FLOW_BOARD_MAX_TILES, Math.floor(count)));
  if (n === 0) return [];
  const rows = n <= 4 ? 1 : 2;
  const cols = Math.ceil(n / rows);
  const w = Math.min(TILE_MAX, Math.floor((INNER.w - (cols - 1) * GAP) / cols));
  const h = Math.min(TILE_MAX, Math.floor((INNER.h - (rows - 1) * GAP) / rows));
  const gridH = rows * h + (rows - 1) * GAP;
  const y0 = INNER.y + Math.floor((INNER.h - gridH) / 2);
  const out: TileRect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const rowW = inRow * w + (inRow - 1) * GAP;
    const x0 = INNER.x + Math.floor((INNER.w - rowW) / 2);
    out.push({ x: x0 + col * (w + GAP), y: y0 + row * (h + GAP), w, h });
  }
  return out;
}
