// Donde esta cada personaje (coordenadas de mundo), para que el mundo reaccione a su paso sin
// conocer al elenco: por ejemplo la puerta que se abre ligada a la distancia (D5: cerrada a 1,3 u,
// abierta a 0,7 u). Cada personaje actualiza su entrada en su frame; leer no asigna memoria.

export interface Presence {
  x: number;
  z: number;
  /** false mientras no se ve (aun no aparece o ya se fue) */
  active: boolean;
}

const entries: Presence[] = [];

export function registerPresence(): Presence {
  const p: Presence = { x: 0, z: 0, active: false };
  entries.push(p);
  return p;
}

export function unregisterPresence(p: Presence): void {
  const i = entries.indexOf(p);
  if (i < 0) return;
  const last = entries.pop();
  if (last && last !== p) entries[i] = last;
}

/** Distancia (plano xz) del personaje activo mas cercano al punto; Infinity si no hay nadie */
export function nearestCharacterDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i];
    if (!p || !p.active) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) best = d;
  }
  return best;
}
