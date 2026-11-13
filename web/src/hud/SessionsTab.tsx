import { useMemo, useState } from 'react';
import type { HistoryRange, SessionRow } from '@shared/contract';
import { formatDayMonth, formatTimeOfDay, formatTokens, formatUsd } from '@/lib/format';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useSessions } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { PALETTE } from '@/theme';
import { PeriodPicker } from './insights/PeriodPicker';
import { Led, PanelState, SkeletonBlock } from './primitives';
import './extras/extras.css';

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todo' },
];

function whenText(s: SessionRow): string {
  if (!s.lastActivityAt) return '—';
  return `${formatDayMonth(s.lastActivityAt)} ${formatTimeOfDay(s.lastActivityAt)}`;
}

/** Todas las sesiones con gasto en el periodo: la oficina solo muestra las abiertas y las de hoy */
export function SessionsTab() {
  const [range, setRange] = useState<HistoryRange>('month');
  const [text, setText] = useState('');
  const query = useSessions(range);
  const data = query.data;
  const inOffice = useOfficeStore((s) => s.snapshot?.rooms);
  const officeIds = useMemo(() => new Set((inOffice ?? []).map((r) => r.id)), [inOffice]);
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    const all = data?.rows ?? [];
    return q ? all.filter((r) => r.title.toLowerCase().includes(q) || r.projectName.toLowerCase().includes(q)) : all;
  }, [data, text]);
  const max = rows.reduce((m, r) => Math.max(m, r.costUsd), 0);
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);

  const open = (row: SessionRow) => {
    if (!officeIds.has(row.id)) return;
    const store = useOfficeStore.getState();
    store.closeHistory();
    store.focusRoom(row.id);
  };

  return (
    <>
      <div className="ins-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
        <div className="x-filters">
          <input
            type="search"
            className="ins-input"
            placeholder="Buscar sala o proyecto"
            aria-label="Buscar sala o proyecto"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={7} height={40} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudieron cargar las sesiones"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <PanelState kind="empty" title="Sin sesiones con gasto en este periodo" text="Prueba con Mes o Todo." />
      ) : (
        <section className="ui-rows" aria-label="Sesiones" style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}>
          <div className="day-head">
            <span className="ui-section-title">
              {rows.length} {rows.length === 1 ? 'sesión' : 'sesiones'}
              {data && data.total > data.rows.length ? <span className="day-date">las {data.rows.length} más caras de {data.total}</span> : null}
            </span>
            <span className="day-total">{formatUsd(total)}</span>
          </div>
          <div className="ui-row ui-row--head x-row-session" aria-hidden>
            {/* alineado con el nombre de las filas, que va despues del LED (8 px) y su separacion (10 px) */}
            <span style={{ paddingLeft: 18 }}>Sala · proyecto</span>
            <span />
            <span className="text-right">Turnos</span>
            <span className="text-right">Agentes</span>
            <span className="text-right">Última actividad</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">USD</span>
          </div>
          <ul className="m-0 list-none p-0">
            {rows.map((s, i) => {
              const where = s.title === s.projectName || !s.projectName ? s.title : `${s.title} · ${s.projectName}`;
              const here = officeIds.has(s.id);
              const lines =
                s.linesAdded !== null || s.linesRemoved !== null
                  ? ` · +${s.linesAdded ?? 0} −${s.linesRemoved ?? 0} líneas`
                  : '';
              return (
                <li
                  key={s.id}
                  className="ui-row x-row-session row-in"
                  style={{ animationDelay: `${rowEnterDelay(i)}ms`, cursor: here ? 'pointer' : 'default' }}
                  onClick={() => open(s)}
                  title={`${where}${lines}${here ? ' · clic para ir a la sala' : ''}`}
                >
                  <span className="rank-name">
                    {s.open ? <Led mode="blink" /> : <span style={{ width: 8, flex: 'none' }} aria-hidden />}
                    <span>{where}</span>
                  </span>
                  <span className="rank-bar" aria-hidden>
                    <span
                      className="rank-bar-fill"
                      style={{ width: max > 0 && s.costUsd > 0 ? `max(2px, ${((s.costUsd / max) * 100).toFixed(1)}%)` : 0, background: PALETTE.lavender }}
                    />
                  </span>
                  <span className="cell-num">{s.turns}</span>
                  <span className="cell-num" title={s.workflows > 0 ? `${s.workflows} flujos` : undefined}>
                    {s.subagents}
                  </span>
                  <span className="cell-num">{whenText(s)}</span>
                  <span className="cell-num">{formatTokens(s.tokens)}</span>
                  <span className={`cell-num cell-num--usd ${s.unpricedTokens > 0 ? 'cell-num--unpriced' : ''}`}>
                    {formatUsd(s.costUsd)}
                    {s.unpricedTokens > 0 ? '*' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
