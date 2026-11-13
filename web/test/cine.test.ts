// @vitest-environment node
// Revelado cinematografico (scene/CinePipeline.tsx): cielo de la hora y niveles de calidad.
import { describe, expect, it } from 'vitest';
import { AO_SCALE, paintSky, QUALITY, SHADOW_HZ, SHADOW_IDLE_HZ } from '@/scene/CinePipeline';
import { estimateHz, frameDue, RATE } from '@/scene/pacer';
import { qualityForGpu } from '@/scene/quality';
import { dayStateAt } from '@/scene/daylight';

const W = 1024;
const H = 512;
const px = (data: Uint8Array, x: number, y: number) => [data[(y * W + x) * 4], data[(y * W + x) * 4 + 1], data[(y * W + x) * 4 + 2]] as number[];
const lum = (c: number[]) => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

describe('cielo de la hora', () => {
  it('de noche es oscuro y lleva estrellas solo en la parte alta', () => {
    const night = new Uint8Array(W * H * 4);
    paintSky(night, dayStateAt(22.5));
    const plain = new Uint8Array(W * H * 4);
    paintSky(plain, { ...dayStateAt(22.5), stars: 0 });
    expect(lum(px(night, 10, H - 1))).toBeLessThan(40);
    let stars = 0;
    let low = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (night[(y * W + x) * 4] !== plain[(y * W + x) * 4]) {
          stars += 1;
          if (y < H * 0.25) low += 1;
        }
      }
    }
    expect(stars).toBeGreaterThan(40);
    // la fila 0 es el borde de abajo de la pantalla: ahi no hay estrellas
    expect(low).toBe(0);
  });

  it('de dia no hay estrellas y el horizonte es mas claro que el cenit', () => {
    const day = new Uint8Array(W * H * 4);
    paintSky(day, dayStateAt(13));
    const same = new Uint8Array(W * H * 4);
    paintSky(same, { ...dayStateAt(13), stars: 0 });
    expect(Buffer.compare(Buffer.from(day), Buffer.from(same))).toBe(0);
    expect(lum(px(day, 5, 0))).toBeGreaterThan(lum(px(day, 5, H - 1)));
  });

  it('al atardecer la franja media tira al rosa', () => {
    const dusk = new Uint8Array(W * H * 4);
    paintSky(dusk, dayStateAt(18.6));
    const mid = px(dusk, 5, Math.round(H * 0.45));
    expect(mid[0]).toBeGreaterThan(mid[2] ?? 0);
    expect(mid[0]).toBeGreaterThan(mid[1] ?? 0);
  });
});

describe('niveles de calidad', () => {
  it('cada nivel pide menos que el anterior', () => {
    expect(QUALITY.alta.ao).toBe(true);
    expect(QUALITY.media.ao).toBe(false);
    expect(QUALITY.baja.ao).toBe(false);
    expect(QUALITY.alta.dpr).toBeGreaterThan(QUALITY.media.dpr);
    expect(QUALITY.media.dpr).toBeGreaterThan(QUALITY.baja.dpr);
    // baja dibuja algo por debajo de la resolucion de la pantalla
    expect(QUALITY.baja.dpr).toBeLessThan(1);
    expect(QUALITY.baja.tilt).toBe(false);
    expect(QUALITY.alta.shadow).toBeGreaterThan(QUALITY.media.shadow);
  });

  it('la tarjeta decide el nivel de partida', () => {
    expect(qualityForGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('alta');
    expect(qualityForGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('media');
    expect(qualityForGpu('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('media');
    expect(qualityForGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe('baja');
    expect(qualityForGpu('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('baja');
    expect(qualityForGpu(null)).toBe('media');
  });

  it('la oclusion va a media resolucion y las sombras no se recalculan en cada cuadro', () => {
    expect(AO_SCALE).toBeLessThanOrEqual(0.5);
    expect(SHADOW_HZ).toBeLessThan(30);
    expect(SHADOW_HZ).toBeGreaterThanOrEqual(12);
    // sin nadie caminando, muy pocas veces por segundo
    expect(SHADOW_IDLE_HZ).toBeLessThanOrEqual(4);
  });
});

describe('ritmo de la escena', () => {
  it('en uso va mas rapido que quieta, y quieta mas que sin foco', () => {
    expect(RATE.active).toBe(60);
    expect(RATE.idle).toBeLessThan(RATE.active);
    expect(RATE.background).toBeLessThan(RATE.idle);
  });

  it('el ritmo no depende de la pantalla: en 144 Hz salta refrescos con separacion pareja', () => {
    // cuantos refrescos de la pantalla pasan entre dos cuadros dibujados
    const every = (hz: number, rate: number) => {
      let n = 1;
      while (!frameDue((n * 1000) / hz, rate, hz)) n += 1;
      return n;
    };
    expect(every(60, RATE.active)).toBe(1);
    expect(every(60, RATE.idle)).toBe(2);
    expect(every(60, RATE.background)).toBe(3);
    expect(every(144, RATE.active)).toBe(2);
    expect(every(144, RATE.idle)).toBe(5);
    expect(every(30, RATE.active)).toBe(1);
    // equipo lento: cada refresco llega tarde y se dibujan todos
    expect(frameDue(120, RATE.idle, 60)).toBe(true);
  });

  it('estima el refresco con los intervalos cortos (los cuadros lentos no cuentan)', () => {
    const at144 = Array.from({ length: 40 }, (_, i) => (i % 9 === 0 ? 21 : 6.94));
    expect(Math.round(estimateHz(at144))).toBe(144);
    const at60 = Array.from({ length: 40 }, (_, i) => (i % 7 === 0 ? 33.4 : 16.7));
    expect(Math.round(estimateHz(at60))).toBe(60);
    expect(estimateHz([16, 16])).toBe(60);
  });
});
