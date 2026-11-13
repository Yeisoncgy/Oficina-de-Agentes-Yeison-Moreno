// Texturas pixel del Kit 3D pintadas por codigo en DataTextures (sin archivos ni URLs):
// - estaticas: microcemento, adoquines y aceras del exterior, halo, burbujas y el atlas "lit" (alfombras,
//   losetas de los cruces, felpudo, cuadros, pizarra, placa del lider y reloj de pared);
// - vivas: pantallas (codigo, pensando, reposo, terminado, apagada), cielo de las ventanas, reloj y el
//   nombre de la placa del lider;
// - carteles de sala en su propio atlas, con regiones que se reciclan.

import { DataTexture, LinearFilter, NearestFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace } from 'three';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import type { LightKey } from './world/kit';
import {
  paintBubble,
  paintClock,
  paintCode,
  paintDone,
  paintDoormat,
  paintGlow,
  paintIdle,
  PAINTINGS,
  paintOff,
  CEMENT_SAND,
  paintMicrocement,
  paintNeonGrid,
  paintCompass,
  paintManhole,
  paintPavers,
  paintPlate,
  plateText,
  paintSidewalk,
  paintSign,
  paintSky,
  paintThink,
  paintWhiteboard,
  Raster,
  RUGS,
  SCREEN_H,
  SCREEN_W,
  SIGN_H,
  SIGN_W,
  SKY_H,
  SKY_W,
  type SkyPalette,
  skyPalette,
} from './world/raster';

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PixelTexture {
  tex: DataTexture;
  g: Raster;
}

function pixelTexture(w: number, h: number, repeat = false): PixelTexture {
  const g = Raster.create(w, h);
  const tex = new DataTexture(g.data, w, h, RGBAFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  if (repeat) {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
  }
  tex.needsUpdate = true;
  return { tex, g };
}

function painted(w: number, h: number, draw: (g: Raster, w: number, h: number) => void, repeat = false): DataTexture {
  const t = pixelTexture(w, h, repeat);
  draw(t.g, w, h);
  t.tex.needsUpdate = true;
  return t.tex;
}

// ---------------------------------------------------------------- atlas

/** [u0, v0, u1, v1] con medio texel de margen hacia adentro */
export type UvRect = readonly [number, number, number, number];

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  rect: UvRect;
}

export class Atlas {
  readonly px: PixelTexture;
  private x = 1;
  private y = 1;
  private row = 0;

  constructor(readonly size: number) {
    this.px = pixelTexture(size, size);
  }

  region(w: number, h: number): Region {
    if (this.x + w + 1 > this.size) {
      this.x = 1;
      this.y += this.row + 2;
      this.row = 0;
    }
    if (this.y + h + 1 > this.size) throw new Error('Atlas lleno');
    const S = this.size;
    const r: Region = {
      x: this.x,
      y: this.y,
      w,
      h,
      rect: [(this.x + 0.02) / S, 1 - (this.y + h - 0.02) / S, (this.x + w - 0.02) / S, 1 - (this.y + 0.02) / S],
    };
    this.x += w + 2;
    this.row = Math.max(this.row, h);
    return r;
  }

  paint(r: Region, draw: (g: Raster) => void): void {
    const g = this.px.g.sub(r.x, r.y, r.w, r.h);
    g.clear();
    draw(g);
    this.px.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- estaticas

/** 64 x 64 = 2 x 2 unidades (32 texeles por unidad) */
export const cementTexture = painted(64, 64, paintMicrocement, true);
export const sandTexture = painted(64, 64, (g, w, h) => paintMicrocement(g, w, h, CEMENT_SAND), true);
export const gridTexture = painted(64, 64, paintNeonGrid, true);
/** exterior: adoquines de las calles y losetas de las aceras, 64 x 64 = 2 x 2 unidades, alineadas al mundo */
export const paversTexture = painted(64, 64, paintPavers, true);
export const sidewalkTexture = painted(64, 64, paintSidewalk, true);
/**
 * Halo suave para luces aditivas (lamparas, pantallas, charcos de luz): caida radial continua, sin el
 * tramado de pixel de antes, que con el revelado cinematografico se veia como una nube de cuadritos.
 */
function softGlow(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = (1 - r) ** 2.2;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
export const glowTexture = softGlow();
export const bubbleTextures: readonly DataTexture[] = [1, 2, 3].map((n) => painted(20, 14, (g, w, h) => paintBubble(g, w, h, n)));

const lit = new Atlas(512);
export const litAtlas = lit.px.tex;

function litPiece(w: number, h: number, draw: (g: Raster) => void): UvRect {
  const r = lit.region(w, h);
  lit.paint(r, draw);
  return r.rect;
}

/** alfombras a 32 texeles por unidad: 5,1 x 3,85 */
export const RUG_TEX = { w: 164, h: 124 } as const;

const clockRegion = lit.region(24, 24);
const PLATE_W = 48;
const PLATE_H = 10;
const plateRegion = lit.region(PLATE_W, PLATE_H);

export const LIT_UV = {
  rugs: RUGS.map((f) => litPiece(RUG_TEX.w, RUG_TEX.h, (g) => f(g, RUG_TEX.w, RUG_TEX.h))),
  /** losetas de los cruces de calles: rosa de los vientos (1 u) y tapa de registro (0,56 u) */
  compass: litPiece(32, 32, (g) => paintCompass(g, 32, 32)),
  manhole: litPiece(18, 18, (g) => paintManhole(g, 18, 18)),
  doormat: litPiece(26, 18, (g) => paintDoormat(g, 26, 18)),
  paintings: PAINTINGS.map((f) => litPiece(24, 18, (g) => f(g, 24, 18))),
  whiteboard: litPiece(56, 32, (g) => paintWhiteboard(g)),
  plate: plateRegion.rect,
  clock: clockRegion.rect,
} as const;

/** texto que lleva la placa: el nombre elegido y, si la fuente no puede dibujar nada de el, el por defecto */
export function leadPlateText(name: string): string {
  return plateText(name) || plateText(DEFAULT_LEAD_NAME);
}

let plateShown: string | null = null;

/** placa del escritorio del lider: se repinta solo cuando cambia el texto (la comparten todas las salas) */
export function paintLeadPlate(name: string): void {
  const text = leadPlateText(name);
  if (text === plateShown) return;
  plateShown = text;
  lit.paint(plateRegion, (g) => paintPlate(g, PLATE_W, PLATE_H, text));
}
paintLeadPlate(DEFAULT_LEAD_NAME);

let clockMinute = -1;

/** reloj de pared: se repinta solo cuando cambia el minuto (lo comparten todas las salas) */
export function paintClockAt(hours: number): void {
  const minute = Math.floor((((hours % 24) + 24) % 24) * 60);
  if (minute === clockMinute) return;
  clockMinute = minute;
  lit.paint(clockRegion, (g) => paintClock(g, 24, 24, minute / 60));
}

// ---------------------------------------------------------------- carteles de sala

const signAtlas = new Atlas(256);
export const signTexture = signAtlas.px.tex;

interface SignSlot {
  region: Region;
  key: string;
  refs: number;
}

const signSlots = new Map<string, SignSlot>();
/** cartel sin texto para cuando el atlas se llena (mas de 30 salas distintas a la vez) */
const blankSign = signAtlas.region(SIGN_W, SIGN_H);
signAtlas.paint(blankSign, (g) => paintSign(g, SIGN_W, SIGN_H, '', '', false));

function newSignRegion(): Region | null {
  try {
    return signAtlas.region(SIGN_W, SIGN_H);
  } catch {
    // atlas lleno: se recicla un cartel que ya nadie usa
    for (const [key, slot] of signSlots) {
      if (slot.refs > 0) continue;
      signSlots.delete(key);
      return slot.region;
    }
    return null;
  }
}

/** region del cartel (titulo, subtitulo, cerrada); se pinta la primera vez y se comparte entre salas iguales */
export function signRect(title: string, subtitle: string, closed: boolean): { key: string; rect: UvRect } {
  const key = `${title}|${subtitle}|${closed ? 1 : 0}`;
  const hit = signSlots.get(key);
  if (hit) return { key, rect: hit.region.rect };
  const region = newSignRegion();
  if (!region) return { key: '', rect: blankSign.rect };
  signAtlas.paint(region, (g) => paintSign(g, SIGN_W, SIGN_H, title, subtitle, closed));
  signSlots.set(key, { region, key, refs: 0 });
  return { key, rect: region.rect };
}

/** una sala usa el cartel (desde un efecto) */
export function retainSign(key: string): void {
  const slot = signSlots.get(key);
  if (slot) slot.refs++;
}

/** la sala dejo de usarlo: sin usuarios, la region se recicla cuando haga falta lugar */
export function releaseSign(key: string): void {
  const slot = signSlots.get(key);
  if (slot) slot.refs = Math.max(0, slot.refs - 1);
}

// ---------------------------------------------------------------- pantallas

export const screenTextures = {
  code: [pixelTexture(SCREEN_W, SCREEN_H), pixelTexture(SCREEN_W, SCREEN_H)],
  think: [1, 2, 3].map((n) => painted(SCREEN_W, SCREEN_H, (g, w, h) => paintThink(g, w, h, n))),
  idle: [true, false].map((c) => painted(SCREEN_W, SCREEN_H, (g, w, h) => paintIdle(g, w, h, c))),
  done: painted(SCREEN_W, SCREEN_H, paintDone),
  off: painted(SCREEN_W, SCREEN_H, paintOff),
};

const CODE_SEEDS = [1, 7];
let codeClock = -9;

/** repinta las dos variantes de codigo cada 0,3 s (compartidas por todas las pantallas) */
export function tickCode(t: number): void {
  if (t - codeClock < 0.3 && t >= codeClock) return;
  codeClock = t;
  screenTextures.code.forEach((p, i) => {
    paintCode(p.g, SCREEN_W, SCREEN_H, t, CODE_SEEDS[i] ?? 1);
    p.tex.needsUpdate = true;
  });
}
tickCode(0);

// ---------------------------------------------------------------- cielo en vivo

const sky = pixelTexture(SKY_W, SKY_H);
export const skyTexture = sky.tex;
let skyPal: SkyPalette | null = null;
let skyClock = -9;

/** cambia la hora del cielo (se llama cuando cambia la hora del dia) */
export function setSkyKey(key: LightKey, t: number): void {
  skyPal = skyPalette(key);
  skyClock = -9;
  tickSky(t);
}

/** anima el cielo (ventanas del skyline, estrellas, nubes, antenas) una vez por segundo */
export function tickSky(t: number): void {
  if (!skyPal) return;
  if (t - skyClock < 1 && t >= skyClock) return;
  skyClock = t;
  paintSky(sky.g, SKY_W, SKY_H, skyPal, t);
  sky.tex.needsUpdate = true;
}
