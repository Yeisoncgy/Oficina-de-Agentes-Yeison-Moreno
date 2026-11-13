import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { create } from 'zustand';
import { Check, CircleAlert, ClipboardCopy, ListTodo, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
import { NOTE_TEXT_MAX, TODO_KEY, type RoomNote } from '@shared/contract';
import { copyText } from '@/lib/copy';
import {
  applyTodoOps,
  dropTodoOpsFor,
  isTempId,
  pruneTodoOps,
  rebindTodoOps,
  TEMP_PREFIX,
  todoClaims,
  todoClock,
  todoCreatedLabel,
  todoDoneGroups,
  todoFullDate,
  todoHeadline,
  todoProgress,
  todoText,
  todoView,
  type TodoChange,
  type TodoOp,
  type TodoView,
} from '@/lib/todo';
import { ApiError, describeApiError } from '@/state/api';
import { addNote, deleteDoneNotes, deleteNote, updateNote } from '@/state/notesApi';
import { useOfficeStore } from '@/state/store';
import { DURATION } from '@/theme';
import { IconButton, PanelState, STROKE } from './primitives';
import { useNow } from './useNow';
import { usePresence, useReducedMotion } from './usePresence';
import './extras/extras.css';
import './todo.css';

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------- cambios optimistas
//
// Cada accion cambia la lista al instante (useTodoOps) y la peticion sale despues, en fila: el servidor
// las recibe en el mismo orden en que el usuario las hizo. Cuando un snapshot ya trae el cambio, el
// cambio local se descarta (pruneTodoOps); si la peticion falla, se descarta y se avisa. Vive fuera del
// componente para que una peticion que termina con el modal cerrado no se pierda.

interface TodoOpsState {
  ops: TodoOp[];
  error: string | null;
  /** texto de un alta que fallo, para devolverlo al campo */
  restore: { text: string; n: number } | null;
}

const useTodoOps = create<TodoOpsState>(() => ({ ops: [], error: null, restore: null }));

/** id real -> id provisional con el que se dibujo: la fila no se vuelve a montar cuando llega el id real */
const keyAlias = new Map<string, string>();
let opSeq = 0;
let queue: Promise<void> = Promise.resolve();

function nextKey(): string {
  opSeq += 1;
  return `${TEMP_PREFIX}${Date.now().toString(36)}-${opSeq}`;
}

function setOps(update: (ops: TodoOp[]) => TodoOp[]): void {
  useTodoOps.setState((s) => {
    const ops = update(s.ops);
    return ops === s.ops ? s : { ops };
  });
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch(() => undefined);
}

function findOp(key: string): TodoOp | undefined {
  return useTodoOps.getState().ops.find((o) => o.key === key);
}

function pruneNow(): void {
  const snapshot = useOfficeStore.getState().snapshot;
  if (!snapshot?.todos) return;
  const todos = snapshot.todos;
  setOps((ops) => pruneTodoOps(todos, ops, snapshot.generatedAt));
}

function quote(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return `«${line.length > 48 ? `${line.slice(0, 47)}…` : line}»`;
}

function reason(err: unknown): string {
  if (err instanceof ApiError && [0, 500, 502, 503, 504].includes(err.status)) {
    return 'El servidor no responde; ¿está corriendo npm run dev?';
  }
  return describeApiError(err);
}

function fail(message: string): void {
  useTodoOps.setState({ error: message });
}

function addTodo(text: string): string {
  const key = nextKey();
  const before = (useOfficeStore.getState().snapshot?.todos ?? []).map((n) => n.id);
  setOps((ops) => [...ops, { kind: 'add', key, text, at: new Date().toISOString(), id: null, serverAt: null, before }]);
  useTodoOps.setState({ error: null });
  enqueue(async () => {
    try {
      const note = await addNote(TODO_KEY, text);
      keyAlias.set(note.id, key);
      setOps((ops) => rebindTodoOps(ops, key, note));
      pruneNow();
    } catch (err) {
      setOps((ops) => dropTodoOpsFor(ops, key));
      useTodoOps.setState((s) => ({
        error: `No se agregó ${quote(text)}. ${reason(err)}`,
        restore: { text, n: (s.restore?.n ?? 0) + 1 },
      }));
    }
  });
  return key;
}

function patchTodo(id: string, change: TodoChange): void {
  const key = nextKey();
  setOps((ops) => [...ops, { kind: 'patch', key, id, change, at: new Date().toISOString(), serverAt: null }]);
  useTodoOps.setState({ error: null });
  enqueue(async () => {
    const op = findOp(key);
    if (!op || op.kind !== 'patch') return;
    if (isTempId(op.id)) {
      // su alta fallo: no hay nota a la que aplicarlo
      setOps((ops) => ops.filter((o) => o.key !== key));
      return;
    }
    try {
      const note = await updateNote(op.id, op.change);
      setOps((ops) => ops.map((o) => (o.key === key && o.kind === 'patch' ? { ...o, serverAt: note.updatedAt } : o)));
      pruneNow();
    } catch (err) {
      setOps((ops) => ops.filter((o) => o.key !== key));
      fail(`${change.text !== undefined ? 'No se guardó el cambio' : 'No se pudo marcar'}. ${reason(err)}`);
    }
  });
}

/** la oculta ya; el DELETE sale con commitRemove (al vencer el aviso de deshacer) */
function removeTodo(id: string): string {
  const key = nextKey();
  setOps((ops) => [...ops, { kind: 'remove', key, id, committed: false }]);
  useTodoOps.setState({ error: null });
  return key;
}

function cancelRemove(key: string): void {
  setOps((ops) => ops.filter((o) => o.key !== key));
}

function commitRemove(key: string, text: string): void {
  const op = findOp(key);
  if (!op || op.kind !== 'remove' || op.committed) return;
  setOps((ops) => ops.map((o) => (o.key === key && o.kind === 'remove' ? { ...o, committed: true } : o)));
  enqueue(async () => {
    const cur = findOp(key);
    if (!cur || cur.kind !== 'remove') return;
    if (isTempId(cur.id)) {
      cancelRemove(key);
      return;
    }
    try {
      await deleteNote(cur.id);
      pruneNow();
    } catch (err) {
      // 404: ya no estaba; el snapshot lo confirma
      if (err instanceof ApiError && err.status === 404) {
        pruneNow();
        return;
      }
      cancelRemove(key);
      fail(`No se borró ${quote(text)}. ${reason(err)}`);
    }
  });
}

function clearDoneTodos(ids: readonly string[]): void {
  const keys = ids.map((id) => ({ key: nextKey(), id }));
  setOps((ops) => [...ops, ...keys.map(({ key, id }): TodoOp => ({ kind: 'remove', key, id, committed: true }))]);
  useTodoOps.setState({ error: null });
  enqueue(async () => {
    try {
      await deleteDoneNotes(TODO_KEY);
      pruneNow();
    } catch (err) {
      const mine = new Set(keys.map((k) => k.key));
      setOps((ops) => ops.filter((o) => !mine.has(o.key)));
      fail(`No se borraron las hechas. ${reason(err)}`);
    }
  });
}

// el snapshot llega muy seguido (cada cambio de cualquier agente): el modal solo se vuelve a dibujar
// cuando cambian los pendientes
type OfficeState = ReturnType<typeof useOfficeStore.getState>;
let memoRaw: RoomNote[] | undefined;
let memoSig = '';
let memoTodos: RoomNote[] | undefined;

function selectTodos(s: OfficeState): RoomNote[] | undefined {
  const raw = s.snapshot?.todos;
  if (raw === memoRaw) return memoTodos;
  memoRaw = raw;
  const sig = raw
    ? `L${raw.map((t) => `${t.id}\u0001${t.done ? 1 : 0}\u0001${t.createdAt}\u0001${t.updatedAt}\u0001${t.text}`).join('\u0002')}`
    : 'U';
  if (sig !== memoSig) {
    memoSig = sig;
    memoTodos = raw;
  }
  return memoTodos;
}

// ---------------------------------------------------------------- modal

/**
 * Pendientes (P): tu lista de cosas por hacer, de toda la herramienta y no de una sala. Escribes, Enter, y al
 * terminar lo marcas: pasa a Hechas, agrupado por el dia en que lo hiciste. Vive en la base local y es la
 * misma en todas las pestanas y sesiones.
 */
export function TodoModal() {
  const open = useOfficeStore((s) => s.todoOpen);
  const { shown, leaving } = usePresence(open ? true : null, DURATION.modalOut);
  if (shown === null) return null;
  return <TodoDialog leaving={leaving} />;
}

function TodoDialog({ leaving }: { leaving: boolean }) {
  const close = useOfficeStore((s) => s.closeTodo);
  const server = useOfficeStore(selectTodos);
  const demo = useOfficeStore((s) => s.demo);
  const ops = useTodoOps((s) => s.ops);
  const now = useNow(30_000, 'local');
  const dialogRef = useRef<HTMLElement>(null);
  const live = !demo && server !== undefined;
  const notes = useMemo(() => (server ? applyTodoOps(server, ops) : undefined), [server, ops]);
  const view = useMemo(() => todoView(live ? notes : undefined), [live, notes]);
  const progress = todoProgress(view, now);
  const any = view.pending.length + view.done.length > 0;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (dialogRef.current?.querySelector<HTMLElement>('#todo-draft') ?? dialogRef.current)?.focus();
    return () => previous?.focus();
  }, []);

  // cada snapshot nuevo confirma (y descarta) los cambios locales que ya trae
  useEffect(() => {
    pruneNow();
    return useOfficeStore.subscribe((s, prev) => {
      if (s.snapshot !== prev.snapshot) pruneNow();
    });
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div aria-hidden className={`scrim ${leaving ? 'is-leaving' : ''}`} onClick={close} />
      <div className="modal-wrap">
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="todo-title"
          tabIndex={-1}
          onKeyDown={trapFocus}
          className={`modal notes-modal todo-modal ${leaving ? 'is-leaving' : ''}`}
        >
          <header className="modal-head notes-head scanline todo-head">
            <ListTodo size={18} strokeWidth={STROKE} aria-hidden className="notes-head-icon" />
            <div className="notes-head-text">
              <h2 id="todo-title" className="modal-title display">
                Pendientes
              </h2>
              <span className="notes-room todo-headline" role="status">
                {todoHeadline(view, now)}
              </span>
            </div>
            <div className="modal-close">
              <kbd className="kbd">Esc</kbd>
              <IconButton label="Cerrar (Esc)" onClick={close}>
                <X size={16} strokeWidth={STROKE} />
              </IconButton>
            </div>
            {live && any ? (
              <div
                className="todo-progress"
                role="progressbar"
                aria-label="Avance de hoy"
                aria-valuemin={0}
                aria-valuemax={Math.max(progress.total, 1)}
                aria-valuenow={progress.total === 0 ? progress.ratio : progress.done}
                aria-valuetext={progress.total === 0 ? 'Nada pendiente' : `${progress.done} de ${progress.total} hechas hoy`}
              >
                <span style={{ transform: `scaleX(${progress.ratio})` }} />
              </div>
            ) : null}
          </header>
          {live && server ? (
            <TodoBody server={server} ops={ops} view={view} now={now} closing={leaving} />
          ) : (
            <div className="modal-body">
              <PanelState
                kind="empty"
                title="Los pendientes necesitan el servidor"
                text="Se guardan en la base local de Colmena. Con el servidor corriendo puedes escribir aquí lo que tienes por hacer."
              />
            </div>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- cuerpo

type Tab = 'pending' | 'done';
type LeaveKind = 'complete' | 'reopen' | 'remove';

/** una fila tal como se dibuja: su llave estable y, si esta saliendo, hacia donde */
interface Row {
  key: string;
  note: RoomNote;
  leave: LeaveKind | null;
}

interface Leaving {
  note: RoomNote;
  list: Tab;
  kind: LeaveKind;
}

interface UndoState {
  opKey: string;
  rowKey: string;
  list: Tab;
  text: string;
  n: number;
}

type FocusTarget = { key: string; part: 'check' | 'edit' } | 'input';

/** casilla + tachado (180) y salida (180); la salida de Hechas espera menos; borrar sale de una */
const LEAVE_MS: Record<LeaveKind, number> = { complete: 380, reopen: 320, remove: 200 };
const LEAVE_REDUCED_MS = 140;
const UNDO_MS = 5_000;

const byCreated = (a: Row, b: Row): number => Date.parse(a.note.createdAt) - Date.parse(b.note.createdAt);
const byDoneDesc = (a: Row, b: Row): number => Date.parse(b.note.updatedAt) - Date.parse(a.note.updatedAt);

function rowSelector(key: string): string {
  return `[data-row-key="${CSS.escape(key)}"]`;
}

function TodoBody({
  server,
  ops,
  view,
  now,
  closing,
}: {
  server: RoomNote[];
  ops: TodoOp[];
  view: TodoView;
  now: number;
  closing: boolean;
}) {
  const reduced = useReducedMotion();
  const error = useTodoOps((s) => s.error);
  const [tab, setTab] = useState<Tab>('pending');
  const [leavingRows, setLeavingRows] = useState<ReadonlyMap<string, Leaving>>(() => new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ pending: null, done: null });
  const clearBtnRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Map<string, number>());
  const focusNext = useRef<FocusTarget | null>(null);
  const scrollTo = useRef<string | null>(null);
  const undoRef = useRef<UndoState | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const present = useRef(new Set<string>());
  const fresh = useRef(new Set<string>());
  const listIds = useRef<Record<Tab, Set<string>>>({ pending: new Set(), done: new Set() });
  const countRefs = useRef<Record<Tab, HTMLSpanElement | null>>({ pending: null, done: null });
  const prevCounts = useRef<Record<Tab, number> | null>(null);

  // un alta cuyo id real ya trae el snapshot (antes de que responda el POST) conserva su llave provisional
  const claimAlias = useMemo(() => {
    const alias = new Map<string, string>();
    for (const [tmp, id] of todoClaims(server, ops)) alias.set(id, tmp);
    return alias;
  }, [server, ops]);
  const rowKey = (id: string): string => keyAlias.get(id) ?? claimAlias.get(id) ?? id;

  const rowsFor = (list: Tab, notes: RoomNote[]): Row[] => {
    const rows: Row[] = [];
    for (const note of notes) {
      const key = rowKey(note.id);
      if (!leavingRows.has(key)) rows.push({ key, note, leave: null });
    }
    for (const [key, l] of leavingRows) if (l.list === list) rows.push({ key, note: l.note, leave: l.kind });
    return rows.sort(list === 'pending' ? byCreated : byDoneDesc);
  };
  const pendingRows = rowsFor('pending', view.pending);
  const doneRows = rowsFor('done', view.done);
  // los grupos traen las mismas notas (por identidad): de ahi se recupera cada fila
  const rowOfNote = new Map(doneRows.map((r) => [r.note, r]));
  const groups = todoDoneGroups(
    doneRows.map((r) => r.note),
    now,
  ).map((g) => ({ ...g, rows: g.items.flatMap((n) => rowOfNote.get(n) ?? []) }));

  // entra con animacion la fila que aparece despues de abrir: nueva, o que vuelve (un borrado que fallo)
  const allKeys = [...pendingRows, ...doneRows].map((r) => r.key);
  const isFresh = (key: string): boolean =>
    fresh.current.has(key) || (seen.current !== null && (!seen.current.has(key) || !present.current.has(key)));

  useLayoutEffect(() => {
    const known = seen.current ?? new Set<string>();
    for (const key of allKeys) {
      if (seen.current && (!known.has(key) || !present.current.has(key))) fresh.current.add(key);
      known.add(key);
    }
    seen.current = known;
    present.current = new Set(allKeys);
    listIds.current = { pending: new Set(view.pending.map((n) => n.id)), done: new Set(view.done.map((n) => n.id)) };
  });

  useFlip(listRef, tab, reduced);

  // el contador que cambia da un saltito (no al abrir)
  const pendingCount = view.pending.length;
  const doneCount = view.done.length;
  useLayoutEffect(() => {
    const prev = prevCounts.current;
    prevCounts.current = { pending: pendingCount, done: doneCount };
    if (!prev || reduced) return;
    for (const [t, n] of [
      ['pending', pendingCount],
      ['done', doneCount],
    ] as const) {
      if (prev[t] === n) continue;
      countRefs.current[t]?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.2)', offset: 0.4 }, { transform: 'scale(1)' }], {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    }
  }, [pendingCount, doneCount, reduced]);

  useEffect(() => {
    undoRef.current = undo;
  }, [undo]);

  // foco despues de que una fila sale, se guarda una edicion o se deshace un borrado
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === 'input') {
      inputRef.current?.focus();
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(rowSelector(target.key));
    const el =
      (target.part === 'edit' ? row?.querySelector<HTMLElement>('.todo-edit-btn') : null) ??
      row?.querySelector<HTMLElement>('.todo-check') ??
      listRef.current?.querySelector<HTMLElement>('.todo-row:not(.is-leaving) .todo-check') ??
      inputRef.current;
    el?.focus();
  });

  // la fila recien escrita queda a la vista
  useLayoutEffect(() => {
    const key = scrollTo.current;
    if (!key) return;
    scrollTo.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(rowSelector(key))
      ?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  });

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(t);
  }, [copied]);

  // al cerrar el modal el borrado pendiente se confirma
  useEffect(() => {
    if (!closing) return;
    const u = undoRef.current;
    if (u) commitRemove(u.opKey, u.text);
  }, [closing]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      const u = undoRef.current;
      if (u) commitRemove(u.opKey, u.text);
      for (const t of pending.values()) window.clearTimeout(t);
      pending.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (confirmClear) confirmCancelRef.current?.focus();
  }, [confirmClear]);

  const startLeaving = (key: string, entry: Leaving, neighbor: string | null) => {
    setLeavingRows((m) => new Map(m).set(key, entry));
    const t = window.setTimeout(
      () => {
        timers.current.delete(key);
        const row = listRef.current?.querySelector(rowSelector(key));
        // la peticion fallo mientras salia: la fila sigue en su lista y vuelve con la entrada de una nueva
        if (entry.kind !== 'remove' && listIds.current[entry.list].has(entry.note.id)) fresh.current.add(key);
        else if (row?.contains(document.activeElement)) focusNext.current = neighbor ? { key: neighbor, part: 'check' } : 'input';
        setLeavingRows((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
      },
      reduced ? LEAVE_REDUCED_MS : LEAVE_MS[entry.kind],
    );
    timers.current.set(key, t);
  };

  const neighborOf = (rows: Row[], key: string): string | null => {
    const alive = rows.filter((r) => r.key === key || !r.leave);
    const i = alive.findIndex((r) => r.key === key);
    return alive[i + 1]?.key ?? alive[i - 1]?.key ?? null;
  };

  const doneFlat = groups.flatMap((g) => g.rows);

  const toggle = (row: Row, list: Tab) => {
    if (row.leave) return;
    const done = !row.note.done;
    const neighbor = neighborOf(list === 'pending' ? pendingRows : doneFlat, row.key);
    patchTodo(row.note.id, { done });
    startLeaving(row.key, { note: { ...row.note, done }, list, kind: done ? 'complete' : 'reopen' }, neighbor);
  };

  const remove = (row: Row, list: Tab) => {
    if (row.leave) return;
    const prev = undoRef.current;
    if (prev) commitRemove(prev.opKey, prev.text);
    const neighbor = neighborOf(list === 'pending' ? pendingRows : doneFlat, row.key);
    const opKey = removeTodo(row.note.id);
    if (editing === row.key) setEditing(null);
    startLeaving(row.key, { note: row.note, list, kind: 'remove' }, neighbor);
    const next = { opKey, rowKey: row.key, list, text: row.note.text, n: (prev?.n ?? 0) + 1 };
    undoRef.current = next;
    setUndo(next);
  };

  const undoRemove = () => {
    const u = undoRef.current;
    if (!u) return;
    const active = document.activeElement;
    const focusLost = !active || active === document.body || !!active.closest('.todo-toast');
    cancelRemove(u.opKey);
    const t = timers.current.get(u.rowKey);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.current.delete(u.rowKey);
      setLeavingRows((m) => {
        const next = new Map(m);
        next.delete(u.rowKey);
        return next;
      });
    }
    // vuelve a su lugar con la entrada de una fila nueva
    fresh.current.add(u.rowKey);
    undoRef.current = null;
    setUndo(null);
    setTab(u.list);
    if (focusLost) focusNext.current = { key: u.rowKey, part: 'check' };
  };

  const expireUndo = () => {
    const u = undoRef.current;
    if (!u) return;
    commitRemove(u.opKey, u.text);
    undoRef.current = null;
    setUndo(null);
  };

  const finishEdit = (row: Row, text: string | null, refocus: boolean) => {
    setEditing(null);
    if (text !== null) {
      const clean = text.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_TEXT_MAX);
      if (clean && clean !== row.note.text) patchTodo(row.note.id, { text: clean });
    }
    if (refocus) focusNext.current = { key: row.key, part: 'edit' };
  };

  const onAdded = (key: string) => {
    scrollTo.current = key;
    if (tab !== 'pending') setTab('pending');
  };

  const copy = async () => {
    if (await copyText(todoText(view))) setCopied(true);
    else fail('El navegador no dejó copiar.');
  };

  const selectTab = (next: Tab, focus = false) => {
    setTab(next);
    setConfirmClear(false);
    if (focus) tabRefs.current[next]?.focus();
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next: Tab | null =
      event.key === 'Home'
        ? 'pending'
        : event.key === 'End'
          ? 'done'
          : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            ? tab === 'pending'
              ? 'done'
              : 'pending'
            : null;
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  };

  // flechas arriba/abajo pasan de casilla en casilla; Ctrl+Z deshace el ultimo borrado
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.classList.contains('todo-check')) {
      const checks = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.todo-row:not(.is-leaving) .todo-check') ?? []);
      const next = checks[checks.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && undoRef.current) {
      const typing = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.value !== '');
      if (typing) return;
      event.preventDefault();
      undoRemove();
    }
  };

  const confirmClearDone = () => {
    const rows = doneRows.filter((r) => !r.leave);
    clearDoneTodos(rows.map((r) => r.note.id));
    // salen todas juntas
    for (const r of rows) startLeaving(r.key, { note: r.note, list: 'done', kind: 'remove' }, null);
    setConfirmClear(false);
    inputRef.current?.focus();
  };

  const cancelClear = () => {
    setConfirmClear(false);
    requestAnimationFrame(() => clearBtnRef.current?.focus());
  };

  const rowProps = {
    now,
    editing,
    isFresh,
    onToggle: toggle,
    onEdit: (row: Row) => {
      if (!row.leave) setEditing(row.key);
    },
    onEditDone: finishEdit,
    onRemove: remove,
  };

  return (
    <div className="todo-main" onKeyDown={onKeyDown}>
      <div className="todo-top">
        <AddForm inputRef={inputRef} onAdded={onAdded} />
        <div className="todo-tabs" role="tablist" aria-label="Pendientes" data-tab={tab}>
          <span className="todo-tabs-thumb" aria-hidden />
          {(['pending', 'done'] as const).map((t) => {
            const count = t === 'pending' ? pendingCount : doneCount;
            return (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                type="button"
                role="tab"
                id={`todo-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="todo-panel"
                tabIndex={tab === t ? 0 : -1}
                className="todo-tab"
                onClick={() => selectTab(t)}
                onKeyDown={onTabKey}
              >
                {t === 'pending' ? 'Por hacer' : 'Hechas'}
                <span
                  ref={(el) => {
                    countRefs.current[t] = el;
                  }}
                  className="todo-count"
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`todo-stage ${undo || error ? 'has-toast' : ''}`}>
        <div
          key={tab}
          id="todo-panel"
          role="tabpanel"
          aria-labelledby={`todo-tab-${tab}`}
          className="modal-body todo-body"
        >
          <div ref={listRef} className="todo-flip">
            {tab === 'pending' ? (
              pendingRows.length === 0 ? (
                doneCount === 0 ? (
                  <PanelState
                    kind="empty"
                    title="Todavía no hay pendientes"
                    text="Escribe arriba lo que tienes por hacer y pulsa Enter. Es una sola lista para toda la herramienta: no depende de ninguna sala ni sesión."
                  />
                ) : (
                  <PanelState
                    kind="empty"
                    title="Nada por hacer"
                    text="Todo al día. Lo que marcas pasa a Hechas, con el día y la hora en que lo hiciste."
                    extra={
                      <button type="button" className="btn btn--sm" onClick={() => selectTab('done', true)}>
                        Ver hechas · {doneCount}
                      </button>
                    }
                  />
                )
              ) : (
                <ul className="todo-list" aria-label="Por hacer">
                  {pendingRows.map((row) => (
                    <TodoRow key={row.key} row={row} list="pending" {...rowProps} />
                  ))}
                </ul>
              )
            ) : groups.length === 0 ? (
              <PanelState
                kind="empty"
                title="Todavía no hay hechas"
                text="Marca la casilla de un pendiente y aparece aquí, agrupado por el día en que lo hiciste."
              />
            ) : (
              <div className="todo-groups">
                {groups.map((g) => (
                  <section key={g.key} className="todo-group" aria-labelledby={`todo-day-${g.key}`}>
                    <h3 id={`todo-day-${g.key}`} className="todo-group-title" data-flip-key={`day:${g.key}`}>
                      <span>{g.label}</span>
                      <span className="todo-group-count">{g.rows.length}</span>
                    </h3>
                    <ul className="todo-list">
                      {g.rows.map((row) => (
                        <TodoRow key={row.key} row={row} list="done" {...rowProps} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="todo-toaster">
          {error ? (
            <div className="todo-toast todo-toast--error" role="alert">
              <CircleAlert size={14} strokeWidth={STROKE} aria-hidden className="todo-toast-icon" />
              <span className="todo-toast-text todo-toast-text--wrap">{error}</span>
              <IconButton label="Cerrar aviso" onClick={() => useTodoOps.setState({ error: null })}>
                <X size={14} strokeWidth={STROKE} />
              </IconButton>
            </div>
          ) : null}
          <UndoToast undo={undo} reduced={reduced} onUndo={undoRemove} onExpire={expireUndo} />
        </div>
      </div>

      <footer className="notes-foot todo-foot">
        {tab === 'done' && confirmClear ? (
          <div
            className="todo-confirm"
            role="group"
            aria-label="Confirmar borrado de las hechas"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              // cancela la confirmacion sin cerrar el modal
              e.preventDefault();
              e.stopPropagation();
              cancelClear();
            }}
          >
            <span className="todo-confirm-text">
              ¿Borrar {doneCount === 1 ? 'la hecha' : `las ${doneCount} hechas`}? No se puede deshacer.
            </span>
            <button ref={confirmCancelRef} type="button" className="btn btn--sm" onClick={cancelClear}>
              Cancelar
            </button>
            <button type="button" className="btn btn--sm todo-danger" onClick={confirmClearDone}>
              <Trash2 size={12} strokeWidth={STROKE} aria-hidden />
              Borrar {doneCount}
            </button>
          </div>
        ) : (
          <>
            <span className="notes-foot-text" role="status">
              {copied
                ? 'Copiado.'
                : tab === 'pending'
                  ? 'Enter agrega · Espacio marca · doble clic edita'
                  : 'Agrupadas por el día en que las marcaste.'}
            </span>
            {tab === 'pending' ? (
              <button type="button" className="btn btn--sm" onClick={() => void copy()} disabled={pendingCount === 0}>
                <ClipboardCopy size={12} strokeWidth={STROKE} aria-hidden />
                Copiar
              </button>
            ) : doneCount > 0 ? (
              <button ref={clearBtnRef} type="button" className="btn btn--sm" onClick={() => setConfirmClear(true)}>
                <Trash2 size={12} strokeWidth={STROKE} aria-hidden />
                Borrar hechas
              </button>
            ) : null}
          </>
        )}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- alta

function AddForm({ inputRef, onAdded }: { inputRef: RefObject<HTMLInputElement | null>; onAdded: (key: string) => void }) {
  const [draft, setDraft] = useState('');
  const restore = useTodoOps((s) => s.restore);

  // un alta que fallo devuelve su texto al campo (si no se escribio otra cosa)
  useEffect(() => {
    if (!restore) return;
    setDraft((d) => d || restore.text);
    useTodoOps.setState({ restore: null });
  }, [restore]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const key = addTodo(text);
    setDraft('');
    onAdded(key);
    // el foco se queda en el campo: se escriben varios seguidos
    inputRef.current?.focus();
  };

  return (
    <form className="todo-add" onSubmit={submit}>
      <label htmlFor="todo-draft" className="sr-only">
        Nuevo pendiente
      </label>
      <div className="todo-add-field">
        <Plus size={16} strokeWidth={STROKE} aria-hidden className="todo-add-icon" />
        <input
          id="todo-draft"
          ref={inputRef}
          className="todo-input"
          type="text"
          maxLength={NOTE_TEXT_MAX}
          placeholder="¿Qué tienes por hacer? Escribe y pulsa Enter"
          autoComplete="off"
          enterKeyHint="done"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn--primary todo-add-btn" disabled={!draft.trim()}>
        Agregar
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- fila

function TodoRow({
  row,
  list,
  now,
  editing,
  isFresh,
  onToggle,
  onEdit,
  onEditDone,
  onRemove,
}: {
  row: Row;
  list: Tab;
  now: number;
  editing: string | null;
  isFresh: (key: string) => boolean;
  onToggle: (row: Row, list: Tab) => void;
  onEdit: (row: Row) => void;
  onEditDone: (row: Row, text: string | null, refocus: boolean) => void;
  onRemove: (row: Row, list: Tab) => void;
}) {
  const { key, note, leave } = row;
  const isEditing = editing === key;
  const textId = `todo-text-${key}`;
  const short = quote(note.text);
  const when =
    list === 'pending'
      ? { iso: note.createdAt, text: todoCreatedLabel(note.createdAt, now), title: `Creada el ${todoFullDate(note.createdAt)}` }
      : {
          iso: note.updatedAt,
          text: todoClock(note.updatedAt),
          title: `Hecha el ${todoFullDate(note.updatedAt)} · creada el ${todoFullDate(note.createdAt)}`,
        };
  const cls = [
    'todo-row',
    note.done ? 'is-done' : '',
    leave ? 'is-leaving' : '',
    isFresh(key) ? 'is-new' : '',
    isEditing ? 'is-editing' : '',
  ].join(' ');

  return (
    <li className={cls} data-row-key={key} data-flip-key={key} data-leave={leave ?? undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={note.done}
        {...(isEditing ? { 'aria-label': 'Pendiente en edición' } : { 'aria-labelledby': textId })}
        title={note.done ? 'Volver a por hacer' : 'Marcar como hecha'}
        className="todo-check"
        onClick={() => onToggle(row, list)}
      >
        <Check size={13} strokeWidth={STROKE} aria-hidden className="todo-check-mark" />
      </button>
      {isEditing ? (
        <TodoEditor initial={note.text} onDone={(text, refocus) => onEditDone(row, text, refocus)} />
      ) : (
        <p
          id={textId}
          className="todo-text"
          title={when.title}
          onDoubleClick={
            list === 'pending' && !leave
              ? () => {
                  window.getSelection()?.removeAllRanges();
                  onEdit(row);
                }
              : undefined
          }
        >
          {note.text}
        </p>
      )}
      {isEditing ? (
        <span className="todo-edit-hint" aria-hidden>
          Enter guarda · Esc cancela
        </span>
      ) : (
        <div className="todo-trail">
          <time className="todo-meta" dateTime={when.iso}>
            {when.text}
          </time>
          <span className="todo-actions">
            {list === 'pending' ? (
              <button
                type="button"
                className="icon-btn todo-edit-btn"
                aria-label={`Editar ${short}`}
                title="Editar (doble clic en el texto)"
                onClick={() => onEdit(row)}
              >
                <Pencil size={14} strokeWidth={STROKE} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn todo-del-btn"
              aria-label={`Borrar ${short}`}
              title="Borrar"
              onClick={() => onRemove(row, list)}
            >
              <Trash2 size={14} strokeWidth={STROKE} aria-hidden />
            </button>
          </span>
        </div>
      )}
    </li>
  );
}

function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = '0px';
  el.style.height = `${el.scrollHeight}px`;
}

/** edicion en el lugar: Enter guarda, Shift+Enter salta de linea, Esc cancela (sin cerrar el modal), salir guarda */
function TodoEditor({ initial, onDone }: { initial: string; onDone: (text: string | null, refocus: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const finished = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitHeight(el);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = (value: string | null, refocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value, refocus);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      finish(null, true);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      finish(text, true);
    }
  };

  return (
    <textarea
      ref={ref}
      className="todo-editor"
      aria-label="Editar pendiente"
      rows={1}
      maxLength={NOTE_TEXT_MAX}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        fitHeight(e.target);
      }}
      onKeyDown={onKey}
      onBlur={() => finish(text, false)}
    />
  );
}

// ---------------------------------------------------------------- aviso de deshacer

function UndoToast({
  undo,
  reduced,
  onUndo,
  onExpire,
}: {
  undo: UndoState | null;
  reduced: boolean;
  onUndo: () => void;
  onExpire: () => void;
}) {
  const { shown, leaving } = usePresence(undo, 160);
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const paused = hover || focusIn;
  const expire = useRef(onExpire);
  const remaining = useRef(UNDO_MS);
  const n = undo?.n ?? null;

  useEffect(() => {
    expire.current = onExpire;
  });

  useEffect(() => {
    remaining.current = UNDO_MS;
  }, [n]);

  // cuenta atras de 5 s; se detiene mientras el cursor o el foco estan en el aviso
  useEffect(() => {
    if (n === null || paused) return;
    const started = performance.now();
    const t = window.setTimeout(() => expire.current(), remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [n, paused]);

  if (!shown) return null;
  return (
    <div
      className={`todo-toast ${leaving ? 'is-leaving' : ''}`}
      role="status"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
      }}
    >
      <Trash2 size={14} strokeWidth={STROKE} aria-hidden className="todo-toast-icon" />
      <span className="todo-toast-text">
        Borrado <span className="todo-toast-quote">{quote(shown.text)}</span>
      </span>
      <button type="button" className="btn btn--sm todo-toast-undo" onClick={onUndo} disabled={leaving}>
        <Undo2 size={12} strokeWidth={STROKE} aria-hidden />
        Deshacer
      </button>
      <kbd className="kbd todo-toast-kbd" aria-hidden>
        Ctrl Z
      </kbd>
      {reduced ? null : (
        <i
          key={shown.n}
          aria-hidden
          className="todo-toast-bar"
          style={{ animationDuration: `${UNDO_MS}ms`, animationPlayState: paused || leaving ? 'paused' : 'running' }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- FLIP

/**
 * Cuando una fila sale, entra o cambia de lugar, las demas no saltan: se mueven a su lugar nuevo con
 * transform (FLIP). `scope` cambia con la pestana: entre pestanas no se anima nada.
 */
function useFlip(ref: RefObject<HTMLElement | null>, scope: string, reduced: boolean): void {
  const prev = useRef(new Map<string, number>());
  const prevScope = useRef(scope);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) {
      prev.current = new Map();
      return;
    }
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'));
    // offsetTop: posicion de layout (sin transforms); la raiz es su offsetParent (position: relative)
    const next = new Map<string, number>();
    for (const el of els) next.set(el.dataset.flipKey ?? '', el.offsetTop);
    const animate = !reduced && prevScope.current === scope;
    prevScope.current = scope;
    if (animate) {
      for (const el of els) {
        if (el.dataset.leave) continue;
        const key = el.dataset.flipKey ?? '';
        const before = prev.current.get(key);
        const after = next.get(key);
        if (before === undefined || after === undefined || Math.abs(before - after) < 1) continue;
        // si ya se estaba moviendo, sigue desde donde va (sin salto)
        const running = el.getAnimations().filter((a) => a.id === 'todo-flip');
        const current = running.length > 0 ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : 0;
        for (const a of running) a.cancel();
        const a = el.animate([{ transform: `translateY(${before - after + current}px)` }, { transform: 'translateY(0)' }], {
          duration: 200,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
        a.id = 'todo-flip';
      }
    }
    prev.current = next;
  });
}
