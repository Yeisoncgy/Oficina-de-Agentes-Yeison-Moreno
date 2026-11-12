import { describe, expect, it } from 'vitest';
import { OfficeBuilder } from '../src/state/office';
import { assignRoomSlots, reorderSlots } from '../src/state/roomSlots';
import { Settings } from '../src/state/settings';
import { loadFixture, SESSION_ID } from './helpers';

describe('lugar fijo de las salas en el mapa', () => {
  it('las nuevas van al final y las demas no se mueven', () => {
    const first = assignRoomSlots(new Map(), ['a', 'b', 'c', 'd']);
    expect([...first.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
    // cambia el orden (otra sala tuvo actividad) y llega una nueva: nadie se mueve
    const second = assignRoomSlots(first, ['d', 'c', 'e', 'b', 'a']);
    expect(second.get('a')).toBe(0);
    expect(second.get('d')).toBe(3);
    expect(second.get('e')).toBe(4);
  });

  it('si una sala sale (archivada o eliminada) su espacio desaparece: sin huecos y en el mismo orden', () => {
    const start = assignRoomSlots(new Map(), ['a', 'b', 'c', 'd']);
    // se va "b": las que venian despues avanzan un lugar
    const without = assignRoomSlots(start, ['a', 'c', 'd']);
    expect([...without.entries()]).toEqual([
      ['a', 0],
      ['c', 1],
      ['d', 2],
    ]);
    // si "b" vuelve (p.ej. se restaura de archivadas) entra al final, como nueva
    expect(assignRoomSlots(without, ['b', 'a', 'c', 'd']).get('b')).toBe(3);
    // ids repetidos no ocupan dos lugares
    expect([...assignRoomSlots(new Map(), ['a', 'a', 'b']).values()]).toEqual([0, 1]);
  });

  it('arrastrar en la lista reparte las mismas celdas en el orden nuevo', () => {
    // "c" guarda la reserva del 5 aunque no este en la lista: no se toca
    const saved = new Map([
      ['a', 0],
      ['b', 1],
      ['d', 3],
      ['c', 5],
    ]);
    const next = reorderSlots(saved, ['d', 'a', 'b', 'x', 'd']);
    expect([...next.entries()].sort((l, r) => l[1] - r[1])).toEqual([
      ['d', 0],
      ['a', 1],
      ['b', 3],
      ['c', 5],
    ]);
    expect(reorderSlots(saved, ['a', 'b', 'd'])).toEqual(saved);
  });

  it('el orden nuevo se guarda en la DB y lo trae el snapshot', async () => {
    const ctx = await loadFixture();
    ctx.office.build();
    new Settings(ctx.db).setRoomSlots(new Map([[SESSION_ID, 2], ['otra-sala', 0]]));
    const builder = new OfficeBuilder(ctx.db, ctx.registry, ctx.now);
    expect(builder.reorderRooms([SESSION_ID, 'otra-sala'])).toBe(true);
    expect(new Settings(ctx.db).roomSlots().get(SESSION_ID)).toBe(0);
    expect(builder.build().rooms[0]?.slot).toBe(0);
    expect(builder.reorderRooms([SESSION_ID, 'otra-sala'])).toBe(false);
  });

  it('el snapshot trae el lugar y se guarda en la DB; al reiniciar, lo de salas que ya no estan se borra', async () => {
    const ctx = await loadFixture();
    const snap = ctx.office.build();
    expect(snap.rooms[0]?.slot).toBe(0);
    const settings = new Settings(ctx.db);
    expect(settings.roomSlots()).toEqual(new Map([[SESSION_ID, 0]]));
    // antes del reinicio habia otra sala adelante que ya no esta (archivada o eliminada)
    settings.setRoomSlots(new Map([['sala-que-se-fue', 0], [SESSION_ID, 1]]));
    const restarted = new OfficeBuilder(ctx.db, ctx.registry, ctx.now);
    expect(restarted.build().rooms[0]?.slot).toBe(0);
    expect(settings.roomSlots()).toEqual(new Map([[SESSION_ID, 0]]));
  });
});
