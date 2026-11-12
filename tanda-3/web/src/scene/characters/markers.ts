// Piezas sueltas del personaje: flecha y anillo de seleccion (ambar del kit), el "!" de alerta viva y
// la caja invisible que recibe el clic. Geometria compartida por todo el elenco.

import { BoxGeometry, RingGeometry } from 'three';
import { STATE } from '@/theme';
import { GeoBuilder } from '../builder';
import { KIT_PAL } from './looks';

/** Altura de la flecha de seleccion sobre los pies (por encima de cascos y moños) */
export const ARROW_Y = 1.32;
/** Altura de la tarjeta flotante sobre los pies */
export const LABEL_Y = 1.64;
/** Con la flecha puesta, el "!" se corre a su lado (u, hacia la derecha de la pantalla) */
export const ALERT_SIDE = 0.24;
/** Media anchura del "!" con su respaldo de tinta, sin el latido (u) */
export const ALERT_HALF_W = 0.08;
/** Aire entre el "!" y la burbuja o el "?" (u) */
const HEAD_SPRITE_GAP = 0.04;
/** El "!" no cambia de lado mientras el sprite siga a menos de esto del centro (vaiven de la cabeza) */
const SIDE_SWAP = 0.05;

/** Burbuja de pensar o "?" de espera, tal como cae en pantalla respecto al centro del personaje (u) */
export interface HeadSprite {
  /** + = a la derecha de la pantalla */
  x: number;
  halfW: number;
}

/** Acimut de la vista (hacia la camara) desde su cuaternion; la camara es ortografica: vale para todos */
export function viewAzimuth(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

/**
 * Corrimiento del "!" hacia la derecha de la pantalla (u). Sin burbuja ni "?" va al lado de la flecha, o
 * centrado si no hay flecha. Con uno de ellos a la vista se va al lado contrario, lo bastante lejos para no
 * pisarlo ni pisar la flecha. `prev` es el corrimiento del cuadro anterior: con el sprite casi centrado no
 * salta de lado en cada vaiven. `pulse` = cuanto crece el "!" al latir.
 */
export function alertOffset(arrow: boolean, sprite: HeadSprite | null, prev: number, pulse = 0): number {
  if (!sprite) return arrow ? ALERT_SIDE : 0;
  const away = sprite.x >= 0 ? -1 : 1;
  const keep = prev !== 0 && Math.sign(prev) !== away && Math.abs(sprite.x) < SIDE_SWAP;
  const dir = keep ? Math.sign(prev) : away;
  const need = sprite.halfW + ALERT_HALF_W * (1 + pulse) + HEAD_SPRITE_GAP;
  return dir * Math.max(ALERT_SIDE, need + dir * sprite.x);
}

function buildArrow() {
  const b = new GeoBuilder();
  const c = KIT_PAL.amber;
  b.boxMM(-0.04, 0.12, -0.03, 0.04, 0.26, 0.03, c);
  b.boxMM(-0.13, 0.08, -0.03, 0.13, 0.12, 0.03, c);
  b.boxMM(-0.09, 0.04, -0.03, 0.09, 0.08, 0.03, c);
  b.boxMM(-0.045, 0, -0.03, 0.045, 0.04, 0.03, c);
  return b.build();
}

/** "!" pixelado en el rojo de error de D2, con respaldo de tinta; mide lo mismo que la flecha */
function buildAlert() {
  const b = new GeoBuilder();
  const c = STATE.error;
  const k = KIT_PAL.ink;
  b.boxMM(-0.055, 0.17, -0.03, 0.055, 0.26, 0.03, c);
  b.boxMM(-0.04, 0.09, -0.03, 0.04, 0.17, 0.03, c);
  b.boxMM(-0.04, 0, -0.03, 0.04, 0.06, 0.03, c);
  b.boxMM(-0.08, 0.07, -0.05, 0.08, 0.285, -0.03, k);
  b.boxMM(-0.065, -0.025, -0.05, 0.065, 0.085, -0.03, k);
  return b.build();
}

export const arrowGeometry = buildArrow();
export const alertGeometry = buildAlert();
/** anillo pixelado en el piso bajo el seleccionado */
export const ringGeometry = new RingGeometry(0.3, 0.37, 12).rotateX(-Math.PI / 2);
export const hitboxGeometry = new BoxGeometry(1, 1, 1);
