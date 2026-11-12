import { describe, expect, it } from 'vitest';
import { EXTERIOR, exteriorPlan } from '@/scene/OfficeBase';
import { assignSlots, buildOfficeNav, computeLayout, DOOR, type Rect, ROOM_FOOTPRINT, type Vec2, worldGround } from '@/scene/layout';
import { FRAME_LIFT, frameRects } from '@/scene/RoomHighlight';

const COUNTS = [1, 2, 3, 4, 5, 6, 7, 9, 12];

function layoutFor(count: number) {
  return computeLayout(assignSlots(new Map(), Array.from({ length: count }, (_, i) => `sala-${i}`)));
}

/** puntos cada 3 cm de cada tramo del grafo del lider que cae fuera de las salas (calles y entradas) */
function streetPoints(count: number): Vec2[] {
  const layout = layoutFor(count);
  const g = buildOfficeNav(layout);
  const out: Vec2[] = [];
  for (const [a, set] of g.edges) {
    for (const b of set) {
      if (a > b) continue;
      const p = g.nodes.get(a);
      const q = g.nodes.get(b);
      if (!p || !q) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.03));
      for (let i = 0; i <= n; i++) {
        const s = { x: p.x + ((q.x - p.x) * i) / n, z: p.z + ((q.z - p.z) * i) / n };
        if (worldGround(layout, s.x, s.z) === 0) out.push(s);
      }
    }
  }
  return out;
}

function distToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
  return Math.hypot(dx, dz);
}

const inside = (r: Rect, p: Vec2) => p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ;
const overlap = (a: Rect, b: Rect) => a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9;

/** holgura minima entre el carril del lider y algo solido (medio cuerpo y un poco) */
const CLEAR = 0.15;

describe('exterior del diorama', () => {
  it('nada solido (farolas, bolardos, jardineras) pisa los carriles del lider', () => {
    for (const count of COUNTS) {
      const plan = exteriorPlan(layoutFor(count));
      const pts = streetPoints(count);
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        for (const l of plan.lamps) expect(Math.hypot(p.x - l.x, p.z - l.z)).toBeGreaterThan(EXTERIOR.lampR + CLEAR);
        for (const o of plan.bollards) expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(EXTERIOR.bollardR + CLEAR);
        for (const { rect } of plan.planters) expect(distToRect(p, rect)).toBeGreaterThan(CLEAR);
      }
    }
    // miles de expect: en una laptop cargada pasa de los 5 s por defecto sin que nada este mal
  }, 30_000);

  it('el lider solo cruza una acera por el rebaje del cordon frente a la puerta', () => {
    for (const count of COUNTS) {
      const plan = exteriorPlan(layoutFor(count));
      for (const p of streetPoints(count)) {
        for (const { room, outer } of plan.sidewalks) {
          if (!inside(outer, p)) continue;
          const z = p.z - room.center.z;
          expect(z).toBeGreaterThanOrEqual(DOOR.openMin - EXTERIOR.doorCut);
          expect(z).toBeLessThanOrEqual(DOOR.openMax + EXTERIOR.doorCut);
        }
      }
    }
  });

  it('las aceras no se pisan entre si ni con las jardineras, y quedan sobre la losa', () => {
    for (const count of COUNTS) {
      const layout = layoutFor(count);
      const plan = exteriorPlan(layout);
      expect(plan.sidewalks).toHaveLength(layout.rooms.length);
      expect(plan.crossings).toHaveLength(layout.rooms.length);
      plan.sidewalks.forEach((a, i) => {
        const B = layout.bounds;
        expect(a.outer.minX).toBeGreaterThan(B.minX);
        expect(a.outer.maxX).toBeLessThan(B.maxX);
        expect(a.outer.minZ).toBeGreaterThan(B.minZ);
        expect(a.outer.maxZ).toBeLessThan(B.maxZ);
        plan.sidewalks.slice(i + 1).forEach((b) => expect(overlap(a.outer, b.outer)).toBe(false));
        for (const { rect } of plan.planters) expect(overlap(a.outer, rect)).toBe(false);
      });
    }
  });

  it('farolas en algunos cruces, no en todos, y fuera del contorno de seleccion', () => {
    const layout = layoutFor(4);
    const plan = exteriorPlan(layout);
    expect(plan.lamps.length).toBeGreaterThan(0);
    expect(plan.lamps.length).toBeLessThan(plan.crossings.length);
    for (const room of layout.rooms) {
      for (const r of frameRects()) {
        const world = { minX: r.minX + room.center.x, maxX: r.maxX + room.center.x, minZ: r.minZ + room.center.z, maxZ: r.maxZ + room.center.z };
        for (const l of plan.lamps) expect(distToRect(l, world)).toBeGreaterThan(EXTERIOR.lampR);
      }
    }
  });

  it('el contorno de sala seleccionada cabe en la acera y va por encima del cordon y de los charcos', () => {
    const F = ROOM_FOOTPRINT;
    for (const r of frameRects()) {
      expect(r.minX).toBeGreaterThanOrEqual(F.minX - EXTERIOR.ring);
      expect(r.maxX).toBeLessThanOrEqual(F.maxX + EXTERIOR.ring);
      expect(r.minZ).toBeGreaterThanOrEqual(F.minZ - EXTERIOR.ring);
      expect(r.maxZ).toBeLessThanOrEqual(F.maxZ + EXTERIOR.ring);
    }
    expect(FRAME_LIFT).toBeGreaterThan(EXTERIOR.curbY);
    expect(FRAME_LIFT).toBeGreaterThan(EXTERIOR.poolY);
  });
});
