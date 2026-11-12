import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { UserPen, X } from 'lucide-react';
import { cleanLeadName } from '@shared/agents';
import { LEAD_NAME_MAX } from '@shared/contract';
import { useSaveLeadName } from '@/state/leadName';
import { useOfficeStore } from '@/state/store';
import { PixelLogo } from '../PixelArt';
import { IconButton, STROKE } from '../primitives';
import { isHudKey, restoreFocus, trapTab, useKeysOutside } from './focus';
import './onboarding.css';

export type WelcomeMode = 'first' | 'edit';

/**
 * Nombre del lead. first: primer arranque (el snapshot trae leadName null); no se cierra con Esc ni con un
 * clic afuera, y se va solo cuando el snapshot trae el nombre: lo copia la respuesta del PUT o lo trae el SSE,
 * lo que llegue primero. edit: cambiarlo despues, con Cancelar.
 */
export function Welcome({ mode }: { mode: WelcomeMode }) {
  const current = useOfficeStore((s) => s.snapshot?.leadName ?? null);
  const closeNameEdit = useOfficeStore((s) => s.closeNameEdit);
  const [value, setValue] = useState(() => (mode === 'edit' ? (current ?? '') : ''));
  const { save, busy, error, clearError } = useSaveLeadName();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const introId = useId();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const first = mode === 'first';
  const clean = cleanLeadName(value);
  const unchanged = !first && clean === current;
  const close = () => {
    if (!first) closeNameEdit();
  };

  // se toma al renderizar: para cuando corre un efecto, autoFocus ya movio el foco al campo
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => () => restoreFocus(previous), [previous]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!clean || busy || unchanged) return;
    const saved = await save(clean);
    if (saved && !first) closeNameEdit();
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      // en el primer arranque Esc no cierra, pero tampoco debe cerrar paneles de atras
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      trapTab(event, dialogRef.current);
      return;
    }
    // H, A y F abririan paneles detras del dialogo; escribiendo en el campo son letras
    if (isHudKey(event) && event.target !== inputRef.current) event.preventDefault();
  };

  useKeysOutside(dialogRef, (event) => {
    if (!isHudKey(event)) return;
    event.preventDefault();
    if (event.key === 'Escape') close();
    else inputRef.current?.focus();
  });

  return (
    <>
      <div aria-hidden className="scrim ob-scrim" onClick={close} />
      <div className="modal-wrap ob-wrap">
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={first ? introId : hintId}
          tabIndex={-1}
          onKeyDown={onKey}
          className="modal ob-welcome"
        >
          <header className="modal-head ob-welcome-head scanline">
            <PixelLogo size={40} />
            <h2 id={titleId} className="modal-title display">
              {first ? 'Bienvenido a Colmena' : 'Cambiar tu nombre'}
            </h2>
            {first ? null : (
              <div className="modal-close">
                <kbd className="kbd">Esc</kbd>
                <IconButton label="Cancelar (Esc)" onClick={close}>
                  <X size={16} strokeWidth={STROKE} />
                </IconButton>
              </div>
            )}
          </header>
          <form className="modal-body ob-welcome-body" onSubmit={(event) => void onSubmit(event)} noValidate>
            {first ? (
              <p id={introId} className="ob-lead">
                Tus agentes de Claude Code, trabajando en vivo.
              </p>
            ) : null}
            <div className="ob-field">
              <label htmlFor={inputId} className="label">
                ¿Cómo te llamas?
              </label>
              <input
                ref={inputRef}
                id={inputId}
                className="ob-input"
                type="text"
                autoFocus
                autoComplete="given-name"
                spellCheck={false}
                maxLength={LEAD_NAME_MAX}
                placeholder="Tu nombre"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) clearError();
                }}
                aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                aria-invalid={error ? true : undefined}
              />
              <p id={hintId} className="ob-hint">
                {first ? 'Puedes cambiarlo después.' : 'Sale en tu escritorio.'}
              </p>
              {error ? (
                <p id={errorId} className="ob-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="ob-actions">
              {first ? null : (
                <button type="button" className="btn" onClick={close}>
                  Cancelar
                </button>
              )}
              <button type="submit" className="btn btn--primary" disabled={!clean || busy || unchanged}>
                {busy ? 'Guardando…' : first ? 'Empezar' : 'Guardar'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

/** Junto al nombre del lider en su panel. Sin server (demo) no hay donde guardar: no se muestra */
export function ChangeNameButton() {
  const demo = useOfficeStore((s) => s.demo);
  const openNameEdit = useOfficeStore((s) => s.openNameEdit);
  if (demo) return null;
  return (
    <IconButton label="Cambiar mi nombre" className="ob-rename" onClick={openNameEdit} aria-haspopup="dialog">
      <UserPen size={14} strokeWidth={STROKE} />
    </IconButton>
  );
}
