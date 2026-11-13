import { describe, expect, it } from 'vitest';
import { ROOM_ACCENTS, roomIdentity } from '@/lib/roomIdentity';
import { STATE } from '@/theme';

describe('identidad de la sala', () => {
  it('numero y color salen del lugar fijo del mapa y se repiten cada 8 salas', () => {
    expect(roomIdentity({ slot: 0 })).toEqual({ number: 1, label: '01', accent: ROOM_ACCENTS[0] });
    expect(roomIdentity({ slot: 11 })).toMatchObject({ number: 12, label: '12', accent: ROOM_ACCENTS[3] });
    // sin lugar (demo, fixtures): el indice que le pasa la lista
    expect(roomIdentity({}, 2)).toMatchObject({ number: 3, accent: ROOM_ACCENTS[2] });
  });

  it('ningun color de sala es un color de estado', () => {
    const states = new Set<string>(Object.values(STATE).map((c) => c.toUpperCase()));
    for (const accent of ROOM_ACCENTS) expect(states.has(accent.toUpperCase())).toBe(false);
    expect(new Set(ROOM_ACCENTS).size).toBe(ROOM_ACCENTS.length);
  });
});
