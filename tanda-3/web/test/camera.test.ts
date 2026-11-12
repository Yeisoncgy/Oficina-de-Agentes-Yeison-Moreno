// Logica pura de la camara (CameraRig.tsx): zoom de rueda, zoom anclado al puntero, iman del angulo base,
// vista guardada y teclas. Lo que mueve la camara de verdad necesita WebGL y no se prueba aqui.
import { describe, expect, it } from 'vitest';
import {
  anchoredZoomShift,
  AZIMUTH_RANGE,
  BASE_AZIMUTH,
  cameraKey,
  parseSavedView,
  settleAzimuth,
  SNAP_AZIMUTH,
  wheelZoomFactor,
} from '@/scene/CameraRig';

describe('zoom con la rueda', () => {
  it('un paso de raton acerca o aleja alrededor de un 20 %, en pixeles o en lineas', () => {
    const inPx = wheelZoomFactor(100, 0, false);
    const inLines = wheelZoomFactor(3, 1, false);
    expect(inPx).toBeCloseTo(0.8, 1);
    expect(inLines).toBeCloseTo(inPx, 1);
    expect(wheelZoomFactor(-100, 0, false)).toBeCloseTo(1 / inPx, 5);
  });

  it('el trackpad va continuo y Ctrl+rueda (pellizco) queda acotado', () => {
    expect(wheelZoomFactor(4, 0, false)).toBeGreaterThan(0.99);
    expect(wheelZoomFactor(4, 0, false)).toBeLessThan(1);
    // un paso entero de raton con Ctrl no da un salto: tope de 50 px
    expect(wheelZoomFactor(100, 0, true)).toBeCloseTo(wheelZoomFactor(50, 0, true), 6);
    expect(wheelZoomFactor(100, 0, true)).toBeGreaterThan(0.7);
    // un delta gigante tampoco
    expect(wheelZoomFactor(5000, 0, false)).toBeGreaterThan(0.75);
  });

  it('el punto bajo el puntero no se mueve al cambiar el zoom', () => {
    // el puntero esta 200 px a la derecha y 100 arriba del centro; el mundo bajo el = objetivo + p / zoom
    const ax = 200;
    const ay = 100;
    const from = 50;
    const to = 100;
    const shift = anchoredZoomShift(from, to, ax, ay);
    const beforeRight = ax / from;
    const afterRight = shift.right + ax / to;
    expect(afterRight).toBeCloseTo(beforeRight, 9);
    expect(shift.up + ay / to).toBeCloseTo(ay / from, 9);
    // en el centro no hay corrimiento
    expect(anchoredZoomShift(from, to, 0, 0)).toEqual({ right: 0, up: 0 });
  });
});

describe('giro', () => {
  it('a menos de SNAP_AZIMUTH del angulo base se asienta en el; mas lejos queda donde esta', () => {
    expect(settleAzimuth(BASE_AZIMUTH + SNAP_AZIMUTH * 0.5)).toBe(BASE_AZIMUTH);
    expect(settleAzimuth(BASE_AZIMUTH - SNAP_AZIMUTH * 0.9)).toBe(BASE_AZIMUTH);
    const free = BASE_AZIMUTH + SNAP_AZIMUTH * 2;
    expect(settleAzimuth(free)).toBe(free);
  });

  it('nunca sale del rango de giro', () => {
    expect(settleAzimuth(BASE_AZIMUTH + 10)).toBe(BASE_AZIMUTH + AZIMUTH_RANGE);
    expect(settleAzimuth(BASE_AZIMUTH - 10)).toBe(BASE_AZIMUTH - AZIMUTH_RANGE);
  });
});

describe('vista guardada', () => {
  const good = { x: 1, y: 0.7, z: -2, zoom: 80, azimuth: 0.8, polar: 1 };

  it('lee una vista completa y descarta cualquier cosa rota', () => {
    expect(parseSavedView(JSON.stringify(good))).toEqual(good);
    expect(parseSavedView(null)).toBeNull();
    expect(parseSavedView('')).toBeNull();
    expect(parseSavedView('{no es json')).toBeNull();
    expect(parseSavedView('[1,2]')).toBeNull();
    expect(parseSavedView(JSON.stringify({ ...good, zoom: 0 }))).toBeNull();
    expect(parseSavedView(JSON.stringify({ ...good, zoom: 'grande' }))).toBeNull();
    expect(parseSavedView(JSON.stringify({ ...good, x: Number.NaN }))).toBeNull();
    const { polar: _omit, ...missing } = good;
    expect(parseSavedView(JSON.stringify(missing))).toBeNull();
  });
});

describe('teclas de la camara', () => {
  it('flechas panean, Q/E giran, + y - acercan, 0 e Inicio reencuadran; H, A y F son del HUD', () => {
    expect(cameraKey('ArrowLeft')).toEqual({ kind: 'pan', x: -1, y: 0 });
    expect(cameraKey('ArrowUp')).toEqual({ kind: 'pan', x: 0, y: 1 });
    expect(cameraKey('q')).toEqual({ kind: 'turn', dir: 1 });
    expect(cameraKey('E')).toEqual({ kind: 'turn', dir: -1 });
    expect(cameraKey('+')).toEqual({ kind: 'zoom', dir: 1 });
    expect(cameraKey('=')).toEqual({ kind: 'zoom', dir: 1 });
    expect(cameraKey('-')).toEqual({ kind: 'zoom', dir: -1 });
    expect(cameraKey('0')).toEqual({ kind: 'all' });
    expect(cameraKey('Home')).toEqual({ kind: 'all' });
    for (const k of ['h', 'a', 'f', 'Tab', 'Escape', ' ']) expect(cameraKey(k)).toBeNull();
  });
});
