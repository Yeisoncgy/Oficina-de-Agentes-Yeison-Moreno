// HUD en vivo montado en jsdom (react-dom): avisador de alertas sin volver a pintar el HUD, banner de alerta
// sin region viva y atajos sin auto-repeticion. Datos sinteticos; sin JSX: el archivo es .ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LiveAlert, OfficeAgent, OfficeRoom, OfficeSnapshot, TokenBreakdown } from '@shared/contract';
import { AlertBanner } from '@/hud/AgentDrawer';
import { useHudHotkeys } from '@/hud/Hud';
import { useAlertNotifications } from '@/hud/useAlertNotifications';
import { useOfficeStore } from '@/state/store';

// react-dom exige declarar el entorno de act()
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tokens = (): TokenBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: id,
    status: 'working',
    task: null,
    action: null,
    model: 'claude-opus-5-5',
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 1,
    ...partial,
  };
}

function office(alert: LiveAlert | null, generatedAt = '2026-09-28T20:00:00Z'): OfficeSnapshot {
  const room: OfficeRoom = {
    id: 'sala-1',
    projectName: 'proyecto-prueba',
    title: 'proyecto-prueba',
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: true,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: agent('sala-1', { kind: 'lead', agentType: 'lead', displayName: 'Ana', deskIndex: 0 }),
    subagents: [agent('ag-1', { displayName: 'Bruno', alert })],
    tokens: tokens(),
    costUsd: 0,
  };
  return {
    generatedAt,
    leadRoomId: 'sala-1',
    rooms: [room],
    today: { costUsd: 0, tokens: tokens() },
    habits: { active: 1, alerts: 1, savingsUsd: 0, notifyBrowser: true },
  };
}

const critical: LiveAlert = { level: 'critical', title: 'Costo $3,40 > $2,00', source: 'rule', ruleId: 'agent_cost' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(element: ReactElement): HTMLDivElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  const r = createRoot(div);
  act(() => r.render(element));
  root = r;
  host = div;
  return div;
}

beforeEach(() => {
  useOfficeStore.setState({ snapshot: null, demo: false, historyOpen: false, historyTab: 'budget', notesRoomId: null });
});

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('avisador de alertas', () => {
  it('avisa sin suscribir al componente: un snapshot nuevo no vuelve a pintar el HUD', () => {
    const created: string[] = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string) {
        created.push(title);
      }
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    // pestana oculta: propiedad propia del document que tapa la del prototipo; se quita al final
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

    let renders = 0;
    function Probe() {
      renders++;
      useAlertNotifications();
      return null;
    }
    render(createElement(Probe));
    expect(renders).toBe(1);

    act(() => useOfficeStore.getState().setSnapshot(office(null)));
    act(() => useOfficeStore.getState().setSnapshot(office(critical, '2026-09-28T20:00:01Z')));
    expect(renders).toBe(1);
    expect(created).toEqual(['Bruno · Sala proyecto-prueba']);

    // la demo no avisa
    act(() => useOfficeStore.setState({ demo: true }));
    act(() =>
      useOfficeStore.getState().setSnapshot(office({ ...critical, title: 'Otra alerta' }, '2026-09-28T20:00:02Z')),
    );
    expect(created).toHaveLength(1);
    expect(renders).toBe(1);
    delete (document as { hidden?: boolean }).hidden;
  });
});

describe('banner de alerta del panel del agente', () => {
  it('no es una region viva: el titulo cambia con el costo y el lector lo releeria en cada snapshot', () => {
    const view = render(createElement(AlertBanner, { alert: critical }));
    const banner = view.querySelector('section.lv-alert');
    expect(banner?.textContent).toContain('Alerta crítica');
    expect(banner?.textContent).toContain('Costo $3,40 > $2,00');
    expect(view.querySelector('[role="status"], [aria-live]')).toBeNull();
  });
});

describe('atajos del HUD', () => {
  function Hotkeys() {
    useHudHotkeys();
    return null;
  }

  const press = (key: string, repeat = false) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true }));
    });

  it('dejar presionada H o A no abre y cierra el historial en cada repeticion', () => {
    render(createElement(Hotkeys));
    press('h');
    expect(useOfficeStore.getState().historyOpen).toBe(true);
    press('h', true);
    press('h', true);
    expect(useOfficeStore.getState().historyOpen).toBe(true);
    press('h');
    expect(useOfficeStore.getState().historyOpen).toBe(false);

    press('a');
    expect(useOfficeStore.getState()).toMatchObject({ historyOpen: true, historyTab: 'habits' });
    press('a', true);
    expect(useOfficeStore.getState().historyOpen).toBe(true);
  });
});
