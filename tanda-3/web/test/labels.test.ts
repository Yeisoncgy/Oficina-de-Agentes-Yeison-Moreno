import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { roomIdentity } from '@/lib/roomIdentity';
import { ZOOM_MID, ZOOM_NEAR, zoomLevel } from '@/scene/CameraRig';
import { RoomPlaque } from '@/scene/labels';
import { useOfficeStore } from '@/state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('detalle de las etiquetas segun el zoom', () => {
  it('con varias salas en pantalla van en pastilla; la tarjeta completa solo de cerca', () => {
    // 6 salas o mas (~50 px por unidad): solo el nombre
    expect(zoomLevel(50)).toBe('far');
    expect(zoomLevel(ZOOM_MID - 1)).toBe('far');
    // 4 salas (~85) y una sala enfocada (~115-145): nombre y cronometro
    expect(zoomLevel(85)).toBe('mid');
    expect(zoomLevel(145)).toBe('mid');
    // de cerca: tarjeta completa
    expect(zoomLevel(ZOOM_NEAR)).toBe('near');
    expect(zoomLevel(300)).toBe('near');
  });
});

describe('puntero sobre un agente', () => {
  afterEach(() => useOfficeStore.setState({ hoveredAgentId: null }));

  it('salir de un agente no apaga al que ya tomo el puntero', () => {
    const { hoverAgent } = useOfficeStore.getState();
    hoverAgent('a');
    hoverAgent('b');
    // llega tarde el "salio de a": b sigue desplegado
    hoverAgent(null, 'a');
    expect(useOfficeStore.getState().hoveredAgentId).toBe('b');
    hoverAgent(null, 'b');
    expect(useOfficeStore.getState().hoveredAgentId).toBeNull();
  });
});

describe('rotulo de sala en el piso', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  type PlaqueProps = Parameters<typeof RoomPlaque>[0];
  const base: PlaqueProps = { title: 'Fase 2', closed: false, busy: false, lastActivityAt: null, onFocus: () => {} };

  function plaque(props: Partial<PlaqueProps> = {}): HTMLElement {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(createElement(RoomPlaque, { ...base, ...props })));
    const el = host.querySelector<HTMLElement>('.ofc-plaque');
    if (!el) throw new Error('no se monto el rotulo');
    return el;
  }

  it('con identidad lleva la chapita con el numero en el color de la sala', () => {
    const identity = roomIdentity({ slot: 2 });
    const el = plaque({ identity });
    expect(el.querySelector('.ofc-plaque-num')?.textContent).toBe('03');
    expect(el.style.getPropertyValue('--room-accent')).toBe(identity.accent);
    // el LED de estado se queda y la etiqueta accesible dice el numero
    expect(el.querySelector('.ofc-led')).not.toBeNull();
    expect(el.getAttribute('aria-label')).toMatch(/^Sala 3, Fase 2/);
    expect(el.classList.contains('is-selected')).toBe(false);
  });

  it('sin identidad sigue igual: sin chapita ni color propio', () => {
    const el = plaque();
    expect(el.querySelector('.ofc-plaque-num')).toBeNull();
    expect(el.style.getPropertyValue('--room-accent')).toBe('');
    expect(el.getAttribute('aria-label')).toMatch(/^Sala Fase 2/);
  });

  it('seleccionada marca el rotulo; inactiva sigue diciendolo en la etiqueta accesible', () => {
    const lastActivityAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const el = plaque({ identity: roomIdentity({ slot: 0 }), selected: true, lastActivityAt });
    expect(el.classList.contains('is-selected')).toBe(true);
    expect(el.getAttribute('aria-current')).toBe('true');
    expect(el.classList.contains('is-inactive')).toBe(true);
    expect(el.getAttribute('aria-label')).toContain(', inactiva');
    // la palabra queda para el puntero o de cerca (CSS): la insignia existe, marcada como de estado
    expect(el.querySelector('.ofc-badge.is-state')?.textContent).toBe('Inactiva');
  });
});
