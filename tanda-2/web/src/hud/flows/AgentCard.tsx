import { useEffect, useState, type CSSProperties } from 'react';
import { LogOut, RotateCcw } from 'lucide-react';
import { elapsedMs, formatClock, formatTokens, formatUsdOrUnpriced } from '@/lib/format';
import { modelLabel } from '@/lib/models';
import { flowActivity, openFlowAgent, ROLE_LABEL, type FlowAgentView } from '@/lib/workflows';
import { agentColor } from '@/theme';
import { Portrait } from '../PixelArt';
import { Led, ModelChip, STROKE, ThinkingDots, ToolIcon } from '../primitives';
import { RoleTag, TONE_LED } from './parts';

const GONE_NOTE_MS = 2_400;

/** Aviso breve cuando se pide el panel de un agente que ya salio de la oficina */
export function useGoneNote(): [boolean, () => void] {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!gone) return;
    const id = window.setTimeout(() => setGone(false), GONE_NOTE_MS);
    return () => window.clearTimeout(id);
  }, [gone]);
  return [gone, () => setGone(true)];
}

export function GoneNote({ show }: { show: boolean }) {
  return (
    <span className="fx-card-note-slot" role="status">
      {show ? (
        <span className="fx-card-note">
          <LogOut size={14} strokeWidth={STROKE} aria-hidden />
          Ya salió de la oficina
        </span>
      ) : null}
    </span>
  );
}

/**
 * Tarjeta de un agente del flujo: quien es (retrato, nombre, rol, modelo), que hace de verdad y que esta
 * haciendo ahora con su cronometro. Tokens y valor solo con "Mostrar gasto". Clic: abre su panel.
 */
export function AgentCard({ view, now, spend }: { view: FlowAgentView; now: number; spend: boolean }) {
  const { ref, live } = view;
  const [goneNote, showGone] = useGoneNote();
  const activity = flowActivity(view);
  const led = TONE_LED[activity.tone];
  const active = activity.tone === 'working' || activity.tone === 'thinking';
  const taskMs = elapsedMs(ref.startedAt, ref.endedAt, now);
  const actionMs = activity.startedAt ? elapsedMs(activity.startedAt, null, now) : null;
  const label = [
    `${view.name}, ${ROLE_LABEL[view.role]}, ${modelLabel(view.model)}`,
    view.attempt > 1 ? `intento ${view.attempt}` : null,
    activity.detail ? `${activity.status}: ${activity.detail}` : activity.status,
    view.work,
    `${ref.endedAt ? 'duró' : 'lleva'} ${formatClock(taskMs)}`,
    spend ? `${formatTokens(ref.tokens.total)} tokens, ${formatUsdOrUnpriced(ref.costUsd)}` : null,
    live ? 'Abrir su panel' : 'Ya salió de la oficina',
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <li className="fx-card-li">
      <button
        type="button"
        className={`fx-card is-${activity.tone} ${live ? '' : 'is-gone'}`}
        style={{ '--ag': agentColor(view.look) } as CSSProperties}
        aria-label={label}
        title={live ? `Abrir el panel de ${view.name}` : 'Ya salió de la oficina'}
        onClick={() => {
          if (openFlowAgent(ref.agentId) === 'gone') showGone();
        }}
      >
        <span className="fx-card-top">
          <Portrait agentType={view.look} size={44} dim={!active} />
          <span className="fx-card-id">
            <span className="fx-card-line">
              <span className="fx-card-name display">{view.name}</span>
              <ModelChip model={view.model} className="fx-card-model" />
            </span>
            <span className="fx-card-line">
              <RoleTag role={view.role} />
              {view.attempt > 1 ? <span className="fx-attempt">Intento {view.attempt}</span> : null}
            </span>
          </span>
        </span>

        <span className="fx-card-work" title={ref.label && view.work !== ref.label ? `Etiqueta del script: ${ref.label}` : undefined}>
          {view.work}
        </span>

        <span className="fx-card-state">
          {activity.tone === 'retried' ? (
            <RotateCcw size={14} strokeWidth={STROKE} aria-hidden className="fx-card-st-icon" />
          ) : (
            <Led color={led.color} mode={led.blink ? 'blink' : 'steady'} hollow={activity.tone === 'done'} className="fx-led" />
          )}
          <span className="fx-card-st">{activity.status}</span>
          {activity.tone === 'thinking' ? <ThinkingDots /> : null}
          <span className="fx-card-act">
            {activity.tool ? <ToolIcon tool={activity.tool} size={14} /> : null}
            {activity.detail ? <span className="fx-card-act-t">{activity.detail}</span> : null}
          </span>
          {actionMs !== null ? <span className="fx-card-clock num">{formatClock(actionMs)}</span> : null}
        </span>

        <span className="fx-card-foot num">
          <span className="fx-card-k">{ref.endedAt ? 'Duró' : 'Lleva'}</span>
          <b>{formatClock(taskMs)}</b>
          {spend ? (
            <span className="fx-card-spend">
              <span>{formatTokens(ref.tokens.total)} tok</span>
              <b className={ref.costUsd === null ? 'is-unpriced' : 'is-usd'}>{formatUsdOrUnpriced(ref.costUsd)}</b>
            </span>
          ) : null}
        </span>
      </button>
      <GoneNote show={goneNote} />
    </li>
  );
}
