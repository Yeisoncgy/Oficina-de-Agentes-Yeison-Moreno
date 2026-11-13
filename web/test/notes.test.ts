import { describe, expect, it } from 'vitest';
import type { RoomNote } from '@shared/contract';
import { notesPrompt, pendingNotes, roomsBySlot } from '@/state/notesApi';

function note(id: string, text: string, done = false): RoomNote {
  return { id, text, done, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z' };
}

describe('copiar pendientes', () => {
  const room = {
    title: 'Proyecto de prueba',
    cwd: 'C:\\demo\\proyecto',
    notes: [note('a', 'Primero'), note('b', 'Ya hecho', true), note('c', 'Varias lineas\n- detalle uno\n\n- detalle dos')],
  };

  it('numera solo los pendientes y dice de que proyecto son', () => {
    expect(notesPrompt(room)).toBe(
      [
        'Pendientes del proyecto "Proyecto de prueba" (C:\\demo\\proyecto):',
        '',
        '1. Primero',
        '2. Varias lineas',
        '   - detalle uno',
        '',
        '   - detalle dos',
      ].join('\n'),
    );
  });

  it('sin notas no hay pendientes', () => {
    expect(pendingNotes({})).toEqual([]);
    expect(pendingNotes(room).map((n) => n.id)).toEqual(['a', 'c']);
  });
});

describe('orden de la lista de salas', () => {
  it('va por lugar en el mapa, no por actividad; sin lugar quedan al final en su orden', () => {
    const rooms = [{ id: 'activa', slot: 3 }, { id: 'demo-1' }, { id: 'vieja', slot: 0 }, { id: 'demo-2' }, { id: 'media', slot: 1 }];
    expect(roomsBySlot(rooms).map((r) => r.id)).toEqual(['vieja', 'media', 'activa', 'demo-1', 'demo-2']);
  });
});
