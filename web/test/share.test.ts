import { describe, expect, it } from 'vitest';
import { shareEqual } from '@/lib/share';
import { createMockSnapshot } from '@/scene/mock';
import { useOfficeStore } from '@/state/store';

const NOW = Date.parse('2026-05-04T15:00:00.000Z');

describe('shareEqual (snapshots con identidad compartida)', () => {
  it('devuelve el anterior si todo llega igual', () => {
    const a = { x: 1, list: [{ id: 'a', n: 1 }], deep: { s: 'hola', z: null } };
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(shareEqual(a, b)).toBe(a);
  });

  it('conserva lo igual y deja lo que cambio con la identidad del dato nuevo', () => {
    const a = { keep: { v: 1 }, list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], top: 1 };
    const b = { keep: { v: 1 }, list: [{ id: 'a', n: 1 }, { id: 'b', n: 3 }], top: 1 };
    const bList = b.list;
    const bItem = b.list[1];
    const out = shareEqual(a, b);
    expect(out).toBe(b);
    expect(out).toEqual({ keep: { v: 1 }, list: [{ id: 'a', n: 1 }, { id: 'b', n: 3 }], top: 1 });
    expect(out.keep).toBe(a.keep);
    expect(out.list).toBe(bList);
    expect(out.list[0]).toBe(a.list[0]);
    expect(out.list[1]).toBe(bItem);
    // el anterior no se toca
    expect(a).toEqual({ keep: { v: 1 }, list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], top: 1 });
  });

  it('no escribe en un dato congelado', () => {
    const a = { keep: { v: 1 }, n: 1 };
    const b = Object.freeze({ keep: { v: 1 }, n: 2 });
    expect(shareEqual(a, b)).toBe(b);
    expect(shareEqual(a, Object.freeze({ keep: { v: 1 }, n: 1 }))).toBe(a);
  });

  it('empareja por id aunque cambie el orden o llegue uno nuevo al principio', () => {
    const a = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const b = [{ id: 'nuevo', n: 0 }, { id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const out = shareEqual(a, b);
    expect(out).toBe(b);
    expect(out).toEqual([{ id: 'nuevo', n: 0 }, { id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    expect(out[1]).toBe(a[0]);
    expect(out[2]).toBe(a[1]);
  });

  it('nota claves que aparecen o desaparecen', () => {
    const a: Record<string, unknown> = { x: 1, y: 2 };
    const b: Record<string, unknown> = { x: 1 };
    expect(shareEqual(a, b)).toEqual({ x: 1 });
    expect(shareEqual(b, a)).toEqual({ x: 1, y: 2 });
    expect(shareEqual({ x: undefined }, {})).toEqual({});
  });

  it('el store comparte las salas que no cambiaron entre dos snapshots', () => {
    // como llegan del server: JSON
    const first = JSON.parse(JSON.stringify(createMockSnapshot(NOW))) as ReturnType<typeof createMockSnapshot>;
    useOfficeStore.getState().setSnapshot(first);
    const kept = useOfficeStore.getState().snapshot;
    const copy = JSON.parse(JSON.stringify(first)) as typeof first;
    useOfficeStore.getState().setSnapshot({ ...copy, generatedAt: new Date(NOW + 1000).toISOString() });
    const next = useOfficeStore.getState().snapshot;
    expect(next).not.toBe(kept);
    expect(next?.rooms).toBe(kept?.rooms);
    expect(next?.generatedAt).toBe(new Date(NOW + 1000).toISOString());
  });
});
