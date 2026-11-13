import { describe, expect, it } from 'vitest';
import type { RoomNote } from '@shared/contract';
import {
  applyTodoOps,
  calendarDaysAgo,
  dropTodoOpsFor,
  pruneTodoOps,
  rebindTodoOps,
  todoClaims,
  todoClock,
  todoCreatedLabel,
  todoDayLabel,
  todoDoneGroups,
  todoHeadline,
  todoProgress,
  todoSummary,
  todoView,
  type TodoOp,
} from '@/lib/todo';

// fechas en hora local: las etiquetas ("hoy", "ayer") dependen del dia local, no del UTC
const local = (month: number, day: number, h = 12, m = 0, year = 2026): number => new Date(year, month - 1, day, h, m).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();
// jueves 12 nov 2026, 15:00
const NOW = local(11, 12, 15, 0);

function note(id: string, over: Partial<RoomNote> = {}): RoomNote {
  const at = iso(local(11, 12, 9, 0));
  return { id, text: `tarea ${id}`, done: false, createdAt: at, updatedAt: at, ...over };
}

describe('fechas de los pendientes', () => {
  it('dias de calendario, no de 24 h', () => {
    expect(calendarDaysAgo(local(11, 12, 0, 5), NOW)).toBe(0);
    expect(calendarDaysAgo(local(11, 11, 23, 59), NOW)).toBe(1);
    expect(calendarDaysAgo(local(11, 9, 8, 0), NOW)).toBe(3);
  });

  it('hora sin cero delante', () => {
    expect(todoClock(local(11, 12, 9, 40))).toBe('9:40');
    expect(todoClock(local(11, 12, 14, 5))).toBe('14:05');
    expect(todoClock('no es fecha')).toBe('');
  });

  it('cuando se creo, en lenguaje de persona', () => {
    expect(todoCreatedLabel(iso(NOW - 20_000), NOW)).toBe('ahora');
    expect(todoCreatedLabel(iso(local(11, 12, 9, 40)), NOW)).toBe('hoy 9:40');
    expect(todoCreatedLabel(iso(local(11, 11, 18, 0)), NOW)).toBe('ayer');
    expect(todoCreatedLabel(iso(local(11, 9, 18, 0)), NOW)).toBe('hace 3 días');
    expect(todoCreatedLabel(iso(local(11, 6, 18, 0)), NOW)).toBe('hace 6 días');
    expect(todoCreatedLabel(iso(local(11, 5, 18, 0)), NOW)).toBe('5 nov');
    expect(todoCreatedLabel(iso(local(12, 20, 10, 0, 2025)), NOW)).toBe('20 dic 2025');
    expect(todoCreatedLabel('mal', NOW)).toBe('');
  });

  it('encabezados de dia', () => {
    expect(todoDayLabel(local(11, 12, 8), NOW)).toBe('Hoy');
    expect(todoDayLabel(local(11, 11, 8), NOW)).toBe('Ayer');
    expect(todoDayLabel(local(11, 9, 8), NOW)).toBe('Lunes 9 nov');
    expect(todoDayLabel(local(12, 31, 8, 0, 2025), NOW)).toBe('Miércoles 31 dic 2025');
  });
});

describe('hechas agrupadas por dia', () => {
  const done = [
    note('lunes', { done: true, updatedAt: iso(local(11, 9, 10, 0)) }),
    note('hoy-temprano', { done: true, updatedAt: iso(local(11, 12, 8, 15)) }),
    note('ayer', { done: true, updatedAt: iso(local(11, 11, 17, 30)) }),
    note('hoy-tarde', { done: true, updatedAt: iso(local(11, 12, 14, 2)) }),
    note('rota', { done: true, updatedAt: 'x' }),
  ];

  it('el dia mas reciente primero y, dentro del dia, la ultima marcada primero', () => {
    const groups = todoDoneGroups(done, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Hoy', 'Ayer', 'Lunes 9 nov', 'Sin fecha']);
    expect(groups[0]?.items.map((n) => n.id)).toEqual(['hoy-tarde', 'hoy-temprano']);
    expect(groups[1]?.items.map((n) => n.id)).toEqual(['ayer']);
    expect(groups[3]?.items.map((n) => n.id)).toEqual(['rota']);
  });

  it('sin hechas no hay grupos', () => {
    expect(todoDoneGroups([], NOW)).toEqual([]);
  });
});

describe('resumen y avance del dia', () => {
  const todos = [
    note('a'),
    note('b'),
    note('c'),
    note('h1', { done: true, updatedAt: iso(local(11, 12, 10)) }),
    note('h2', { done: true, updatedAt: iso(local(11, 12, 11)) }),
    note('vieja', { done: true, updatedAt: iso(local(11, 2, 11)) }),
  ];

  it('cabecera: por hacer y hechas hoy', () => {
    expect(todoHeadline(todoView(todos), NOW)).toBe('3 por hacer · 2 hechas hoy');
    expect(todoHeadline(todoView(todos.slice(0, 1)), NOW)).toBe('1 por hacer');
    expect(todoHeadline(todoView(todos.slice(3, 4)), NOW)).toBe('Nada por hacer · 1 hecha hoy');
    expect(todoHeadline(todoView(todos.slice(5)), NOW)).toBe('Nada por hacer');
    expect(todoHeadline(todoView([]), NOW)).toBe('Sin pendientes');
  });

  it('la barra cuenta lo de hoy contra lo que falta', () => {
    expect(todoProgress(todoView(todos), NOW)).toEqual({ done: 2, total: 5, ratio: 0.4 });
    expect(todoProgress(todoView(todos.slice(5)), NOW)).toEqual({ done: 0, total: 0, ratio: 1 });
    expect(todoProgress(todoView([]), NOW)).toEqual({ done: 0, total: 0, ratio: 0 });
  });

  it('el resumen de siempre no cambia (lo usan otras vistas)', () => {
    expect(todoSummary(todoView(todos))).toBe('3 por hacer · 3 hechos');
  });
});

describe('cambios optimistas', () => {
  const server = [note('a'), note('b', { done: true, updatedAt: iso(local(11, 12, 10)) })];
  const add = (over: Partial<Extract<TodoOp, { kind: 'add' }>> = {}): TodoOp => ({
    kind: 'add',
    key: 'tmp:1',
    text: 'nueva',
    at: iso(NOW),
    id: null,
    serverAt: null,
    before: ['a', 'b'],
    ...over,
  });

  it('un alta aparece al instante con su id provisional', () => {
    const list = applyTodoOps(server, [add()]);
    expect(list.map((n) => n.id)).toEqual(['a', 'b', 'tmp:1']);
    expect(list[2]).toMatchObject({ text: 'nueva', done: false, createdAt: iso(NOW) });
  });

  it('sin duplicado cuando el snapshot trae la nota antes de que responda el POST', () => {
    const withNew = [...server, note('real-1', { text: 'nueva' })];
    const ops = [add()];
    expect(applyTodoOps(withNew, ops).map((n) => n.id)).toEqual(['a', 'b', 'real-1']);
    expect(todoClaims(withNew, ops).get('tmp:1')).toBe('real-1');
    // una nota vieja con el mismo texto no cuenta: ya estaba al escribirla
    const old = [note('vieja', { text: 'nueva' })];
    expect(applyTodoOps(old, [add({ before: ['vieja'] })]).map((n) => n.id)).toEqual(['vieja', 'tmp:1']);
  });

  it('sin duplicado cuando responde el POST y despues llega el snapshot', () => {
    const real = note('real-1', { text: 'nueva', createdAt: iso(NOW + 5) });
    const ops = rebindTodoOps([add()], 'tmp:1', real);
    expect(applyTodoOps(server, ops).map((n) => n.id)).toEqual(['a', 'b', 'real-1']);
    const withNew = [...server, real];
    expect(applyTodoOps(withNew, ops).map((n) => n.id)).toEqual(['a', 'b', 'real-1']);
    expect(pruneTodoOps(withNew, ops, iso(NOW + 10))).toEqual([]);
  });

  it('marcar, editar y borrar sobre una nota que se esta creando siguen al id real', () => {
    const ops: TodoOp[] = [
      add(),
      { kind: 'patch', key: 'p1', id: 'tmp:1', change: { done: true }, at: iso(NOW + 1), serverAt: null },
    ];
    expect(applyTodoOps(server, ops).find((n) => n.id === 'tmp:1')?.done).toBe(true);
    const real = note('real-1', { text: 'nueva' });
    const rebound = rebindTodoOps(ops, 'tmp:1', real);
    expect(rebound[1]).toMatchObject({ kind: 'patch', id: 'real-1' });
    expect(applyTodoOps([...server, real], rebound).find((n) => n.id === 'real-1')?.done).toBe(true);
    // si el alta falla, se va con todo lo que dependia de ella
    expect(dropTodoOpsFor(ops, 'tmp:1')).toEqual([]);
  });

  it('marcar como hecha le pone la hora; volver a pendiente no la mueve de dia', () => {
    const marked = applyTodoOps(server, [{ kind: 'patch', key: 'p', id: 'a', change: { done: true }, at: iso(NOW), serverAt: null }]);
    expect(marked[0]).toMatchObject({ done: true, updatedAt: iso(NOW) });
    const reopened = applyTodoOps(server, [{ kind: 'patch', key: 'p', id: 'b', change: { done: false }, at: iso(NOW), serverAt: null }]);
    expect(reopened[1]).toMatchObject({ done: false, updatedAt: server[1]?.updatedAt });
  });

  it('borrar la oculta al instante (aunque el DELETE espere al deshacer)', () => {
    expect(applyTodoOps(server, [{ kind: 'remove', key: 'r', id: 'a', committed: false }]).map((n) => n.id)).toEqual(['b']);
  });

  it('un cambio se queda hasta que el snapshot lo trae', () => {
    const patch: TodoOp = { kind: 'patch', key: 'p', id: 'a', change: { done: true }, at: iso(NOW), serverAt: null };
    // sin respuesta: se queda aunque el snapshot ya coincida
    expect(pruneTodoOps([note('a', { done: true })], [patch], iso(NOW))).toHaveLength(1);
    const settled = { ...patch, serverAt: iso(NOW + 3) };
    // respondio pero el snapshot es viejo: se queda (no parpadea)
    expect(pruneTodoOps(server, [settled], iso(NOW))).toHaveLength(1);
    // el snapshot ya lo trae: se va
    expect(pruneTodoOps([note('a', { done: true })], [settled], iso(NOW + 4))).toEqual([]);
    // un snapshot posterior que dice otra cosa (lo cambiaron en otra pestana) manda
    expect(pruneTodoOps(server, [settled], iso(NOW + 10))).toEqual([]);
  });

  it('el borrado se va cuando el snapshot ya no trae la nota', () => {
    const remove: TodoOp = { kind: 'remove', key: 'r', id: 'a', committed: true };
    expect(pruneTodoOps(server, [remove], iso(NOW))).toHaveLength(1);
    expect(pruneTodoOps(server.slice(1), [remove], iso(NOW))).toEqual([]);
  });

  it('no suelta el borrado de una nota que todavia se esta creando', () => {
    const real = note('real-1', { text: 'nueva', createdAt: iso(NOW + 5) });
    const ops = rebindTodoOps(
      [add(), { kind: 'remove', key: 'r', id: 'tmp:1', committed: false }],
      'tmp:1',
      real,
    );
    // el snapshot aun no trae real-1: el borrado se queda y la nota sigue oculta
    const kept = pruneTodoOps(server, ops, iso(NOW - 1));
    expect(kept).toHaveLength(2);
    expect(applyTodoOps(server, kept).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('devuelve el mismo arreglo si no hay nada que quitar', () => {
    const ops: TodoOp[] = [add()];
    expect(pruneTodoOps(server, ops, iso(NOW))).toBe(ops);
  });
});
