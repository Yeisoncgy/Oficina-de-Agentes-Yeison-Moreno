// Un solo reloj de 1 s compartido por todas las etiquetas: los cronometros se re-renderizan una vez
// por segundo sin tocar el resto de la escena.

import { useSyncExternalStore } from 'react';
import { serverNow } from '@/state/store';

let now = serverNow();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  now = serverNow();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = serverNow();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getNow(): number {
  return now;
}

/** Hora del servidor (ms), actualizada cada segundo */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}
