import { useState, type CSSProperties, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { BudgetResponse } from '@shared/contract';
import { formatDayMonth, formatMonthLabel, formatTimeOfDay, formatTokens, formatUsd } from '@/lib/format';
import {
  budgetGauge,
  budgetTrack,
  chartScale,
  currentMonth,
  dailyPace,
  filledSegments,
  isWeekend,
  localDateKey,
  monthDays,
  parseEsNumber,
  shiftMonth,
} from '@/lib/history';
import { describeApiError, useBudget, useClearBudgetBaseline, useSetBudgetBaseline } from '@/state/api';
import { MonthsTable, PaceNow, ProjectCaps, SpendNotes } from './extras/BudgetExtras';
import { BudgetAmount, DaysOffCalendar } from './insights/BudgetPlan';
import { IconButton, PanelState, SkeletonBlock, STROKE, TONE_COLOR } from './primitives';
import './insights.css';

export function BudgetTab() {
  const thisMonth = currentMonth(Date.now());
  const [month, setMonth] = useState(thisMonth);
  const query = useBudget(month);
  const data = query.data;
  const isCurrent = month === thisMonth;

  return (
    <>
      <div className="ins-top">
        <div className="month-nav">
          <IconButton label="Mes anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <ChevronLeft size={16} strokeWidth={STROKE} />
          </IconButton>
          <h3 className="month-label display m-0" aria-live="polite">
            {formatMonthLabel(month)}
          </h3>
          <IconButton label="Mes siguiente" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={isCurrent}>
            <ChevronRight size={16} strokeWidth={STROKE} />
          </IconButton>
        </div>
      </div>

      {query.isPending ? (
        <SkeletonBlock rows={3} height={72} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudo cargar el presupuesto"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : data ? (
        <div
          className="flex flex-col gap-7 transition-opacity duration-150"
          style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}
        >
          <Hero data={data} isCurrent={isCurrent} />
          <PaceStats data={data} isCurrent={isCurrent} />
          {isCurrent && data.burnPerHourUsd !== undefined ? <PaceNow data={data} /> : null}
          <DailyChart data={data} />
          <SpendNotes data={data} />
          <ProjectCaps data={data} />
          {data.unpricedTokens > 0 ? (
            <p className="ui-hint">
              <span className="ui-chip ui-chip--warn">{formatTokens(data.unpricedTokens)} tokens sin precio</span> no
              suman al gastado ni a la proyección.
            </p>
          ) : null}
          <Settings data={data} />
          <MonthsTable />
          <p className="ui-hint">Valor equivalente API, no es un cobro real.</p>
        </div>
      ) : null}
    </>
  );
}

/** Frase de estado bajo la barra: una linea, con tono solo si hay problema */
function statusLine(data: BudgetResponse, isCurrent: boolean): { text: string; tone: 'ok' | 'warn' | 'over' } {
  const gauge = budgetGauge(data);
  if (!(data.budgetUsd > 0)) return { text: 'Sin presupuesto definido.', tone: 'ok' };
  if (data.spentUsd > data.budgetUsd) {
    return { text: `Pasaste el presupuesto por ${formatUsd(data.spentUsd - data.budgetUsd)}.`, tone: 'over' };
  }
  if (!isCurrent) return { text: `Cerró con ${formatUsd(gauge.remainingUsd)} de margen.`, tone: 'ok' };
  if (gauge.projectedOverUsd > 0) {
    return { text: `Al ritmo actual pasas el presupuesto por ${formatUsd(gauge.projectedOverUsd)}.`, tone: 'warn' };
  }
  return { text: `Al ritmo actual cierras con ${formatUsd(data.budgetUsd - data.projectedUsd)} de margen.`, tone: 'ok' };
}

const TRACK_SEGMENTS = 20;

/** Gastado de presupuesto, la barra de 20 segmentos con la marca de proyeccion y una frase de estado */
function Hero({ data, isCurrent }: { data: BudgetResponse; isCurrent: boolean }) {
  const track = budgetTrack(data);
  const gauge = budgetGauge(data);
  const on = filledSegments(track.spentPct / 100, TRACK_SEGMENTS);
  const ghost = isCurrent ? Math.max(on, filledSegments(track.projectedPct / 100, TRACK_SEGMENTS)) : on;
  const showProj = isCurrent && data.budgetUsd > 0;
  const status = statusLine(data, isCurrent);
  return (
    <section className="budget-hero row-in" aria-label="Gasto del mes">
      <div className="budget-hero-head">
        <div className={`ui-stat ui-stat--hero ${gauge.tone === 'over' ? 'ui-stat--error' : ''}`}>
          <span className="ui-stat-label">Gastado</span>
          <span className="ui-stat-value">
            {formatUsd(data.spentUsd)}
            {data.budgetUsd > 0 ? <span className="budget-of"> de {formatUsd(data.budgetUsd)}</span> : null}
          </span>
        </div>
        {isCurrent ? <RealSpend data={data} /> : null}
      </div>
      <div
        className="track"
        style={{ '--tone': TONE_COLOR[gauge.tone] } as CSSProperties}
        role="img"
        aria-label={`Gastado ${formatUsd(data.spentUsd)} de ${formatUsd(data.budgetUsd)}${
          showProj ? `; proyección al cierre ${formatUsd(data.projectedUsd)}` : ''
        }`}
      >
        {Array.from({ length: TRACK_SEGMENTS }, (_, i) => (
          <span key={i} className={`track-seg ${i < on ? 'is-on' : i < ghost ? 'is-ghost' : ''}`} />
        ))}
        {showProj ? (
          <span
            className={`track-proj ${track.over ? 'is-over' : ''}`}
            style={{ left: `${track.projectedPct}%` }}
            title={`Proyección ${formatUsd(data.projectedUsd)}`}
          />
        ) : null}
      </div>
      <p className={`budget-status ${status.tone === 'ok' ? '' : `is-${status.tone}`}`}>{status.text}</p>
    </section>
  );
}

/** El server cuenta hoy entre los laborales que faltan solo si hoy es laboral del mes pedido */
function countsToday(month: string, daysOff: readonly string[], nowMs: number): boolean {
  const today = localDateKey(nowMs);
  return today.startsWith(`${month}-`) && !isWeekend(today) && !daysOff.includes(today);
}

function PaceStats({ data, isCurrent }: { data: BudgetResponse; isCurrent: boolean }) {
  const workdays = data.workdays;
  const gauge = budgetGauge(data);
  const burn = data.burnRateUsd ?? null;

  if (!isCurrent) {
    return (
      <div className="ui-stats row-in">
        <div className="ui-stat">
          <span className="ui-stat-label">Promedio por día laboral</span>
          <span className="ui-stat-value">{formatUsd(burn)}</span>
        </div>
        {workdays ? (
          <div className="ui-stat">
            <span className="ui-stat-label">Días laborales</span>
            <span className="ui-stat-value">{workdays.total}</span>
          </div>
        ) : null}
      </div>
    );
  }

  const recommended = data.recommendedPerDayUsd ?? null;
  const trend = data.trend5dUsd ?? null;
  const trendHigh = trend !== null && recommended !== null && trend > recommended;
  const projTone = gauge.tone === 'over' ? 'ui-stat--error' : gauge.tone === 'warn' ? 'ui-stat--warn' : '';
  return (
    <div className="ui-stats row-in">
      <div className={`ui-stat ${projTone}`}>
        <span className="ui-stat-label">Proyectado</span>
        <span className="ui-stat-value">{formatUsd(data.projectedUsd)}</span>
        {burn !== null ? <span className="ui-stat-sub">ritmo {formatUsd(burn)} por día</span> : null}
      </div>
      {workdays ? (
        <>
          <div className="ui-stat">
            <span className="ui-stat-label">Recomendado por día</span>
            <span className="ui-stat-value">{formatUsd(recommended)}</span>
            {trend !== null ? (
              <span className={`ui-stat-sub ${trendHigh ? 'is-warn' : ''}`}>últimos 5 días: {formatUsd(trend)}</span>
            ) : null}
          </div>
          <div className="ui-stat">
            <span className="ui-stat-label">Días laborales que quedan</span>
            <span className="ui-stat-value">{workdays.remaining}</span>
            <span className="ui-stat-sub">
              de {workdays.total}
              {workdays.remaining > 0 && countsToday(data.month, data.daysOff ?? [], Date.now()) ? ', con hoy' : ''}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Resumen corto del plegable: solo lo que se aparta de lo normal */
function settingsSummary(data: BudgetResponse): string {
  const offCount = data.daysOff?.length ?? 0;
  const parts = [
    data.budgetSource === 'custom' ? 'monto propio' : null,
    offCount > 0 ? `${offCount} ${offCount === 1 ? 'día libre' : 'días libres'}` : null,
  ].filter((p) => p !== null);
  return ['Ajustes', ...parts].join(' · ');
}

function Settings({ data }: { data: BudgetResponse }) {
  return (
    <details className="ui-disclosure budget-settings">
      <summary>{settingsSummary(data)}</summary>
      <div className="budget-plan">
        <BudgetAmount data={data} />
        <DaysOffCalendar data={data} nowMs={Date.now()} />
      </div>
    </details>
  );
}

/**
 * Ajuste al gasto real, junto al gastado (solo el mes actual): el usuario escribe cuanto lleva gastado segun su
 * consola de Claude y desde ese momento se suma solo lo nuevo (lo anterior, p.ej. otra cuenta, deja de contar).
 */
function RealSpend({ data }: { data: BudgetResponse }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const set = useSetBudgetBaseline();
  const clear = useClearBudgetBaseline();
  const parsed = parseEsNumber(value);
  const valid = parsed !== null && parsed >= 0 && parsed <= 1_000_000;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || parsed === null) return;
    set.mutate(Math.round(parsed * 100) / 100, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    return (
      <form className="real-spend" onSubmit={submit} aria-label="Ajustar al gasto real">
        <label className="real-spend-label" htmlFor="real-spend">
          ¿Cuánto llevas gastado según tu consola?
        </label>
        <span className="real-spend-row">
          <span className="real-spend-field">
            <span className="num" aria-hidden>
              $
            </span>
            <input
              id="real-spend"
              className="num ins-input"
              inputMode="decimal"
              autoFocus
              placeholder="256,00"
              value={value}
              aria-invalid={value.trim() !== '' && !valid}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Esc cancela la edicion sin cerrar el historial
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
          </span>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!valid || set.isPending}>
            Guardar
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
            Cancelar
          </button>
        </span>
        <span className="ui-hint">Desde ahora se suma solo lo nuevo.</span>
        {set.isError ? (
          <span className="inline-error" role="alert">
            {describeApiError(set.error)}
          </span>
        ) : null}
      </form>
    );
  }

  if (data.baseline) {
    const since = data.baseline.since;
    return (
      <div className="real-spend" role="group" aria-label="Ajuste al gasto real">
        <span className="real-spend-set">
          <SlidersHorizontal size={12} strokeWidth={STROKE} aria-hidden />
          Ajustado a <b className="num">{formatUsd(data.baseline.amountUsd)}</b>
          <span className="ui-muted">
            · {formatDayMonth(since)}, {formatTimeOfDay(since)}
          </span>
        </span>
        <span className="real-spend-row">
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
            Volver a ajustar
          </button>
          <button type="button" className="btn btn--sm" onClick={() => clear.mutate()} disabled={clear.isPending}>
            <RotateCcw size={12} strokeWidth={STROKE} aria-hidden /> Quitar ajuste
          </button>
        </span>
        {clear.isError ? (
          <span className="inline-error" role="alert">
            {describeApiError(clear.error)}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="real-spend">
      <button
        type="button"
        className="btn btn--sm real-spend-open"
        onClick={() => setEditing(true)}
        title="¿No coincide con tu consola de Claude? Escribe lo que llevas y desde ahí se suma solo lo nuevo."
      >
        <SlidersHorizontal size={14} strokeWidth={STROKE} aria-hidden /> Ajustar al gasto real
      </button>
    </div>
  );
}

function DailyChart({ data }: { data: BudgetResponse }) {
  const now = Date.now();
  const days = monthDays(data.month, data.daily, now, data.daysOff ?? []);
  const perWorkday = Boolean(data.workdays?.total);
  const pace = dailyPace(data.budgetUsd, data.month, data.workdays?.total);
  const maxCost = days.reduce((max, d) => Math.max(max, d.costUsd), 0);
  const scale = chartScale(Math.max(maxCost, pace));
  const [hover, setHover] = useState<number | null>(null);
  const today = days.find((d) => d.isToday) ?? null;
  const focus = hover !== null ? (days[hover - 1] ?? null) : today;
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  const pct = (v: number) => `${Math.min(100, (v / scale.max) * 100)}%`;

  return (
    <section className="ui-section row-in" aria-label="Costo por día">
      <div className="ui-section-head">
        <span className="ui-section-title">
          Costo por día
          {focus ? (
            <span className="chart-focus num">
              {focus.isToday && hover === null ? 'hoy' : formatDayMonth(`${focus.date}T12:00:00`)} ·{' '}
              {formatUsd(focus.costUsd)}
            </span>
          ) : null}
        </span>
        {pace > 0 ? (
          <span className="chart-legend">
            <span className="legend-line" aria-hidden />
            Ritmo {formatUsd(pace)} por día{perWorkday ? ' laboral' : ''}
          </span>
        ) : null}
      </div>
      <div
        className="chart-plot"
        style={cols}
        role="img"
        aria-label={`Costo por día de ${formatMonthLabel(data.month)}; el día más alto fue ${formatUsd(maxCost)}`}
        onMouseLeave={() => setHover(null)}
      >
        {scale.ticks.map((tick, i) => (
          <div key={tick} className="chart-grid" style={{ bottom: `${i * 40}%` }}>
            <span>{formatUsd(tick).replace(',00', '')}</span>
          </div>
        ))}
        {pace > 0 ? <div className="pace" style={{ bottom: pct(pace) }} /> : null}
        {days.map((d, i) => {
          const over = !d.isFuture && pace > 0 && d.costUsd > pace;
          const cls = [
            'bar',
            d.isFuture ? 'is-future' : over ? 'is-over' : '',
            d.isToday ? 'is-today' : '',
            hover === d.day ? 'is-hover' : '',
          ].join(' ');
          const height = d.isFuture ? '2px' : d.costUsd > 0 ? `max(3px, ${pct(d.costUsd)})` : '2px';
          return (
            <div
              key={d.date}
              className={cls}
              style={{ height, animationDelay: `${120 + i * 12}ms` }}
              title={`${formatDayMonth(`${d.date}T12:00:00`)}${perWorkday && !d.isWorkday ? ' (no laboral)' : ''} · ${
                d.isFuture ? 'sin datos' : formatUsd(d.costUsd)
              }${over ? ' · sobre el ritmo' : ''}`}
              onMouseEnter={() => setHover(d.day)}
            />
          );
        })}
      </div>
      <div className="chart-x" style={cols} aria-hidden>
        {days.map((d) => (
          <span key={d.date} className={`${d.isToday ? 'is-today' : ''} ${perWorkday && !d.isWorkday ? 'is-off' : ''}`}>
            {d.day === 1 || d.day % 5 === 0 || d.isToday ? d.day : ''}
          </span>
        ))}
      </div>
    </section>
  );
}
