// Registro de fondos de cielo: cada archivo de esta carpeta que exporta `painter` queda disponible. El que
// se usa es DEFAULT_SKY, o el de ?cielo=nombre para probar otro.

import { type SkyPainter } from './shared';

export { SKY_H, SKY_W, type SkyDay, type SkyPainter } from './shared';

/** fondo con el que se dibuja la oficina */
export const DEFAULT_SKY = 'cielo';

const modules = import.meta.glob<{ painter?: SkyPainter }>('./*.ts', { eager: true });

export const SKIES: ReadonlyMap<string, SkyPainter> = new Map(
  Object.values(modules)
    .map((m) => m.painter)
    .filter((p): p is SkyPainter => p !== undefined)
    .map((p) => [p.name, p]),
);

function requested(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('cielo');
}

/** el fondo elegido: ?cielo=nombre si existe; si no, el de siempre */
export function skyPainter(): SkyPainter {
  const pick = SKIES.get(requested() ?? '') ?? SKIES.get(DEFAULT_SKY) ?? SKIES.values().next().value;
  if (!pick) throw new Error('No hay ningun fondo de cielo en scene/sky');
  return pick;
}
