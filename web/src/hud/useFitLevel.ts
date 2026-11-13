// La franja de arriba se adapta a lo que lleva, no al ancho de la ventana: mide sus tres grupos y escribe en
// el DOM cuanto recorta cada uno (data-fit y compania). Las reglas de cada escalon viven en hud/polish.css.
import { useCallback } from 'react';
import { FIT_STEPS, type FitGroup, type FitPlan, planTopFit } from '@/lib/topFit';

const GROUPS: readonly FitGroup[] = ['view', 'money', 'panels'];

function groupOf(strip: HTMLElement, group: FitGroup): HTMLElement | null {
  return strip.querySelector<HTMLElement>(`:scope > .hud-bar--${group}`);
}

function writeCuts(strip: HTMLElement, cuts: Pick<FitPlan, FitGroup>): void {
  for (const group of GROUPS) strip.dataset[group] = String(cuts[group]);
}

/**
 * Mide y decide en una sola pasada, sin estado de React: el nivel queda escrito antes de que se pinte el cuadro,
 * asi la franja no alcanza a verse montada. Cada prueba recorta los tres grupos a la vez (cada uno hasta su
 * ultimo escalon) y un solo reflow da sus tres anchos: a lo sumo cinco mediciones por calculo.
 */
export function fitTopStrip(strip: HTMLElement): FitPlan | null {
  const available = strip.clientWidth;
  if (available <= 0) return null;
  const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
  const els = { view: groupOf(strip, 'view'), money: groupOf(strip, 'money'), panels: groupOf(strip, 'panels') };
  const widths = new Map<string, number>();
  // mientras mide, los grupos van a su ancho natural (en varias filas el dinero se estira a lo ancho)
  strip.dataset.probe = '';
  const widthOf = (group: FitGroup, step: number): number => {
    const key = `${group}${step}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const probe = {
      view: Math.min(step, FIT_STEPS.view - 1),
      panels: Math.min(step, FIT_STEPS.panels - 1),
      money: Math.min(step, FIT_STEPS.money - 1),
    };
    writeCuts(strip, probe);
    for (const g of GROUPS) {
      const el = els[g];
      widths.set(`${g}${probe[g]}`, el ? Math.ceil(el.getBoundingClientRect().width) : 0);
    }
    return widths.get(key) ?? 0;
  };
  const plan = planTopFit(widthOf, available, gap);
  delete strip.dataset.probe;
  writeCuts(strip, plan);
  strip.dataset.rows = String(plan.rows);
  strip.dataset.fit = String(plan.level);
  return plan;
}

/**
 * Ref de la franja. Recalcula cuando cambia el tamano del HUD (ventana), cuando cambia lo que dicen los grupos
 * (cifras, insignias, estado de la conexion) y cuando terminan de cargar las fuentes. El observador de cambios
 * no mira atributos: el propio data-fit no lo vuelve a disparar. El de tamano mira la raiz del HUD, que no
 * cambia con el nivel; asi pasar a dos filas no reabre el calculo.
 */
export function useFitLevel(): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    let alive = true;
    const fit = () => {
      if (alive && el.isConnected) fitTopStrip(el);
    };
    fit();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    resize?.observe(el.parentElement ?? el);
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(fit);
    changes?.observe(el, { childList: true, characterData: true, subtree: true });
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    void fonts?.ready.then(fit);
    fonts?.addEventListener('loadingdone', fit);
    return () => {
      alive = false;
      resize?.disconnect();
      changes?.disconnect();
      fonts?.removeEventListener('loadingdone', fit);
    };
  }, []);
}
