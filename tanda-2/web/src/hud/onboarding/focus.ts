import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>;

/** Tab y Shift+Tab dan la vuelta dentro del dialogo */
export function trapTab(event: KeyLike, root: HTMLElement | null): void {
  if (event.key !== 'Tab' || !root) return;
  const active = document.activeElement;
  const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === active),
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const outside = !root.contains(active);
  if (event.shiftKey && (outside || active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

/** teclas que el HUD atiende en window (useHudHotkeys): Esc, Tab y los atajos H, A y F */
export function isHudKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  if (event.key === 'Escape' || event.key === 'Tab') return true;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return /^[haf]$/i.test(event.key);
}

/**
 * Con el foco fuera del dialogo (clic en el fondo, un boton que se desmonto con el foco) las teclas irian
 * directo al HUD de atras. Se atienden en la fase de captura, antes que useHudHotkeys; con el foco adentro,
 * decide el onKeyDown del dialogo.
 */
export function useKeysOutside(rootRef: RefObject<HTMLElement | null>, onKey: (event: KeyboardEvent) => void): void {
  const handler = useRef(onKey);
  handler.current = onKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || (event.target instanceof Node && root.contains(event.target))) return;
      handler.current(event);
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [rootRef]);
}

/**
 * Al cerrar, el foco vuelve a donde estaba; salvo que otro dialogo ya lo haya tomado (la guia que abre
 * "Cambiar mi nombre" no debe quitarle el foco al campo del nombre).
 */
export function restoreFocus(previous: HTMLElement | null): void {
  const active = document.activeElement;
  if (previous?.isConnected && (active === null || active === document.body)) previous.focus();
}
