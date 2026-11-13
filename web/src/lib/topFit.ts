// Barra de arriba (TopBar): cuanto recorta cada grupo para que los tres quepan en la franja sin montarse.
// Puro: recibe el ancho de cada grupo en cada escalon (lo mide useFitLevel) y decide; no toca el DOM.

/** vista (izquierda) · dinero (centro) · paneles (derecha) */
export type FitGroup = 'view' | 'money' | 'panels';

export type FitRows = 1 | 2 | 3;

/** escalon de recorte de cada grupo; el 0 es el grupo completo */
export interface FitCuts {
  /**
   * 1 sin textos ("Vista ligera", calidad: quedan los iconos con su title) · 2 ademas sin el texto de la conexion
   * ("En vivo", "Sin conexión"…: queda el LED o el icono)
   */
  view: number;
  /** 1 sin teclas · 2 sin textos (queda icono e insignia) */
  panels: number;
  /** 1 sin tokens de hoy · 2 sin proyeccion, salvo la que avisa · 3 sin ritmo · 4 sin barrita ni proyeccion */
  money: number;
}

export interface FitPlan extends FitCuts {
  /** 0-7: una fila (cuanto mas alto, mas recortada) · 8: dos filas · 9: tres filas */
  level: number;
  rows: FitRows;
}

/** cuantos escalones tiene cada grupo */
export const FIT_STEPS: Readonly<Record<FitGroup, number>> = { view: 3, panels: 3, money: 5 };

/** nivel de la franja en dos filas y en tres */
export const FIT_TWO_ROWS = 8;
export const FIT_THREE_ROWS = 9;

/**
 * Una fila, en el orden en que se recorta: primero lo decorativo (teclas, textos de los botones) y el dinero al
 * final (hoy y el mes contra el tope no se recortan nunca).
 */
export const ONE_ROW_LADDER: readonly FitCuts[] = [
  { view: 0, panels: 0, money: 0 }, // todo
  { view: 0, panels: 1, money: 0 }, // sin teclas
  { view: 1, panels: 1, money: 0 }, // sin textos de la vista
  { view: 1, panels: 2, money: 0 }, // sin textos de los paneles
  { view: 1, panels: 2, money: 1 }, // sin tokens de hoy
  { view: 1, panels: 2, money: 2 }, // sin proyeccion (salvo la que avisa)
  { view: 1, panels: 2, money: 3 }, // sin ritmo
  { view: 1, panels: 2, money: 4 }, // sin barrita: queda "NOV $1.666 / $500"
];

/** dos filas: arriba vista y paneles, que se recortan juntos; el dinero tiene la segunda fila para el solo */
const TOP_ROW_LADDER: readonly Omit<FitCuts, 'money'>[] = [
  { view: 0, panels: 0 },
  { view: 0, panels: 1 },
  { view: 1, panels: 1 },
  { view: 1, panels: 2 },
  { view: 2, panels: 2 },
];

/** ancho (px) del grupo con ese escalon de recorte */
export type FitWidthOf = (group: FitGroup, step: number) => number;

/** primer escalon del grupo que cabe en `available`; si ninguno, el ultimo */
function firstStep(group: FitGroup, widthOf: FitWidthOf, available: number): number {
  const last = FIT_STEPS[group] - 1;
  for (let step = 0; step < last; step++) if (widthOf(group, step) <= available) return step;
  return last;
}

/**
 * Plan de la franja. Prueba una fila desde el nivel 0 hacia arriba hasta que la suma de los tres grupos y sus
 * dos separaciones cabe; si ni recortada cabe, pasa a dos filas (vista y paneles arriba, el dinero debajo a lo
 * ancho) y, si arriba tampoco caben juntos, a tres. En varias filas cada fila se recorta por su cuenta: el
 * dinero, con una fila entera, recupera lo que quepa.
 * Pide los anchos en orden creciente de escalon, para que quien mide pueda medir los tres grupos de una vez.
 */
export function planTopFit(widthOf: FitWidthOf, available: number, gap: number): FitPlan {
  for (let level = 0; level < ONE_ROW_LADDER.length; level++) {
    const cuts = ONE_ROW_LADDER[level]!;
    const total = widthOf('view', cuts.view) + widthOf('money', cuts.money) + widthOf('panels', cuts.panels) + 2 * gap;
    if (total <= available) return { level, rows: 1, ...cuts };
  }
  const money = firstStep('money', widthOf, available);
  const top = TOP_ROW_LADDER.find((c) => widthOf('view', c.view) + gap + widthOf('panels', c.panels) <= available);
  if (top) return { level: FIT_TWO_ROWS, rows: 2, ...top, money };
  return {
    level: FIT_THREE_ROWS,
    rows: 3,
    view: firstStep('view', widthOf, available),
    panels: firstStep('panels', widthOf, available),
    money,
  };
}
