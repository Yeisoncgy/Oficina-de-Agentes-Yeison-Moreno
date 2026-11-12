// Pequeno puente entre la escena 3D y el DOM que la contiene: cursor de mano y doble clic.

let rootEl: HTMLElement | null = null;
let lastRoomDoubleClick = 0;

export function registerSceneRoot(el: HTMLElement | null): void {
  rootEl = el;
}

export function sceneRoot(): HTMLElement | null {
  return rootEl;
}

export function setSceneCursor(pointer: boolean): void {
  if (rootEl) rootEl.style.cursor = pointer ? 'pointer' : '';
}

/** una sala atendio el doble clic (asi el doble clic en el vacio no reencuadra todo) */
export function markRoomDoubleClick(): void {
  lastRoomDoubleClick = performance.now();
}

export function roomHandledDoubleClickRecently(windowMs = 300): boolean {
  return performance.now() - lastRoomDoubleClick < windowMs;
}
