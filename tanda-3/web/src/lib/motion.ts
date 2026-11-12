// Reglas de movimiento del HUD (D5) que no se pueden expresar solo con CSS.
import { DURATION } from '@/theme';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Con movimiento reducido toda salida es un fundido de 120 ms */
export function exitDuration(ms: number, reduced: boolean): number {
  return reduced ? DURATION.reduced : ms;
}

/** Ventana de la entrada del HUD: una sola vez por carga */
export const BOOT_WINDOW_MS = 1_500;

/**
 * Retardo de la entrada de cada tarjeta flotante (D5): 240 ms + 60 ms por tarjeta mientras el HUD
 * entra; despues cada tarjeta aparece sin esperar. Tope para que una oficina llena no tarde.
 */
export function cardEnterDelay(index: number, sinceBootMs: number): number {
  if (sinceBootMs > BOOT_WINDOW_MS) return 0;
  return Math.min(240 + 60 * Math.max(0, index), 900);
}

/** Cascada de filas del historial (D5): 80 ms + 35 ms por fila, con tope */
export function rowEnterDelay(index: number): number {
  return 80 + 35 * Math.min(Math.max(0, index), 12);
}

/**
 * Desfase para que todos los LED que laten lo hagan en fase (D5: "todas las tarjetas laten juntas"):
 * un retardo negativo alineado al reloj de pared.
 */
export function phaseDelay(periodMs: number, nowMs: number): string {
  return `-${Math.round(nowMs % periodMs)}ms`;
}
