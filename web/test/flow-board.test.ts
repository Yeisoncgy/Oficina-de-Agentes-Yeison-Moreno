import { describe, expect, it } from 'vitest';
import type { OfficeRoom, TokenBreakdown, WorkflowPhase, WorkflowRun } from '@shared/contract';
import { createMockSnapshot } from '../src/scene/mock';
import {
  boardKey,
  boardTiles,
  BOARD_TEX,
  compressTiles,
  FLOW_BOARD_LINGER_MS,
  flowBoardModel,
  pickBoardRun,
  type TileState,
} from '../src/scene/flowBoard';
import { paintFlowBoard } from '../src/scene/flowBoardTexture';
import { Raster } from '../src/scene/world/raster';

const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const tokens = (): TokenBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function phase(title: string, status: WorkflowPhase['status']): WorkflowPhase {
  return { title, status, agentsStarted: 0, agentsDone: 0 };
}

function run(partial: Partial<WorkflowRun> & Pick<WorkflowRun, 'runId'>): WorkflowRun {
  return {
    name: 'flujo_ficticio',
    description: '',
    status: 'running',
    startedAt: iso(NOW - 5 * 60_000),
    endedAt: null,
    phases: [],
    agents: [],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  };
}

const baseRoom = (() => {
  const room = createMockSnapshot(NOW).rooms[0];
  if (!room) throw new Error('la demo no trae salas');
  return room;
})();

function room(workflows: WorkflowRun[] | undefined, leadAtDoor = false): OfficeRoom {
  return { ...baseRoom, workflows, lead: { ...baseRoom.lead, place: leadAtDoor ? 'door' : 'desk' } };
}

describe('tablero de fases: que corrida muestra', () => {
  it('sin flujos no hay tablero', () => {
    expect(flowBoardModel(room(undefined), NOW)).toBeNull();
    expect(flowBoardModel(room([]), NOW)).toBeNull();
  });

  it('entre varias en curso elige la que arranco mas tarde', () => {
    const a = run({ runId: 'a', startedAt: iso(NOW - 20 * 60_000) });
    const b = run({ runId: 'b', startedAt: iso(NOW - 2 * 60_000) });
    const done = run({ runId: 'c', status: 'done', startedAt: iso(NOW - 60_000), endedAt: iso(NOW - 30_000) });
    expect(pickBoardRun(room([a, b, done]), NOW)?.runId).toBe('b');
  });

  it('sin ninguna en curso, la ultima que termino hace menos de 10 min, con su estado final', () => {
    const old = run({ runId: 'vieja', status: 'done', endedAt: iso(NOW - 8 * 60_000) });
    const recent = run({ runId: 'reciente', status: 'failed', endedAt: iso(NOW - 3 * 60_000) });
    const model = flowBoardModel(room([old, recent]), NOW);
    expect(model?.runId).toBe('reciente');
    expect(model?.status).toBe('failed');
  });

  it('una que termino hace 10 min o mas ya no se muestra', () => {
    const gone = run({ runId: 'x', status: 'done', endedAt: iso(NOW - FLOW_BOARD_LINGER_MS) });
    expect(flowBoardModel(room([gone]), NOW)).toBeNull();
    expect(flowBoardModel(room([gone]), NOW - 1)).not.toBeNull();
  });
});

describe('tablero de fases: cuadros', () => {
  it('un cuadro por fase, en orden', () => {
    const r = run({ runId: 'r', phases: [phase('A', 'done'), phase('B', 'running'), phase('C', 'pending')] });
    expect(flowBoardModel(room([r]), NOW)?.tiles).toEqual(['done', 'running', 'pending']);
  });

  it('sin fases declaradas, un solo cuadro con el estado de la corrida', () => {
    expect(flowBoardModel(room([run({ runId: 'r' })]), NOW)?.tiles).toEqual(['running']);
    const stopped = run({ runId: 's', status: 'stopped', endedAt: iso(NOW - 60_000) });
    expect(flowBoardModel(room([stopped]), NOW)?.tiles).toEqual(['failed']);
    const done = run({ runId: 'd', status: 'done', endedAt: iso(NOW - 60_000) });
    expect(flowBoardModel(room([done]), NOW)?.tiles).toEqual(['done']);
  });

  it('en una corrida que ya no corre, una fase que quedo en curso toma el final', () => {
    const failed = run({ runId: 'f', status: 'failed', endedAt: iso(NOW - 60_000), phases: [phase('A', 'done'), phase('B', 'running')] });
    expect(flowBoardModel(room([failed]), NOW)?.tiles).toEqual(['done', 'failed']);
  });

  it('con mas de 8 fases comprime vecinas y toma el peor estado', () => {
    const tiles: TileState[] = ['done', 'done', 'done', 'done', 'done', 'failed', 'running', 'pending', 'pending', 'pending'];
    const out = compressTiles(tiles);
    expect(out).toHaveLength(8);
    // grupos de 10 en 8: [0] [1] [2] [3,4] [5] [6] [7] [8,9]
    expect(out).toEqual(['done', 'done', 'done', 'done', 'failed', 'running', 'pending', 'pending']);
    expect(compressTiles(['done', 'pending', 'running', 'done'], 2)).toEqual(['pending', 'running']);
    expect(compressTiles(['done', 'done'])).toEqual(['done', 'done']);
  });

  it('el modelo nunca pasa de 8 cuadros', () => {
    const phases = Array.from({ length: 13 }, (_, i) => phase(`F${i}`, i < 6 ? 'done' : i === 6 ? 'running' : 'pending'));
    const tiles = flowBoardModel(room([run({ runId: 'r', phases })]), NOW)?.tiles ?? [];
    expect(tiles).toHaveLength(8);
    expect(tiles.filter((t) => t === 'running')).toHaveLength(1);
  });
});

describe('tablero de fases: espera y clave', () => {
  it('waiting sale de awaitsHuman: el lider en la puerta con el flujo en curso', () => {
    const r = run({ runId: 'r', phases: [phase('A', 'running')] });
    expect(flowBoardModel(room([r], true), NOW)?.waiting).toBe(true);
    expect(flowBoardModel(room([r], false), NOW)?.waiting).toBe(false);
  });

  it('la clave cambia con los cuadros y con la espera', () => {
    const a = boardKey({ tiles: ['done', 'running'], waiting: false });
    expect(boardKey({ tiles: ['done', 'running'], waiting: false })).toBe(a);
    expect(boardKey({ tiles: ['done', 'running'], waiting: true })).not.toBe(a);
    expect(boardKey({ tiles: ['done', 'done'], waiting: false })).not.toBe(a);
  });
});

describe('tablero de fases: disposicion y pintura', () => {
  it('los cuadros caben en la textura, sin encimarse, en una o dos filas', () => {
    for (let n = 1; n <= 8; n++) {
      const rects = boardTiles(n);
      expect(rects).toHaveLength(n);
      expect(new Set(rects.map((r) => r.y)).size).toBe(n <= 4 ? 1 : 2);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(1);
        expect(r.y).toBeGreaterThanOrEqual(3);
        expect(r.x + r.w).toBeLessThanOrEqual(BOARD_TEX.w - 1);
        expect(r.y + r.h).toBeLessThanOrEqual(BOARD_TEX.h - 1);
        expect(r.w).toBeGreaterThanOrEqual(7);
      }
      rects.forEach((a, i) =>
        rects.slice(i + 1).forEach((b) => {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }),
      );
    }
    expect(boardTiles(0)).toEqual([]);
    expect(boardTiles(20)).toHaveLength(8);
  });

  it('pinta cada estado con su color y la franja ambar con espera', () => {
    const g = Raster.create(BOARD_TEX.w, BOARD_TEX.h);
    const pixel = (x: number, y: number) => {
      const i = ((BOARD_TEX.h - 1 - y) * BOARD_TEX.w + x) * 4;
      return [g.data[i], g.data[i + 1], g.data[i + 2]];
    };
    const tiles: TileState[] = ['done', 'running', 'pending', 'failed'];
    paintFlowBoard(g, tiles, false);
    const rects = boardTiles(tiles.length);
    const borders = rects.map((r) => pixel(r.x, r.y));
    expect(new Set(borders.map((c) => c.join(','))).size).toBe(4);
    const strip = pixel(10, 1);
    paintFlowBoard(g, tiles, true);
    expect(pixel(10, 1)).not.toEqual(strip);
  });
});
