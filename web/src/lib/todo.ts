// Pendientes generales: una sola lista para toda la herramienta, sin sala ni sesion. Logica pura; la dibuja
// hud/TodoModal.tsx. Se guardan con las rutas de las notas bajo la llave TODO_KEY y llegan en el snapshot.
import type { RoomNote } from '@shared/contract';
import { capitalize, formatDayMonth, formatWeekdayDateLong, pad2 } from './format';

export function pendingTodos(todos: readonly RoomNote[] | undefined): RoomNote[] {
  return (todos ?? []).filter((t) => !t.done);
}

export interface TodoView {
  /** por hacer, en el orden en que se escribieron */
  pending: RoomNote[];
  /** hechos, el ultimo que se marco primero */
  done: RoomNote[];
}

function at(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function todoView(todos: readonly RoomNote[] | undefined): TodoView {
  const all = todos ?? [];
  return {
    pending: all.filter((t) => !t.done).sort((a, b) => at(a.createdAt) - at(b.createdAt)),
    done: all.filter((t) => t.done).sort((a, b) => at(b.updatedAt) - at(a.updatedAt)),
  };
}

/** "3 por hacer · 5 hechos" */
export function todoSummary(view: TodoView): string {
  const p = view.pending.length;
  const d = view.done.length;
  if (p === 0 && d === 0) return 'Sin pendientes';
  const parts = [p === 0 ? 'Nada por hacer' : `${p} por hacer`];
  if (d > 0) parts.push(`${d} ${d === 1 ? 'hecho' : 'hechos'}`);
  return parts.join(' · ');
}

/** texto para pegar en cualquier lado: los pendientes numerados */
export function todoText(view: TodoView): string {
  return view.pending
    .map((t, i) => {
      const [first = '', ...rest] = t.text.split('\n');
      return [`${i + 1}. ${first}`, ...rest.map((line) => (line ? `   ${line}` : ''))].join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------- fechas en lenguaje de persona

const DAY_MS = 86_400_000;

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** dias de calendario (hora local) entre `ms` y `nowMs`: 0 = hoy, 1 = ayer; negativo si es del futuro */
export function calendarDaysAgo(ms: number, nowMs: number): number {
  // redondeo: los dias con cambio de horario duran 23 o 25 h
  return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(ms)) / DAY_MS);
}

/** 9:40 · 14:05 (hora local, sin cero delante de la hora) */
export function todoClock(input: string | number): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

/** cuando se escribio: ahora · hoy 9:40 · ayer · hace 3 días · 12 nov (· 12 nov 2025 si es de otro año) */
export function todoCreatedLabel(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  if (Math.abs(nowMs - ms) < 60_000) return 'ahora';
  const days = calendarDaysAgo(ms, nowMs);
  if (days === 0) return `hoy ${todoClock(ms)}`;
  if (days === 1) return 'ayer';
  if (days > 1 && days < 7) return `hace ${days} días`;
  return formatDayMonth(ms, nowMs);
}

/** fecha completa para el tooltip: "jueves 12 nov 2026, 9:40" */
export function todoFullDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return `${formatWeekdayDateLong(ms)} ${new Date(ms).getFullYear()}, ${todoClock(ms)}`;
}

/** encabezado de un dia: Hoy · Ayer · Lunes 9 nov (· Lunes 9 nov 2025 si es de otro año) */
export function todoDayLabel(ms: number, nowMs: number): string {
  const days = calendarDaysAgo(ms, nowMs);
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  const year = new Date(ms).getFullYear();
  const base = capitalize(formatWeekdayDateLong(ms));
  return year === new Date(nowMs).getFullYear() ? base : `${base} ${year}`;
}

export interface TodoDayGroup {
  /** dia local 'AAAA-MM-DD' (o 'sin-fecha') */
  key: string;
  label: string;
  /** la ultima que se marco primero */
  items: RoomNote[];
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Hechas agrupadas por el dia (hora local) en que se marcaron, el dia mas reciente primero. "Cuando se
 * hizo" es updatedAt: el servidor lo pone al marcarla (y las hechas no se editan, asi que no se mueve).
 */
export function todoDoneGroups(done: readonly RoomNote[], nowMs: number): TodoDayGroup[] {
  const dated: { note: RoomNote; ms: number }[] = [];
  const undated: RoomNote[] = [];
  for (const note of done) {
    const ms = Date.parse(note.updatedAt);
    if (Number.isNaN(ms)) undated.push(note);
    else dated.push({ note, ms });
  }
  dated.sort((a, b) => b.ms - a.ms);
  const groups: TodoDayGroup[] = [];
  for (const { note, ms } of dated) {
    const key = localDayKey(ms);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(note);
    else groups.push({ key, label: todoDayLabel(ms, nowMs), items: [note] });
  }
  if (undated.length > 0) groups.push({ key: 'sin-fecha', label: 'Sin fecha', items: undated });
  return groups;
}

/** cuantas se marcaron hoy (dia local) */
export function doneTodayCount(view: TodoView, nowMs: number): number {
  return view.done.filter((t) => {
    const ms = Date.parse(t.updatedAt);
    return !Number.isNaN(ms) && calendarDaysAgo(ms, nowMs) === 0;
  }).length;
}

/** resumen de la cabecera: "3 por hacer · 2 hechas hoy" · "Nada por hacer · 1 hecha hoy" · "Sin pendientes" */
export function todoHeadline(view: TodoView, nowMs: number): string {
  const p = view.pending.length;
  if (p === 0 && view.done.length === 0) return 'Sin pendientes';
  const first = p === 0 ? 'Nada por hacer' : `${p} por hacer`;
  const today = doneTodayCount(view, nowMs);
  return today > 0 ? `${first} · ${today} ${today === 1 ? 'hecha' : 'hechas'} hoy` : first;
}

export interface TodoProgress {
  /** hechas hoy */
  done: number;
  /** hechas hoy + por hacer */
  total: number;
  /** 0..1; sin nada de hoy y sin nada por hacer, 1 si hay hechas de antes (todo al dia) */
  ratio: number;
}

/** avance del dia: lo hecho hoy contra lo hecho hoy mas lo que falta */
export function todoProgress(view: TodoView, nowMs: number): TodoProgress {
  const done = doneTodayCount(view, nowMs);
  const total = view.pending.length + done;
  if (total === 0) return { done: 0, total: 0, ratio: view.done.length > 0 ? 1 : 0 };
  return { done, total, ratio: done / total };
}

// ---------------------------------------------------------------- cambios optimistas
//
// La lista que se ve = la del ultimo snapshot + los cambios que el usuario hizo y el servidor todavia no
// reflejo. Cada cambio se quita (pruneTodoOps) cuando un snapshot ya lo trae: asi no hay parpadeo ni
// duplicados, llegue antes la respuesta HTTP o el snapshot.

export interface TodoChange {
  text?: string;
  done?: boolean;
}

export type TodoOp =
  | {
      kind: 'add';
      /** id provisional ('tmp:…') mientras el servidor no responde */
      key: string;
      text: string;
      /** hora local en que se escribio */
      at: string;
      /** id real cuando el POST responde */
      id: string | null;
      /** createdAt que dio el servidor */
      serverAt: string | null;
      /** ids que ya estaban en el snapshot al escribirlo: lo nuevo con el mismo texto es este */
      before: readonly string[];
    }
  | {
      kind: 'patch';
      key: string;
      id: string;
      change: TodoChange;
      at: string;
      /** updatedAt que dio el servidor; null mientras la peticion no termina */
      serverAt: string | null;
    }
  | {
      kind: 'remove';
      key: string;
      id: string;
      /** false mientras se puede deshacer: todavia no se mando el DELETE */
      committed: boolean;
    };

export const TEMP_PREFIX = 'tmp:';

export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

/** adds sin respuesta todavia: a que nota del servidor corresponde cada uno (mismo texto, nota nueva) */
function claimUnresolvedAdds(server: readonly RoomNote[], ops: readonly TodoOp[]): Map<string, string> {
  const owned = new Set<string>();
  for (const op of ops) if (op.kind === 'add' && op.id) owned.add(op.id);
  const claims = new Map<string, string>();
  for (const op of ops) {
    if (op.kind !== 'add' || op.id) continue;
    const before = new Set(op.before);
    const match = server.find((n) => n.text === op.text && !before.has(n.id) && !owned.has(n.id));
    if (match) {
      owned.add(match.id);
      claims.set(op.key, match.id);
    }
  }
  return claims;
}

function patchNote(note: RoomNote, change: TodoChange, at: string): RoomNote {
  const done = change.done ?? note.done;
  return {
    ...note,
    text: change.text ?? note.text,
    done,
    // "cuando se hizo": solo al pasar a hecha; volver a pendiente no la mueve de su dia
    updatedAt: done && !note.done ? at : note.updatedAt,
  };
}

/** la lista que se ve: snapshot + cambios pendientes, en orden */
export function applyTodoOps(server: readonly RoomNote[], ops: readonly TodoOp[]): RoomNote[] {
  if (ops.length === 0) return [...server];
  const claims = claimUnresolvedAdds(server, ops);
  const resolve = (id: string): string => claims.get(id) ?? id;
  let list = [...server];
  for (const op of ops) {
    if (op.kind === 'add') {
      const id = op.id ?? claims.get(op.key) ?? null;
      if (id && list.some((n) => n.id === id)) continue;
      list.push({ id: op.id ?? op.key, text: op.text, done: false, createdAt: op.at, updatedAt: op.at });
    } else if (op.kind === 'patch') {
      const id = resolve(op.id);
      list = list.map((n) => (n.id === id ? patchNote(n, op.change, op.at) : n));
    } else {
      const id = resolve(op.id);
      list = list.filter((n) => n.id !== id);
    }
  }
  return list;
}

/** ids provisionales que el snapshot ya trae aunque el POST no haya respondido: tmp -> id real */
export function todoClaims(server: readonly RoomNote[], ops: readonly TodoOp[]): Map<string, string> {
  return claimUnresolvedAdds(server, ops);
}

function matches(note: RoomNote, change: TodoChange): boolean {
  return (change.text === undefined || note.text === change.text) && (change.done === undefined || note.done === change.done);
}

/**
 * Quita los cambios que el snapshot ya refleja. Devuelve el mismo arreglo si no quita nada.
 * - add: cuando el snapshot trae su id real (o uno posterior al alta ya no lo trae: lo borraron en otro lado)
 * - patch: terminado y el snapshot ya coincide, la nota ya no existe o el snapshot es posterior a la respuesta
 * - remove: cuando el snapshot ya no trae la nota (y no es una que se esta creando)
 */
export function pruneTodoOps(server: readonly RoomNote[], ops: readonly TodoOp[], generatedAt: string | null): TodoOp[] {
  if (ops.length === 0) return ops as TodoOp[];
  const byId = new Map(server.map((n) => [n.id, n]));
  const gen = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const after = (serverAt: string | null): boolean =>
    serverAt !== null && !Number.isNaN(gen) && gen > Date.parse(serverAt);
  // notas que se estan creando: su id todavia no tiene por que estar en el snapshot
  const creating = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'add' && (op.id === null || !byId.has(op.id))) {
      creating.add(op.key);
      if (op.id) creating.add(op.id);
    }
  }
  const keep = ops.filter((op) => {
    if (op.kind === 'add') {
      if (op.id === null) return true;
      if (byId.has(op.id)) return false;
      return !after(op.serverAt);
    }
    if (isTempId(op.id) || creating.has(op.id)) return true;
    const note = byId.get(op.id);
    if (op.kind === 'remove') return note !== undefined;
    if (op.serverAt === null) return true;
    if (!note || matches(note, op.change)) return false;
    return !after(op.serverAt);
  });
  return keep.length === ops.length ? (ops as TodoOp[]) : keep;
}

/** el POST respondio: el alta y todo lo que apuntaba a su id provisional pasan al id real */
export function rebindTodoOps(ops: readonly TodoOp[], tempKey: string, note: RoomNote): TodoOp[] {
  return ops.map((op) => {
    if (op.kind === 'add') return op.key === tempKey ? { ...op, id: note.id, serverAt: note.createdAt } : op;
    return op.id === tempKey ? { ...op, id: note.id } : op;
  });
}

/** el alta fallo: fuera ella y lo que dependia de su id provisional */
export function dropTodoOpsFor(ops: readonly TodoOp[], tempKey: string): TodoOp[] {
  return ops.filter((op) => (op.kind === 'add' ? op.key !== tempKey : op.id !== tempKey));
}
