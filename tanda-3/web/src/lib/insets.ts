// Cuanto tapa el HUD de cada lado de la ventana, a partir de las cajas de sus paneles visibles.
import type { HudInsets } from '@/state/store';

export type HudEdge = keyof HudInsets;

/** caja de un panel en px de ventana (sin transformaciones: las animaciones de entrada no cuentan) */
export interface EdgeBox {
  edge: HudEdge;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * top = borde inferior mas bajo de los paneles de arriba · left = borde derecho de los de la izquierda ·
 * right = desde el borde izquierdo de los de la derecha · bottom = desde el borde superior de los de abajo.
 * Redondeado y acotado a la ventana. Sin margen extra: el respiro lo decide quien encuadra.
 */
export function computeHudInsets(boxes: readonly EdgeBox[], viewport: { width: number; height: number }): HudInsets {
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  for (const b of boxes) {
    if (!(b.width > 0 && b.height > 0)) continue;
    if (b.edge === 'top') top = Math.max(top, b.y + b.height);
    else if (b.edge === 'bottom') bottom = Math.max(bottom, viewport.height - b.y);
    else if (b.edge === 'left') left = Math.max(left, b.x + b.width);
    else right = Math.max(right, viewport.width - b.x);
  }
  const fit = (value: number, max: number) => Math.round(Math.min(Math.max(0, value), Math.max(0, max)));
  return {
    top: fit(top, viewport.height),
    right: fit(right, viewport.width),
    bottom: fit(bottom, viewport.height),
    left: fit(left, viewport.width),
  };
}
