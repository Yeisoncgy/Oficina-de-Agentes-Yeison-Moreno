import { truncate } from './labels';

export const TITLE_MAX = 90;

/** lineas user que no son un prompt escrito por una persona */
const NOT_HUMAN = /^(<command-|<local-command|Caveat:|<task-notification|\[Request interrupted)/;

const TAG_BLOCK = /<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g;

/** quita bloques <tag ...>...</tag> (ide_selection, system-reminder, pasted_content...) */
export function stripTagBlocks(text: string): string {
  let prev = text;
  for (let i = 0; i < 5; i++) {
    const next = prev.replace(TAG_BLOCK, '');
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

export function promptTitle(text: string): string {
  const first = stripTagBlocks(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ? truncate(first, TITLE_MAX) : '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Texto de una linea `user` escrita por una persona, o null. Descarta isMeta, resultados de
 * herramientas, resumenes de compactacion, comandos locales y notificaciones.
 */
export function extractPrompt(line: Record<string, unknown>): { text: string; title: string } | null {
  if (line.type !== 'user') return null;
  if (line.isMeta === true || line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true) return null;
  if (line.toolUseResult !== undefined) return null;
  const message = line.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') return null;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    if (texts.length === 0) return null;
    raw = texts.join('\n\n');
  } else {
    return null;
  }
  if (NOT_HUMAN.test(raw.trim())) return null;
  const text = stripTagBlocks(raw).trim();
  const title = promptTitle(text);
  if (!title) return null;
  return { text, title };
}
