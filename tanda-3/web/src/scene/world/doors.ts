// Puertas que se abren al paso: cerrada a 13 grados cuando nadie esta a mas de 1,3 u, abierta a 77 grados
// a 0,7 u. Solo el paso de un personaje abre la puerta: cada personaje que camina avisa su posicion de
// mundo cada frame (reportWalker). Los cambios del snapshot (llegadas, bajas, reasignaciones) no abren nada.

import { AMBIENT } from './ambient';

export const DOOR_CLOSED = 0.22;
export const DOOR_OPEN = 1.35;

const MAX_WALKERS = 64;
const walkers = Array.from({ length: MAX_WALKERS }, () => ({ x: 0, z: 0, at: -99 }));
let cursor = 0;

/** un personaje que camina avisa donde esta (coordenadas de mundo). Sin asignaciones. */
export function reportWalker(x: number, z: number): void {
  const w = walkers[cursor];
  if (!w) return;
  w.x = x;
  w.z = z;
  w.at = AMBIENT.clock;
  cursor = (cursor + 1) % MAX_WALKERS;
}

/** 0 cerrada · 1 abierta, segun el caminante mas cercano a (x, z) del ultimo instante */
export function walkerOpen(x: number, z: number): number {
  let open = 0;
  const now = AMBIENT.clock;
  for (const w of walkers) {
    if (now - w.at > 0.12) continue;
    const d = Math.hypot(w.x - x, w.z - z);
    open = Math.max(open, 1 - Math.min(1, Math.max(0, (d - 0.7) / 0.6)));
  }
  return open;
}
