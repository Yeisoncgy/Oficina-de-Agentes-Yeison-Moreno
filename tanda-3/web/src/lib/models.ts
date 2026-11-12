// Nombre corto de un modelo a partir de su id tecnico: "claude-opus-5-5" -> "Opus 5.5".
import { PALETTE, UI } from '@/theme';

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';

interface ParsedModel {
  family: string;
  version: string[];
}

const VERSION_PART = /^\d{1,2}$/;
const FAMILY_PART = /^[a-z]+$/i;

/**
 * Formato nuevo: claude-<familia>-<mayor>-<menor>[-fecha]. Formato viejo: claude-<mayor>-<menor>-<familia>[-fecha].
 * Acepta prefijos de proveedor ("us.anthropic.") y sufijos como "[1m]", "@fecha" o "-v1:0".
 */
function parseModel(id: string): ParsedModel | null {
  const base = id.trim().replace(/\[[^\]]*\]$/, '');
  const at = base.toLowerCase().lastIndexOf('claude-');
  if (at === -1) return null;
  const rest = base.slice(at + 'claude-'.length).split('@')[0] ?? '';
  const version: string[] = [];
  let family: string | null = null;
  let versionFirst = false;
  for (const part of rest.split('-')) {
    if (family === null) {
      if (VERSION_PART.test(part)) {
        version.push(part);
        versionFirst = true;
        continue;
      }
      if (!FAMILY_PART.test(part)) return null;
      family = part.toLowerCase();
      continue;
    }
    // lo que sigue a la familia: su version (formato nuevo) y luego fecha o sufijos que se ignoran
    if (versionFirst || !VERSION_PART.test(part)) break;
    version.push(part);
  }
  return family ? { family, version } : null;
}

/** "Opus 5.5" · "Haiku 4.5" (sin la fecha) · id desconocido tal cual · sin modelo "—" */
export function modelLabel(id: string | null | undefined): string {
  if (!id || !id.trim()) return '—';
  const parsed = parseModel(id);
  if (!parsed) return id;
  const name = `${parsed.family.charAt(0).toUpperCase()}${parsed.family.slice(1)}`;
  return parsed.version.length > 0 ? `${name} ${parsed.version.join('.')}` : name;
}

export function modelFamily(id: string | null | undefined): ModelFamily {
  if (!id) return 'other';
  const family = parseModel(id)?.family;
  return family === 'fable' || family === 'opus' || family === 'sonnet' || family === 'haiku' ? family : 'other';
}

/**
 * Marca de familia en el chip de modelo (borde izquierdo). No es un estado: es solo para distinguir de un
 * vistazo que agentes van con que modelo. Espejo de .model-chip[data-family] en index.css.
 */
export const MODEL_FAMILY_COLOR: Record<ModelFamily, string> = {
  fable: PALETTE.neon,
  opus: PALETTE.amber,
  sonnet: PALETTE.moon,
  haiku: PALETTE.leaf,
  other: UI.textMuted,
};
