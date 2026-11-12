import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { exitDuration, prefersReducedMotion } from '@/lib/motion';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** prefers-reduced-motion, leido al iniciar y en cada cambio (D5) */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function readWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, readWidth, () => 1440);
}

/**
 * Mantiene montado el ultimo valor mientras corre su animacion de salida.
 * `leaving` = el valor ya no esta, pero se sigue mostrando para animar la salida.
 */
export function usePresence<T>(value: T | null, exitMs: number): { shown: T | null; leaving: boolean } {
  const reduced = useReducedMotion();
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  const present = value !== null;
  const [prevPresent, setPrevPresent] = useState(present);
  const [leaving, setLeaving] = useState(false);
  if (present !== prevPresent) {
    // se ajusta en el mismo render para no pintar un cuadro vacio entre la salida y el desmontaje
    setPrevPresent(present);
    setLeaving(!present);
  }

  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(false), exitDuration(exitMs, reduced));
    return () => window.clearTimeout(id);
  }, [leaving, exitMs, reduced]);

  if (present) return { shown: value, leaving: false };
  return { shown: leaving ? last.current : null, leaving };
}
