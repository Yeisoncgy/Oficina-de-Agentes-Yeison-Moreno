// Etiquetas HTML sobre la escena (texto nitido, no pixelado): tarjeta de agente, cartel de sala,
// cargador y aviso sin WebGL. Se montan dentro de <Html> de drei, en su propia raiz de React:
// aqui no se usan hooks de R3F.
//
// Tarjeta (D3 + D2 "etiqueta del mundo"): cuelga de un hilo ambar con remache. Poco texto sobre la escena
// (decision de diseno): segun el zoom (data-zoom en la raiz de la escena) far = pastilla con el nombre,
// mid = pastilla con nombre y cronometro, near (una sala de cerca) = tarjeta completa. Pasar el puntero por
// el agente, su escritorio (is-hot) o la pastilla la despliega completa, con el desglose de tokens.
// Seleccionada lleva contorno ambar mientras el panel esta abierto.

import { type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, useRef, useState } from 'react';
import type { LiveAlert, OfficeAgent } from '@shared/contract';
import { elapsedMs, formatClock, formatTimeOfDay, formatTokens, formatUsdOrUnpriced } from '@/lib/format';
import { MODEL_FAMILY_COLOR, modelFamily, modelLabel } from '@/lib/models';
import { cardEnterDelay, phaseDelay } from '@/lib/motion';
import { ROOM_INACTIVE_AFTER_MS, tokenSegments } from '@/lib/office';
import type { RoomIdentity } from '@/lib/roomIdentity';
import { ROLE_LABEL } from '@/lib/workflows';
import { useOfficeStore } from '@/state/store';
import { agentColor, DURATION, EASE, FONTS, lookKey, PALETTE, STATE, UI } from '@/theme';
import { useNow } from './useTicker';

const FRAME_OUTER = UI.frameOuter;

/** marco de etiqueta del mundo (D2 --frame-label): borde escalonado de 2 px + aro de tinta */
const frameLabel = (color: string) =>
  `0 -2px 0 0 ${color}, 0 2px 0 0 ${color}, -2px 0 0 0 ${color}, 2px 0 0 0 ${color}, 0 0 0 4px ${FRAME_OUTER}`;

/** etiqueta sin el puntero encima (ni en la escena ni sobre ella) */
const RESTING = '.ofc-pin:not(.is-hot):not(:has(.ofc-card:hover))';
/** en pastilla: vista general o caminando */
const CHIP = `:is([data-office-scene]:is([data-zoom="far"], [data-zoom="mid"]) ${RESTING}, [data-office-scene] .ofc-anchor[data-pose="walk"] ${RESTING})`;
/** pastilla solo con el nombre, sin cronometro */
const BARE = `:is([data-office-scene][data-zoom="far"] ${RESTING}, [data-office-scene] .ofc-anchor[data-pose="walk"] ${RESTING})`;

/** estilos de las etiquetas; el nivel de zoom llega como data-zoom en la raiz de la escena */
export const SCENE_CSS = `
[data-office-scene] .ofc-anchor { pointer-events: none; }

/* ---------- tarjeta del agente ---------- */
/* el hilo mide lo mismo en pastilla y en tarjeta: el borde de abajo no se mueve al desplegarla y el puntero
   no se sale (si no, parpadea) */
.ofc-pin { position: relative; width: 0; height: 0; --ofc-line: 10px; }
.ofc-line {
  position: absolute; left: -1px; bottom: 0; width: 2px; height: var(--ofc-line);
  background: ${UI.accent}; opacity: 0.7;
  transition: height ${DURATION.cardLevel}ms ${EASE.change}, opacity ${DURATION.hover}ms linear;
  animation: ofc-fade ${DURATION.cardIn}ms linear backwards; animation-delay: var(--ofc-delay, 0ms);
}
.ofc-foot {
  position: absolute; left: -3px; bottom: -3px; width: 6px; height: 6px; background: ${UI.accent};
  box-shadow: 0 0 0 1px ${FRAME_OUTER};
  animation: ofc-fade ${DURATION.cardIn}ms linear backwards; animation-delay: var(--ofc-delay, 0ms);
}
.ofc-pin.is-selected .ofc-line { opacity: 1; }

.ofc-card {
  --frame: ${UI.border};
  position: absolute; left: 0; bottom: var(--ofc-line);
  box-sizing: border-box; width: 196px;
  translate: -50% 0;
  interpolate-size: allow-keywords;
  background: ${UI.panelGlass}; color: ${UI.text};
  font-family: ${FONTS.mono}; font-size: 11px; line-height: 1.35; font-variant-numeric: tabular-nums;
  pointer-events: auto; cursor: pointer; user-select: none;
  box-shadow: ${frameLabel('var(--frame)')}, 0 4px 0 4px rgb(8 6 24 / 0.5);
  transform-origin: 50% 100%;
  transition:
    width ${DURATION.cardLevel}ms ${EASE.change},
    bottom ${DURATION.cardLevel}ms ${EASE.change},
    transform ${DURATION.hover}ms ${EASE.arrive},
    box-shadow ${DURATION.hover}ms ${EASE.arrive};
  animation: ofc-card-in ${DURATION.cardIn}ms ${EASE.bounce} backwards;
  animation-delay: var(--ofc-delay, 0ms);
}
/* puente sensible hasta el ancla: cubre el hilo y los 2 px que sube con el hover */
.ofc-card::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: calc(var(--ofc-line) + 2px); }
.ofc-card:hover { --frame: ${UI.textMuted}; transform: translateY(-2px); }
.ofc-card:active { transform: scale(0.97); transition-duration: ${DURATION.press}ms; }
.ofc-card:focus-visible { outline: 2px solid ${UI.focus}; outline-offset: 6px; }
.ofc-pin.is-selected .ofc-card {
  --frame: ${UI.accent};
  box-shadow: ${frameLabel('var(--frame)')}, 0 0 0 7px rgb(245 169 74 / 0.3), 0 0 28px rgb(245 169 74 / 0.28);
}
.ofc-pin.is-done .ofc-card { background: rgb(20 19 43 / 0.88); }

.ofc-head {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px 5px; white-space: nowrap;
  box-shadow: inset 0 -2px 0 0 ${UI.borderSubtle};
  transition: box-shadow ${DURATION.cardLevel}ms linear;
}
.ofc-swatch { flex: none; width: 8px; height: 8px; background: var(--ag); box-shadow: 0 0 0 1px ${FRAME_OUTER}; }
.ofc-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-family: ${FONTS.display}; font-size: 16px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ag); -webkit-font-smoothing: none;
}
.ofc-st { display: none; flex: none; width: 6px; height: 6px; margin-left: 2px; background: var(--st); }
.ofc-pin.is-working .ofc-st, .ofc-pin.is-working .ofc-led {
  animation: ofc-blink 1200ms steps(2, jump-none) infinite; animation-delay: var(--ofc-phase, 0ms);
}
.ofc-timer { flex: none; margin-left: auto; padding-left: 6px; font-size: 16px; font-weight: 700; line-height: 1; color: ${UI.text}; }
.ofc-pin.is-idle .ofc-timer { color: ${UI.textSecondary}; }
.ofc-pin.is-done .ofc-timer { color: ${UI.textMuted}; }

/* pliegues animables: alto por grid-template-rows, el texto nuevo aparece en la segunda mitad */
.ofc-fold {
  display: grid; grid-template-rows: 1fr;
  transition: grid-template-rows ${DURATION.cardLevel}ms ${EASE.change};
}
.ofc-fold > div {
  min-height: 0; overflow: hidden; opacity: 1;
  transition: opacity ${DURATION.cardLevel / 2}ms linear ${DURATION.cardLevel / 2}ms;
}
.ofc-fold--hover { grid-template-rows: 0fr; }
.ofc-fold--hover > div { opacity: 0; transition-delay: 0ms; }
.ofc-card:hover .ofc-fold--hover { grid-template-rows: 1fr; }
.ofc-card:hover .ofc-fold--hover > div { opacity: 1; transition-delay: ${DURATION.cardLevel / 2}ms; }

.ofc-body { display: flex; flex-direction: column; gap: 3px; padding: 5px 8px 7px; }
.ofc-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: ${UI.textSecondary}; }
.ofc-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ofc-model {
  display: inline-flex; flex: none; align-items: center; gap: 4px; height: 16px; padding: 0 5px 0 4px;
  font-size: 10px; font-weight: 700; line-height: 1; white-space: nowrap;
  color: color-mix(in srgb, var(--fam) 62%, ${UI.text});
  background: color-mix(in srgb, var(--fam) 14%, ${UI.panel});
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fam) 45%, transparent);
}
.ofc-model::before { content: ''; flex: none; width: 5px; height: 5px; background: var(--fam); }
.ofc-role {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; color: ${UI.textMuted};
}
.ofc-action { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--st); }
.ofc-action.is-new { animation: ofc-action-in ${DURATION.actionIn}ms ${EASE.arrive} 80ms backwards, ofc-flash ${DURATION.actionFlash}ms linear; }
.ofc-action svg { flex: none; }
.ofc-led { flex: none; width: 6px; height: 6px; background: currentColor; }
.ofc-action-label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ofc-action-time { flex: none; color: ${UI.textMuted}; }
.ofc-foot-row { display: flex; justify-content: space-between; gap: 8px; color: ${UI.textMuted}; }
.ofc-usd { font-weight: 700; color: ${UI.accent}; }
.ofc-usd.is-unpriced { font-weight: 400; color: ${UI.textMuted}; }
.ofc-breakdown {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; margin-top: 3px; padding-top: 5px;
  box-shadow: inset 0 2px 0 0 ${UI.borderSubtle}; font-size: 10px;
}
.ofc-bd { display: flex; justify-content: space-between; gap: 4px; color: ${UI.textMuted}; }
.ofc-bd b { font-weight: 700; color: ${UI.textSecondary}; }

/* pastilla (vista general y caminando): LED + nombre (+ cronometro en mid). Pasar el puntero por el agente,
   su escritorio o la pastilla la despliega en la tarjeta completa. */
${CHIP} .ofc-foot { opacity: 0; }
${CHIP} .ofc-card {
  width: auto; max-width: 148px;
  background: rgb(14 12 34 / 0.8);
  box-shadow: 0 0 0 1px var(--frame), 0 2px 0 1px rgb(8 6 24 / 0.45);
}
${CHIP}.is-selected .ofc-card { box-shadow: 0 0 0 2px ${UI.accent}, 0 0 14px rgb(245 169 74 / 0.35); }
${CHIP}.is-done .ofc-card { opacity: 0.72; }
${CHIP} .ofc-head { gap: 5px; padding: 3px 6px 3px 5px; box-shadow: none; }
${CHIP} .ofc-swatch { display: none; }
${CHIP} .ofc-st { display: block; order: -1; margin-left: 0; }
${CHIP} .ofc-name {
  font-family: ${FONTS.mono}; font-size: 11px; line-height: 13px; font-weight: 700; letter-spacing: 0.08em;
  -webkit-font-smoothing: antialiased;
}
${CHIP} .ofc-timer { padding-left: 3px; font-size: 11px; line-height: 13px; color: ${UI.textSecondary}; }
${CHIP} .ofc-fold--mid { grid-template-rows: 0fr; contain: inline-size; }
${CHIP} .ofc-fold--mid > div { opacity: 0; transition-delay: 0ms; }
${BARE} .ofc-timer { display: none; }

/* ---------- rotulo de sala: en el piso, delante de los escritorios, una sola linea ---------- */
.ofc-plaque {
  --frame: color-mix(in srgb, ${PALETTE.dusk} 70%, ${UI.accent});
  display: flex; align-items: center; gap: 6px;
  box-sizing: border-box; max-width: 230px; height: 20px; padding: 0 8px 0 7px;
  translate: -50% -50%;
  background: rgb(14 12 34 / 0.74); color: ${UI.accent};
  font-family: ${FONTS.mono}; font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: 0.1em;
  text-transform: uppercase; -webkit-font-smoothing: antialiased;
  pointer-events: auto; cursor: pointer; user-select: none; white-space: nowrap;
  box-shadow: 0 0 0 1px var(--frame), 0 2px 0 1px rgb(8 6 24 / 0.4);
  transition: box-shadow ${DURATION.hover}ms ${EASE.arrive}, transform ${DURATION.hover}ms ${EASE.arrive};
  animation: ofc-plaque-in 320ms ${EASE.arrive} backwards;
}
.ofc-plaque:hover { --frame: var(--room-accent, ${UI.accent}); max-width: 420px; transform: translateY(-1px); }
.ofc-plaque:focus-visible { outline: 2px solid ${UI.focus}; outline-offset: 4px; }
.ofc-plaque.is-closed { --frame: ${UI.border}; color: ${UI.textMuted}; background: rgb(14 12 34 / 0.6); }
.ofc-plaque-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ofc-plaque-sub {
  display: none; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-weight: 400; letter-spacing: 0.02em; text-transform: none; color: ${UI.textMuted};
}
.ofc-plaque:hover .ofc-plaque-sub, [data-office-scene][data-zoom="near"] .ofc-plaque-sub { display: block; }
/* chapita con el numero de la sala sobre su color (roomIdentity): el mismo que en la lista y el panel */
.ofc-plaque-num {
  flex: none; box-sizing: border-box; min-width: 16px; height: 14px; padding: 0 2px; margin-left: -3px;
  display: grid; place-items: center;
  background: var(--room-accent); color: ${UI.onAccent};
  font-size: 10px; letter-spacing: 0; line-height: 1;
  box-shadow: inset 0 -2px 0 rgb(8 6 24 / 0.28);
}
.ofc-plaque.is-closed .ofc-plaque-num, .ofc-plaque.is-inactive .ofc-plaque-num { opacity: 0.6; }
/* Inactiva / Cerrada: el LED hueco (o su ausencia) y el tono apagado ya lo dicen de lejos; la palabra, con el
   puntero o de cerca */
.ofc-badge.is-state { display: none; }
.ofc-plaque:hover .ofc-badge.is-state, [data-office-scene][data-zoom="near"] .ofc-badge.is-state { display: block; }
.ofc-plaque .ofc-led { width: 6px; height: 6px; color: ${STATE.working}; }
.ofc-plaque.is-busy .ofc-led { animation: ofc-blink 1200ms steps(2, jump-none) infinite; animation-delay: var(--ofc-phase, 0ms); }
.ofc-plaque.is-calm .ofc-led { color: ${STATE.idle}; }
.ofc-plaque.is-inactive { --frame: ${UI.border}; color: ${UI.textSecondary}; background: rgb(14 12 34 / 0.64); }
.ofc-plaque.is-inactive .ofc-led { color: ${STATE.offline}; background: none; box-shadow: inset 0 0 0 1px currentColor; }
.ofc-badge {
  flex: none; padding: 2px 4px; font-family: ${FONTS.mono}; font-size: 9px; font-weight: 700; line-height: 1;
  letter-spacing: 0.14em; text-transform: uppercase; background: ${UI.panelSunken}; color: ${UI.textSecondary};
  box-shadow: inset 0 0 0 1px ${UI.border};
}
/* sala con el panel abierto: marco de 2 px en su color (el contorno del piso hace lo mismo en la escena) */
.ofc-plaque.is-selected {
  --frame: var(--room-accent, ${UI.accent});
  box-shadow: 0 0 0 2px var(--frame), 0 2px 0 2px rgb(8 6 24 / 0.4);
}
/* alerta viva de la sala: marco rojo, LED rojo e insignia "!" que late; espera del lider: insignia ambar */
.ofc-plaque.is-alert { --frame: ${STATE.error}; }
.ofc-plaque.is-alert .ofc-led { color: ${STATE.error}; }
.ofc-badge.is-alert {
  min-width: 13px; padding: 2px 3px; text-align: center; letter-spacing: 0;
  background: ${STATE.error}; color: ${UI.onAccent}; box-shadow: none;
  animation: ofc-blink 1200ms steps(2, jump-none) infinite;
}
.ofc-plaque.is-critical .ofc-badge.is-alert { animation-duration: 700ms; }
.ofc-badge.is-waiting {
  background: color-mix(in srgb, ${UI.accent} 18%, ${UI.panelSunken}); color: ${UI.accent};
  box-shadow: inset 0 0 0 1px ${UI.accent}; letter-spacing: 0.08em;
}
.ofc-pin.is-alert .ofc-card { --frame: ${STATE.error}; }

/* ---------- cargador y aviso sin WebGL ---------- */
.ofc-loader {
  position: absolute; left: 50%; bottom: 72px; translate: -50% 0;
  display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  font-family: ${FONTS.mono}; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: ${UI.textSecondary}; background: ${UI.panelGlass};
  box-shadow: ${frameLabel(UI.border)};
  pointer-events: none;
}
.ofc-loader i { display: inline-block; width: 6px; height: 6px; background: ${UI.accent}; animation: ofc-step 0.9s steps(1, end) infinite; }
.ofc-loader i:nth-child(2) { animation-delay: 0.3s; }
.ofc-loader i:nth-child(3) { animation-delay: 0.6s; }
.ofc-fallback {
  position: absolute; left: 50%; bottom: 72px; translate: -50% 0;
  box-sizing: border-box; width: min(380px, calc(100% - 32px)); padding: 18px 20px;
  display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
  background: ${UI.panelGlass}; color: ${UI.textSecondary};
  font-family: ${FONTS.body}; font-size: 13px; line-height: 1.5;
  box-shadow: ${frameLabel(`color-mix(in srgb, ${STATE.error} 55%, ${UI.border})`)}, 0 20px 40px -12px rgb(8 6 24 / 0.7);
}
.ofc-fallback strong {
  font-family: ${FONTS.display}; font-size: 16px; line-height: 24px; font-weight: 400; letter-spacing: 0.08em;
  text-transform: uppercase; color: ${UI.text}; -webkit-font-smoothing: none;
}
.ofc-fallback svg { color: ${STATE.error}; }

@keyframes ofc-card-in { from { opacity: 0; transform: translateY(6px) scale(0.92); } }
@keyframes ofc-plaque-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes ofc-fade { from { opacity: 0; } }
@keyframes ofc-action-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes ofc-flash { from { background-color: color-mix(in srgb, currentColor 20%, transparent); } }
@keyframes ofc-blink { 0% { opacity: 1; } 100% { opacity: 0.3; } }
@keyframes ofc-step { 0% { opacity: 1; } 34% { opacity: 0.2; } }
@media (prefers-reduced-motion: reduce) {
  .ofc-card, .ofc-line, .ofc-foot, .ofc-plaque, .ofc-action.is-new { animation: ofc-fade ${DURATION.reduced}ms linear backwards !important; }
  .ofc-st, .ofc-led, .ofc-loader i, .ofc-badge.is-alert { animation: none !important; }
  .ofc-card, .ofc-card:hover, .ofc-card:active, .ofc-plaque:hover { transform: none !important; }
  .ofc-card, .ofc-fold, .ofc-fold > div, .ofc-line {
    transition: opacity ${DURATION.reduced}ms linear, box-shadow ${DURATION.reduced}ms linear !important;
  }
}
`;

const stop = (e: PointerEvent | MouseEvent) => e.stopPropagation();

// Entrada de las tarjetas (D5): 240 ms + 60 ms por tarjeta mientras entra el HUD.
let firstCardAt = 0;
let cardsMounted = 0;

function nextEnterDelay(): number {
  const now = performance.now();
  if (firstCardAt === 0) firstCardAt = now;
  const delay = cardEnterDelay(cardsMounted, now - firstCardAt);
  cardsMounted += 1;
  return delay;
}

type CardState = 'working' | 'idle' | 'done';

const STATE_COLOR: Record<CardState, string> = {
  working: STATE.working,
  idle: STATE.idle,
  done: STATE.done,
};

function PauseIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function actionOf(agent: OfficeAgent): { label: string; key: string } {
  if (agent.status === 'done') {
    const end = agent.task?.endedAt;
    return { label: end ? `Terminó · ${formatTimeOfDay(end)}` : 'Terminó', key: 'done' };
  }
  if (agent.status === 'idle') return { label: 'Inactivo', key: 'idle' };
  if (!agent.action) return { label: 'Pensando', key: 'thinking' };
  return { label: agent.action.label, key: `${agent.action.startedAt}:${agent.action.tool}:${agent.action.label}` };
}

/** Tarjeta flotante de un agente: nombre, tarea, accion actual, cronometros, tokens y costo */
export function AgentCard({ agent }: { agent: OfficeAgent }) {
  const now = useNow();
  const selected = useOfficeStore((s) => s.selectedAgentId === agent.id);
  const hot = useOfficeStore((s) => s.hoveredAgentId === agent.id);
  const [enterDelay] = useState(nextEnterDelay);
  const [phase] = useState(() => phaseDelay(DURATION.liveDot, performance.now()));
  const state: CardState = agent.status;
  const action = actionOf(agent);
  const firstActionKey = useRef(action.key);
  const taskMs = agent.task ? elapsedMs(agent.task.startedAt, agent.task.endedAt, now) : null;
  const actionMs = agent.action && state === 'working' ? elapsedMs(agent.action.startedAt, null, now) : null;
  const t = agent.tokens;
  const detail = agent.task?.detail;
  const alert = state === 'done' ? null : (agent.alert ?? null);

  const style = {
    '--ag': agentColor(lookKey(agent)),
    '--st': STATE_COLOR[state],
    '--ofc-delay': `${enterDelay}ms`,
    '--ofc-phase': phase,
  } as CSSProperties;

  const select = () => useOfficeStore.getState().selectAgent(agent.id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  };

  return (
    <div className={`ofc-pin is-${state}${selected ? ' is-selected' : ''}${hot ? ' is-hot' : ''}${alert ? ' is-alert' : ''}`} style={style}>
      <i className="ofc-line" aria-hidden />
      <i className="ofc-foot" aria-hidden />
      <div
        className="ofc-card"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${agent.displayName}: ${action.label}${alert ? `. Alerta: ${alert.title}` : ''}. Abrir su panel`}
        title={alert ? alert.title : undefined}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          select();
        }}
        onKeyDown={onKeyDown}
        onDoubleClick={stop}
      >
        <div className="ofc-head">
          <span className="ofc-swatch" aria-hidden />
          <span className="ofc-name">{agent.displayName}</span>
          <span className="ofc-st" aria-hidden />
          <span className="ofc-timer">{taskMs === null ? '—' : formatClock(taskMs)}</span>
        </div>
        <div className="ofc-fold ofc-fold--mid">
          <div>
            <div className="ofc-body">
              <div className="ofc-meta">
                <span
                  className="ofc-model"
                  style={{ '--fam': MODEL_FAMILY_COLOR[modelFamily(agent.model)] } as CSSProperties}
                  title={agent.model ? `Modelo: ${agent.model}` : 'Modelo sin reportar'}
                >
                  {modelLabel(agent.model)}
                </span>
                {agent.workflow ? <span className="ofc-role">{ROLE_LABEL[agent.workflow.role]}</span> : null}
              </div>
              <div className="ofc-fold ofc-fold--full">
                <div>
                  <div className="ofc-title" title={detail ? `Flujo: ${detail}` : undefined}>
                    {agent.task?.title ?? 'Sin tarea'}
                  </div>
                </div>
              </div>
              <div key={action.key} className={`ofc-action${action.key !== firstActionKey.current ? ' is-new' : ''}`}>
                {state === 'working' ? <span className="ofc-led" aria-hidden /> : state === 'idle' ? <PauseIcon /> : <CheckIcon />}
                <span className="ofc-action-label">{action.label}</span>
                {actionMs === null ? null : <span className="ofc-action-time">{formatClock(actionMs)}</span>}
              </div>
              <div className="ofc-fold ofc-fold--full">
                <div>
                  <div className="ofc-foot-row">
                    <span>{formatTokens(t.total)} tok</span>
                    <span className={`ofc-usd${agent.costUsd === null ? ' is-unpriced' : ''}`}>
                      {formatUsdOrUnpriced(agent.costUsd)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="ofc-fold ofc-fold--hover">
                <div>
                  <div className="ofc-breakdown">
                    {tokenSegments(t).map((s) => (
                      <span key={s.key} className="ofc-bd">
                        {s.short}
                        <b>{formatTokens(s.value)}</b>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** insignia del rotulo cuando el lider espera una respuesta (pregunta o plan) y su avatar no esta en la sala */
const WAITING_TEXT = 'Espera tu respuesta';

interface RoomPlaqueProps {
  title: string;
  subtitle?: string | null;
  closed: boolean;
  /** alguien de la sala trabaja */
  busy: boolean;
  /** null = sin sala (lobby): nunca se ve inactiva */
  lastActivityAt: string | null;
  /** alerta roja viva de la sala: insignia "!" (el detalle va en el titulo y la etiqueta accesible) */
  alert?: LiveAlert | null;
  /** alerta viva del lider (bucle, errores) y su avatar no esta en la sala: la misma insignia, su detalle aparte */
  leadAlert?: LiveAlert | null;
  /** el lider espera una respuesta y su avatar no esta en la sala */
  waiting?: boolean;
  /** numero y color propio de la sala (roomIdentity): chapita a la izquierda del titulo y marco en su color */
  identity?: RoomIdentity;
  /** la sala tiene el panel abierto: marco de 2 px en su color */
  selected?: boolean;
  onFocus: () => void;
}

/**
 * Rotulo de la sala en el piso: numero de la sala (con identidad), LED, titulo, insignias de alerta o espera y
 * (con el puntero o de cerca) el proyecto y la palabra Inactiva / Cerrada
 */
export function RoomPlaque({
  title,
  subtitle,
  closed,
  busy,
  lastActivityAt,
  alert = null,
  leadAlert = null,
  waiting = false,
  identity,
  selected = false,
  onFocus,
}: RoomPlaqueProps) {
  const [phase] = useState(() => phaseDelay(DURATION.liveDot, performance.now()));
  const now = useNow();
  const last = lastActivityAt === null ? NaN : Date.parse(lastActivityAt);
  const inactive = !closed && !busy && !Number.isNaN(last) && now - last >= ROOM_INACTIVE_AFTER_MS;
  const live = closed ? null : alert;
  const leadLive = closed ? null : leadAlert;
  // una sola insignia "!" con el nivel mas grave de las dos
  const level = live?.level === 'critical' || leadLive?.level === 'critical' ? 'critical' : (live ?? leadLive)?.level;
  const waits = !closed && waiting;
  const cls =
    `ofc-plaque${closed ? ' is-closed' : busy ? ' is-busy' : inactive ? ' is-inactive' : ' is-calm'}` +
    `${level ? ` is-alert is-${level}` : ''}${waits ? ' is-waiting' : ''}${selected ? ' is-selected' : ''}`;
  const hint = [subtitle, live?.title, leadLive ? `Líder: ${leadLive.title}` : null, waits ? WAITING_TEXT : null]
    .filter(Boolean)
    .join(' · ');
  const style = { '--ofc-phase': phase, ...(identity ? { '--room-accent': identity.accent } : {}) } as CSSProperties;
  return (
    <div
      className={cls}
      style={style}
      title={hint ? `${title} · ${hint}` : title}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={
        `Sala ${identity ? `${identity.number}, ` : ''}${title}` +
        `${closed ? ', cerrada' : busy ? ', trabajando' : inactive ? ', inactiva' : ''}` +
        `${live ? `, alerta: ${live.title}` : ''}${leadLive ? `, alerta del líder: ${leadLive.title}` : ''}` +
        `${waits ? `, ${WAITING_TEXT.toLowerCase()}` : ''}. Llevar la cámara aquí`
      }
      onPointerDown={stop}
      onClick={(e) => {
        e.stopPropagation();
        onFocus();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      {identity ? (
        <span className="ofc-plaque-num" aria-hidden>
          {identity.label}
        </span>
      ) : null}
      {closed ? null : <span className="ofc-led" aria-hidden />}
      <span className="ofc-plaque-title">{title}</span>
      {subtitle ? <span className="ofc-plaque-sub">· {subtitle}</span> : null}
      {waits ? <span className="ofc-badge is-waiting">{WAITING_TEXT}</span> : null}
      {level ? (
        <span className="ofc-badge is-alert" aria-hidden>
          !
        </span>
      ) : null}
      {closed ? (
        <span className="ofc-badge is-state">Cerrada</span>
      ) : inactive && !waits ? (
        <span className="ofc-badge is-state">Inactiva</span>
      ) : null}
    </div>
  );
}

export function SceneLoader() {
  return (
    <div className="ofc-loader" role="status">
      <span aria-hidden>
        <i /> <i /> <i />
      </span>
      Preparando la oficina…
    </div>
  );
}

export function NoWebGL({ reason }: { reason: 'unsupported' | 'error' }) {
  return (
    <div className="ofc-fallback" role="alert">
      <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <strong>{reason === 'unsupported' ? 'Sin WebGL 2' : 'La vista 3D se detuvo'}</strong>
      {reason === 'unsupported'
        ? 'Este navegador no tiene WebGL 2 disponible, así que la oficina 3D no se puede dibujar. Los paneles siguen funcionando.'
        : 'Ocurrió un error al dibujar la oficina 3D. Recarga la página para intentarlo de nuevo; los paneles siguen funcionando.'}
    </div>
  );
}
