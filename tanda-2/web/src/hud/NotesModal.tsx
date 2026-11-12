import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRightLeft,
  Check,
  CheckCheck,
  ClipboardCopy,
  Pencil,
  Square,
  SquareCheckBig,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { NOTE_TEXT_MAX, type OfficeRoom, type RoomNote } from '@shared/contract';
import { copyText } from '@/lib/copy';
import { describeApiError } from '@/state/api';
import {
  addNote,
  deleteDoneNotes,
  deleteNote,
  moveNotes,
  notesPrompt,
  pendingNotes,
  roomsBySlot,
  updateNote,
} from '@/state/notesApi';
import { useOfficeStore } from '@/state/store';
import { DURATION } from '@/theme';
import { IconButton, PanelState, STROKE } from './primitives';
import { usePresence } from './usePresence';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Notas de una sala: lo pendiente que sale en una reunion, para pedirselo despues a Claude Code.
 * "Copiar pendientes" arma un texto listo para pegar en el chat. Se abre desde la lista de salas.
 */
export function NotesModal() {
  const roomId = useOfficeStore((s) => s.notesRoomId);
  const { shown, leaving } = usePresence(roomId, DURATION.modalOut);
  if (shown === null) return null;
  return <NotesDialog roomId={shown} leaving={leaving} />;
}

function NotesDialog({ roomId, leaving }: { roomId: string; leaving: boolean }) {
  const room = useOfficeStore((s) => s.snapshot?.rooms.find((r) => r.id === roomId) ?? null);
  const demo = useOfficeStore((s) => s.demo);
  const close = useOfficeStore((s) => s.closeNotes);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (dialogRef.current?.querySelector<HTMLElement>('textarea') ?? dialogRef.current)?.focus();
    return () => previous?.focus();
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
          aria-labelledby="notes-title"
          tabIndex={-1}
          onKeyDown={trapFocus}
          className={`modal notes-modal ${leaving ? 'is-leaving' : ''}`}
        >
          <header className="modal-head notes-head scanline">
            <StickyNote size={18} strokeWidth={STROKE} aria-hidden className="notes-head-icon" />
            <div className="notes-head-text">
              <h2 id="notes-title" className="modal-title display">
                Notas
              </h2>
              {room ? (
                <span className="notes-room" title={room.cwd || undefined}>
                  {room.title}
                </span>
              ) : null}
            </div>
            <div className="modal-close">
              <kbd className="kbd">Esc</kbd>
              <IconButton label="Cerrar (Esc)" onClick={close}>
                <X size={16} strokeWidth={STROKE} />
              </IconButton>
            </div>
          </header>
          {demo ? (
            <div className="modal-body">
              <PanelState
                kind="empty"
                title="Las notas necesitan el servidor"
                text="En modo demo los datos son simulados en el navegador. Con npm run dev corriendo puedes dejarle notas a cada sala."
              />
            </div>
          ) : !room || !room.projectKey ? (
            <div className="modal-body">
              <PanelState
                kind="empty"
                title="Esta sala ya no está en la oficina"
                text="Las notas quedan guardadas en la sala y vuelven a aparecer cuando la sala regrese a la oficina."
              />
            </div>
          ) : (
            <NotesBody room={room} projectKey={room.projectKey} />
          )}
        </section>
      </div>
    </>
  );
}

function NotesBody({ room, projectKey }: { room: OfficeRoom; projectKey: string }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const notes = room.notes ?? [];
  const pending = pendingNotes(room);
  const done = notes.filter((n) => n.done);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2_500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(describeApiError(err));
      return false;
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    const ok = await run(() => addNote(projectKey, text));
    setSaving(false);
    if (ok) setDraft('');
  };

  const onDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const copy = async () => {
    const ok = await copyText(notesPrompt(room));
    if (ok) setCopied(true);
    else setError('El navegador no dejó copiar. Selecciona el texto de las notas y cópialo a mano.');
  };

  const markAllDone = () => void run(() => Promise.all(pending.map((n) => updateNote(n.id, { done: true }))));

  return (
    <>
      <div className="modal-body notes-body">
        <div className="notes-compose">
          <label htmlFor="notes-draft" className="label">
            Nuevo pendiente
          </label>
          <textarea
            id="notes-draft"
            className="notes-input"
            rows={3}
            maxLength={NOTE_TEXT_MAX}
            placeholder="Ej.: cambiar el filtro de fechas del reporte a mes contable"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
          />
          <div className="notes-compose-foot">
            <button type="button" className="btn btn--sm" onClick={() => void submit()} disabled={!draft.trim() || saving}>
              <Check size={12} strokeWidth={STROKE} aria-hidden />
              Agregar
            </button>
          </div>
        </div>

        {error ? (
          <p className="inline-error notes-error" role="alert">
            {error}
          </p>
        ) : null}

        {notes.length === 0 ? (
          <PanelState
            kind="empty"
            title="Sin notas en esta sala"
            text="Escribe lo que salga en la reunión. Luego copias los pendientes y los pegas en el chat de Claude Code."
          />
        ) : (
          <>
            <section aria-labelledby="notes-pending-title" className="notes-section">
              <h3 id="notes-pending-title" className="label notes-section-title">
                Pendientes · {pending.length}
              </h3>
              {pending.length === 0 ? (
                <p className="notes-empty">No queda nada pendiente.</p>
              ) : (
                <ol className="notes-list m-0 list-none">
                  {pending.map((note, i) => (
                    <NoteItem key={note.id} note={note} index={i + 1} run={run} />
                  ))}
                </ol>
              )}
            </section>
            {done.length > 0 ? (
              <section aria-labelledby="notes-done-title" className="notes-section">
                <div className="notes-section-head">
                  <h3 id="notes-done-title" className="label notes-section-title">
                    Hechas · {done.length}
                  </h3>
                  <button type="button" className="btn btn--sm" onClick={() => void run(() => deleteDoneNotes(projectKey))}>
                    <Trash2 size={12} strokeWidth={STROKE} aria-hidden />
                    Borrar hechas
                  </button>
                </div>
                <ul className="notes-list m-0 list-none">
                  {done.map((note) => (
                    <NoteItem key={note.id} note={note} index={null} run={run} />
                  ))}
                </ul>
              </section>
            ) : null}
            <MoveNotes room={room} projectKey={projectKey} count={notes.length} run={run} />
          </>
        )}
      </div>
      <footer className="notes-foot">
        <span className="notes-foot-text" role="status">
          {copied
            ? 'Copiado. Pégalo en el chat de Claude Code.'
            : pending.length > 0
              ? `${pending.length} ${pending.length === 1 ? 'pendiente' : 'pendientes'} para copiar`
              : 'Sin pendientes para copiar'}
        </span>
        {copied && pending.length > 0 ? (
          <button type="button" className="btn btn--sm" onClick={markAllDone}>
            <CheckCheck size={12} strokeWidth={STROKE} aria-hidden />
            Marcar como hechas
          </button>
        ) : null}
        <button type="button" className="btn btn--primary" onClick={() => void copy()} disabled={pending.length === 0}>
          <ClipboardCopy size={14} strokeWidth={STROKE} aria-hidden />
          Copiar pendientes
        </button>
      </footer>
    </>
  );
}

/** Notas que quedaron en la sala equivocada: pasan todas a otra sala y el modal la sigue */
function MoveNotes({
  room,
  projectKey,
  count,
  run,
}: {
  room: OfficeRoom;
  projectKey: string;
  count: number;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const rooms = useOfficeStore((s) => s.snapshot?.rooms);
  const openNotes = useOfficeStore((s) => s.openNotes);
  const [targetId, setTargetId] = useState('');
  const [moving, setMoving] = useState(false);
  const others = roomsBySlot(rooms ?? []).filter((r) => r.id !== room.id && r.projectKey);
  if (others.length === 0) return null;
  const target = others.find((r) => r.id === targetId) ?? null;

  const move = async () => {
    if (!target?.projectKey || moving) return;
    setMoving(true);
    const ok = await run(() => moveNotes(projectKey, target.projectKey ?? ''));
    setMoving(false);
    if (ok) openNotes(target.id);
  };

  return (
    <div className="notes-move">
      <label htmlFor="notes-move-target" className="label">
        Mover {count === 1 ? 'la nota' : `las ${count} notas`} a otra sala
      </label>
      <div className="notes-move-row">
        <select
          id="notes-move-target"
          className="notes-move-select"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={moving}
        >
          <option value="">Elegir sala…</option>
          {others.map((r) => (
            <option key={r.id} value={r.id}>
              {r.customName && r.autoTitle && r.autoTitle !== r.title ? `${r.title} · ${r.autoTitle}` : r.title}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn--sm" onClick={() => void move()} disabled={!target || moving}>
          <ArrowRightLeft size={12} strokeWidth={STROKE} aria-hidden />
          Mover
        </button>
      </div>
    </div>
  );
}

function NoteItem({
  note,
  index,
  run,
}: {
  note: RoomNote;
  /** numero con el que sale al copiar; null en las hechas */
  index: number | null;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);

  const startEdit = () => {
    setText(note.text);
    setEditing(true);
  };

  const save = async () => {
    const clean = text.trim();
    if (!clean) return;
    if (clean === note.text) {
      setEditing(false);
      return;
    }
    if (await run(() => updateNote(note.id, { text: clean }))) setEditing(false);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // cancela la edicion sin cerrar el modal
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      setEditing(false);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <li className={`notes-item ${note.done ? 'is-done' : ''}`}>
      <button
        type="button"
        className="notes-check"
        aria-pressed={note.done}
        aria-label={note.done ? 'Volver a pendiente' : 'Marcar como hecha'}
        title={note.done ? 'Volver a pendiente' : 'Marcar como hecha'}
        onClick={() => void run(() => updateNote(note.id, { done: !note.done }))}
      >
        {note.done ? (
          <SquareCheckBig size={16} strokeWidth={STROKE} aria-hidden />
        ) : (
          <Square size={16} strokeWidth={STROKE} aria-hidden />
        )}
      </button>
      {index !== null ? <span className="notes-num num">{index}.</span> : null}
      {editing ? (
        <div className="notes-edit">
          <textarea
            className="notes-input"
            aria-label="Editar nota"
            rows={Math.min(8, Math.max(2, text.split('\n').length))}
            maxLength={NOTE_TEXT_MAX}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="notes-edit-actions">
            <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={!text.trim()}>
              Guardar
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="notes-text" onDoubleClick={note.done ? undefined : startEdit}>
            {note.text}
          </p>
          <span className="notes-actions">
            {note.done ? null : (
              <IconButton label="Editar" onClick={startEdit}>
                <Pencil size={14} strokeWidth={STROKE} />
              </IconButton>
            )}
            <IconButton label="Borrar" onClick={() => void run(() => deleteNote(note.id))}>
              <Trash2 size={14} strokeWidth={STROKE} />
            </IconButton>
          </span>
        </>
      )}
    </li>
  );
}
