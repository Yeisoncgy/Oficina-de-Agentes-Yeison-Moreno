// Nivel de calidad de la escena. "auto" arranca segun la tarjeta grafica (dedicada: alta; integrada: media;
// sin aceleracion: baja) y el gobernador del revelado lo baja si el equipo no da. El usuario puede fijarlo
// desde la barra (se recuerda en el navegador) o con ?calidad=alta|media|baja.

import { useSyncExternalStore } from 'react';

export type Quality = 'alta' | 'media' | 'baja';
export type QualityMode = 'auto' | Quality;

export const QUALITY_MODES: readonly QualityMode[] = ['auto', 'alta', 'media', 'baja'];
export const QUALITY_KEY = 'oficina.calidad';

/**
 * Que lleva cada nivel: oclusion ambiental, resolucion maxima (px fisicos por px CSS; por debajo de 1 se
 * dibuja mas chico y el navegador lo estira), antialias, desenfoque de miniatura y lado del mapa de sombras.
 * La luz y los materiales son los mismos en los tres: baja se ve un poco menos nitida, no distinta.
 */
export const QUALITY: Readonly<Record<Quality, { ao: boolean; dpr: number; samples: number; tilt: boolean; shadow: number }>> = {
  alta: { ao: true, dpr: 1.5, samples: 4, tilt: true, shadow: 2048 },
  media: { ao: false, dpr: 1.25, samples: 4, tilt: true, shadow: 1024 },
  baja: { ao: false, dpr: 0.75, samples: 2, tilt: false, shadow: 1024 },
};

const ORDER: readonly Quality[] = ['alta', 'media', 'baja'];

function isQuality(v: unknown): v is Quality {
  return v === 'alta' || v === 'media' || v === 'baja';
}

/**
 * Nivel de partida segun el nombre de la tarjeta (WEBGL_debug_renderer_info). Las integradas y las
 * desconocidas empiezan en media: es mas barato subir a mano que arrancar a tirones.
 */
export function qualityForGpu(renderer: string | null): Quality {
  const r = (renderer ?? '').toLowerCase();
  if (!r) return 'media';
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(r)) return 'baja';
  if (/nvidia|geforce|rtx|gtx|quadro|radeon (rx|pro)|\barc\b|apple m\d/.test(r)) return 'alta';
  return 'media';
}

function readGpu(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return null;
  }
}

function readPinned(): Quality | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('calidad');
  return isQuality(raw) ? raw : null;
}

function readMode(): QualityMode {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(QUALITY_KEY);
    return isQuality(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

interface State {
  mode: QualityMode;
  /** nivel con el que se dibuja */
  level: Quality;
  /** el gobernador ya lo bajo en esta carga */
  lowered: boolean;
}

const pinned = readPinned();
let gpuLevel: Quality | null = null;
const autoLevel = (): Quality => (gpuLevel ??= qualityForGpu(readGpu()));

function initial(): State {
  const mode: QualityMode = pinned ?? readMode();
  return { mode, level: mode === 'auto' ? autoLevel() : mode, lowered: false };
}

let state: State | null = null;
const current = (): State => (state ??= initial());
const listeners = new Set<() => void>();

function emit(next: State): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQuality(): Quality {
  return current().level;
}

export function getQualityMode(): QualityMode {
  return current().mode;
}

/** elige el nivel a mano (o vuelve a automatico) y lo recuerda */
export function setQualityMode(mode: QualityMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(QUALITY_KEY);
    else localStorage.setItem(QUALITY_KEY, mode);
  } catch {
    // sin almacenamiento: vale solo para esta carga
  }
  emit({ mode, level: mode === 'auto' ? autoLevel() : mode, lowered: false });
}

/** el gobernador: baja un nivel si esta en automatico. Devuelve false si ya no puede bajar. */
export function lowerQuality(): boolean {
  const s = current();
  if (s.mode !== 'auto') return false;
  const next = ORDER[ORDER.indexOf(s.level) + 1];
  if (!next) return false;
  emit({ mode: 'auto', level: next, lowered: true });
  return true;
}

export function useQuality(): Quality {
  return useSyncExternalStore(
    subscribe,
    () => current().level,
    () => 'media' as Quality,
  );
}

export function useQualityMode(): QualityMode {
  return useSyncExternalStore(
    subscribe,
    () => current().mode,
    () => 'auto' as QualityMode,
  );
}
