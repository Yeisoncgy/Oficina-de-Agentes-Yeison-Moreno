import { useEffect, useState } from 'react';
import { serverNow } from '@/state/store';

/**
 * Reloj que avanza cada `intervalMs`. 'server' corrige con el offset del snapshot (cronometros);
 * 'local' es la hora de esta maquina (reloj de la placa).
 */
export function useNow(intervalMs = 1_000, clock: 'server' | 'local' = 'server', active = true): number {
  const read = clock === 'server' ? serverNow : Date.now;
  const [now, setNow] = useState(read);
  useEffect(() => {
    if (!active) return;
    setNow(read());
    const id = window.setInterval(() => setNow(read()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active, read]);
  return now;
}
