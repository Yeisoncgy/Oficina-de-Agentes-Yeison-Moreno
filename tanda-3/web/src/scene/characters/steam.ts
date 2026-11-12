// Vapor de la taza (D1 "microdetalles de vida", tiempos de D5): 6 particulas a 1/6 de ciclo, 2,2 s de
// vida, suben 0,35 u con vaiven de 0,03 u y opacidad en arco (maximo 55 %). Va colgado del hueso de
// la taza, asi sigue a la mano y se oculta con ella. update no asigna memoria.

import { AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, Points, PointsMaterial } from 'three';
import { KIT_PAL } from './looks';

const COUNT = 6;
const LIFE = 2.2;
const RISE = 0.35;
const MAX_ALPHA = 0.55;
/** borde superior de la taza en el espacio de su hueso */
const MUG_TOP = 0.045;

export const steamMaterial = new PointsMaterial({
  size: 2,
  sizeAttenuation: false,
  vertexColors: true,
  blending: AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
steamMaterial.name = 'vapor';

const cream = new Color(KIT_PAL.cream);

export interface Steam {
  points: Points;
  /** t en segundos; on = la taza esta en la mano y el movimiento no esta reducido */
  update(t: number, on: boolean): void;
  dispose(): void;
}

export function createSteam(): Steam {
  const geo = new BufferGeometry();
  const pos = new Float32BufferAttribute(new Float32Array(COUNT * 3), 3);
  const col = new Float32BufferAttribute(new Float32Array(COUNT * 3), 3);
  geo.setAttribute('position', pos);
  geo.setAttribute('color', col);
  const points = new Points(geo, steamMaterial);
  points.name = 'vapor';
  points.frustumCulled = false;
  points.visible = false;
  return {
    points,
    update(t, on) {
      points.visible = on;
      if (!on) return;
      for (let j = 0; j < COUNT; j++) {
        const life = (t / LIFE + j / COUNT) % 1;
        pos.setXYZ(j, Math.sin(life * 6 + j) * 0.03, MUG_TOP + life * RISE, Math.cos(life * 5 + j) * 0.02);
        const a = MAX_ALPHA * Math.sin(life * Math.PI);
        col.setXYZ(j, cream.r * a, cream.g * a, cream.b * a);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
    },
  };
}
