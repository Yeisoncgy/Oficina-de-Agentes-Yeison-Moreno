// Direccion de arte compartida por la escena 3D y el HUD: "Estudio nocturno" (direccion A, v2).
// Fuentes del diseno: paleta de la escena y elenco = kit 3D (D4); tokens de interfaz = sistema de
// diseno (D2); tiempos = lenguaje de movimiento (D5). Todo color de la app sale de aqui.

import { PERSONA_BY_TYPE, personaLook } from '@shared/personas';
import { KIT_PAL } from '@/scene/characters/looks';

/**
 * Paleta de la escena (PAL del kit 3D): 20 colores y ninguno mas.
 * Las claves antiguas se conservan para el codigo que ya las usa; apuntan al color mas cercano de la
 * paleta nueva.
 */
export const PALETTE = {
  ink: '#14132B',
  inkSoft: '#232553',
  slate: '#3A3F7A',
  cream: '#FFE3B0',
  paper: '#D2CCE4',

  floorLight: '#A8704A',
  floorDark: '#6E4632',
  wall: '#554A86',
  wallShade: '#3A3F7A',
  trim: '#6E4632',
  wood: '#A8704A',
  woodDark: '#6E4632',
  rug: '#7A3E63',
  rugAccent: '#F5A94A',
  plant: '#5E9A5F',
  plantDark: '#2C5446',
  pot: '#D9673B',
  metal: '#9A96C4',
  metalDark: '#6B5E9E',

  screenOn: '#6FF0E4',
  screenGlow: '#2FA6A6',
  screenOff: '#232553',
  lamp: '#FFB25A',

  red: '#D9673B',
  teal: '#2FA6A6',
  coral: '#F07BA8',
  mustard: '#F5A94A',
  violet: '#6B5E9E',
  blue: '#8FA6E8',
  pink: '#F07BA8',
  green: '#5E9A5F',
  gray: '#9A96C4',

  // Nombres del kit 3D (D4 PAL)
  night: '#232553',
  indigo: '#3A3F7A',
  dusk: '#6B5E9E',
  lavender: '#9A96C4',
  moon: '#8FA6E8',
  amber: '#F5A94A',
  ember: '#D9673B',
  walnut: '#6E4632',
  honey: '#A8704A',
  plum: '#7A3E63',
  leaf: '#5E9A5F',
  moss: '#2C5446',
  cyan: '#6FF0E4',
  neon: '#F07BA8',
  skinLight: '#F2C19B',
  skinDark: '#A86B4C',
} as const;

/** Superficies, texto y acento de la interfaz (D2, par 1a "Lampara") */
export const UI = {
  bg: '#0F0E1C',
  panel: '#14132B',
  panelGlass: 'rgb(20 19 43 / 0.94)',
  panelRaised: '#1E1D40',
  panelHover: '#272650',
  panelSunken: '#0B0A18',
  border: '#3A3F7A',
  borderStrong: '#6B5E9E',
  borderSubtle: '#2A2850',
  frameOuter: '#0B0A18',
  text: '#FFE3B0',
  textSecondary: '#D2CCE4',
  textMuted: '#9A96C4',
  accent: '#F5A94A',
  accentHover: '#FFC27A',
  accentPressed: '#D98F35',
  onAccent: '#14132B',
  focus: '#FFE3B0',
} as const;

/** Estados (D2): siempre LED cuadrado de 8 px + etiqueta; el color nunca va solo */
export const STATE = {
  working: '#6FF0E4',
  idle: '#9A96C4',
  done: '#89E29D',
  error: '#F9786A',
  warning: '#F8D05C',
  live: '#8FA6E8',
  offline: '#9290A1',
} as const;

/** Cielo y horario de lamparas (el cielo sale de LIGHT del kit 3D) */
export const SKY = {
  day: '#8E93C9',
  dusk: '#F29A6B',
  night: '#0E0F2A',
  /** 18:00-06:00 lamparas encendidas */
  lampsOnFromHour: 18,
  lampsOffAtHour: 6,
} as const;

export const STATUS_COLOR = {
  working: STATE.working,
  idle: STATE.idle,
  done: STATE.done,
} as const;

/** Rasgo que se reconoce en silueta (kit 3D). 'ponytail' queda por compatibilidad: ahora es un peinado. */
export type Accessory =
  | 'hoodie'
  | 'hardhat'
  | 'ponytail'
  | 'backpack'
  | 'explorer-hat'
  | 'glasses'
  | 'clipboard'
  | 'headphones'
  | 'bowtie'
  | 'badge'
  | 'labcoat'
  | 'security'
  | 'none';

export type HairStyle = 'messy' | 'short' | 'ponytail' | 'bob' | 'bun' | 'buzz' | 'swept';

export interface AgentLook {
  shirt: string;
  pants: string;
  /** color del pelo */
  hair: string;
  skin: string;
  accessory: Accessory;
  /** peinado del kit 3D */
  hairStyle?: HairStyle;
  /** color secundario del accesorio (acc2 del kit 3D) */
  accent?: string;
}

const P = PALETTE;

/** Personaje generico del kit 3D: tipos que no estan en el elenco */
export const DEFAULT_LOOK: AgentLook = {
  shirt: P.dusk,
  pants: P.indigo,
  hair: P.walnut,
  skin: P.skinLight,
  accessory: 'badge',
  hairStyle: 'short',
  accent: P.cream,
};

const PERSONA_ACCESSORY: Record<string, Accessory> = { explorerHat: 'explorer-hat' };

function personaAgentLook(key: string): AgentLook | undefined {
  const p = personaLook(key);
  if (!p) return undefined;
  return {
    shirt: KIT_PAL[p.shirt],
    pants: KIT_PAL[p.pants],
    hair: KIT_PAL[p.hairC],
    skin: KIT_PAL[p.skin],
    accessory: PERSONA_ACCESSORY[p.acc] ?? (p.acc as Accessory),
    hairStyle: p.hair,
    accent: KIT_PAL[p.acc2],
  };
}

/**
 * Elenco del kit 3D (CAST), por tipo de agente. Mismos colores en el personaje 3D y en su retrato.
 * Pruebas y seguridad son personas del equipo (Tomas con bata, Sara con chaqueta): su look sale de
 * shared/personas.ts, igual que su personaje 3D.
 */
export const AGENT_LOOKS: Record<string, AgentLook> = {
  lead: { shirt: P.ember, pants: P.night, hair: P.night, skin: P.skinLight, accessory: 'hoodie', hairStyle: 'messy', accent: P.cream },
  'tr-builder': { shirt: P.teal, pants: P.indigo, hair: P.walnut, skin: P.skinLight, accessory: 'hardhat', hairStyle: 'short', accent: P.amber },
  Explore: { shirt: P.neon, pants: P.indigo, hair: P.night, skin: P.skinDark, accessory: 'backpack', hairStyle: 'ponytail', accent: P.amber },
  'tr-explorer': { shirt: P.leaf, pants: P.walnut, hair: P.walnut, skin: P.skinLight, accessory: 'explorer-hat', hairStyle: 'short', accent: P.honey },
  'tr-docs': { shirt: P.lavender, pants: P.plum, hair: P.ember, skin: P.skinLight, accessory: 'glasses', hairStyle: 'bob', accent: P.ink },
  Plan: { shirt: P.plum, pants: P.night, hair: P.night, skin: P.skinDark, accessory: 'clipboard', hairStyle: 'bun', accent: P.honey },
  'general-purpose': { shirt: P.moss, pants: P.night, hair: P.night, skin: P.skinDark, accessory: 'headphones', hairStyle: 'buzz', accent: P.neon },
  'claude-code-guide': { shirt: P.cream, pants: P.walnut, hair: P.lavender, skin: P.skinLight, accessory: 'bowtie', hairStyle: 'swept', accent: P.ember },
  tester: personaAgentLook('tomas') ?? DEFAULT_LOOK,
  security: personaAgentLook('sara') ?? DEFAULT_LOOK,
};

/** clave de look de un agente: su persona (unica en la oficina) o, si no llego, su tipo */
export function lookKey(a: { persona?: string | null; agentType: string }): string {
  return a.persona ?? a.agentType;
}

/** look por tipo de agente ('tr-builder') o por persona ('iris') */
export function lookFor(key: string): AgentLook {
  return AGENT_LOOKS[key] ?? personaAgentLook(key) ?? DEFAULT_LOOK;
}

/**
 * Color de identidad de cada agente en la interfaz (nombre, muestra, barras). Es el tono de su camiseta
 * a la claridad que se lee como texto sobre el panel (AA). Los que coinciden en tono con la camiseta
 * usan el valor de D2; Dora, Paula y Gael usan el de D3, porque el de D2 contradice su camiseta.
 * Tomas (pruebas) toma el azul de su camiseta y Sara (seguridad) un verde oliva que no se confunde
 * con el de Marco ni con el de Gael.
 */
export const AGENT_COLOR: Record<string, string> = {
  lead: '#F08D6A',
  'tr-builder': '#41BDD1',
  Explore: '#E887B6',
  'tr-explorer': '#73C076',
  'tr-docs': '#ABA7D6',
  Plan: '#C98BB1',
  'general-purpose': '#7DBA9C',
  'claude-code-guide': '#CABCA5',
  tester: '#9DB0F0',
  security: '#B3C77A',
};

export const DEFAULT_AGENT_COLOR = UI.textSecondary;

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** color de identidad por tipo ('tr-builder') o por persona ('iris'): legible sobre el panel (AA) */
export function agentColor(key: string): string {
  const byType = AGENT_COLOR[key];
  if (byType) return byType;
  const base = key.split('#')[0] ?? key;
  const kitType = Object.entries(PERSONA_BY_TYPE).find(([, id]) => id === base)?.[0];
  if (kitType && AGENT_COLOR[kitType]) return AGENT_COLOR[kitType];
  const p = personaLook(key);
  return p ? mixHex(KIT_PAL[p.shirt], '#FFE3B0', 0.38) : DEFAULT_AGENT_COLOR;
}

/** Tamano del pixel en px CSS: la escena se renderiza a 1/PIXEL_SIZE y se escala con nearest */
export const PIXEL_SIZE = 3;

export const FONTS = {
  /** Silkscreen: solo en mayusculas y a 16, 24, 32 o 48 px (grilla de 8) */
  display: "'Silkscreen', monospace",
  /** texto corrido del HUD (minimo 12 px) */
  body: "'Atkinson Hyperlegible Next', system-ui, sans-serif",
  /** cifras: tokens, USD, cronometros (siempre tabular-nums) */
  mono: "'Atkinson Hyperlegible Mono', ui-monospace, monospace",
} as const;

/** Curvas de D5 */
export const EASE = {
  /** lo que entra y frena: HUD, panel, tarjetas */
  arrive: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** lo que sale y acelera */
  leave: 'cubic-bezier(0.64, 0, 0.78, 0)',
  /** cambios de estado, camara, hora */
  change: 'cubic-bezier(0.65, 0, 0.35, 1)',
  /** solo apariciones: agentes y tarjetas */
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/** Duraciones de D5 en ms */
export const DURATION = {
  hover: 120,
  press: 80,
  reduced: 120,
  hudEnter: 320,
  cardIn: 320,
  cardOut: 180,
  cardLevel: 220,
  drawerIn: 280,
  drawerOut: 220,
  modalIn: 280,
  modalOut: 200,
  actionOut: 160,
  actionIn: 240,
  actionFlash: 600,
  liveDot: 1200,
  liveRing: 1600,
} as const;
