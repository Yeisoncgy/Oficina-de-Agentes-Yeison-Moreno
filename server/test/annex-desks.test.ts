import { describe, expect, it } from 'vitest';
import { DESK_ORDER } from '../src/config';
import { assignDesks } from '../src/state/office';

describe('anexos: con mas de 6 agentes nadie se queda sin puesto', () => {
  it('la sala se llena 6..1 y despues cada anexo igual (12..7, 18..13, 24..19)', () => {
    expect(DESK_ORDER).toEqual([6, 5, 4, 3, 2, 1, 12, 11, 10, 9, 8, 7, 18, 17, 16, 15, 14, 13, 24, 23, 22, 21, 20, 19]);
  });

  it('8 agentes: los 6 primeros en la sala y el 7 y el 8 en el anexo, en su fila de adelante', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `a${i}`);
    const desks = assignDesks(new Map(), ids);
    expect(ids.map((id) => desks.get(id))).toEqual([6, 5, 4, 3, 2, 1, 12, 11]);
  });

  it('recien despues del puesto 24 alguien queda sin puesto', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `a${i}`);
    const desks = assignDesks(new Map(), ids);
    expect(desks.get('a23')).toBe(19);
    expect(desks.get('a24')).toBe(-1);
  });
});
