import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface ReadResult {
  /** offset desde el que se leyo (0 si el archivo se achico) */
  startOffset: number;
  /** byte siguiente al ultimo '\n' procesado: nunca avanza sobre una linea parcial */
  endOffset: number;
  size: number;
  mtimeMs: number;
  reset: boolean;
}

export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Lee lineas completas desde `fromOffset` por bloques. `onLines` recibe cada lote junto con el
 * offset que queda consumido al procesarlo (para persistirlo en la misma transaccion).
 * La linea parcial del final no se entrega y el offset se queda antes de ella.
 * Devuelve null si el archivo no existe.
 */
export async function readNewLines(
  filePath: string,
  fromOffset: number,
  onLines: (lines: string[], endOffset: number) => void,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<ReadResult | null> {
  let fh: FileHandle;
  try {
    fh = await fs.promises.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    let reset = false;
    let offset = fromOffset;
    if (st.size < offset) {
      offset = 0;
      reset = true;
    }
    const startOffset = offset;
    let readPos = offset;
    let committed = offset;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(chunkBytes);
    while (readPos < st.size) {
      const want = Math.min(chunkBytes, st.size - readPos);
      const { bytesRead } = await fh.read(buf, 0, want, readPos);
      if (bytesRead <= 0) break;
      readPos += bytesRead;
      // copia: `buf` se reutiliza en la siguiente vuelta
      const fresh = Buffer.from(buf.subarray(0, bytesRead));
      const data = carry.length > 0 ? Buffer.concat([carry, fresh]) : fresh;
      // 0x0A nunca aparece dentro de un caracter UTF-8 multibyte: cortar por byte es seguro
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        carry = data;
        continue;
      }
      const complete = data.subarray(0, lastNl + 1);
      carry = Buffer.from(data.subarray(lastNl + 1));
      committed += complete.length;
      const lines = complete.toString('utf8').split('\n');
      lines.pop();
      onLines(
        lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)),
        committed,
      );
    }
    return { startOffset, endOffset: committed, size: st.size, mtimeMs: Math.floor(st.mtimeMs), reset };
  } finally {
    await fh.close();
  }
}
