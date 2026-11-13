// Raycast rapido para las mallas grandes de la sala (paredes y muebles fusionados: ~25 000 triangulos). R3F
// lanza un rayo en cada movimiento del puntero sobre la escena (para el resaltado al pasar) y tambien mientras
// se arrastra la camara; con el raycast de three cada sala bajo el rayo recorria todos sus triangulos (~1 ms
// por sala y movimiento en un equipo modesto). Aqui cada geometria lleva un arbol de cajas (BVH) que se arma
// una sola vez (las geometrias de sala estan cacheadas por decoracion y estilo) y el rayo solo prueba los
// triangulos de las cajas que cruza. Devuelve los mismos cortes que el raycast de three (mismo lado, mismas
// distancias), asi los clics y el resaltado no cambian.

import {
  BackSide,
  type BufferGeometry,
  DoubleSide,
  type Intersection,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Ray,
  type Raycaster,
  Sphere,
  Triangle,
  Vector3,
} from 'three';

/** triangulos por hoja: menos = mas cajas, mas = mas triangulos por caja */
const LEAF = 12;

interface Bvh {
  /** por nodo: minX, minY, minZ, maxX, maxY, maxZ */
  bounds: Float32Array;
  /** por nodo: hoja = [inicio, cantidad] en `tris`; interno = [hijo derecho, -1] (el izquierdo es el siguiente) */
  meta: Int32Array;
  /** triangulos (indice del primer vertice / 3) en el orden de las hojas */
  tris: Uint32Array;
  nodes: number;
}

const cache = new WeakMap<BufferGeometry, Bvh | null>();

/** el raycast de three, para los casos que este no cubre */
const MeshRaycast = Mesh.prototype.raycast;

/** vertice v del triangulo t (con o sin indice) */
function vertexIndex(geometry: BufferGeometry, t: number, v: number): number {
  const index = geometry.index;
  return index ? index.getX(t * 3 + v) : t * 3 + v;
}

function triangleCount(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  return Math.floor((geometry.index ? geometry.index.count : pos.count) / 3);
}

function buildBvh(geometry: BufferGeometry): Bvh | null {
  const pos = geometry.getAttribute('position');
  const n = triangleCount(geometry);
  // grupos o rango de dibujo parcial: que lo resuelva three
  if (!pos || n === 0 || geometry.groups.length > 0 || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return null;
  const box = new Float32Array(n * 6);
  const cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let v = 0; v < 3; v++) {
      const i = vertexIndex(geometry, t, v);
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
    const o = t * 6;
    box[o] = x0;
    box[o + 1] = y0;
    box[o + 2] = z0;
    box[o + 3] = x1;
    box[o + 4] = y1;
    box[o + 5] = z1;
    cen[t * 3] = (x0 + x1) / 2;
    cen[t * 3 + 1] = (y0 + y1) / 2;
    cen[t * 3 + 2] = (z0 + z1) / 2;
  }
  const tris = new Uint32Array(n);
  for (let t = 0; t < n; t++) tris[t] = t;
  // a lo sumo 2n - 1 nodos (cada hoja tiene al menos un triangulo); al final se recorta a lo usado
  const maxNodes = 2 * n;
  const bounds = new Float32Array(maxNodes * 6);
  const meta = new Int32Array(maxNodes * 2);
  let nodes = 0;

  const build = (start: number, end: number): number => {
    const node = nodes++;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cz0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    let cz1 = -Infinity;
    for (let k = start; k < end; k++) {
      const t = tris[k] ?? 0;
      const b = t * 6;
      x0 = Math.min(x0, box[b] ?? 0);
      y0 = Math.min(y0, box[b + 1] ?? 0);
      z0 = Math.min(z0, box[b + 2] ?? 0);
      x1 = Math.max(x1, box[b + 3] ?? 0);
      y1 = Math.max(y1, box[b + 4] ?? 0);
      z1 = Math.max(z1, box[b + 5] ?? 0);
      const c = t * 3;
      cx0 = Math.min(cx0, cen[c] ?? 0);
      cy0 = Math.min(cy0, cen[c + 1] ?? 0);
      cz0 = Math.min(cz0, cen[c + 2] ?? 0);
      cx1 = Math.max(cx1, cen[c] ?? 0);
      cy1 = Math.max(cy1, cen[c + 1] ?? 0);
      cz1 = Math.max(cz1, cen[c + 2] ?? 0);
    }
    const o = node * 6;
    bounds[o] = x0;
    bounds[o + 1] = y0;
    bounds[o + 2] = z0;
    bounds[o + 3] = x1;
    bounds[o + 4] = y1;
    bounds[o + 5] = z1;
    const count = end - start;
    const ex = cx1 - cx0;
    const ey = cy1 - cy0;
    const ez = cz1 - cz0;
    const extent = Math.max(ex, ey, ez);
    if (count <= LEAF || extent <= 1e-9) {
      meta[node * 2] = start;
      meta[node * 2 + 1] = count;
      return node;
    }
    // corte por la mitad del eje mas largo de los centros; si deja un lado vacio, por la mediana
    const axis = extent === ex ? 0 : extent === ey ? 1 : 2;
    const mid = (axis === 0 ? cx0 + cx1 : axis === 1 ? cy0 + cy1 : cz0 + cz1) / 2;
    let i = start;
    let j = end - 1;
    while (i <= j) {
      const ti = tris[i] ?? 0;
      if ((cen[ti * 3 + axis] ?? 0) < mid) i++;
      else {
        tris[i] = tris[j] ?? 0;
        tris[j] = ti;
        j--;
      }
    }
    let split = i;
    if (split === start || split === end) {
      const sorted = Array.from(tris.subarray(start, end)).sort((a, b) => (cen[a * 3 + axis] ?? 0) - (cen[b * 3 + axis] ?? 0));
      tris.set(sorted, start);
      split = start + (count >> 1);
    }
    build(start, split);
    const right = build(split, end);
    meta[node * 2] = right;
    meta[node * 2 + 1] = -1;
    return node;
  };
  build(0, n);
  return { bounds: bounds.slice(0, nodes * 6), meta: meta.slice(0, nodes * 2), tris, nodes };
}

/** arbol de la geometria (se arma una vez y queda en cache); null si no conviene (grupos, rango parcial) */
export function bvhOf(geometry: BufferGeometry): Bvh | null {
  let hit = cache.get(geometry);
  if (hit === undefined) {
    hit = buildBvh(geometry);
    cache.set(geometry, hit);
  }
  return hit;
}

/** arma el arbol cuando el navegador este libre, para que el primer movimiento del puntero no lo pague */
export function prepareRaycast(geometry: BufferGeometry | null | undefined): void {
  if (!geometry || cache.has(geometry) || typeof window === 'undefined') return;
  const run = () => {
    if (!cache.has(geometry)) bvhOf(geometry);
  };
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4000 });
  else window.setTimeout(run, 500);
}

const _inverse = new Matrix4();
const _ray = new Ray();
const _sphere = new Sphere();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _point = new Vector3();
const _world = new Vector3();
const _normal = new Vector3();
const _stack: number[] = [];

/** el rayo (local) cruza la caja del nodo */
function hitsBox(b: Float32Array, o: number, ray: Ray, inv: Vector3): boolean {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  let t0 = ((inv.x >= 0 ? (b[o] ?? 0) : (b[o + 3] ?? 0)) - ox) * inv.x;
  let t1 = ((inv.x >= 0 ? (b[o + 3] ?? 0) : (b[o] ?? 0)) - ox) * inv.x;
  const ty0 = ((inv.y >= 0 ? (b[o + 1] ?? 0) : (b[o + 4] ?? 0)) - oy) * inv.y;
  const ty1 = ((inv.y >= 0 ? (b[o + 4] ?? 0) : (b[o + 1] ?? 0)) - oy) * inv.y;
  if (t0 > ty1 || ty0 > t1) return false;
  if (ty0 > t0 || Number.isNaN(t0)) t0 = ty0;
  if (ty1 < t1 || Number.isNaN(t1)) t1 = ty1;
  const tz0 = ((inv.z >= 0 ? (b[o + 2] ?? 0) : (b[o + 5] ?? 0)) - oz) * inv.z;
  const tz1 = ((inv.z >= 0 ? (b[o + 5] ?? 0) : (b[o + 2] ?? 0)) - oz) * inv.z;
  if (t0 > tz1 || tz0 > t1) return false;
  if (tz0 > t0 || Number.isNaN(t0)) t0 = tz0;
  if (tz1 < t1 || Number.isNaN(t1)) t1 = tz1;
  return t1 >= 0;
}

const _inv = new Vector3();

/**
 * Para usar como `raycast` de una malla grande sin skin ni morph (prop de R3F). Mismo resultado que
 * Mesh.prototype.raycast para material de una sola cara o doble cara, sin grupos.
 */
export function fastRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection<Object3D>[]): void {
  const geometry = this.geometry;
  const material = this.material as Material | Material[];
  if (Array.isArray(material) || material === undefined) {
    MeshRaycast.call(this, raycaster, intersects);
    return;
  }
  const bvh = bvhOf(geometry);
  if (!bvh) {
    MeshRaycast.call(this, raycaster, intersects);
    return;
  }
  // primero la esfera en el mundo, como three
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  _sphere.copy(geometry.boundingSphere ?? _sphere).applyMatrix4(this.matrixWorld);
  if (!raycaster.ray.intersectsSphere(_sphere)) return;

  _inverse.copy(this.matrixWorld).invert();
  _ray.copy(raycaster.ray).applyMatrix4(_inverse);
  _inv.set(1 / _ray.direction.x, 1 / _ray.direction.y, 1 / _ray.direction.z);

  const pos = geometry.getAttribute('position');
  const side = material.side;
  const cull = side !== DoubleSide;
  const { bounds, meta, tris } = bvh;
  _stack.length = 0;
  _stack.push(0);
  while (_stack.length > 0) {
    const node = _stack.pop() ?? 0;
    if (!hitsBox(bounds, node * 6, _ray, _inv)) continue;
    const a = meta[node * 2] ?? 0;
    const count = meta[node * 2 + 1] ?? 0;
    if (count < 0) {
      _stack.push(a, node + 1);
      continue;
    }
    for (let k = a; k < a + count; k++) {
      const t = tris[k] ?? 0;
      const ia = vertexIndex(geometry, t, 0);
      const ib = vertexIndex(geometry, t, 1);
      const ic = vertexIndex(geometry, t, 2);
      _a.fromBufferAttribute(pos, ia);
      _b.fromBufferAttribute(pos, ib);
      _c.fromBufferAttribute(pos, ic);
      const hit = side === BackSide ? _ray.intersectTriangle(_c, _b, _a, true, _point) : _ray.intersectTriangle(_a, _b, _c, cull, _point);
      if (!hit) continue;
      _world.copy(_point).applyMatrix4(this.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(_world);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      Triangle.getNormal(_a, _b, _c, _normal);
      intersects.push({
        distance,
        point: _world.clone(),
        object: this,
        face: { a: ia, b: ib, c: ic, normal: _normal.clone(), materialIndex: 0 },
        faceIndex: t,
      });
    }
  }
}
