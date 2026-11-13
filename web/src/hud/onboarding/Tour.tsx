import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, UserPen } from 'lucide-react';
import { useOfficeStore } from '@/state/store';
import { STROKE } from '../primitives';
import { isHudKey, restoreFocus, trapTab, useKeysOutside } from './focus';
import { markTourSeen } from './seen';
import { freeArea, placeCard, sameBox, spotBox, unionBox, type Box, type Size } from './tourLayout';
import { pickTourAgent, TOUR_SPOTLIGHT_MIN_WIDTH, tourSteps } from './tourSteps';
import './onboarding.css';

/** tope para esperar a que se monte el panel pedido; su entrada animada se espera aparte (animation.finished) */
const SETTLE_MS = 700;

type TourKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'preventDefault'>;

/**
 * Mini tutorial del HUD: oscurece todo, resalta una zona por paso con un aro ambar y explica para que
 * sirve. No publica su borde en hudInsets (la camara se reencuadraria en cada paso). Al salir deja
 * cerrado el panel del agente que abrio; no toca la preferencia de Flujos.
 */
export function Tour() {
  const open = useOfficeStore((s) => s.tourOpen);
  return open ? <TourLayer /> : null;
}

function readViewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function useViewport(): Size {
  const [size, setSize] = useState(readViewport);
  useEffect(() => {
    const onResize = () =>
      setSize((prev) => {
        const next = readViewport();
        return prev.width === next.width && prev.height === next.height ? prev : next;
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function TourLayer() {
  const demo = useOfficeStore((s) => s.demo);
  const name = useOfficeStore((s) => s.snapshot?.leadName ?? null);
  const rooms = useOfficeStore((s) => s.snapshot?.rooms.length ?? 0);
  const insets = useOfficeStore((s) => s.hudInsets);
  const closeTour = useOfficeStore((s) => s.closeTour);
  const openNameEdit = useOfficeStore((s) => s.openNameEdit);
  const viewport = useViewport();
  const spotlight = viewport.width >= TOUR_SPOTLIGHT_MIN_WIDTH;
  // se elige al abrir: si cambiara con cada snapshot, el panel saltaria de un agente a otro
  const [agentId] = useState(() => pickTourAgent(useOfficeStore.getState().snapshot));
  const [prevSelected] = useState(() => useOfficeStore.getState().selectedAgentId);
  const steps = useMemo(
    () => tourSteps({ name, demo, rooms, agentId, spotlight }),
    [name, demo, rooms, agentId, spotlight],
  );
  const [index, setIndex] = useState(0);
  const last = steps.length - 1;
  const at = Math.min(index, last);
  const step = steps[at]!;
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const go = (delta: number) => setIndex((i) => Math.max(0, Math.min(i + delta, last)));
  const finish = () => {
    markTourSeen();
    closeTour();
  };
  const rename = () => {
    markTourSeen();
    openNameEdit();
  };

  // el paso del panel abre un agente real; al salir de ese paso (o de la guia) vuelve lo que habia
  const opened = useRef(false);
  useEffect(() => {
    const s = useOfficeStore.getState();
    if (step.openAgentId) {
      if (s.selectedAgentId !== step.openAgentId) {
        s.selectAgent(step.openAgentId);
        opened.current = true;
      }
    } else if (opened.current) {
      opened.current = false;
      s.selectAgent(prevSelected);
    }
  }, [step.openAgentId, prevSelected]);
  useEffect(
    () => () => {
      if (!opened.current) return;
      opened.current = false;
      useOfficeStore.getState().selectAgent(prevSelected);
    },
    [prevSelected],
  );

  const [spot, setSpot] = useState<Box | null>(null);
  useEffect(() => {
    const target = step.target;
    if (target.kind === 'none') {
      setSpot(null);
      return;
    }
    let alive = true;
    let observer: ResizeObserver | null = null;
    const observed = new Set<Element>();
    const awaited = new WeakSet<Animation>();
    /** true si encontro el objetivo */
    const measure = (entering: boolean): boolean => {
      if (!alive) return false;
      const vp = readViewport();
      let box: Box | null;
      if (target.kind === 'scene') {
        box = freeArea(useOfficeStore.getState().hudInsets, vp);
      } else {
        // lo que sale (el panel de sala que cede su lugar al del agente) ya no es el objetivo
        const els = Array.from(document.querySelectorAll(target.selector)).filter(
          (el) => !el.classList.contains('is-leaving'),
        );
        for (const el of els) {
          // la entrada del panel lo corre con transform: el ResizeObserver no la ve; se re-mide al terminar
          for (const anim of el.getAnimations?.() ?? []) {
            if (awaited.has(anim)) continue;
            awaited.add(anim);
            anim.finished.then(
              () => measure(false),
              () => measure(false),
            );
          }
          if (observed.has(el)) continue;
          observed.add(el);
          observer?.observe(el);
        }
        box = unionBox(els.map(boxOf));
      }
      // un panel que se acaba de pedir todavia no esta montado: se espera a la medida siguiente
      if (!box && entering) return false;
      const next = box ? spotBox(box, vp) : null;
      setSpot((prev) => (sameBox(prev, next) ? prev : next));
      return box !== null;
    };
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(() => measure(false));
    // el panel se pide en el efecto de arriba y se monta en un render posterior: se busca cuadro a cuadro
    const since = performance.now();
    let frame = 0;
    const poll = () => {
      if (measure(true) || performance.now() - since >= SETTLE_MS) return;
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(poll);
    };
    poll();
    const timer = window.setTimeout(() => measure(false), SETTLE_MS);
    const onResize = () => measure(false);
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [step.target, insets]);

  const [cardSize, setCardSize] = useState<Size>({ width: 0, height: 0 });
  const measureCard = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const next = { width: card.offsetWidth, height: card.offsetHeight };
    setCardSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
  }, []);
  useLayoutEffect(measureCard, [at, measureCard]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureCard);
    observer.observe(card);
    return () => observer.disconnect();
  }, [measureCard]);
  const pos = placeCard(spot, cardSize, viewport);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();
    return () => restoreFocus(previous);
  }, []);
  // el boton con foco pudo desmontarse o quedar deshabilitado (Anterior en el paso 1)
  useEffect(() => {
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) primaryRef.current?.focus();
  }, [at]);

  // Esc y H/A/F no deben llegar a useHudHotkeys: con preventDefault ese handler no hace nada
  const onKey = (event: TourKey) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'Tab') {
      trapTab(event, cardRef.current);
    } else if (isHudKey(event)) {
      event.preventDefault();
    }
  };
  useKeysOutside(cardRef, (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      primaryRef.current?.focus();
    } else {
      onKey(event);
    }
  });

  return (
    <div className="ob-tour">
      {spot ? (
        <div aria-hidden className="ob-spot" style={{ left: spot.x, top: spot.y, width: spot.width, height: spot.height }} />
      ) : (
        <div aria-hidden className="ob-dim" />
      )}
      <section
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onKey}
        className="win ob-card"
        style={{ left: pos.x, top: pos.y }}
        data-step={step.id}
      >
        <header className="win-head scanline ob-card-head">
          <span className="label">
            Paso {at + 1} de {steps.length}
          </span>
          {at < last ? (
            <button type="button" className="link" onClick={finish}>
              Saltar guía
            </button>
          ) : null}
        </header>
        <div className="ob-card-body">
          <h2 id={titleId} className="display ob-card-title">
            {step.title}
          </h2>
          <div id={bodyId} className="ob-card-text">
            {step.body.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </div>
          {step.shortcuts.length > 0 ? (
            <ul className="ob-keys" aria-label="Atajos de teclado">
              {step.shortcuts.map((s) => (
                <li key={s.key}>
                  <kbd className="kbd">{s.key}</kbd>
                  <span>{s.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {step.keys.length > 0 ? (
            <p className="ob-keyline">
              <span className="label">Atajo</span>
              {step.keys.map((key) => (
                <kbd key={key} className="kbd">
                  {key}
                </kbd>
              ))}
            </p>
          ) : null}
          {step.offerDemo ? (
            <a className="link ob-offer" href="?demo=1">
              Ver con datos de ejemplo
            </a>
          ) : null}
          {step.offerRename ? (
            <button type="button" className="btn btn--sm ob-offer" onClick={rename} aria-haspopup="dialog">
              <UserPen size={12} strokeWidth={STROKE} aria-hidden />
              Cambiar mi nombre
            </button>
          ) : null}
        </div>
        <footer className="ob-card-foot">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => go(-1)}
            disabled={at === 0}
            aria-keyshortcuts="ArrowLeft"
          >
            <ArrowLeft size={12} strokeWidth={STROKE} aria-hidden />
            Anterior
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn--sm btn--primary"
            onClick={at === last ? finish : () => go(1)}
            aria-keyshortcuts={at === last ? undefined : 'ArrowRight'}
          >
            {at === last ? 'Terminar' : 'Siguiente'}
            {at === last ? (
              <Check size={12} strokeWidth={STROKE} aria-hidden />
            ) : (
              <ArrowRight size={12} strokeWidth={STROKE} aria-hidden />
            )}
          </button>
        </footer>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          Paso {at + 1} de {steps.length}: {step.title}
        </p>
      </section>
    </div>
  );
}
