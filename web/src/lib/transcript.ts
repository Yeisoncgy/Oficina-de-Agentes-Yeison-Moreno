import type { TranscriptEntry, TranscriptEntryKind, TranscriptResponse } from '@shared/contract';

export const TRANSCRIPT_LABEL: Record<TranscriptEntryKind, string> = {
  prompt: 'Prompt',
  text: 'Texto',
  tool_use: 'Herramienta',
  tool_result: 'Resultado',
};

/** Linea plegada de un resultado (D3): "Resultado · 412 líneas" · "Error · código de salida 1" */
export function resultSummary(item: Pick<TranscriptItem, 'isError' | 'preview' | 'lineCount'>): string {
  if (item.isError) return `Error · ${item.preview || 'sin detalle'}`;
  if (item.lineCount > 1) return `Resultado · ${item.lineCount} líneas`;
  return `Resultado · ${item.preview || 'vacío'}`;
}

/** La ultima herramienta sin resultado mientras el agente trabaja es la accion en curso */
export function currentToolId(items: readonly Pick<TranscriptItem, 'id' | 'kind'>[], live: boolean): string | null {
  if (!live) return null;
  const last = items[items.length - 1];
  return last && last.kind === 'tool_use' ? last.id : null;
}

const PREVIEW_MAX = 140;
const LONG_CHARS = 600;
const LONG_LINES = 10;

export interface TranscriptItem {
  id: string;
  kind: TranscriptEntryKind;
  timestamp: string;
  text: string;
  toolName: string | null;
  isError: boolean;
  /** primera linea con contenido, recortada */
  preview: string;
  lineCount: number;
  /** merece recortarse con "Ver todo" */
  long: boolean;
}

/**
 * Las paginas llegan de la mas nueva (0) a la mas antigua; cada una en orden cronologico.
 * Resultado: todo en orden cronologico y sin repetir (un refetch puede solapar paginas).
 */
export function mergeTranscriptPages(pages: readonly TranscriptResponse[]): TranscriptEntry[] {
  const seen = new Set<string>();
  const out: TranscriptEntry[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const page = pages[i];
    if (!page) continue;
    for (const entry of page.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

export function toTranscriptItem(entry: TranscriptEntry): TranscriptItem {
  const text = (entry.text ?? '').replace(/\s+$/, '');
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  return {
    id: entry.id,
    kind: entry.kind,
    timestamp: entry.timestamp,
    text,
    toolName: entry.toolName ?? null,
    isError: entry.isError === true,
    preview: first.length > PREVIEW_MAX ? `${first.slice(0, PREVIEW_MAX - 1)}…` : first,
    lineCount: lines.length,
    long: text.length > LONG_CHARS || lines.length > LONG_LINES,
  };
}

export function toTranscriptItems(entries: readonly TranscriptEntry[]): TranscriptItem[] {
  return entries.map(toTranscriptItem);
}
