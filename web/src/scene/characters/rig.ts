// Personajes chibi del kit 3D (buildCharacter): una SkinnedMesh por personaje (1 draw call) con
// skinning rigido. Los huesos son los pivotes de la animacion:
//   root (pies: escala, saltito) -> hips (y 0,31) -> legL / legR (caderas)
//                                               -> torso (y 0,35) -> head (cuello, y 0,62) -> eyes, eyesHappy, mouth, tail
//                                                                 -> armL / armR (hombros, y 0,58) -> mug, marker, flask, lens (mano)
//                                                                 -> book (frente al pecho)
//   accessory: en la cabeza (cascos, gafas, audifonos, antiparras, audifono de seguridad), el torso
//   (capucha, mochila, moño, gafete) o armL (tabla)
// Utileria de las actividades (taza, marcador, libro, matraz, lupa): oculta salvo en la pose que la usa.
// Mira a +z; su izquierda es +x. De pie mide ~1,1.
//
// La geometria y los inversos de los huesos se construyen una vez por personaje y se comparten entre
// todas sus instancias; cada instancia solo crea sus huesos.

import { Bone, BufferGeometry, Matrix4, Skeleton, SkinnedMesh, Sphere, Sprite, Vector3 } from 'three';
import { type CastId, castLook, type CastLook, KIT_PAL } from './looks';
import { bubbleMaterial, characterMaterialFor, questionMaterial, sparkMaterialFor, zzzMaterial } from './materials';
import { hashStr, mixTint, shade, SkinGeo } from './geo';

/** Proporciones chibi del kit (1 : 1,4) */
export const CHIBI = { headW: 0.48, headH: 0.42, headD: 0.42, bevel: 0.04, bodyW: 0.36, eyeX: 0.1, eyeY: 0.2 } as const;
/** cuanto sube la cadera al sentarse (asiento a 0,45) */
export const SIT_LIFT = 0.19;

export const BONE_NAMES = [
  'root',
  'hips',
  'legL',
  'legR',
  'torso',
  'head',
  'armL',
  'armR',
  'eyes',
  'eyesHappy',
  'mouth',
  'accessory',
  'mug',
  'marker',
  'tail',
  'book',
  'flask',
  'lens',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

export const BONE: Readonly<Record<BoneName, number>> = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])) as Record<
  BoneName,
  number
>;

const HEAD_TOP = 0.03 + CHIBI.headH;
const HALF_D = CHIBI.headD / 2;
/** chaqueta del accesorio de seguridad (sus solapas van en night, mas oscuras) */
const JACKET = KIT_PAL.indigo;

/** "?" de espera: a un lado de la cabeza, donde va la burbuja de pensar (espacio de la cabeza) */
export const QUESTION_POS = { x: 0.3, y: 0.7 } as const;
/** zzz de dormido: sobre la cadera, asi no se hunde con la cabeza en el escritorio */
export const ZZZ_POS = { x: 0.24, y: 0.8 } as const;

type Parent = BoneName | null;

function accessoryParent(look: CastLook): BoneName {
  switch (look.acc) {
    case 'hardhat':
    case 'explorerHat':
    case 'glasses':
    case 'headphones':
    case 'labcoat':
    case 'security':
      return 'head';
    case 'clipboard':
      return 'armL';
    default:
      return 'torso';
  }
}

function skeletonLayout(look: CastLook): { parent: Parent; pos: [number, number, number] }[] {
  const arm = CHIBI.bodyW / 2 + 0.05;
  const layout: Record<BoneName, { parent: Parent; pos: [number, number, number] }> = {
    root: { parent: null, pos: [0, 0, 0] },
    hips: { parent: 'root', pos: [0, 0.31, 0] },
    legL: { parent: 'hips', pos: [0.09, 0, 0] },
    legR: { parent: 'hips', pos: [-0.09, 0, 0] },
    torso: { parent: 'hips', pos: [0, 0.04, 0] },
    head: { parent: 'torso', pos: [0, 0.27, 0] },
    armL: { parent: 'torso', pos: [arm, 0.23, 0] },
    armR: { parent: 'torso', pos: [-arm, 0.23, 0] },
    eyes: { parent: 'head', pos: [0, CHIBI.eyeY, HALF_D + 0.003] },
    eyesHappy: { parent: 'head', pos: [0, CHIBI.eyeY, HALF_D + 0.003] },
    mouth: { parent: 'head', pos: [0, CHIBI.eyeY - 0.11, HALF_D + 0.003] },
    accessory: { parent: accessoryParent(look), pos: [0, 0, 0] },
    mug: { parent: 'armR', pos: [0, -0.3, 0.03] },
    marker: { parent: 'armR', pos: [0, -0.3, 0.02] },
    tail: { parent: 'head', pos: [0, HEAD_TOP - 0.1, -HALF_D - 0.06] },
    book: { parent: 'torso', pos: [0, 0.1, 0.22] },
    flask: { parent: 'armR', pos: [0, -0.3, 0.03] },
    lens: { parent: 'armR', pos: [0, -0.29, 0.02] },
  };
  return BONE_NAMES.map((n) => layout[n]);
}

interface CharacterAsset {
  look: CastLook;
  geometry: BufferGeometry;
  parents: number[];
  rest: Vector3[];
  boneInverses: Matrix4[];
  triangles: number;
  hasTail: boolean;
}

function buildAsset(id: CastId): CharacterAsset {
  const L = castLook(id);
  const layout = skeletonLayout(L);
  const parents = layout.map((b) => (b.parent === null ? -1 : BONE[b.parent]));
  const rest = layout.map((b) => new Vector3(...b.pos));
  // en reposo los huesos solo se trasladan: el espacio de cada uno es la suma de su cadena
  const world = rest.map(() => new Vector3());
  rest.forEach((p, i) => {
    const parent = parents[i] ?? -1;
    world[i]?.copy(p);
    if (parent >= 0) world[i]?.add(world[parent] ?? new Vector3());
  });
  const restMatrix = world.map((w) => new Matrix4().makeTranslation(w.x, w.y, w.z));
  const boneInverses = world.map((w) => new Matrix4().makeTranslation(-w.x, -w.y, -w.z));

  const S = CHIBI;
  const w = S.headW;
  const d = S.headD;
  const bv = S.bevel;
  const top = HEAD_TOP;
  const bw = S.bodyW;
  const e = 0.018;
  const skin = L.skin;
  const hair = L.hairC;
  const shirt = L.shirt;
  const pants = L.pants;
  const acc2 = L.acc2;
  const dark = shade(shirt, 0.72);
  const P = KIT_PAL;
  // la bata y la chaqueta tapan la camiseta (asoma en la V del cuello) y tambien las mangas
  const sleeve = L.acc === 'labcoat' ? P.cream : L.acc === 'security' ? JACKET : shirt;

  const g = new SkinGeo(hashStr(L.id));
  const on = (b: BoneName) => g.on(BONE[b], restMatrix[BONE[b]] ?? new Matrix4());

  // piernas y cadera
  for (const leg of ['legL', 'legR'] as const) {
    on(leg);
    g.box(-0.06, -0.23, -0.065, 0.06, 0.02, 0.065, pants);
    g.box(-0.065, -0.31, -0.07, 0.065, -0.23, 0.1, shade(pants, 0.55));
  }
  on('hips');
  g.box(-0.16, -0.05, -0.11, 0.16, 0.06, 0.11, pants, { jitter: 0.03 });

  // torso
  on('torso');
  g.box(-bw / 2, 0, -0.12, bw / 2, 0.27, 0.12, shirt, { top: 0.06, jitter: 0.03 });
  g.box(-bw / 2 - 0.012, 0.05, -0.1, bw / 2 + 0.012, 0.23, 0.1, shirt);
  g.box(-0.06, 0.25, -0.05, 0.06, 0.31, 0.05, skin);

  // cabeza con bisel
  on('head');
  g.box(-w / 2, 0.03 + bv, -d / 2 + bv, w / 2, top - bv, d / 2 - bv, skin);
  g.box(-w / 2 + bv, 0.03 + bv, -d / 2, w / 2 - bv, top - bv, d / 2, skin);
  g.box(-w / 2 + bv, 0.03, -d / 2 + bv, w / 2 - bv, top, d / 2 - bv, skin);
  const hatted = L.acc === 'hardhat' || L.acc === 'explorerHat';
  if (L.hair === 'buzz') {
    g.box(-w / 2 - 0.01, top - 0.08, -d / 2 - 0.01, w / 2 + 0.01, top + 0.02, d / 2 + 0.01, hair);
    g.box(-w / 2 - 0.01, 0.16, -d / 2 - 0.012, w / 2 + 0.01, top, -d / 2 + 0.08, hair);
  } else {
    g.box(-w / 2 - e, top - 0.1, -d / 2 - e, w / 2 + e, top + (hatted ? 0 : 0.05), d / 2 + e, hair);
    g.box(-w / 2 - e, 0.12, -d / 2 - e, w / 2 + e, top, -d / 2 + 0.1, hair);
    g.box(-w / 2 - e, 0.2, -d / 2, -w / 2 + 0.01, top, 0.04, hair);
    g.box(w / 2 - 0.01, 0.2, -d / 2, w / 2 + e, top, 0.04, hair);
    // brillo en el pelo
    if (!hatted) g.qy(-w / 2 + 0.05, d / 2 - 0.12, w / 2 - 0.16, d / 2 - 0.02, top + 0.051, mixTint(hair, '#B8B2E6', 0.32));
  }
  switch (L.hair) {
    case 'messy':
      g.boxC(0.08, top + 0.07, 0.05, 0.1, 0.08, 0.1, hair, { rz: 0.45 });
      g.boxC(-0.08, top + 0.06, -0.02, 0.09, 0.07, 0.09, hair, { rz: -0.35 });
      g.boxC(0, top + 0.08, -0.12, 0.08, 0.06, 0.08, hair, { rx: -0.4 });
      g.box(-w / 2, top - 0.15, d / 2 - 0.01, w * 0.15, top - 0.08, d / 2 + e + 0.005, hair);
      break;
    case 'short':
      if (!hatted) g.box(-w / 2, top - 0.14, d / 2 - 0.01, w * 0.2, top - 0.08, d / 2 + e + 0.005, hair);
      break;
    case 'ponytail':
      g.box(-w / 2, top - 0.13, d / 2 - 0.01, w / 2, top - 0.08, d / 2 + e + 0.005, hair);
      g.box(-0.05, top - 0.14, -d / 2 - 0.07, 0.05, top - 0.05, -d / 2 - e, acc2);
      break;
    case 'bob':
      g.box(-w / 2 - e - 0.01, 0.02, -d / 2 - e, -w / 2 + 0.02, top, d / 2 - 0.04, hair);
      g.box(w / 2 - 0.02, 0.02, -d / 2 - e, w / 2 + e + 0.01, top, d / 2 - 0.04, hair);
      g.box(-w / 2, top - 0.16, d / 2 - 0.01, w / 2, top - 0.08, d / 2 + e + 0.005, hair);
      break;
    case 'bun':
      g.box(-w / 2, top - 0.13, d / 2 - 0.01, w * 0.1, top - 0.08, d / 2 + e + 0.005, hair);
      g.boxC(0, top + 0.12, -0.04, 0.17, 0.14, 0.17, hair, { ry: 0.3 });
      g.box(-0.09, top + 0.04, -0.13, 0.09, top + 0.07, 0.05, acc2);
      break;
    case 'swept':
      g.boxC(0.02, top - 0.07, d / 2 + 0.005, w * 0.9, 0.07, 0.04, hair, { rz: -0.18 });
      break;
    default:
      break;
  }
  const hasTail = L.hair === 'ponytail';
  if (hasTail) {
    on('tail');
    g.box(-0.06, -0.3, -0.07, 0.06, 0.02, 0.05, hair);
    g.box(-0.045, -0.37, -0.06, 0.045, -0.3, 0.04, hair);
  }

  // rostro: rubor, ojos altos con brillo crema, ojos felices y boca (planos sobre la cara)
  on('head');
  for (const sx of [-1, 1]) {
    const cx = sx * S.eyeX + sx * 0.035;
    g.qz(cx - 0.035, S.eyeY - 0.085, cx + 0.035, S.eyeY - 0.06, d / 2 + 0.002, mixTint(skin, P.neon, 0.5));
  }
  on('eyes');
  for (const sx of [-1, 1]) {
    const x = sx * S.eyeX;
    g.qz(x - 0.028, -0.05, x + 0.028, 0.05, 0, P.ink);
    g.qz(x - 0.02, 0.012, x - 0.002, 0.04, 0.001, P.cream);
  }
  on('eyesHappy');
  for (const sx of [-1, 1]) {
    const x = sx * S.eyeX;
    g.qz(x - 0.045, -0.01, x - 0.015, 0.012, 0, P.ink);
    g.qz(x - 0.018, 0.01, x + 0.018, 0.032, 0, P.ink);
    g.qz(x + 0.015, -0.01, x + 0.045, 0.012, 0, P.ink);
  }
  on('mouth');
  g.qz(-0.025, -0.009, 0.025, 0.009, 0, shade(skin, 0.45));

  // brazos
  for (const arm of ['armL', 'armR'] as const) {
    on(arm);
    g.box(-0.05, -0.2, -0.055, 0.05, 0.03, 0.055, sleeve, { top: 0.06 });
    g.box(-0.045, -0.28, -0.05, 0.045, -0.2, 0.05, skin);
    if (L.acc === 'hoodie') g.box(-0.053, -0.21, -0.058, 0.053, -0.18, 0.058, dark);
  }

  // accesorio: el rasgo que se reconoce en silueta
  on('accessory');
  switch (L.acc) {
    case 'hoodie':
      g.box(-0.19, 0.15, -0.2, 0.19, 0.35, -0.08, dark);
      g.box(-0.14, 0.03, 0.12, 0.14, 0.11, 0.132, dark);
      g.box(-0.06, 0.13, 0.12, -0.04, 0.24, 0.135, acc2);
      g.box(0.04, 0.13, 0.12, 0.06, 0.24, 0.135, acc2);
      break;
    case 'hardhat': {
      const hc = P.amber;
      g.box(-w / 2 - 0.035, top - 0.03, -d / 2 - 0.035, w / 2 + 0.035, top + 0.12, d / 2 + 0.035, hc, { top: 0.1 });
      g.box(-w / 2 - 0.045, top - 0.04, d / 2, w / 2 + 0.045, top - 0.01, d / 2 + 0.11, shade(hc, 0.85));
      g.box(-0.035, top + 0.12, -d / 2 - 0.02, 0.035, top + 0.15, d / 2 + 0.02, shade(hc, 1.1));
      on('torso');
      g.box(-bw / 2 - 0.006, 0.09, -0.126, bw / 2 + 0.006, 0.12, 0.126, P.cream);
      g.box(-0.17, -0.02, -0.122, 0.17, 0.02, 0.122, P.walnut);
      g.box(-0.03, -0.015, 0.12, 0.03, 0.015, 0.13, acc2);
      break;
    }
    case 'backpack':
      g.box(-0.13, 0.03, -0.21, 0.13, 0.25, -0.12, acc2, { top: 0.1 });
      g.box(-0.13, 0.05, 0.12, -0.1, 0.26, 0.13, shade(acc2, 0.8));
      g.box(0.1, 0.05, 0.12, 0.13, 0.26, 0.13, shade(acc2, 0.8));
      break;
    case 'explorerHat':
      g.box(-w / 2 - 0.1, top - 0.03, -d / 2 - 0.1, w / 2 + 0.1, top, d / 2 + 0.1, acc2, { top: 0.08 });
      g.box(-w / 2 + 0.02, top, -d / 2 + 0.02, w / 2 - 0.02, top + 0.15, d / 2 - 0.02, acc2, { top: 0.08 });
      g.box(-w / 2 + 0.015, top, -d / 2 + 0.015, w / 2 - 0.015, top + 0.04, d / 2 - 0.015, shade(acc2, 0.6));
      on('torso');
      g.boxC(0, 0.12, 0.125, 0.05, 0.3, 0.01, acc2, { rz: 0.75 });
      g.box(-0.25, -0.05, -0.07, -0.18, 0.08, 0.08, shade(acc2, 0.8));
      break;
    case 'glasses': {
      const ey = S.eyeY;
      const gz = d / 2 + 0.014;
      for (const sx of [-1, 1]) {
        const cx = sx * S.eyeX;
        g.qz(cx - 0.075, ey + 0.055, cx + 0.075, ey + 0.075, gz, acc2);
        g.qz(cx - 0.075, ey - 0.075, cx + 0.075, ey - 0.055, gz, acc2);
        g.qz(cx - 0.075, ey - 0.055, cx - 0.055, ey + 0.055, gz, acc2);
        g.qz(cx + 0.055, ey - 0.055, cx + 0.075, ey + 0.055, gz, acc2);
      }
      g.qz(-0.025, ey + 0.02, 0.025, ey + 0.04, gz, acc2);
      g.box(-w / 2 - 0.012, ey + 0.045, -0.1, -w / 2, ey + 0.065, d / 2 + 0.012, acc2);
      g.box(w / 2, ey + 0.045, -0.1, w / 2 + 0.012, ey + 0.065, d / 2 + 0.012, acc2);
      on('torso');
      g.box(-0.035, 0.01, 0.12, 0.035, 0.27, 0.128, dark);
      g.box(0.07, 0.13, 0.12, 0.085, 0.21, 0.13, P.amber);
      break;
    }
    case 'clipboard':
      g.box(0.05, -0.38, -0.11, 0.075, -0.1, 0.11, P.walnut);
      g.box(0.075, -0.35, -0.09, 0.082, -0.13, 0.09, P.cream);
      g.box(0.078, -0.14, -0.03, 0.086, -0.11, 0.03, P.lavender);
      on('head');
      g.boxC(-w / 2 - 0.02, 0.3, 0.02, 0.02, 0.02, 0.16, acc2, { rx: 0.4 });
      on('torso');
      g.qz(-0.07, 0.15, -0.05, 0.27, 0.121, acc2);
      g.qz(0.05, 0.15, 0.07, 0.27, 0.121, acc2);
      g.qz(-0.05, 0.08, 0.05, 0.15, 0.122, P.cream);
      break;
    case 'headphones':
      g.box(-w / 2 - 0.04, top + 0.02, -0.04, w / 2 + 0.04, top + 0.07, 0.04, P.ink);
      g.box(-w / 2 - 0.05, 0.22, -0.04, -w / 2 - 0.01, top + 0.07, 0.04, P.ink);
      g.box(w / 2 + 0.01, 0.22, -0.04, w / 2 + 0.05, top + 0.07, 0.04, P.ink);
      g.box(-w / 2 - 0.09, 0.1, -0.09, -w / 2, 0.3, 0.09, acc2, { top: 0.1 });
      g.box(w / 2, 0.1, -0.09, w / 2 + 0.09, 0.3, 0.09, acc2, { top: 0.1 });
      on('torso');
      g.qz(-0.08, 0.09, 0.08, 0.21, 0.121, acc2);
      break;
    case 'bowtie':
      g.box(-0.08, 0.23, 0.1, 0.08, 0.275, 0.125, P.cream);
      g.box(-0.09, 0.195, 0.12, -0.02, 0.255, 0.145, acc2);
      g.box(0.02, 0.195, 0.12, 0.09, 0.255, 0.145, acc2);
      g.box(-0.025, 0.21, 0.12, 0.025, 0.24, 0.15, shade(acc2, 0.7));
      g.box(-bw / 2 + 0.03, 0.01, 0.12, -0.04, 0.21, 0.126, P.walnut);
      g.box(0.04, 0.01, 0.12, bw / 2 - 0.03, 0.21, 0.126, P.walnut);
      // bigote
      on('head');
      g.box(-0.08, 0.1, d / 2, 0.08, 0.135, d / 2 + 0.022, hair);
      g.box(-0.1, 0.09, d / 2, -0.06, 0.12, d / 2 + 0.02, hair);
      g.box(0.06, 0.09, d / 2, 0.1, 0.12, d / 2 + 0.02, hair);
      break;
    case 'badge':
      g.qz(0.05, 0.08, 0.13, 0.18, 0.121, P.cream);
      g.qz(0.075, 0.15, 0.105, 0.165, 0.122, P.ink);
      g.qz(0.095, 0.12, 0.105, 0.15, 0.122, P.ink);
      g.qz(0.085, 0.095, 0.095, 0.108, 0.122, P.ink);
      g.qz(0.02, 0.18, 0.035, 0.27, 0.121, P.amber);
      g.qz(-0.035, 0.18, -0.02, 0.27, 0.121, P.amber);
      break;
    case 'labcoat': {
      // antiparras en la frente: cinta de tinta y dos lentes del color del accesorio
      const gy = top - 0.11;
      g.box(-w / 2 - 0.014, gy - 0.02, -d / 2 - 0.014, w / 2 + 0.014, gy + 0.02, d / 2 + 0.014, P.ink);
      for (const sx of [-1, 1]) g.boxC(sx * 0.1, gy, d / 2 + 0.025, 0.13, 0.085, 0.03, acc2, { top: 0.1 });
      g.qz(0.05, gy + 0.01, 0.08, gy + 0.03, d / 2 + 0.041, P.cream);
      // bata crema abierta: camiseta en la V, solapas y bolsillo con boligrafo
      on('torso');
      g.box(-bw / 2 - 0.02, -0.12, -0.13, bw / 2 + 0.02, 0.275, 0.13, P.cream, { top: 0.06, jitter: 0.03 });
      g.qz(-0.04, 0.1, 0.04, 0.275, 0.131, shirt);
      g.qz(-0.08, 0.15, -0.04, 0.275, 0.132, shade(P.cream, 0.8));
      g.qz(0.04, 0.15, 0.08, 0.275, 0.132, shade(P.cream, 0.8));
      g.qz(0.07, 0.04, 0.14, 0.1, 0.132, shade(P.cream, 0.86));
      g.qz(0.09, 0.08, 0.105, 0.14, 0.133, P.teal);
      break;
    }
    case 'security':
      // audifono en la oreja derecha con el cable en espiral hacia el cuello
      g.box(-w / 2 - 0.045, 0.1, -0.005, -w / 2 + 0.005, 0.19, 0.055, acc2);
      g.boxC(-w / 2 + 0.012, 0.025, 0, 0.016, 0.16, 0.016, acc2, { rz: 0.35 });
      // chaqueta oscura abierta, solapas y credencial con clip
      on('torso');
      g.box(-bw / 2 - 0.02, -0.07, -0.13, bw / 2 + 0.02, 0.275, 0.13, JACKET, { top: 0.08, jitter: 0.03 });
      g.qz(-0.035, 0.1, 0.035, 0.275, 0.131, shirt);
      g.qz(-0.075, 0.13, -0.035, 0.275, 0.132, P.night);
      g.qz(0.035, 0.13, 0.075, 0.275, 0.132, P.night);
      g.qz(0.075, 0.05, 0.145, 0.14, 0.132, P.cream);
      g.qz(0.087, 0.09, 0.112, 0.125, 0.133, P.ink);
      g.qz(0.1, 0.14, 0.12, 0.16, 0.133, P.amber);
      break;
    default:
      break;
  }

  // objetos en la mano (ocultos salvo en la pose que los usa)
  on('mug');
  g.cyl(0, -0.05, 0, 0.045, 0.045, 0.09, P.cream, 8);
  g.box(0.045, -0.03, -0.01, 0.07, 0.02, 0.01, P.cream);
  on('marker');
  g.box(-0.012, -0.06, -0.012, 0.012, 0.05, 0.012, P.teal);
  g.box(-0.008, 0.05, -0.008, 0.008, 0.07, 0.008, P.ink);
  // libro abierto: tapa y dos paginas con un renglon, mirando a +y
  on('book');
  g.box(-0.13, -0.014, -0.09, 0.13, 0, 0.09, P.plum);
  g.qy(-0.12, -0.08, -0.008, 0.08, 0.001, P.cream);
  g.qy(0.008, -0.08, 0.12, 0.08, 0.001, P.cream);
  g.qy(-0.1, 0, -0.03, 0.02, 0.002, P.lavender);
  g.qy(0.03, -0.03, 0.1, -0.01, 0.002, P.lavender);
  // matraz tomado del cuello, con liquido cian
  on('flask');
  g.cyl(0, -0.08, 0, 0.055, 0.02, 0.08, P.cyan, 6);
  g.box(-0.018, 0, -0.018, 0.018, 0.05, 0.018, P.lavender);
  // lupa: mango hacia +z desde la mano y lente horizontal
  on('lens');
  g.box(-0.012, -0.012, -0.02, 0.012, 0.012, 0.07, P.walnut);
  g.cyl(0, -0.008, 0.13, 0.06, 0.06, 0.016, P.moon, 6);

  const triangles = g.triangles;
  const geometry = g.build();
  geometry.name = `personaje-${L.id}`;
  return { look: L, geometry, parents, rest, boneInverses, triangles, hasTail };
}

const assets = new Map<CastId, CharacterAsset>();

function assetFor(id: CastId): CharacterAsset {
  let a = assets.get(id);
  if (!a) {
    a = buildAsset(id);
    assets.set(id, a);
  }
  return a;
}

/** Triangulos del personaje (presupuesto: ~600) */
export function characterTriangles(id: CastId): number {
  return assetFor(id).triangles;
}

export interface CharacterRig {
  castId: CastId;
  look: CastLook;
  mesh: SkinnedMesh;
  bones: Bone[];
  /** los mismos huesos por nombre */
  b: Readonly<Record<BoneName, Bone>>;
  /** posiciones de reposo, por indice de hueso (compartidas: solo lectura) */
  rest: readonly Vector3[];
  hasTail: boolean;
  bubble: Sprite;
  spark: Sprite;
  /** "?" de espera y zzz de dormido */
  question: Sprite;
  zzz: Sprite;
  triangles: number;
  dispose(): void;
}

const IDENTITY = new Matrix4();
/** Esfera fija para el recorte por camara (evita el calculo con skinning en CPU) */
const CHARACTER_SPHERE = new Sphere(new Vector3(0, 0.62, 0), 0.95);

export function createRig(id: CastId): CharacterRig {
  const asset = assetFor(id);
  const bones = asset.rest.map((p, i) => {
    const bn = new Bone();
    bn.name = BONE_NAMES[i] ?? `hueso-${i}`;
    bn.position.copy(p);
    bn.rotation.order = 'YXZ';
    return bn;
  });
  asset.parents.forEach((parent, i) => {
    const bn = bones[i];
    const pb = parent >= 0 ? bones[parent] : undefined;
    if (bn && pb) pb.add(bn);
  });
  const named = Object.fromEntries(BONE_NAMES.map((n, i) => [n, bones[i]])) as Record<BoneName, Bone>;

  const mesh = new SkinnedMesh(asset.geometry, characterMaterialFor(0, false));
  mesh.name = `personaje-${id}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.add(named.root);
  const skeleton = new Skeleton(bones, asset.boneInverses);
  mesh.bind(skeleton, IDENTITY);
  mesh.boundingSphere = CHARACTER_SPHERE;

  const bubble = new Sprite(bubbleMaterial);
  bubble.name = 'burbuja';
  bubble.position.set(0.34, 0.66, 0);
  bubble.scale.set(0.34, 0.24, 1);
  bubble.visible = false;
  named.head.add(bubble);

  const spark = new Sprite(sparkMaterialFor(1));
  spark.name = 'chispa';
  spark.position.set(0, 0.55, 0);
  spark.visible = false;
  mesh.add(spark);

  const question = new Sprite(questionMaterial);
  question.name = 'pregunta';
  question.position.set(QUESTION_POS.x, QUESTION_POS.y, 0);
  question.scale.set(0.2, 0.275, 1);
  question.visible = false;
  named.head.add(question);

  const zzz = new Sprite(zzzMaterial);
  zzz.name = 'zzz';
  zzz.position.set(ZZZ_POS.x, ZZZ_POS.y, 0);
  zzz.scale.set(0.3, 0.3, 1);
  zzz.visible = false;
  named.hips.add(zzz);

  return {
    castId: id,
    look: asset.look,
    mesh,
    bones,
    b: named,
    rest: asset.rest,
    hasTail: asset.hasTail,
    bubble,
    spark,
    question,
    zzz,
    triangles: asset.triangles,
    dispose: () => skeleton.dispose(),
  };
}
