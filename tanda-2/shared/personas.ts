// Personas de la oficina: cada agente visible es una persona distinta (nombre y look unicos a la vez).
// El server asigna la persona; el frontend arma el personaje 3D, el retrato y el color con su look.
// Los colores son claves de la paleta del kit 3D (web/src/scene/characters/looks.ts, KIT_PAL).
import { DEFAULT_LEAD_NAME } from './agents';

export type PersonaColor =
  | 'ink' | 'night' | 'indigo' | 'dusk' | 'lavender' | 'wall' | 'moon' | 'cream' | 'amber' | 'ember'
  | 'walnut' | 'honey' | 'plum' | 'leaf' | 'moss' | 'cyan' | 'teal' | 'neon' | 'skinL' | 'skinD';

export type PersonaAccessory =
  | 'hoodie' | 'hardhat' | 'backpack' | 'explorerHat' | 'glasses' | 'clipboard' | 'headphones' | 'bowtie' | 'badge'
  /** bata de laboratorio (Tomas, Pruebas) */
  | 'labcoat'
  /** chaleco e insignia de seguridad (Sara, Seguridad) */
  | 'security';

export type PersonaHair = 'messy' | 'short' | 'ponytail' | 'bob' | 'bun' | 'buzz' | 'swept';

export interface Persona {
  id: string;
  name: string;
  acc: PersonaAccessory;
  hair: PersonaHair;
  shirt: PersonaColor;
  pants: PersonaColor;
  skin: PersonaColor;
  hairC: PersonaColor;
  /** color secundario del accesorio */
  acc2: PersonaColor;
}

/**
 * persona del lead: la misma id que su agentType, asi que castIdFor/lookFor/agentColor llegan al mismo
 * personaje y color por la persona o por el tipo. Su nombre visible es el que eligio el usuario.
 */
export const LEAD_PERSONA = 'lead';

/** Los 8 del kit primero (el primero solo para el lead), luego el resto del equipo. */
export const PERSONAS: readonly Persona[] = [
  { id: LEAD_PERSONA, name: DEFAULT_LEAD_NAME, acc: 'hoodie', hair: 'messy', shirt: 'ember', pants: 'night', skin: 'skinL', hairC: 'night', acc2: 'cream' },
  { id: 'bruno', name: 'Bruno', acc: 'hardhat', hair: 'short', shirt: 'teal', pants: 'indigo', skin: 'skinL', hairC: 'walnut', acc2: 'amber' },
  { id: 'elena', name: 'Elena', acc: 'backpack', hair: 'ponytail', shirt: 'neon', pants: 'indigo', skin: 'skinD', hairC: 'night', acc2: 'amber' },
  { id: 'marco', name: 'Marco', acc: 'explorerHat', hair: 'short', shirt: 'leaf', pants: 'walnut', skin: 'skinL', hairC: 'walnut', acc2: 'honey' },
  { id: 'dora', name: 'Dora', acc: 'glasses', hair: 'bob', shirt: 'lavender', pants: 'plum', skin: 'skinL', hairC: 'ember', acc2: 'ink' },
  { id: 'paula', name: 'Paula', acc: 'clipboard', hair: 'bun', shirt: 'plum', pants: 'night', skin: 'skinD', hairC: 'night', acc2: 'honey' },
  { id: 'gael', name: 'Gael', acc: 'headphones', hair: 'buzz', shirt: 'moss', pants: 'night', skin: 'skinD', hairC: 'night', acc2: 'neon' },
  { id: 'guido', name: 'Guido', acc: 'bowtie', hair: 'swept', shirt: 'cream', pants: 'walnut', skin: 'skinL', hairC: 'lavender', acc2: 'ember' },
  { id: 'iris', name: 'Iris', acc: 'headphones', hair: 'bob', shirt: 'amber', pants: 'indigo', skin: 'skinL', hairC: 'night', acc2: 'teal' },
  { id: 'tomas', name: 'Tomás', acc: 'labcoat', hair: 'buzz', shirt: 'moon', pants: 'walnut', skin: 'skinD', hairC: 'night', acc2: 'amber' },
  { id: 'lucia', name: 'Lucía', acc: 'glasses', hair: 'ponytail', shirt: 'teal', pants: 'plum', skin: 'skinL', hairC: 'walnut', acc2: 'ink' },
  { id: 'nico', name: 'Nico', acc: 'backpack', hair: 'messy', shirt: 'ember', pants: 'indigo', skin: 'skinL', hairC: 'honey', acc2: 'moss' },
  { id: 'vera', name: 'Vera', acc: 'bowtie', hair: 'bun', shirt: 'cyan', pants: 'night', skin: 'skinD', hairC: 'ember', acc2: 'plum' },
  { id: 'leo', name: 'Leo', acc: 'explorerHat', hair: 'swept', shirt: 'plum', pants: 'night', skin: 'skinL', hairC: 'night', acc2: 'honey' },
  { id: 'sara', name: 'Sara', acc: 'security', hair: 'bob', shirt: 'leaf', pants: 'indigo', skin: 'skinD', hairC: 'walnut', acc2: 'cream' },
  { id: 'ivan', name: 'Iván', acc: 'badge', hair: 'buzz', shirt: 'lavender', pants: 'moss', skin: 'skinL', hairC: 'walnut', acc2: 'amber' },
  { id: 'julia', name: 'Julia', acc: 'hoodie', hair: 'ponytail', shirt: 'moss', pants: 'night', skin: 'skinL', hairC: 'ember', acc2: 'cream' },
  { id: 'mateo', name: 'Mateo', acc: 'glasses', hair: 'short', shirt: 'honey', pants: 'indigo', skin: 'skinD', hairC: 'night', acc2: 'ink' },
  { id: 'carla', name: 'Carla', acc: 'headphones', hair: 'bun', shirt: 'dusk', pants: 'walnut', skin: 'skinL', hairC: 'honey', acc2: 'cyan' },
  { id: 'hugo', name: 'Hugo', acc: 'hardhat', hair: 'messy', shirt: 'wall', pants: 'night', skin: 'skinL', hairC: 'night', acc2: 'amber' },
  { id: 'noa', name: 'Noa', acc: 'backpack', hair: 'bob', shirt: 'cream', pants: 'plum', skin: 'skinD', hairC: 'night', acc2: 'teal' },
  { id: 'ramiro', name: 'Ramiro', acc: 'explorerHat', hair: 'buzz', shirt: 'amber', pants: 'moss', skin: 'skinD', hairC: 'night', acc2: 'walnut' },
  { id: 'emma', name: 'Emma', acc: 'clipboard', hair: 'swept', shirt: 'moon', pants: 'plum', skin: 'skinL', hairC: 'honey', acc2: 'ember' },
  { id: 'simon', name: 'Simón', acc: 'bowtie', hair: 'short', shirt: 'teal', pants: 'walnut', skin: 'skinD', hairC: 'night', acc2: 'cream' },
  { id: 'alba', name: 'Alba', acc: 'glasses', hair: 'bun', shirt: 'ember', pants: 'night', skin: 'skinL', hairC: 'lavender', acc2: 'ink' },
  { id: 'diego', name: 'Diego', acc: 'hoodie', hair: 'buzz', shirt: 'leaf', pants: 'indigo', skin: 'skinL', hairC: 'walnut', acc2: 'amber' },
  { id: 'luna', name: 'Luna', acc: 'headphones', hair: 'ponytail', shirt: 'lavender', pants: 'night', skin: 'skinD', hairC: 'night', acc2: 'amber' },
  { id: 'ciro', name: 'Ciro', acc: 'badge', hair: 'messy', shirt: 'cyan', pants: 'walnut', skin: 'skinL', hairC: 'ember', acc2: 'plum' },
  { id: 'maya', name: 'Maya', acc: 'backpack', hair: 'swept', shirt: 'honey', pants: 'plum', skin: 'skinL', hairC: 'night', acc2: 'teal' },
  { id: 'pablo', name: 'Pablo', acc: 'clipboard', hair: 'short', shirt: 'dusk', pants: 'night', skin: 'skinD', hairC: 'walnut', acc2: 'amber' },
  { id: 'ines', name: 'Inés', acc: 'bowtie', hair: 'bob', shirt: 'moss', pants: 'indigo', skin: 'skinL', hairC: 'honey', acc2: 'ember' },
  { id: 'teo', name: 'Teo', acc: 'explorerHat', hair: 'messy', shirt: 'neon', pants: 'walnut', skin: 'skinL', hairC: 'night', acc2: 'cream' },
];

/** persona que prefiere cada tipo del elenco cuando esta libre */
export const PERSONA_BY_TYPE: Readonly<Record<string, string>> = {
  lead: LEAD_PERSONA,
  'tr-builder': 'bruno',
  Explore: 'elena',
  'tr-explorer': 'marco',
  'tr-docs': 'dora',
  Plan: 'paula',
  'general-purpose': 'gael',
  'claude-code-guide': 'guido',
  // tipos del elenco de los roles Pruebas y Seguridad (server/src/ingest/roles.ts, ROLE_LOOK)
  tester: 'tomas',
  security: 'sara',
};

const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

export function personaById(id: string | null | undefined): Persona | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/**
 * Personas unicas para los agentes visibles: conserva la que ya tenia cada uno; los nuevos toman la de
 * su tipo si esta libre y si no la primera libre del equipo. La persona del lead queda reservada para el lead.
 * Si se agotan (mas agentes que personas) se repite empezando por el final, con sufijo numerico.
 */
export function assignPersonas(
  prev: ReadonlyMap<string, string>,
  visible: ReadonlyArray<{ id: string; type: string }>,
): Map<string, string> {
  const next = new Map<string, string>();
  const used = new Set<string>([LEAD_PERSONA]);
  for (const v of visible) {
    const p = prev.get(v.id);
    // las variantes numeradas ('gael#2') tambien se conservan: su base es una persona del equipo
    if (p && BY_ID.has(p.split('#')[0] ?? '') && !used.has(p)) {
      next.set(v.id, p);
      used.add(p);
    }
  }
  // primero el resto del equipo; los del kit quedan para los agentes de su propio tipo
  const kit = new Set(Object.values(PERSONA_BY_TYPE));
  const pool = [...PERSONAS.filter((p) => !kit.has(p.id)), ...PERSONAS.filter((p) => kit.has(p.id) && p.id !== LEAD_PERSONA)];
  for (const v of visible) {
    if (next.has(v.id)) continue;
    const preferred = PERSONA_BY_TYPE[v.type];
    let pick = preferred && preferred !== LEAD_PERSONA && !used.has(preferred) ? preferred : undefined;
    if (!pick) pick = pool.find((p) => !used.has(p.id))?.id;
    if (!pick) {
      // mas agentes visibles que personas: variante numerada, estable mientras siga visible
      let n = 2;
      for (;;) {
        const base = pool[(visible.length + n) % pool.length] ?? pool[0];
        const id = `${base?.id ?? 'gael'}#${n}`;
        if (!used.has(id)) {
          pick = id;
          break;
        }
        n++;
      }
    }
    next.set(v.id, pick);
    used.add(pick);
  }
  return next;
}

/** nombre visible de una persona (las variantes numeradas llevan sufijo) */
export function personaName(id: string): string {
  const [base, n] = id.split('#');
  const p = BY_ID.get(base ?? '');
  const name = p?.name ?? base ?? id;
  return n ? `${name} ${n}` : name;
}

/** look de una persona (las variantes numeradas usan el de su base) */
export function personaLook(id: string | null | undefined): Persona | undefined {
  if (!id) return undefined;
  return BY_ID.get(id.split('#')[0] ?? '');
}
