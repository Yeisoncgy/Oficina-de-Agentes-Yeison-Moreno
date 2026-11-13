import { beforeEach, describe, expect, it } from 'vitest';
import { AMBIENT } from '../src/scene/world/ambient';
import { reportWalker, walkerOpen } from '../src/scene/world/doors';

describe('puertas: se abren solo con un personaje que camina cerca', () => {
  beforeEach(() => {
    AMBIENT.clock = 1000;
  });

  it('sin nadie caminando, la puerta queda cerrada', () => {
    AMBIENT.clock = 2000;
    expect(walkerOpen(5, 5)).toBe(0);
  });

  it('un personaje sobre la puerta la abre del todo', () => {
    reportWalker(10, 10);
    expect(walkerOpen(10, 10)).toBe(1);
  });

  it('a 1 u de distancia abre a la mitad', () => {
    AMBIENT.clock = 1100;
    reportWalker(20, 0);
    expect(walkerOpen(21, 0)).toBeCloseTo(0.5, 5);
  });

  it('lejos de la puerta no la mueve', () => {
    AMBIENT.clock = 1200;
    reportWalker(30, 0);
    expect(walkerOpen(32, 0)).toBe(0);
  });

  it('un aviso viejo (mas de 0,12 s) ya no cuenta', () => {
    AMBIENT.clock = 1300;
    reportWalker(40, 0);
    AMBIENT.clock = 1300.5;
    expect(walkerOpen(40, 0)).toBe(0);
  });
});
