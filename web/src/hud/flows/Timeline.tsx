import { useMemo, type CSSProperties } from 'react';
import type { OfficeRoom, WorkflowRun } from '@shared/contract';
import { elapsedMs, formatClock, formatTimeOfDay, formatUsdOrUnpriced } from '@/lib/format';
import { flowActivity, openFlowAgent, PHASE_STATUS_LABEL, ROLE_LABEL, runTimeline, type TimelineBar } from '@/lib/workflows';
import { agentColor } from '@/theme';
import { Portrait } from '../PixelArt';
import { GoneNote, useGoneNote } from './AgentCard';
import { ROLE_ICON } from './parts';
import { STROKE } from '../primitives';

export const timelineGroupId = (key: string) => `fx-tl-${key}`;

/**
 * Linea de tiempo de la corrida: una fila por agente con una barra desde que arranco hasta que termino
 * (o hasta ahora), agrupadas por fase. Deja ver que corrio en paralelo, que se reintento y donde se fue
 * el tiempo. Clic en una fila: abre el panel del agente.
 */
export function RunTimeline({ run, room, now, spend }: { run: WorkflowRun; room: OfficeRoom; now: number; spend: boolean }) {
  const timeline = useMemo(() => runTimeline(run, room, now), [run, room, now]);
  const [goneNote, showGone] = useGoneNote();

  if (timeline.groups.length === 0) {
    return <p className="fx-board-empty">Todavía no hay agentes para dibujar en el tiempo.</p>;
  }

  return (
    <div className="fx-tl" role="group" aria-label={`Línea de tiempo, ${formatClock(timeline.endMs - timeline.startMs)} en total`}>
      <div className="fx-tl-axis" aria-hidden>
        <span className="fx-tl-axis-k">Desde el inicio</span>
        <span className="fx-tl-track">
          {timeline.ticks.map((tick) => (
            <span key={tick.at} className="fx-tl-tick num" style={{ left: `${tick.at * 100}%` }}>
              {tick.label}
            </span>
          ))}
        </span>
      </div>
      <div className="fx-tl-body">
        {timeline.now !== null ? (
          <span className="fx-tl-now" style={{ '--at': timeline.now } as CSSProperties} aria-hidden>
            <span className="fx-tl-now-k">Ahora</span>
          </span>
        ) : null}
        {timeline.groups.map((group) => (
          <section key={group.key} id={timelineGroupId(group.key)} className={`fx-tl-group is-${group.status}`} tabIndex={-1}>
            <h4 className="fx-tl-group-h">
              {group.index >= 0 ? <span className="fx-tl-group-n num">{group.index + 1}</span> : null}
              <span className="fx-tl-group-t">{group.title}</span>
              <span className="fx-tl-group-st">{PHASE_STATUS_LABEL[group.status]}</span>
            </h4>
            <ul className="fx-tl-rows">
              {group.bars.map((bar) => (
                <TimelineRow key={bar.view.ref.agentId} bar={bar} now={now} spend={spend} onGone={showGone} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <GoneNote show={goneNote} />
    </div>
  );
}

function TimelineRow({ bar, now, spend, onGone }: { bar: TimelineBar; now: number; spend: boolean; onGone: () => void }) {
  const { view, from, to, open } = bar;
  const { ref } = view;
  const activity = flowActivity(view);
  const Icon = ROLE_ICON[view.role];
  const ms = elapsedMs(ref.startedAt, ref.endedAt, now);
  const when = `${formatTimeOfDay(ref.startedAt)}${ref.endedAt ? ` a ${formatTimeOfDay(ref.endedAt)}` : ', sigue'}`;
  const label = [
    `${view.name}, ${ROLE_LABEL[view.role]}`,
    activity.status,
    view.work,
    `${when}, ${formatClock(ms)}`,
    spend ? formatUsdOrUnpriced(ref.costUsd) : null,
    view.live ? 'Abrir su panel' : 'Ya salió de la oficina',
  ]
    .filter(Boolean)
    .join('. ');
  const style = { '--from': from, '--to': to, '--ag': agentColor(view.look) } as CSSProperties;
  return (
    <li>
      <button
        type="button"
        className={`fx-tl-row is-${activity.tone} ${open ? 'is-open' : ''}`}
        aria-label={label}
        title={`${view.name} · ${view.work} · ${when} (${formatClock(ms)})`}
        onClick={() => {
          if (openFlowAgent(ref.agentId) === 'gone') onGone();
        }}
      >
        <span className="fx-tl-who">
          <Portrait agentType={view.look} size={28} dim={activity.tone !== 'working' && activity.tone !== 'thinking'} />
          <span className="fx-tl-name">{view.name}</span>
          <Icon size={14} strokeWidth={STROKE} aria-hidden className="fx-tl-role" />
        </span>
        <span className="fx-tl-track">
          <span className="fx-tl-bar" style={style}>
            <span className="fx-tl-bar-t">
              <b className="num">{formatClock(ms)}</b> {view.work}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
