import { describe, expect, it } from 'vitest';
import { BackSide, DoubleSide, type Intersection, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { bvhOf, fastRaycast } from '@/scene/raycast';
import { roomGeometry } from '@/scene/world/room';
import { THEMES } from '@/scene/world/themes';

/** rayos como los de la camara isometrica, repartidos sobre la sala */
function rays(count: number): Raycaster[] {
  const out: Raycaster[] = [];
  const dir = new Vector3(-0.55, -0.62, -0.56).normalize();
  for (let i = 0; i < count; i++) {
    const x = -5 + ((i * 7.31) % 10);
    const z = -4 + ((i * 3.17) % 8);
    out.push(new Raycaster(new Vector3(x, 0, z).addScaledVector(dir, -30), dir.clone()));
  }
  return out;
}

const summary = (hits: Intersection[]) =>
  hits
    .map((h) => `${h.faceIndex}:${h.distance.toFixed(5)}:${h.point.x.toFixed(4)},${h.point.y.toFixed(4)},${h.point.z.toFixed(4)}`)
    .sort();

describe('raycast con arbol de cajas (salas)', () => {
  it('da los mismos cortes que el raycast de three, con cualquier lado del material', () => {
    const geometry = roomGeometry(1, 2, THEMES.japandi).meshes.toon;
    if (!geometry) throw new Error('sin geometria');
    expect(bvhOf(geometry)).not.toBeNull();
    for (const side of [undefined, DoubleSide, BackSide]) {
      const mesh = new Mesh(geometry, new MeshStandardMaterial(side === undefined ? {} : { side }));
      mesh.position.set(3.5, 0.2, -1.25);
      mesh.updateMatrixWorld(true);
      let total = 0;
      for (const rc of rays(160)) {
        const a: Intersection[] = [];
        const b: Intersection[] = [];
        Mesh.prototype.raycast.call(mesh, rc, a);
        fastRaycast.call(mesh, rc, b);
        expect(summary(b)).toEqual(summary(a));
        total += a.length;
      }
      expect(total).toBeGreaterThan(50);
    }
  });

  it('es varias veces mas rapido que recorrer todos los triangulos', () => {
    const geometry = roomGeometry(0, 0, THEMES.loft).meshes.toon;
    if (!geometry) throw new Error('sin geometria');
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    mesh.updateMatrixWorld(true);
    bvhOf(geometry);
    const list = rays(120);
    const time = (fn: (rc: Raycaster, out: Intersection[]) => void) => {
      const t0 = performance.now();
      for (let k = 0; k < 3; k++) for (const rc of list) fn(rc, []);
      return performance.now() - t0;
    };
    const slow = time((rc, out) => Mesh.prototype.raycast.call(mesh, rc, out));
    const fast = time((rc, out) => fastRaycast.call(mesh, rc, out));
    console.log(`raycast de una sala: three ${(slow / 360).toFixed(3)} ms · arbol ${(fast / 360).toFixed(3)} ms`);
    expect(fast * 4).toBeLessThan(slow);
  });
});
