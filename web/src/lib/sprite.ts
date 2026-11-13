// Retratos pixel (busto chibi 16x16) para el HUD, derivados del look de cada agente en theme.ts.
// Mismo elenco que los personajes 3D del kit: camiseta, pelo, piel, peinado y rasgo de silueta.
import { PALETTE, type AgentLook, type HairStyle } from '@/theme';

export type PixelGrid = ReadonlyArray<ReadonlyArray<string | null>>;

export const SPRITE_SIZE = 16;

type Grid = (string | null)[][];

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** Multiplica el color (sombra toon del kit: shade(k, f)) */
export function shadeHex(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * f, g * f, b * f);
}

export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Luminancia relativa WCAG (0..1) */
export function relativeLuminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blank(): Grid {
  return Array.from({ length: SPRITE_SIZE }, () => Array<string | null>(SPRITE_SIZE).fill(null));
}

function put(grid: Grid, row: number, col: number, color: string): void {
  const r = grid[row];
  if (r && col >= 0 && col < r.length) r[col] = color;
}

function hline(grid: Grid, row: number, from: number, to: number, color: string): void {
  for (let c = from; c <= to; c += 1) put(grid, row, c, color);
}

function vline(grid: Grid, col: number, from: number, to: number, color: string): void {
  for (let r = from; r <= to; r += 1) put(grid, r, col, color);
}

/** solo pinta donde no hay nada (lo que queda detras de la cabeza o del cuerpo) */
function behind(grid: Grid, row: number, col: number, color: string): void {
  if (grid[row]?.[col] === null) put(grid, row, col, color);
}

function paintBody(grid: Grid, look: AgentLook): void {
  const dark = shadeHex(look.shirt, 0.72);
  hline(grid, 11, 4, 6, look.shirt);
  hline(grid, 11, 9, 11, look.shirt);
  hline(grid, 11, 7, 8, look.skin);
  hline(grid, 12, 3, 12, look.shirt);
  for (let r = 13; r <= 15; r += 1) {
    hline(grid, r, 2, 13, look.shirt);
    put(grid, r, 4, dark);
    put(grid, r, 11, dark);
  }
}

function paintHead(grid: Grid, look: AgentLook): void {
  for (let r = 4; r <= 9; r += 1) hline(grid, r, 3, 12, look.skin);
  hline(grid, 10, 4, 11, look.skin);
  // ojos grandes con brillo crema arriba a la izquierda (kit: ojos altos con brillo crema)
  for (const c of [4, 10]) {
    put(grid, 6, c, PALETTE.cream);
    put(grid, 6, c + 1, PALETTE.ink);
    put(grid, 7, c, PALETTE.ink);
    put(grid, 7, c + 1, PALETTE.ink);
  }
  const blush = mixHex(look.skin, PALETTE.neon, 0.5);
  put(grid, 8, 4, blush);
  put(grid, 8, 11, blush);
  hline(grid, 9, 7, 8, shadeHex(look.skin, 0.45));
}

const HATTED = new Set(['hardhat', 'explorer-hat']);

function paintHair(grid: Grid, look: AgentLook, style: HairStyle): void {
  const h = look.hair;
  const hatted = HATTED.has(look.accessory);
  if (style === 'buzz') {
    hline(grid, 2, 3, 12, h);
    hline(grid, 3, 3, 12, h);
    return;
  }
  if (!hatted) {
    hline(grid, 1, 4, 11, h);
    hline(grid, 2, 3, 12, h);
    hline(grid, 2, 5, 7, mixHex(h, '#B8B2E6', 0.32));
  }
  hline(grid, 3, 2, 13, h);
  for (let r = 4; r <= 6; r += 1) {
    put(grid, r, 2, h);
    put(grid, r, 13, h);
  }
  if (hatted) {
    hline(grid, 4, 3, 5, h);
    return;
  }
  switch (style) {
    case 'messy':
      put(grid, 0, 5, h);
      put(grid, 0, 6, h);
      put(grid, 0, 9, h);
      hline(grid, 4, 3, 9, h);
      hline(grid, 5, 3, 4, h);
      break;
    case 'short':
      hline(grid, 4, 3, 9, h);
      break;
    case 'ponytail':
      hline(grid, 4, 3, 12, h);
      put(grid, 4, 14, look.accent ?? PALETTE.amber);
      vline(grid, 14, 5, 8, h);
      break;
    case 'bob':
      hline(grid, 4, 3, 12, h);
      put(grid, 5, 3, h);
      put(grid, 5, 12, h);
      vline(grid, 2, 3, 10, h);
      vline(grid, 13, 3, 10, h);
      break;
    case 'bun':
      hline(grid, 4, 3, 8, h);
      hline(grid, 0, 6, 9, h);
      hline(grid, 1, 6, 9, look.accent ?? PALETTE.honey);
      break;
    case 'swept':
      hline(grid, 4, 3, 12, h);
      hline(grid, 5, 9, 12, h);
      break;
  }
}

/** Prenda abierta encima de la camiseta (bata, chaqueta): tapa el cuerpo y deja la camiseta en la V */
function paintOver(grid: Grid, garment: string, shirt: string): void {
  hline(grid, 11, 4, 6, garment);
  hline(grid, 11, 9, 11, garment);
  hline(grid, 12, 3, 12, garment);
  for (let r = 13; r <= 15; r += 1) hline(grid, r, 2, 13, garment);
  for (let r = 12; r <= 15; r += 1) hline(grid, r, 7, 8, shirt);
}

function paintAccessory(grid: Grid, look: AgentLook): void {
  const acc = look.accent ?? PALETTE.cream;
  const dark = shadeHex(look.shirt, 0.72);
  switch (look.accessory) {
    case 'hoodie':
      for (const [r, c] of [
        [8, 2],
        [9, 2],
        [10, 2],
        [10, 3],
        [11, 3],
        [8, 13],
        [9, 13],
        [10, 13],
        [10, 12],
        [11, 12],
      ] as const)
        put(grid, r, c, dark);
      vline(grid, 6, 12, 13, acc);
      vline(grid, 9, 12, 13, acc);
      hline(grid, 15, 5, 10, dark);
      break;
    case 'hardhat': {
      const hat = PALETTE.amber;
      hline(grid, 0, 7, 8, mixHex(hat, '#FFFFFF', 0.25));
      hline(grid, 1, 3, 12, hat);
      hline(grid, 2, 3, 12, hat);
      hline(grid, 1, 4, 5, mixHex(hat, '#FFFFFF', 0.3));
      hline(grid, 3, 2, 13, shadeHex(hat, 0.85));
      hline(grid, 14, 2, 13, PALETTE.cream);
      break;
    }
    case 'explorer-hat':
      hline(grid, 0, 4, 11, acc);
      hline(grid, 1, 4, 11, acc);
      hline(grid, 2, 4, 11, shadeHex(acc, 0.6));
      hline(grid, 3, 1, 14, acc);
      put(grid, 12, 5, acc);
      put(grid, 13, 6, acc);
      put(grid, 14, 7, acc);
      put(grid, 15, 8, acc);
      break;
    case 'backpack':
      put(grid, 11, 3, acc);
      put(grid, 11, 12, acc);
      vline(grid, 5, 12, 15, shadeHex(acc, 0.8));
      vline(grid, 10, 12, 15, shadeHex(acc, 0.8));
      break;
    case 'glasses': {
      // lentes: brillo arriba y pupila de 1 pixel mirando al centro, dentro de un aro de 4x4
      const shine = mixHex(look.skin, '#FFFFFF', 0.45);
      for (const [c0, pupil] of [
        [3, 5],
        [9, 10],
      ] as const) {
        hline(grid, 6, c0 + 1, c0 + 2, look.skin);
        hline(grid, 7, c0 + 1, c0 + 2, look.skin);
        put(grid, 6, c0 + 1, shine);
        put(grid, 7, pupil, PALETTE.ink);
        hline(grid, 5, c0, c0 + 3, acc);
        hline(grid, 8, c0, c0 + 3, acc);
        vline(grid, c0, 6, 7, acc);
        vline(grid, c0 + 3, 6, 7, acc);
      }
      hline(grid, 6, 7, 8, acc);
      vline(grid, 7, 12, 15, dark);
      vline(grid, 8, 12, 15, dark);
      put(grid, 13, 10, PALETTE.amber);
      break;
    }
    case 'clipboard':
      put(grid, 5, 13, acc);
      put(grid, 6, 13, acc);
      for (let r = 13; r <= 15; r += 1) hline(grid, r, 8, 12, PALETTE.walnut);
      hline(grid, 14, 9, 11, PALETTE.cream);
      hline(grid, 15, 9, 11, PALETTE.cream);
      put(grid, 13, 10, PALETTE.lavender);
      break;
    case 'headphones':
      hline(grid, 1, 3, 12, PALETTE.ink);
      vline(grid, 2, 2, 5, PALETTE.ink);
      vline(grid, 13, 2, 5, PALETTE.ink);
      for (let r = 6; r <= 8; r += 1) {
        hline(grid, r, 1, 2, acc);
        hline(grid, r, 13, 14, acc);
      }
      hline(grid, 13, 7, 8, acc);
      hline(grid, 14, 7, 8, acc);
      break;
    case 'bowtie':
      hline(grid, 9, 6, 9, look.hair);
      hline(grid, 11, 6, 9, PALETTE.cream);
      hline(grid, 12, 5, 6, acc);
      hline(grid, 12, 9, 10, acc);
      hline(grid, 12, 7, 8, shadeHex(acc, 0.7));
      for (let r = 13; r <= 15; r += 1) {
        hline(grid, r, 5, 6, PALETTE.walnut);
        hline(grid, r, 9, 10, PALETTE.walnut);
      }
      break;
    case 'badge':
      put(grid, 12, 6, PALETTE.amber);
      put(grid, 12, 9, PALETTE.amber);
      hline(grid, 13, 7, 8, PALETTE.cream);
      hline(grid, 14, 7, 8, PALETTE.cream);
      put(grid, 14, 8, PALETTE.ink);
      break;
    case 'labcoat': {
      // bata crema abierta (camiseta en la V, solapas, boligrafo) y antiparras en la frente
      const coat = PALETTE.cream;
      const fold = shadeHex(coat, 0.8);
      paintOver(grid, coat, look.shirt);
      for (let r = 13; r <= 15; r += 1) put(grid, r, 4, shadeHex(coat, 0.86));
      for (const c of [6, 9]) vline(grid, c, 12, 13, fold);
      put(grid, 13, 11, PALETTE.teal);
      hline(grid, 4, 3, 12, PALETTE.ink);
      for (const c0 of [4, 10]) {
        hline(grid, 4, c0, c0 + 1, acc);
        hline(grid, 5, c0, c0 + 1, acc);
        put(grid, 4, c0, mixHex(acc, '#FFFFFF', 0.4));
      }
      break;
    }
    case 'security':
      // chaqueta oscura abierta, credencial con clip y audifono con cable hacia el cuello
      paintOver(grid, PALETTE.indigo, look.shirt);
      for (const c of [6, 9]) vline(grid, c, 12, 13, PALETTE.night);
      put(grid, 13, 10, PALETTE.amber);
      hline(grid, 14, 10, 11, acc);
      hline(grid, 15, 10, 11, acc);
      put(grid, 14, 10, PALETTE.ink);
      vline(grid, 2, 7, 9, acc);
      vline(grid, 3, 10, 11, acc);
      break;
    case 'ponytail':
    case 'none':
      break;
  }
}

/** Contorno de tinta de 1 pixel alrededor de la silueta (como el contorno de la escena) */
function outline(grid: Grid, color: string): void {
  const marks: [number, number][] = [];
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell !== null) return;
      const near = [grid[r - 1]?.[c], grid[r + 1]?.[c], row[c - 1], row[c + 1]];
      if (near.some((n) => n !== null && n !== undefined && n !== color)) marks.push([r, c]);
    }),
  );
  for (const [r, c] of marks) put(grid, r, c, color);
}

/** Busto 16x16 del agente: pelo, cara chibi, camiseta y su rasgo de silueta */
export function spriteGrid(look: AgentLook): (string | null)[][] {
  const grid = blank();
  const style: HairStyle = look.hairStyle ?? (look.accessory === 'ponytail' ? 'ponytail' : 'short');
  paintBody(grid, look);
  paintHead(grid, look);
  paintHair(grid, look, style);
  paintAccessory(grid, look);
  if (style === 'ponytail') behind(grid, 9, 14, look.hair);
  outline(grid, PALETTE.ink);
  return grid;
}

function parseGrid(rows: readonly string[], legend: Record<string, string>): (string | null)[][] {
  return rows.map((row) => [...row].map((ch) => legend[ch] ?? null));
}

/** Colores de la marca Colmena: abeja dorada con alas de cristal turquesa */
export const LOGO_COLORS = {
  ink: PALETTE.ink,
  goldLight: '#FFE08A',
  gold: '#F2C14E',
  goldDark: '#B07A22',
  stripe: '#4A3418',
  crystalLight: '#A6FFEE',
  crystal: '#33D9C1',
  shine: '#FFFFFF',
  blush: '#FF7FA8',
} as const;

/**
 * Marca de Colmena (20x17): abeja obrera redonda con antenas de bolita, ojos con brillo, cachetes, dos
 * rayas, panza sombreada, aguijon y alas de cristal con reflejo. Mismo dibujo que web/public/favicon.svg.
 * Los ojos estan en x 7-8 y 11-12, filas 7-8 (PixelLogo los cierra al parpadear).
 */
export const LOGO_GRID: PixelGrid = parseGrid(
  [
    '....KKK......KKK....',
    '....KYK......KYK....',
    '....KKK......KKK....',
    '.KKK.K........K.KKK.',
    'KHHHK.K......K.KHHHK',
    'KHWHHK.KKKKKK.KHHWHK',
    'KHHHTKKYYYYYYKKTHHHK',
    'KTHTTKGWKGGWKGKTTHTK',
    '.KTTKKGKKGGKKGKKTTK.',
    '..KKKGPGGKKGGPGKKK..',
    '....KSSSSSSSSSSK....',
    '....KGGGGGGGGGGK....',
    '....KSSSSSSSSSSK....',
    '.....KgGGGGGGgK.....',
    '......KggggggK......',
    '.......KKKKKK.......',
    '.........KK.........',
  ],
  {
    K: LOGO_COLORS.ink,
    Y: LOGO_COLORS.goldLight,
    G: LOGO_COLORS.gold,
    g: LOGO_COLORS.goldDark,
    S: LOGO_COLORS.stripe,
    H: LOGO_COLORS.crystalLight,
    T: LOGO_COLORS.crystal,
    W: LOGO_COLORS.shine,
    P: LOGO_COLORS.blush,
  },
);

export interface PixelRun {
  x: number;
  y: number;
  w: number;
  color: string;
}

/** Une pixeles contiguos del mismo color por fila: menos <rect> en el SVG */
export function gridRuns(grid: PixelGrid): PixelRun[] {
  const runs: PixelRun[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = row[x];
      if (!color) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === color) end += 1;
      runs.push({ x, y, w: end - x, color });
      x = end;
    }
  });
  return runs;
}
