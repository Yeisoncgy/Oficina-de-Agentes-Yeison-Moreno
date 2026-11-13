import type { LiveAlert } from '@shared/contract';

/**
 * Alertas y conteos vivos que el motor de habitos (server/src/habits) le entrega al snapshot. OfficeBuilder
 * solo lee este indice ya calculado: build() corre en cada sweep y en cada lote de ingesta, asi que nada
 * caro puede vivir ahi.
 */
export interface AlertsIndex {
  agent(agentId: string): LiveAlert | null;
  room(sessionId: string): LiveAlert | null;
  /** hallazgos vivos de la sesion (insignia de la sala) */
  habitCount(sessionId: string): number;
  summary(): { active: number; alerts: number; savingsUsd: number; notifyBrowser: boolean };
}

export interface AlertsProvider {
  current(): AlertsIndex;
}

export const EMPTY_ALERTS: AlertsIndex = {
  agent: () => null,
  room: () => null,
  habitCount: () => 0,
  summary: () => ({ active: 0, alerts: 0, savingsUsd: 0, notifyBrowser: false }),
};

export const NO_ALERTS: AlertsProvider = { current: () => EMPTY_ALERTS };
