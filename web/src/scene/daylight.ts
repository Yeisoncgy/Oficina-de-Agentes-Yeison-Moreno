// Luz de la oficina. Sigue la hora real (tarde dorada, atardecer, noche) salvo que el usuario la fije con
// el control de hora de la barra de arriba (setTimeMode) o con ?hora=H. El reloj de pared de las salas
// siempre marca la hora real. dayStateAt es pura; el store se recalcula cada minuto.

import { useSyncExternalStore } from 'react';
import { Color, Vector3 } from 'three';
import { type LightKey, lightKey, sunDirection } from './world/kit';

/** lamparas encendidas de 18:00 a 06:30 (D5) */
export const LAMPS_ON_FROM = 18;
export const LAMPS_OFF_AT = 6.5;

export interface DayState {
  /** hora de la luz: la real, la que fijo el usuario o la de ?hora */
  hour: number;
  /** hora que marca el reloj de pared (la real salvo ?hora) */
  clockHour: number;
  /** 0 noche · 1 pleno dia (peso normalizado) */
  daylight: number;
  /** 0..1 cuanto de amanecer/atardecer */
  dusk: number;
  /** 0..1 cuanto de noche cerrada (estrellas) */
  night: number;
  lampsOn: boolean;
  /** color de fondo cuando el pixelado esta apagado */
  sky: Color;
  skyTop: Color;
  skyBottom: Color;
  sunColor: Color;
  sunIntensity: number;
  /** direccion unitaria hacia el sol o la luna (siempre entra por detras de la pared del fondo) */
  sunDirection: Vector3;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  /** el kit no usa luz ambiente (queda en 0 por compatibilidad) */
  ambientColor: Color;
  ambientIntensity: number;
  /** 0.35 de dia · 1 de noche: fuerza de lampara del kit */
  lampI: number;
  /** 0..1 estrellas del fondo */
  stars: number;
  /** halo de pantallas: mas fuerte de noche (D1) */
  glowNight: number;
  /** mezcla completa del kit para quien la necesite (cielo de las ventanas) */
  key: LightKey;
}

export function dayStateAt(hourInput: number, clockHour = hourInput): DayState {
  const key = lightKey(hourInput);
  const W = key.W;
  const hour = W.h;
  const lampsOn = hour >= LAMPS_ON_FROM || hour < LAMPS_OFF_AT;
  const dir = { x: 0, y: 1, z: 0 };
  sunDirection(W, dir);
  return {
    hour,
    clockHour: ((clockHour % 24) + 24) % 24,
    daylight: W.day,
    dusk: W.dusk,
    night: W.night,
    lampsOn,
    sky: key.skyBot.clone().lerp(key.skyTop, 0.5),
    skyTop: key.skyTop,
    skyBottom: key.skyBot,
    sunColor: key.sun,
    sunIntensity: key.sunI * Math.PI,
    sunDirection: new Vector3(dir.x, dir.y, dir.z).normalize(),
    hemiSky: key.hemiSky,
    hemiGround: key.hemiGround,
    hemiIntensity: key.hemiI * Math.PI,
    ambientColor: new Color(0, 0, 0),
    ambientIntensity: 0,
    lampI: key.lampI,
    stars: key.stars,
    glowNight: Math.max(0.35, W.night + W.dusk * 0.6),
    key,
  };
}

function hourOverride(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('hora');
  if (raw === null) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Hora de la luz que elige el usuario (barra de arriba): 'auto' sigue la hora real; las otras la dejan fija
 * en pleno dia, al atardecer o de noche, sea la hora que sea. Se recuerda en este navegador.
 */
export type TimeMode = 'auto' | 'dia' | 'atardecer' | 'noche';
export const TIME_MODES: readonly TimeMode[] = ['auto', 'dia', 'atardecer', 'noche'];
export const TIME_MODE_KEY = 'oficina.hora';
export const TIME_MODE_HOUR: Readonly<Record<Exclude<TimeMode, 'auto'>, number>> = { dia: 13, atardecer: 18.6, noche: 22.5 };

function readTimeMode(): TimeMode {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(TIME_MODE_KEY);
    return TIME_MODES.includes(raw as TimeMode) ? (raw as TimeMode) : 'auto';
  } catch {
    return 'auto';
  }
}

let timeMode: TimeMode = readTimeMode();

export function getTimeMode(): TimeMode {
  return timeMode;
}

export function setTimeMode(mode: TimeMode): void {
  if (mode === timeMode) return;
  timeMode = mode;
  try {
    if (mode === 'auto') window.localStorage.removeItem(TIME_MODE_KEY);
    else window.localStorage.setItem(TIME_MODE_KEY, mode);
  } catch {
    // sin almacenamiento: la eleccion vale hasta recargar
  }
  refresh();
}

/** hora de la luz: la de ?hora, la fija que eligio el usuario o la real */
export function currentHour(): number {
  const forced = hourOverride();
  if (forced !== null) return forced;
  return timeMode === 'auto' ? clockHourNow() : TIME_MODE_HOUR[timeMode];
}

/** hora del reloj de pared: la de ?hora o la real */
export function clockHourNow(): number {
  const forced = hourOverride();
  if (forced !== null) return forced;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

let current: DayState = dayStateAt(currentHour(), clockHourNow());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function refresh(): void {
  current = dayStateAt(currentHour(), clockHourNow());
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) timer = setInterval(refresh, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getDayState(): DayState {
  return current;
}

export function useDayState(): DayState {
  return useSyncExternalStore(subscribe, getDayState, getDayState);
}

export function useTimeMode(): TimeMode {
  return useSyncExternalStore(subscribe, getTimeMode, getTimeMode);
}
