import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readNewLines } from '../src/ingest/reader';
import { TempHome } from './helpers';

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

async function collect(file: string, from: number, chunk?: number) {
  const lines: string[] = [];
  const res = await readNewLines(file, from, (batch) => lines.push(...batch), chunk);
  return { lines, res };
}

describe('readNewLines', () => {
  it('no avanza sobre la linea parcial y la retoma despues', async () => {
    home = new TempHome();
    const file = home.write('a.jsonl', 'uno\ndos\npar');
    const first = await collect(file, 0);
    expect(first.lines).toEqual(['uno', 'dos']);
    expect(first.res?.endOffset).toBe(8);

    home.append('a.jsonl', 'cial\r\ntres\n');
    const second = await collect(file, first.res?.endOffset ?? 0);
    expect(second.lines).toEqual(['parcial', 'tres']);
    expect(second.res?.endOffset).toBe(fs.statSync(file).size);

    const third = await collect(file, second.res?.endOffset ?? 0);
    expect(third.lines).toEqual([]);
  });

  it('reinicia en 0 si el archivo se achico', async () => {
    home = new TempHome();
    const file = home.write('b.jsonl', 'linea larga uno\nlinea larga dos\n');
    const first = await collect(file, 0);
    fs.writeFileSync(file, 'corta\n');
    const again = await collect(file, first.res?.endOffset ?? 0);
    expect(again.res?.reset).toBe(true);
    expect(again.lines).toEqual(['corta']);
  });

  it('no rompe caracteres multibyte entre bloques', async () => {
    home = new TempHome();
    const file = home.write('c.jsonl', 'ñandú\ncañón\n');
    const out = await collect(file, 0, 3);
    expect(out.lines).toEqual(['ñandú', 'cañón']);
  });

  it('archivo inexistente devuelve null', async () => {
    const out = await collect('Z:\\no\\existe\\falso.jsonl', 0);
    expect(out.res).toBeNull();
  });
});
