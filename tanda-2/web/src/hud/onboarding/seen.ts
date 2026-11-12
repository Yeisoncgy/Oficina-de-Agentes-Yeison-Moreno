// Lo que la guia recuerda en este navegador. Todo con try/catch: sin almacenamiento local (ventana privada,
// sitio bloqueado) la guia se vuelve a ofrecer en la proxima carga y nada mas.

export const TOUR_SEEN_KEY = 'oficina.guia-vista';
/** pista inicial "Haz clic en un agente" (Hint en Hud.tsx) */
export const HINT_KEY = 'oficina.pista-inicial';

export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function readTourSeen(): boolean {
  return readFlag(TOUR_SEEN_KEY);
}

/** al terminar u omitir la guia: tampoco hace falta la pista inicial, que diria lo mismo */
export function markTourSeen(): void {
  for (const key of [TOUR_SEEN_KEY, HINT_KEY]) {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // sin almacenamiento local: la guia vuelve a ofrecerse en la proxima carga
    }
  }
}
