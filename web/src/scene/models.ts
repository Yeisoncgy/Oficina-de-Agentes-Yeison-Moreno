// Modelos low-poly construidos por codigo (sin assets): personajes chibi con accesorios y piezas
// sueltas (flecha de seleccion, pantalla, caja unidad). Salas, escritorios y muebles son las piezas
// del Kit 3D en ./world. Unidades: 1 u ~ 1 m "chibi". Personaje ~1.1 u de alto, escritorio 0.75 u.

import { BoxGeometry, type BufferGeometry, PlaneGeometry } from 'three';
import { type AgentLook, lookFor, PALETTE } from '@/theme';
import { GeoBuilder, mix, shade } from './builder';
import { PAL as KIT_PAL } from './world/kit';
import { SCREEN_SIZE } from './world/pieces';

const P = PALETTE;

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = make();
    return value;
  };
}

// ---------------------------------------------------------------- personajes

/** Articulaciones del personaje (pies en y = 0, mirando a +z; su derecha es -x) */
export const BODY = {
  hipY: 0.31,
  hipX: 0.09,
  shoulderY: 0.58,
  shoulderX: 0.235,
  neckY: 0.62,
  eyeY: 0.2,
  eyeZ: 0.205,
  /** cuanto sube la cadera al sentarse (asiento a 0.5) */
  sitLift: 0.19,
} as const;

export interface CharacterParts {
  torso: BufferGeometry;
  head: BufferGeometry;
  eyes: BufferGeometry;
  armL: BufferGeometry;
  armR: BufferGeometry;
  leg: BufferGeometry;
  heldMug: BufferGeometry;
}

function buildTorso(look: AgentLook): BufferGeometry {
  const b = new GeoBuilder();
  b.boxMM(-0.17, 0.27, -0.11, 0.17, 0.36, 0.11, look.pants);
  b.boxMM(-0.18, 0.34, -0.12, 0.18, 0.62, 0.12, look.shirt);
  b.boxMM(-0.07, 0.6, -0.05, 0.07, 0.645, 0.05, look.skin);
  switch (look.accessory) {
    case 'hoodie': {
      const dark = mix(look.shirt, P.ink, 0.28);
      b.boxMM(-0.2, 0.5, -0.19, 0.2, 0.7, -0.09, dark);
      b.boxMM(-0.17, 0.39, 0.12, 0.17, 0.46, 0.132, dark);
      b.boxMM(-0.065, 0.48, 0.12, -0.045, 0.59, 0.134, P.cream);
      b.boxMM(0.045, 0.48, 0.12, 0.065, 0.59, 0.134, P.cream);
      break;
    }
    case 'bowtie':
      b.boxMM(-0.08, 0.585, 0.1, 0.08, 0.625, 0.125, P.cream);
      b.boxMM(-0.09, 0.545, 0.12, -0.02, 0.605, 0.145, P.red);
      b.boxMM(0.02, 0.545, 0.12, 0.09, 0.605, 0.145, P.red);
      b.boxMM(-0.025, 0.56, 0.12, 0.025, 0.59, 0.15, shade(P.red, 0.65));
      break;
    case 'hardhat':
      b.boxMM(-0.185, 0.45, -0.125, 0.185, 0.485, 0.125, P.cream);
      break;
    case 'explorer-hat':
      b.box(0.06, 0.44, 0.25, 0, 0.47, 0, P.woodDark, { z: 0.72 });
      b.boxMM(-0.25, 0.3, -0.07, -0.18, 0.43, 0.08, P.woodDark);
      b.boxMM(-0.255, 0.38, -0.03, -0.25, 0.41, 0.04, P.mustard);
      break;
    case 'clipboard':
      b.boxMM(0.05, 0.5, 0.12, 0.13, 0.56, 0.132, shade(look.shirt, 0.78));
      b.boxMM(0.08, 0.53, 0.122, 0.095, 0.6, 0.137, P.blue);
      break;
    case 'glasses':
      b.boxMM(-0.012, 0.47, 0.12, 0.012, 0.62, 0.128, P.blue);
      b.boxMM(-0.05, 0.41, 0.12, 0.05, 0.48, 0.134, P.cream);
      break;
    default:
      break;
  }
  return b.build();
}

function buildHead(look: AgentLook): BufferGeometry {
  const b = new GeoBuilder();
  const hair = look.hair;
  b.boxMM(-0.23, 0.02, -0.2, 0.23, 0.42, 0.2, look.skin);
  if (look.accessory !== 'headphones') {
    b.boxMM(-0.255, 0.15, -0.03, -0.23, 0.25, 0.05, look.skin);
    b.boxMM(0.23, 0.15, -0.03, 0.255, 0.25, 0.05, look.skin);
  }
  b.boxMM(-0.2, 0.1, 0.2, -0.13, 0.135, 0.206, P.coral);
  b.boxMM(0.13, 0.1, 0.2, 0.2, 0.135, 0.206, P.coral);
  b.boxMM(-0.035, 0.075, 0.2, 0.035, 0.09, 0.206, shade(look.skin, 0.55));
  const hatted = look.accessory === 'hardhat' || look.accessory === 'explorer-hat';
  b.boxMM(-0.245, 0.32, -0.215, 0.245, hatted ? 0.42 : 0.47, 0.215, hair);
  b.boxMM(-0.245, 0.08, -0.235, 0.245, 0.44, -0.16, hair);
  b.boxMM(-0.25, 0.2, -0.2, -0.225, 0.42, 0.06, hair);
  b.boxMM(0.225, 0.2, -0.2, 0.25, 0.42, 0.06, hair);
  b.boxMM(-0.235, 0.33, 0.19, 0.235, 0.4, 0.232, hair);
  b.boxMM(-0.235, 0.28, 0.19, -0.08, 0.34, 0.228, hair);

  switch (look.accessory) {
    case 'hardhat':
      b.boxMM(-0.25, 0.4, -0.23, 0.25, 0.54, 0.23, P.mustard);
      b.boxMM(-0.27, 0.39, -0.25, 0.27, 0.42, 0.31, shade(P.mustard, 0.85));
      b.boxMM(-0.03, 0.54, -0.2, 0.03, 0.57, 0.2, shade(P.mustard, 0.92));
      break;
    case 'explorer-hat':
      b.boxMM(-0.34, 0.4, -0.31, 0.34, 0.43, 0.31, P.floorDark);
      b.boxMM(-0.21, 0.43, -0.2, 0.21, 0.56, 0.2, P.floorDark);
      b.boxMM(-0.215, 0.43, -0.205, 0.215, 0.47, 0.205, P.woodDark);
      break;
    case 'ponytail':
      b.boxMM(-0.05, 0.3, -0.28, 0.05, 0.37, -0.22, P.coral);
      b.boxMM(-0.065, 0.02, -0.31, 0.065, 0.32, -0.21, hair);
      b.boxMM(-0.045, -0.05, -0.3, 0.045, 0.03, -0.22, hair);
      break;
    case 'glasses':
      for (const cx of [-0.1, 0.1]) {
        b.boxMM(cx - 0.075, 0.26, 0.212, cx + 0.075, 0.28, 0.23, P.ink);
        b.boxMM(cx - 0.075, 0.12, 0.212, cx + 0.075, 0.14, 0.23, P.ink);
        b.boxMM(cx - 0.075, 0.12, 0.212, cx - 0.055, 0.28, 0.23, P.ink);
        b.boxMM(cx + 0.055, 0.12, 0.212, cx + 0.075, 0.28, 0.23, P.ink);
      }
      b.boxMM(-0.025, 0.22, 0.212, 0.025, 0.24, 0.23, P.ink);
      b.boxMM(-0.255, 0.25, -0.05, -0.235, 0.27, 0.215, P.ink);
      b.boxMM(0.235, 0.25, -0.05, 0.255, 0.27, 0.215, P.ink);
      break;
    case 'headphones':
      b.boxMM(-0.27, 0.46, -0.05, 0.27, 0.51, 0.05, P.ink);
      b.boxMM(-0.285, 0.26, -0.045, -0.24, 0.5, 0.045, P.ink);
      b.boxMM(0.24, 0.26, -0.045, 0.285, 0.5, 0.045, P.ink);
      b.boxMM(-0.3, 0.1, -0.08, -0.235, 0.28, 0.08, P.slate);
      b.boxMM(0.235, 0.1, -0.08, 0.3, 0.28, 0.08, P.slate);
      b.boxMM(-0.306, 0.16, -0.03, -0.3, 0.22, 0.03, P.coral);
      b.boxMM(0.3, 0.16, -0.03, 0.306, 0.22, 0.03, P.coral);
      break;
    case 'hoodie':
      b.box(0.09, 0.07, 0.09, 0.07, 0.49, 0.06, hair, { z: 0.45 });
      b.box(0.08, 0.06, 0.08, -0.07, 0.485, -0.03, hair, { z: -0.35 });
      b.box(0.07, 0.05, 0.07, 0.0, 0.5, -0.12, hair, { x: -0.4 });
      break;
    case 'clipboard':
      b.box(0.02, 0.02, 0.17, 0.262, 0.3, 0.0, P.mustard, { x: 0.3 });
      b.box(0.022, 0.022, 0.03, 0.262, 0.325, 0.085, P.pink, { x: 0.3 });
      break;
    default:
      break;
  }
  return b.build();
}

const buildEyes = once(() => {
  const b = new GeoBuilder();
  b.boxMM(-0.128, -0.0425, -0.01, -0.072, 0.0425, 0.01, P.ink);
  b.boxMM(0.072, -0.0425, -0.01, 0.128, 0.0425, 0.01, P.ink);
  b.boxMM(-0.117, 0.01, 0.01, -0.097, 0.03, 0.013, P.cream);
  b.boxMM(0.083, 0.01, 0.01, 0.103, 0.03, 0.013, P.cream);
  return b.build();
});

function buildArm(look: AgentLook, side: 1 | -1): BufferGeometry {
  const b = new GeoBuilder();
  b.boxMM(-0.05, -0.2, -0.055, 0.05, 0.03, 0.055, look.shirt);
  b.boxMM(-0.045, -0.28, -0.05, 0.045, -0.2, 0.05, look.skin);
  if (look.accessory === 'hoodie') b.boxMM(-0.053, -0.21, -0.058, 0.053, -0.18, 0.058, mix(look.shirt, P.ink, 0.28));
  if (look.accessory === 'clipboard' && side === 1) {
    b.boxMM(0.05, -0.38, -0.11, 0.075, -0.1, 0.11, P.woodDark);
    b.boxMM(0.075, -0.35, -0.09, 0.082, -0.13, 0.09, P.cream);
    b.boxMM(0.045, -0.125, -0.03, 0.08, -0.09, 0.03, P.metal);
    for (const y of [-0.18, -0.22, -0.26, -0.3]) b.boxMM(0.082, y, -0.065, 0.085, y + 0.012, 0.06, P.slate);
  }
  return b.build();
}

function buildLeg(look: AgentLook): BufferGeometry {
  const b = new GeoBuilder();
  b.boxMM(-0.06, -0.23, -0.065, 0.06, 0.02, 0.065, look.pants);
  const shoe = look.pants === P.ink ? P.woodDark : P.ink;
  b.boxMM(-0.065, -0.29, -0.07, 0.065, -0.23, 0.1, shoe);
  b.boxMM(-0.066, -0.31, -0.071, 0.066, -0.29, 0.101, P.paper);
  return b.build();
}

const buildHeldMug = once(() => {
  const b = new GeoBuilder();
  b.cyl(0.045, 0.04, 0.09, 0, -0.33, 0.07, P.cream, 8);
  b.cyl(0.046, 0.046, 0.022, 0, -0.29, 0.07, P.red, 8);
  b.box(0.016, 0.045, 0.02, 0.052, -0.29, 0.07, P.cream);
  return b.build();
});

const partsCache = new Map<AgentLook, CharacterParts>();

export function characterParts(agentType: string): CharacterParts {
  const look = lookFor(agentType);
  const cached = partsCache.get(look);
  if (cached) return cached;
  const parts: CharacterParts = {
    torso: buildTorso(look),
    head: buildHead(look),
    eyes: buildEyes(),
    armL: buildArm(look, 1),
    armR: buildArm(look, -1),
    leg: buildLeg(look),
    heldMug: buildHeldMug(),
  };
  partsCache.set(look, parts);
  return parts;
}

// ---------------------------------------------------------------- piezas sueltas

/** flecha de seleccion (ambar del kit) */
export const arrowGeometry = once(() => {
  const b = new GeoBuilder();
  const amber = KIT_PAL.amber;
  b.boxMM(-0.04, 0.12, -0.03, 0.04, 0.26, 0.03, amber);
  b.boxMM(-0.13, 0.08, -0.03, 0.13, 0.12, 0.03, amber);
  b.boxMM(-0.09, 0.04, -0.03, 0.09, 0.08, 0.03, amber);
  b.boxMM(-0.045, 0, -0.03, 0.045, 0.04, 0.03, amber);
  return b.build();
});

/** pantalla de monitor del kit (0.38 x 0.2) */
export const screenGeometry = once(() => new PlaneGeometry(SCREEN_SIZE.w, SCREEN_SIZE.h));
export const unitBox = once(() => new BoxGeometry(1, 1, 1));

// La geometria de salas, escritorios, muebles y pasillos vive en ./world (piezas del Kit 3D).
