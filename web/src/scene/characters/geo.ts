// Acumulador de geometria del kit (clase Geo): primitivas no indexadas con color por vertice
// (lineal), variacion por cara, cara superior mas clara y skinning rigido (cada vertice pertenece a
// un solo hueso). Solo se usa al construir; nunca en el frame.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Quaternion,
  Uint16BufferAttribute,
  Vector3,
} from 'three';

import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type Tint = string | Color;

/** los personajes son de vinilo: toda caja con cuerpo lleva el canto redondeado */
export const SOFT = { minSide: 0.09, radius: 0.034, ratio: 0.34 } as const;

function softBox(w: number, h: number, d: number): { geo: BufferGeometry; soft: boolean } {
  const m = Math.min(w, h, d);
  const soft = m >= SOFT.minSide;
  return { geo: soft ? new RoundedBoxGeometry(w, h, d, 1, Math.min(SOFT.radius, m * SOFT.ratio)) : new BoxGeometry(w, h, d), soft };
}

export interface FaceOpts {
  /** variacion de brillo por cara (+-) */
  jitter?: number;
  /** cuanto mas clara la cara que mira arriba */
  top?: number;
  /** la variacion de color es una sola para toda la pieza (cajas redondeadas) */
  whole?: boolean;
  rx?: number;
  ry?: number;
  rz?: number;
}

export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function hashStr(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 100003;
  return h;
}

export function toColor(c: Tint): Color {
  return typeof c === 'string' ? new Color(c) : c.clone();
}

/** color * f */
export function shade(c: Tint, f: number): Color {
  return toColor(c).multiplyScalar(f);
}

/** mezcla a -> b */
export function mixTint(a: Tint, b: Tint, t: number): Color {
  return toColor(a).lerp(toColor(b), t);
}

const ST: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
];

const tmpV = new Vector3();
const tmpN = new Vector3();
const tmpM = new Matrix4();
const tmpNM = new Matrix3();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const ONE = new Vector3(1, 1, 1);

export class SkinGeo {
  private readonly p: number[] = [];
  private readonly n: number[] = [];
  private readonly c: number[] = [];
  private readonly sk: number[] = [];
  private faces = 0;
  private bone = 0;
  private readonly pre = new Matrix4();

  constructor(private readonly seed = 1) {}

  /** Lo que se agregue a continuacion pertenece al hueso i, en su espacio de reposo m */
  on(boneIndex: number, m: Matrix4): this {
    this.bone = boneIndex;
    this.pre.copy(m);
    return this;
  }

  add(g: BufferGeometry, m: Matrix4, color: Tint, o: FaceOpts = {}): this {
    const src = g.index ? g.toNonIndexed() : g;
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    tmpM.multiplyMatrices(this.pre, m);
    tmpNM.getNormalMatrix(tmpM);
    const base = toColor(color);
    for (let i = 0; i < pos.count; i++) {
      tmpV.fromBufferAttribute(pos, i).applyMatrix4(tmpM);
      tmpN.fromBufferAttribute(nor, i).applyMatrix3(tmpNM).normalize();
      this.p.push(tmpV.x, tmpV.y, tmpV.z);
      this.n.push(tmpN.x, tmpN.y, tmpN.z);
      let k = 1;
      const face = o.whole ? this.faces : this.faces + Math.floor(i / 6);
      if (o.jitter) k *= 1 + o.jitter * (hash1(face * 7.13 + this.seed) * 2 - 1);
      if (o.top && tmpN.y > 0.6) k *= 1 + o.top;
      this.c.push(base.r * k, base.g * k, base.b * k);
      this.sk.push(this.bone);
    }
    this.faces += Math.ceil(pos.count / 6);
    if (src !== g) src.dispose();
    g.dispose();
    return this;
  }

  /** caja por esquinas */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Tint, o?: FaceOpts): this {
    const { geo, soft } = softBox(Math.max(0.001, Math.abs(x1 - x0)), Math.max(0.001, Math.abs(y1 - y0)), Math.max(0.001, Math.abs(z1 - z0)));
    return this.add(geo, new Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), color, soft ? { ...o, whole: true } : o);
  }

  /** caja centrada, con giro opcional */
  boxC(cx: number, cy: number, cz: number, w: number, h: number, d: number, color: Tint, o: FaceOpts = {}): this {
    tmpE.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const m = new Matrix4().compose(new Vector3(cx, cy, cz), tmpQ.setFromEuler(tmpE), ONE);
    const { geo, soft } = softBox(w, h, d);
    return this.add(geo, m, color, soft ? { ...o, whole: true } : o);
  }

  /** cilindro con base en y0: radio r0 abajo, r1 arriba */
  cyl(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, color: Tint, seg = 8, o: FaceOpts = {}): this {
    tmpE.set(o.rx ?? 0, 0, o.rz ?? 0);
    const m = new Matrix4().compose(new Vector3(cx, y0 + h / 2, cz), tmpQ.setFromEuler(tmpE), ONE);
    return this.add(new CylinderGeometry(r1, r0, h, seg), m, color, o);
  }

  private quad(ox: number, oy: number, oz: number, a: readonly number[], b: readonly number[], color: Tint, o?: FaceOpts): this {
    const ax = a[0] ?? 0;
    const ay = a[1] ?? 0;
    const az = a[2] ?? 0;
    const bx = b[0] ?? 0;
    const by = b[1] ?? 0;
    const bz = b[2] ?? 0;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const P: number[] = [];
    const N: number[] = [];
    for (const [s, t] of ST) {
      P.push(ox + ax * s + bx * t, oy + ay * s + by * t, oz + az * s + bz * t);
      N.push(nx / l, ny / l, nz / l);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new Float32BufferAttribute(N, 3));
    return this.add(g, new Matrix4(), color, o);
  }

  /** plano que mira a +z */
  qz(x0: number, y0: number, x1: number, y1: number, z: number, color: Tint, o?: FaceOpts): this {
    return this.quad(x0, y0, z, [x1 - x0, 0, 0], [0, y1 - y0, 0], color, o);
  }

  /** plano que mira a +y */
  qy(x0: number, z0: number, x1: number, z1: number, y: number, color: Tint, o?: FaceOpts): this {
    return this.quad(x0, y, z1, [x1 - x0, 0, 0], [0, 0, z0 - z1], color, o);
  }

  get triangles(): number {
    return this.p.length / 9;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    const count = this.sk.length;
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      si[i * 4] = this.sk[i] ?? 0;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
