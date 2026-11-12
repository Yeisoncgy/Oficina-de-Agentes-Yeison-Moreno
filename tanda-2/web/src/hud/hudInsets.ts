// Medicion del HUD para la camara: cada panel visible se registra con su borde (useHudEdge) y la raiz
// del HUD (useHudInsetsRoot) publica en el store cuanto tapa por cada lado. Se mide con offset* (sin las
// transformaciones de las animaciones) en un solo cuadro por tanda de cambios; el store ignora repetidos.
import { useCallback } from 'react';
import { computeHudInsets, type EdgeBox, type HudEdge } from '@/lib/insets';
import { useOfficeStore } from '@/state/store';

const panels = new Map<HTMLElement, HudEdge>();
let root: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let scheduled = false;

function resizeObserver(): ResizeObserver | null {
  if (observer) return observer;
  if (typeof ResizeObserver === 'undefined') return null;
  observer = new ResizeObserver(schedule);
  return observer;
}

function schedule(): void {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    measure();
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
  else window.setTimeout(run, 16);
}

/** caja del elemento relativa a la raiz del HUD (que cubre la ventana) */
function layoutBox(el: HTMLElement, base: HTMLElement): Omit<EdgeBox, 'edge'> | null {
  if (!el.isConnected || el.offsetWidth === 0 || el.offsetHeight === 0) return null;
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== base) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  if (node !== base) return null;
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

function measure(): void {
  const base = root;
  if (!base) return;
  const boxes: EdgeBox[] = [];
  for (const [el, edge] of panels) {
    const box = layoutBox(el, base);
    if (box) boxes.push({ edge, ...box });
  }
  useOfficeStore
    .getState()
    .setHudInsets(computeHudInsets(boxes, { width: base.clientWidth, height: base.clientHeight }));
}

/** Ref de la raiz del HUD: mide al montar, al cambiar la ventana y cuando cambia un panel */
export function useHudInsetsRoot(): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    root = el;
    resizeObserver()?.observe(el);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer?.unobserve(el);
      window.removeEventListener('resize', schedule);
      if (root === el) root = null;
    };
  }, []);
}

/** Ref de un panel que tapa la escena por `edge`; con active=false (p. ej. mientras sale) deja de contar */
export function useHudEdge(edge: HudEdge, active = true): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || !active) return undefined;
      panels.set(el, edge);
      resizeObserver()?.observe(el);
      schedule();
      return () => {
        panels.delete(el);
        observer?.unobserve(el);
        schedule();
      };
    },
    [edge, active],
  );
}
