// Construye mallas "low-poly" fusionando primitivas en una sola geometria con color por vertice:
// un mueble entero (o una sala entera) = 1 draw call, con el material toon compartido.
// GeoBuilder: API simple (personajes). KitGeo + Buckets: el acumulador del Kit 3D con uv, variacion
// de color por cara (jitter), cara superior mas clara (top), quads texturizados y pila de transformaciones
// para armar la sala entera en un balde por material.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { hash1, PAL, type PalKey } from './world/kit';

/**
 * Canto redondeado de los muebles: una caja con algo de cuerpo lleva un bisel suave que atrapa la luz.
 * Las piezas finas (laminas, patas, libros) y las muy largas (paredes, losas) quedan a escuadra.
 */
export const BEVEL = { minSide: 0.045, maxSide: 3.2, radius: 0.026, ratio: 0.3 } as const;

function boxGeometry(w: number, h: number, d: number, sharp: boolean): { geo: BufferGeometry; round: boolean } {
  const m = Math.min(w, h, d);
  const round = !sharp && m >= BEVEL.minSide && Math.max(w, h, d) <= BEVEL.maxSide;
  return { geo: round ? new RoundedBoxGeometry(w, h, d, 1, Math.min(BEVEL.radius, m * BEVEL.ratio)) : new BoxGeometry(w, h, d), round };
}

export type ColorLike = string | Color;

export interface Rot {
  x?: number;
  y?: number;
  z?: number;
}

const tmpMatrix = new Matrix4();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpPos = new Vector3();
const tmpScale = new Vector3(1, 1, 1);

export function toColor(c: ColorLike): Color {
  return typeof c === 'string' ? new Color(c) : c;
}

/** color * k (en espacio lineal) */
export function shade(c: ColorLike, k: number): Color {
  return toColor(c).clone().multiplyScalar(k);
}

/** mezcla a -> b */
export function mix(a: ColorLike, b: ColorLike, t: number): Color {
  return toColor(a).clone().lerp(toColor(b), t);
}

export class GeoBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];

  /** Agrega una primitiva ya creada (se consume y se libera) */
  add(geo: BufferGeometry, x: number, y: number, z: number, color: ColorLike, rot?: Rot, scale?: [number, number, number]): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    tmpEuler.set(rot?.x ?? 0, rot?.y ?? 0, rot?.z ?? 0);
    tmpQuat.setFromEuler(tmpEuler);
    tmpScale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    tmpMatrix.compose(tmpPos.set(x, y, z), tmpQuat, tmpScale);
    g.applyMatrix4(tmpMatrix);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const col = toColor(color);
    for (let i = 0; i < pos.count; i++) {
      this.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      this.colors.push(col.r, col.g, col.b);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, rot?: Rot): this {
    return this.add(new BoxGeometry(w, h, d), x, y, z, color, rot);
  }

  /** caja por esquinas min/max (paredes, zocalos) */
  boxMM(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: ColorLike): this {
    return this.box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, color);
  }

  /** cilindro con base en y (no centrado): de y a y + h */
  cyl(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: ColorLike, segments = 8, rot?: Rot): this {
    return this.add(new CylinderGeometry(rTop, rBottom, h, segments), x, y + h / 2, z, color, rot);
  }

  /** cilindro centrado en (x, y, z), util girado (esferas de reloj, tazas de lado) */
  cylC(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: ColorLike, segments = 8, rot?: Rot): this {
    return this.add(new CylinderGeometry(rTop, rBottom, h, segments), x, y, z, color, rot);
  }

  ico(r: number, x: number, y: number, z: number, color: ColorLike, scale?: [number, number, number]): this {
    return this.add(new IcosahedronGeometry(r, 0), x, y, z, color, undefined, scale);
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- acumulador del Kit 3D

/** color de la paleta del kit, '#hex' o Color (lineal) */
export type KitColor = PalKey | string | Color;

export function kitColor(c: KitColor): Color {
  if (c instanceof Color) return c.clone();
  return new Color(c in PAL ? PAL[c as PalKey] : c);
}

/** color del kit multiplicado (sombra) */
export function kshade(c: KitColor, f: number): Color {
  return kitColor(c).multiplyScalar(f);
}

export interface FaceOpts {
  /** variacion de brillo por cara (+-) */
  jitter?: number;
  /** caras que miran arriba, mas claras */
  top?: number;
  /** sin bisel: piezas que se juntan a tope (paredes, losas, cordones) */
  sharp?: boolean;
  /** la variacion de color es una sola para toda la pieza (cajas biseladas) */
  whole?: boolean;
  /** region de textura [u0, v0, u1, v1] para quads */
  uvRect?: readonly [number, number, number, number];
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const ST: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
];

const kv = new Vector3();
const kn = new Vector3();
const kNormal = new Matrix3();
const kM = new Matrix4();

/** matriz de colocacion: traslacion + giro en y */
export function M4(x: number, y: number, z: number, ry = 0): Matrix4 {
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(0, ry, 0)), new Vector3(1, 1, 1));
}

/** Geometria no indexada con color por vertice (lineal), uv y variacion por cara. `pre` = matriz de colocacion */
export class KitGeo {
  private p: number[] = [];
  private n: number[] = [];
  private c: number[] = [];
  private uv: number[] = [];
  private faces = 0;
  pre: Matrix4 | null = null;

  /** preFn: colocacion vigente al momento de agregar (la pila de Buckets) */
  constructor(
    private readonly seed = 1,
    private readonly preFn?: () => Matrix4 | null,
  ) {}

  get vertexCount(): number {
    return this.p.length / 3;
  }

  add(g: BufferGeometry, m: Matrix4, color: KitColor, o: FaceOpts = {}): this {
    const src = g.index ? g.toNonIndexed() : g;
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    const uv = src.getAttribute('uv');
    const pre = this.preFn ? this.preFn() : this.pre;
    const M = pre ? kM.multiplyMatrices(pre, m) : m;
    kNormal.getNormalMatrix(M);
    const base = kitColor(color);
    const r = o.uvRect;
    for (let i = 0; i < pos.count; i++) {
      kv.fromBufferAttribute(pos, i).applyMatrix4(M);
      kn.fromBufferAttribute(nor, i).applyMatrix3(kNormal).normalize();
      this.p.push(kv.x, kv.y, kv.z);
      this.n.push(kn.x, kn.y, kn.z);
      let k = 1;
      const face = o.whole ? this.faces : this.faces + Math.floor(i / 6);
      if (o.jitter) k *= 1 + o.jitter * (hash1(face * 7.13 + this.seed) * 2 - 1);
      if (o.top && kn.y > 0.6) k *= 1 + o.top;
      this.c.push(base.r * k, base.g * k, base.b * k);
      if (uv && r) this.uv.push(r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
      else if (uv && !r) this.uv.push(uv.getX(i), uv.getY(i));
      else this.uv.push(0, 0);
    }
    this.faces += Math.ceil(pos.count / 6);
    if (src !== g) src.dispose();
    g.dispose();
    return this;
  }

  /** caja por esquinas */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: KitColor, o?: FaceOpts): this {
    const { geo, round } = boxGeometry(Math.max(0.001, Math.abs(x1 - x0)), Math.max(0.001, Math.abs(y1 - y0)), Math.max(0.001, Math.abs(z1 - z0)), o?.sharp === true);
    return this.add(geo, new Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), color, round ? { ...o, whole: true } : o);
  }

  /** caja por centro con giro opcional (rx, ry, rz) */
  boxC(cx: number, cy: number, cz: number, w: number, h: number, d: number, color: KitColor, o: FaceOpts = {}): this {
    const m = new Matrix4().compose(
      new Vector3(cx, cy, cz),
      new Quaternion().setFromEuler(new Euler(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0)),
      new Vector3(1, 1, 1),
    );
    const { geo, round } = boxGeometry(w, h, d, o.sharp === true);
    return this.add(geo, m, color, round ? { ...o, whole: true } : o);
  }

  /** cilindro con base en y0: r0 abajo, r1 arriba */
  cyl(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, color: KitColor, seg = 8, o: FaceOpts = {}): this {
    const m = new Matrix4().compose(
      new Vector3(cx, y0 + h / 2, cz),
      new Quaternion().setFromEuler(new Euler(o.rx ?? 0, 0, o.rz ?? 0)),
      new Vector3(1, 1, 1),
    );
    return this.add(new CylinderGeometry(r1, r0, h, seg), m, color, o);
  }

  ico(cx: number, cy: number, cz: number, r: number, color: KitColor, o: FaceOpts = {}): this {
    const m = new Matrix4().compose(
      new Vector3(cx, cy, cz),
      new Quaternion().setFromEuler(new Euler(o.rx ?? 0, o.ry ?? 0, 0)),
      new Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1),
    );
    return this.add(new IcosahedronGeometry(r, 0), m, color, o);
  }

  /** quad desde el origen o con lados a y b; uv 0..1 (o uvRect) */
  quad(o: readonly number[], a: readonly number[], b: readonly number[], color: KitColor, opt: FaceOpts = {}): this {
    const [ox = 0, oy = 0, oz = 0] = o;
    const [ax = 0, ay = 0, az = 0] = a;
    const [bx = 0, by = 0, bz = 0] = b;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const P: number[] = [];
    const U: number[] = [];
    const N: number[] = [];
    for (const [s, t] of ST) {
      P.push(ox + ax * s + bx * t, oy + ay * s + by * t, oz + az * s + bz * t);
      U.push(s, t);
      N.push(nx / l, ny / l, nz / l);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new Float32BufferAttribute(U, 2));
    return this.add(g, new Matrix4(), color, opt);
  }

  /** quad vertical que mira a +z */
  qz(x0: number, y0: number, x1: number, y1: number, z: number, c: KitColor, o?: FaceOpts): this {
    return this.quad([x0, y0, z], [x1 - x0, 0, 0], [0, y1 - y0, 0], c, o);
  }

  /** quad horizontal que mira a +y; la parte de arriba de la textura queda hacia -z */
  qy(x0: number, z0: number, x1: number, z1: number, y: number, c: KitColor, o?: FaceOpts): this {
    return this.quad([x0, y, z1], [x1 - x0, 0, 0], [0, 0, z0 - z1], c, o);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Baldes por material (toon, lit, floor, sky, bulb, glowLamp...) con una pila de colocaciones:
 * cada pieza del kit se arma en su origen y `place` la pone en la sala. Todo lo estatico de una sala
 * termina en una malla por balde.
 */
export class Buckets<K extends string> {
  private readonly geos = new Map<K, KitGeo>();
  private readonly stack: Matrix4[] = [];

  constructor(private readonly seed = 1) {}

  private current(): Matrix4 | null {
    return this.stack.length ? (this.stack[this.stack.length - 1] ?? null) : null;
  }

  geo(bucket: K): KitGeo {
    let g = this.geos.get(bucket);
    if (!g) {
      g = new KitGeo(this.seed + this.geos.size * 17, () => this.current());
      this.geos.set(bucket, g);
    }
    return g;
  }

  /** arma lo que haga `draw` con la colocacion m (compuesta con la actual) */
  place(m: Matrix4, draw: () => void): void {
    const cur = this.current();
    this.stack.push(cur ? cur.clone().multiply(m) : m.clone());
    try {
      draw();
    } finally {
      this.stack.pop();
    }
  }

  /** una geometria por balde con vertices */
  build(): Partial<Record<K, BufferGeometry>> {
    const out: Partial<Record<K, BufferGeometry>> = {};
    for (const [k, g] of this.geos) if (g.vertexCount > 0) out[k] = g.build();
    return out;
  }
}
