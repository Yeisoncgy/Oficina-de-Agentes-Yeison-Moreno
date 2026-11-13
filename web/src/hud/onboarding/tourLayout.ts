// Geometria de la guia: caja resaltada y lugar de la tarjeta, en px de ventana. Puro.
import type { HudInsets } from '@/state/store';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** respiro entre la ventana y la tarjeta */
const MARGIN = 12;
/** espacio entre el aro y la tarjeta */
const GAP = 14;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(value, hi));

/** caja que envuelve las visibles; las de tamano 0 (display: none, fuera de pantalla) no cuentan */
export function unionBox(boxes: readonly Box[]): Box | null {
  const shown = boxes.filter((b) => b.width > 0 && b.height > 0);
  if (shown.length === 0) return null;
  const x = Math.min(...shown.map((b) => b.x));
  const y = Math.min(...shown.map((b) => b.y));
  const right = Math.max(...shown.map((b) => b.x + b.width));
  const bottom = Math.max(...shown.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** lo que el HUD deja libre para la escena (hudInsets); null si no queda nada */
export function freeArea(insets: HudInsets, viewport: Size): Box | null {
  const width = viewport.width - insets.left - insets.right;
  const height = viewport.height - insets.top - insets.bottom;
  if (width <= 0 || height <= 0) return null;
  return { x: insets.left, y: insets.top, width, height };
}

/** caja del aro: el objetivo con un respiro, sin salirse de la ventana (el aro de 2 px sigue visible) */
export function spotBox(target: Box, viewport: Size, pad = 6): Box {
  const x = clamp(target.x - pad, 2, viewport.width - 2);
  const y = clamp(target.y - pad, 2, viewport.height - 2);
  const right = clamp(target.x + target.width + pad, x, viewport.width - 2);
  const bottom = clamp(target.y + target.height + pad, y, viewport.height - 2);
  return { x, y, width: right - x, height: bottom - y };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function fits(box: Box, viewport: Size): boolean {
  return (
    box.x >= MARGIN &&
    box.y >= MARGIN &&
    box.x + box.width <= viewport.width - MARGIN &&
    box.y + box.height <= viewport.height - MARGIN
  );
}

/**
 * Esquina de la tarjeta: debajo, arriba, a la derecha o a la izquierda del objetivo, en ese orden, la
 * primera que quepa entera sin taparlo. Si ninguna cabe (un objetivo enorme, como la escena), va adentro,
 * abajo al centro. Sin objetivo, al centro de la ventana.
 */
export function placeCard(target: Box | null, card: Size, viewport: Size): { x: number; y: number } {
  const maxX = viewport.width - card.width - MARGIN;
  const maxY = viewport.height - card.height - MARGIN;
  if (!target) {
    return {
      x: Math.round(clamp((viewport.width - card.width) / 2, MARGIN, maxX)),
      y: Math.round(clamp((viewport.height - card.height) / 2, MARGIN, maxY)),
    };
  }
  const alignX = clamp(target.x + target.width / 2 - card.width / 2, MARGIN, maxX);
  const alignY = clamp(target.y + target.height / 2 - card.height / 2, MARGIN, maxY);
  const candidates = [
    { x: alignX, y: target.y + target.height + GAP },
    { x: alignX, y: target.y - GAP - card.height },
    { x: target.x + target.width + GAP, y: alignY },
    { x: target.x - GAP - card.width, y: alignY },
  ];
  const spot = candidates.find((c) => {
    const box = { ...c, ...card };
    return fits(box, viewport) && !overlaps(box, target);
  });
  const chosen = spot ?? { x: alignX, y: clamp(target.y + target.height - card.height - GAP, MARGIN, maxY) };
  return { x: Math.round(chosen.x), y: Math.round(chosen.y) };
}

export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
