import { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, EyeOff, Undo2 } from 'lucide-react';
import type { InboxGroup, InboxLevel } from '@shared/contract';
import { copyText } from '@/lib/copy';
import { describeApiError, useDismissInbox, useHabitsInbox, useRestoreInbox } from '@/state/api';
import { STROKE } from '../primitives';

/** "Deshacer" sigue a la vista este tiempo despues de copiar */
const UNDO_MS = 10_000;
const RESTORED_MS = 4_000;

type Outcome =
  /** se copio (o se confirmo la copia a mano) y se pidio el descarte */
  | { kind: 'copied'; level: InboxLevel; keys: string[] }
  /** el navegador no dejo copiar: nada se descarta hasta que el usuario confirme */
  | { kind: 'manual'; level: InboxLevel; keys: string[]; text: string }
  | { kind: 'restored'; level: InboxLevel; count: number };

const COPY_LABEL: Record<InboxLevel, string> = { critical: 'Copiar alertas', warning: 'Copiar avisos' };

/** alerta es femenino y aviso masculino: la terminacion concuerda participio y pronombre (Copiadas... Pegalas) */
function ending(level: InboxLevel, n: number): string {
  if (level === 'critical') return n === 1 ? 'a' : 'as';
  return n === 1 ? 'o' : 'os';
}

function countText(level: InboxLevel, n: number): string {
  const word = level === 'critical' ? 'alerta' : 'aviso';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function copiedMessage(level: InboxLevel, n: number): string {
  const e = ending(level, n);
  return `Copiad${e} ${countText(level, n)}. Pégal${e} en Claude Code.`;
}

function restoredMessage(level: InboxLevel, n: number): string {
  return `Volvi${n === 1 ? 'ó' : 'eron'} ${countText(level, n)} a la lista.`;
}

/**
 * Bandeja (solo En vivo), a la derecha de la cabecera de Habitos: copia todas las alertas o todos los avisos
 * en un texto ordenado para pegar en Claude Code. El server arma el texto y, al copiar, los descarta en todos
 * lados (lista, contadores, rotulos y el "!" de la escena) hasta que salga algo nuevo.
 */
export function AlertsInbox() {
  const query = useHabitsInbox();
  const dismiss = useDismissInbox();
  const restore = useRestoreInbox();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);

  const undoable = outcome?.kind === 'copied' && dismiss.isSuccess;

  // el boton copiado desaparece (0 items) y el foco caeria al body, desde donde Tab sale del historial:
  // pasa a Deshacer y, cuando Deshacer se va, a la bandeja
  const keepFocus = () => {
    if (undoRef.current && document.activeElement === undoRef.current) rootRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!undoable) return;
    const active = document.activeElement;
    if (active === document.body || (active && rootRef.current?.contains(active))) undoRef.current?.focus();
  }, [undoable]);

  useEffect(() => {
    if (!outcome || outcome.kind === 'manual') return;
    const t = window.setTimeout(
      () => {
        keepFocus();
        setOutcome(null);
      },
      outcome.kind === 'copied' ? UNDO_MS : RESTORED_MS,
    );
    return () => window.clearTimeout(t);
  }, [outcome]);

  const data = query.data;
  if (!data) {
    return query.isError ? (
      <p className="inbox-error" role="alert">
        No se pudo leer la bandeja. {describeApiError(query.error)}
      </p>
    ) : null;
  }

  const hide = (level: InboxLevel, keys: string[]) => {
    setOutcome({ kind: 'copied', level, keys });
    dismiss.mutate({ level, keys });
  };

  // llaves y texto se toman al hacer clic: si el refresco trae algo nuevo, eso no se descarta sin copiarlo
  const copy = async (level: InboxLevel, group: InboxGroup) => {
    const keys = group.items.map((i) => i.key);
    const text = group.text;
    if (await copyText(text)) hide(level, keys);
    else setOutcome({ kind: 'manual', level, keys, text });
  };

  const undo = () => {
    if (outcome?.kind !== 'copied' || restore.isPending) return;
    const { level, keys } = outcome;
    restore.mutate(
      { keys },
      {
        onSuccess: () => {
          keepFocus();
          setOutcome({ kind: 'restored', level, count: keys.length });
        },
      },
    );
  };

  let status = '';
  if (outcome?.kind === 'copied') status = copiedMessage(outcome.level, outcome.keys.length);
  else if (outcome?.kind === 'restored') status = restoredMessage(outcome.level, outcome.count);

  return (
    <section ref={rootRef} className="inbox" aria-label="Bandeja para Claude Code" tabIndex={-1}>
      <div className="inbox-actions">
        <CopyButton level="critical" group={data.alerts} primary onCopy={copy} />
        <CopyButton level="warning" group={data.warnings} onCopy={copy} />
      </div>

      <p className="inbox-line">
        <span className="inbox-status" role="status">
          {status}
        </span>
        {undoable ? (
          <button ref={undoRef} type="button" className="btn btn--sm" onClick={undo}>
            <Undo2 size={12} strokeWidth={STROKE} aria-hidden />
            Deshacer
          </button>
        ) : null}
      </p>

      {outcome?.kind === 'manual' ? (
        <div className="inbox-manual">
          <p role="alert">
            El navegador no dejó copiar. Cópialo a mano:
            <code>{outcome.text}</code>
          </p>
          <button type="button" className="btn btn--sm" onClick={() => hide(outcome.level, outcome.keys)}>
            <EyeOff size={12} strokeWidth={STROKE} aria-hidden />
            Ya lo copié, ocultarl{ending(outcome.level, outcome.keys.length)}
          </button>
        </div>
      ) : null}

      {data.dismissed > 0 ? (
        <p className="ui-hint inbox-hidden num">
          {data.dismissed} {data.dismissed === 1 ? 'oculta' : 'ocultas'} hasta que salga algo nuevo
        </p>
      ) : null}
      {outcome?.kind === 'copied' && dismiss.isError ? (
        <p className="inbox-error" role="alert">
          No se ocult{outcome.keys.length === 1 ? 'ó' : 'aron'}. {describeApiError(dismiss.error)}
        </p>
      ) : null}
      {outcome?.kind === 'copied' && restore.isError ? (
        <p className="inbox-error" role="alert">
          No se pudo deshacer. {describeApiError(restore.error)}
        </p>
      ) : null}
    </section>
  );
}

/** sin items no se muestra; copiar dos veces lo mismo es inofensivo (el descarte es idempotente) */
function CopyButton({
  level,
  group,
  primary = false,
  onCopy,
}: {
  level: InboxLevel;
  group: InboxGroup;
  primary?: boolean;
  onCopy: (level: InboxLevel, group: InboxGroup) => Promise<void>;
}) {
  const n = group.items.length;
  if (n === 0) return null;
  return (
    <button
      type="button"
      className={`btn btn--sm ${primary ? 'btn--primary' : ''}`}
      onClick={() => void onCopy(level, group)}
    >
      <ClipboardCopy size={12} strokeWidth={STROKE} aria-hidden />
      {COPY_LABEL[level]} ({n})
    </button>
  );
}
