// Elenco del kit 3D (D4, direccion A "Estudio nocturno"): paleta, rasgo de silueta y colores de cada
// personaje, y a que tipo de agente corresponde. Los colores son los del kit, sin inventar ninguno.
import { LEAD_PERSONA, PERSONAS } from '@shared/personas';

/** Paleta del kit. La escena no usa otros colores. */
export const KIT_PAL = {
  ink: '#14132B',
  night: '#232553',
  indigo: '#3A3F7A',
  dusk: '#6B5E9E',
  lavender: '#9A96C4',
  wall: '#554A86',
  moon: '#8FA6E8',
  cream: '#FFE3B0',
  amber: '#F5A94A',
  ember: '#D9673B',
  walnut: '#6E4632',
  honey: '#A8704A',
  plum: '#7A3E63',
  leaf: '#5E9A5F',
  moss: '#2C5446',
  cyan: '#6FF0E4',
  teal: '#2FA6A6',
  neon: '#F07BA8',
  skinL: '#F2C19B',
  skinD: '#A86B4C',
} as const;

export type PalKey = keyof typeof KIT_PAL;

/** persona de shared/personas.ts ('bruno', 'iris'...) o 'generic' */
export type CastId = string;

export type Accessory =
  | 'hoodie'
  | 'hardhat'
  | 'backpack'
  | 'explorerHat'
  | 'glasses'
  | 'clipboard'
  | 'headphones'
  | 'bowtie'
  | 'badge'
  /** bata crema con gafas de laboratorio en la frente (Tomas, pruebas) */
  | 'labcoat'
  /** chaqueta oscura, audifono con cable y credencial (Sara, seguridad) */
  | 'security';

export type HairStyle = 'messy' | 'short' | 'ponytail' | 'bob' | 'bun' | 'buzz' | 'swept';

interface CastEntry {
  id: CastId;
  acc: Accessory;
  hair: HairStyle;
  shirt: PalKey;
  pants: PalKey;
  skin: PalKey;
  hairC: PalKey;
  /** color secundario del accesorio (cordones, cinta, lentes, moño...) */
  acc2: PalKey;
}

/**
 * Todas las personas de la oficina (los 8 del kit + el resto del equipo, shared/personas.ts) y el
 * generico. Cada agente visible es una persona distinta: el server se la asigna.
 */
export const CAST: readonly CastEntry[] = [
  ...PERSONAS.map((p) => ({
    id: p.id,
    acc: p.acc,
    hair: p.hair,
    shirt: p.shirt,
    pants: p.pants,
    skin: p.skin,
    hairC: p.hairC,
    acc2: p.acc2,
  })),
  { id: 'generic', acc: 'badge', hair: 'short', shirt: 'dusk', pants: 'indigo', skin: 'skinL', hairC: 'walnut', acc2: 'cream' },
];

const CAST_IDS = new Set(CAST.map((c) => c.id));

/** Tipo tecnico del agente (contrato: OfficeAgent.agentType) -> personaje. Otro tipo = generico. */
export const CAST_BY_AGENT_TYPE: Readonly<Record<string, CastId>> = {
  lead: LEAD_PERSONA,
  'tr-builder': 'bruno',
  Explore: 'elena',
  'tr-explorer': 'marco',
  'tr-docs': 'dora',
  Plan: 'paula',
  'general-purpose': 'gael',
  'claude-code-guide': 'guido',
  tester: 'tomas',
  security: 'sara',
};

/** persona ('iris', 'iris#2') o tipo de agente ('tr-builder') -> personaje; lo demas = generico */
export function castIdFor(key: string): CastId {
  const base = key.split('#')[0] ?? key;
  if (base !== 'generic' && CAST_IDS.has(base)) return base;
  return Object.prototype.hasOwnProperty.call(CAST_BY_AGENT_TYPE, key) ? (CAST_BY_AGENT_TYPE[key] ?? 'generic') : 'generic';
}

/** Personaje con los colores ya resueltos a hex */
export interface CastLook {
  id: CastId;
  acc: Accessory;
  hair: HairStyle;
  shirt: string;
  pants: string;
  skin: string;
  hairC: string;
  acc2: string;
}

const resolved = new Map<CastId, CastLook>();

export function castLook(id: CastId): CastLook {
  const hit = resolved.get(id);
  if (hit) return hit;
  const e = CAST.find((c) => c.id === id) ?? CAST[CAST.length - 1];
  if (!e) throw new Error('El elenco esta vacio');
  const look: CastLook = {
    id: e.id,
    acc: e.acc,
    hair: e.hair,
    shirt: KIT_PAL[e.shirt],
    pants: KIT_PAL[e.pants],
    skin: KIT_PAL[e.skin],
    hairC: KIT_PAL[e.hairC],
    acc2: KIT_PAL[e.acc2],
  };
  resolved.set(id, look);
  return look;
}

export function castLookFor(agentType: string): CastLook {
  return castLook(castIdFor(agentType));
}
