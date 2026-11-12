import { LEAD_NAME_MAX } from './contract';

// Nombres de los agentes. Editable: cambia el nombre y reinicia `npm run dev`.
// Tipo no listado = se muestra su nombre tecnico.

/** nombre del lead mientras el usuario no elige uno (y el del demo) */
export const DEFAULT_LEAD_NAME = 'Líder';

export const AGENT_NAMES: Record<string, string> = {
  'tr-builder': 'Bruno',
  Explore: 'Elena',
  'tr-explorer': 'Marco',
  'tr-docs': 'Dora',
  Plan: 'Paula',
  'general-purpose': 'Gael',
  'claude-code-guide': 'Guido',
  // tipos del elenco de los roles Pruebas y Seguridad (sin tilde: el nombre arma el token --color-agent-*)
  tester: 'Tomas',
  security: 'Sara',
};

/**
 * Los agentes del tool Workflow sin tipo pedido llegan como 'workflow-subagent' y el server les pone
 * el tipo del elenco de su rol. Si alguno quedara con el tipo tecnico, se llama asi.
 */
const WORKFLOW_FALLBACK_NAME = 'Agente de flujo';

export function agentBaseName(agentType: string): string {
  if (agentType === 'lead') return DEFAULT_LEAD_NAME;
  if (agentType === 'workflow-subagent') return WORKFLOW_FALLBACK_NAME;
  return AGENT_NAMES[agentType] ?? agentType;
}

/**
 * Nombre del lead que escribio el usuario, listo para guardar y mostrar: una linea, sin caracteres de
 * control ni de formato invisibles (los de direccion del texto desordenan el HUD), sin espacios de sobra
 * y hasta LEAD_NAME_MAX letras. null si no es texto o queda vacio.
 */
export function cleanLeadName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/u.test(c) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  // por puntos de codigo: cortar en unidades UTF-16 puede partir un caracter en dos
  const name = Array.from(flat).slice(0, LEAD_NAME_MAX).join('').trimEnd();
  return name || null;
}
