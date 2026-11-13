// @vitest-environment node
// Barra de arriba: el plan de recorte (planTopFit) es puro; aqui los anchos salen de una tabla.
import { describe, expect, it } from 'vitest';
import { FIT_STEPS, FIT_THREE_ROWS, FIT_TWO_ROWS, type FitGroup, ONE_ROW_LADDER, planTopFit } from '@/lib/topFit';

// anchos parecidos a los medidos en la oficina 3D con el mes pasado de tope
const WIDTHS: Record<FitGroup, number[]> = {
  view: [474, 337, 274],
  panels: [672, 568, 280],
  money: [789, 690, 600, 456, 253],
};
const GAP = 16;
const widthOf = (group: FitGroup, step: number) => WIDTHS[group][step]!;
const plan = (available: number) => planTopFit(widthOf, available, GAP);

/** ancho minimo que necesita el nivel `level` de una fila */
const oneRowNeed = (level: number) => {
  const c = ONE_ROW_LADDER[level]!;
  return widthOf('view', c.view) + widthOf('money', c.money) + widthOf('panels', c.panels) + 2 * GAP;
};

describe('planTopFit', () => {
  it('con espacio de sobra no recorta nada', () => {
    expect(plan(2560)).toEqual({ level: 0, rows: 1, view: 0, panels: 0, money: 0 });
  });

  it('una fila: recorre los niveles en orden y elige el primero que cabe justo', () => {
    for (let level = 0; level < ONE_ROW_LADDER.length; level++) {
      const need = oneRowNeed(level);
      expect(plan(need), `nivel ${level} con ${need}px`).toEqual({ level, rows: 1, ...ONE_ROW_LADDER[level] });
      // un pixel menos ya no cabe: pasa al siguiente (o a dos filas)
      expect(plan(need - 1).level).toBeGreaterThan(level);
    }
  });

  it('lo decorativo se va antes que el dinero: el dinero solo se recorta con teclas y textos ya fuera', () => {
    for (const cuts of ONE_ROW_LADDER) {
      if (cuts.money > 0) {
        expect(cuts.view).toBe(1);
        expect(cuts.panels).toBe(FIT_STEPS.panels - 1);
      }
    }
    // y en el orden pedido: teclas, textos de la vista, textos de los paneles, tokens, proyeccion, ritmo, barrita
    expect(ONE_ROW_LADDER.map((c) => `${c.view}${c.panels}${c.money}`)).toEqual([
      '000', '010', '110', '120', '121', '122', '123', '124',
    ]);
  });

  it('cuanto mas angosta la franja, mas alto el nivel (nunca baja)', () => {
    let last = 0;
    for (let available = 2600; available >= 200; available -= 7) {
      const { level } = plan(available);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });

  it('dos filas: vista y paneles arriba se recortan juntos; el dinero recupera lo que quepa en su fila', () => {
    // 880: una fila ya no cabe (el nivel 7 pide 902); arriba caben sin textos de los paneles; el dinero entero
    expect(plan(880)).toEqual({ level: FIT_TWO_ROWS, rows: 2, view: 1, panels: 2, money: 0 });
    // 600: arriba solo sin "En vivo"; al dinero le caben hoy, mes y ritmo
    expect(plan(600)).toEqual({ level: FIT_TWO_ROWS, rows: 2, view: 2, panels: 2, money: 2 });
  });

  it('tres filas: cada grupo se recorta por su cuenta; si nada cabe, todo al ultimo escalon', () => {
    expect(plan(560)).toEqual({ level: FIT_THREE_ROWS, rows: 3, view: 0, panels: 2, money: 3 });
    expect(plan(120)).toEqual({ level: FIT_THREE_ROWS, rows: 3, view: 2, panels: 2, money: 4 });
  });

  it('pide los anchos en orden: con medir los tres grupos a la vez bastan cinco mediciones', () => {
    for (const available of [2560, 1500, 1000, 880, 600, 360]) {
      const probes = new Set<number>();
      const cache = new Map<string, number>();
      const measured = (group: FitGroup, step: number) => {
        const key = `${group}${step}`;
        if (!cache.has(key)) {
          // como useFitLevel: una prueba recorta los tres grupos al mismo escalon (cada uno hasta su ultimo)
          probes.add(step);
          for (const g of ['view', 'panels', 'money'] as const) {
            const s = Math.min(step, FIT_STEPS[g] - 1);
            cache.set(`${g}${s}`, widthOf(g, s));
          }
        }
        return cache.get(key)!;
      };
      expect(planTopFit(measured, available, GAP)).toEqual(plan(available));
      expect(probes.size).toBeLessThanOrEqual(FIT_STEPS.money);
    }
  });
});
