import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { BUDGET_DEFAULT_USD, type BudgetResponse } from '@shared/contract';
import { formatUsd } from '@/lib/format';
import { formatEsInput, monthCalendar, parseEsNumber, type CalendarDay } from '@/lib/history';
import { describeApiError, useClearBudgetAmount, useSetBudgetAmount, useSetDayOff } from '@/state/api';
import { STROKE } from '../primitives';

const MAX_BUDGET = 1_000_000;

/** Monto del presupuesto mensual: editable (PUT) o de vuelta al de por defecto (DELETE) */
export function BudgetAmount({ data }: { data: BudgetResponse }) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const set = useSetBudgetAmount();
  const clear = useClearBudgetAmount();
  const parsed = parseEsNumber(value);
  const valid = parsed !== null && parsed > 0 && parsed <= MAX_BUDGET;
  const custom = data.budgetSource === 'custom';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || parsed === null) return;
    set.mutate(Math.round(parsed * 100) / 100, { onSuccess: () => setEditing(false) });
  };

  if (!editing) {
    return (
      <section className="plan-block" aria-label="Presupuesto mensual">
        <span className="ui-section-title">Presupuesto mensual</span>
        <span className="ui-muted">
          <b className="num">{formatUsd(data.budgetUsd)}</b> · {custom ? 'Monto propio' : 'Por defecto'}, para todos los meses
        </span>
        <span className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setValue(formatEsInput(data.budgetUsd, 'usd'));
              setEditing(true);
            }}
          >
            <Pencil size={12} strokeWidth={STROKE} aria-hidden /> Cambiar monto
          </button>
          {custom ? (
            <button type="button" className="btn btn--sm" onClick={() => clear.mutate()} disabled={clear.isPending}>
              <RotateCcw size={12} strokeWidth={STROKE} aria-hidden /> Volver a {formatUsd(BUDGET_DEFAULT_USD)}
            </button>
          ) : null}
        </span>
        {clear.isError ? (
          <span className="inline-error" role="alert">
            {describeApiError(clear.error)}
          </span>
        ) : null}
      </section>
    );
  }

  return (
    <form className="plan-block" onSubmit={submit} aria-label="Cambiar el presupuesto mensual">
      <label className="ui-section-title" htmlFor={inputId}>
        Presupuesto mensual
      </label>
      <span className="flex items-center gap-1">
        <span className="num" aria-hidden>
          $
        </span>
        <input
          id={inputId}
          className="num ins-input w-32"
          inputMode="decimal"
          autoFocus
          placeholder="500,00"
          value={value}
          aria-invalid={value.trim() !== '' && !valid}
          onChange={(e) => setValue(e.target.value)}
        />
      </span>
      <span className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn--sm btn--primary" disabled={!valid || set.isPending}>
          Guardar
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
          Cancelar
        </button>
      </span>
      {set.isError ? (
        <span className="inline-error" role="alert">
          {describeApiError(set.error)}
        </span>
      ) : null}
    </form>
  );
}

const WEEKDAYS: [string, string][] = [
  ['L', 'lunes'],
  ['M', 'martes'],
  ['X', 'miércoles'],
  ['J', 'jueves'],
  ['V', 'viernes'],
  ['S', 'sábado'],
  ['D', 'domingo'],
];

/**
 * Mini calendario del mes: los dias entre semana se marcan o desmarcan como libres (festivos,
 * vacaciones) y dejan de contar como laborales. Un solo punto de tabulacion; las flechas se mueven entre
 * los dias habiles (arriba y abajo, una semana).
 */
export function DaysOffCalendar({ data, nowMs }: { data: BudgetResponse; nowMs: number }) {
  const titleId = useId();
  const setDayOff = useSetDayOff();
  const weeks = monthCalendar(data.month, data.daysOff ?? [], nowMs);
  const weekdays = weeks.flat().filter((c): c is CalendarDay => c !== null && !c.weekend);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const current =
    (focusDate && weekdays.some((d) => d.date === focusDate) ? focusDate : null) ??
    weekdays.find((d) => d.isToday)?.date ??
    weekdays[0]?.date ??
    null;
  const offCount = weekdays.filter((d) => d.off).length;

  const focusDay = (date: string) => {
    setFocusDate(date);
    document.getElementById(`${titleId}-${date}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = weekdays.findIndex((d) => d.date === current);
    if (index === -1) return;
    let target: CalendarDay | undefined;
    if (event.key === 'ArrowRight') target = weekdays[index + 1];
    else if (event.key === 'ArrowLeft') target = weekdays[index - 1];
    else if (event.key === 'Home') target = weekdays[0];
    else if (event.key === 'End') target = weekdays[weekdays.length - 1];
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const day = (weekdays[index]?.day ?? 0) + (event.key === 'ArrowDown' ? 7 : -7);
      target = weekdays.find((d) => d.day === day);
    } else return;
    event.preventDefault();
    if (target) focusDay(target.date);
  };

  const pendingDate = setDayOff.isPending ? setDayOff.variables?.date : undefined;

  return (
    <section className="cal" aria-labelledby={titleId}>
      <div className="cal-head">
        <span id={titleId} className="ui-section-title">
          Días libres
        </span>
        <span className="ui-muted">
          {offCount} {offCount === 1 ? 'marcado' : 'marcados'}
        </span>
      </div>
      <p className="ui-hint">Festivos o vacaciones: no cuentan como laborales.</p>
      <div role="grid" aria-labelledby={titleId} className="cal-grid" onKeyDown={onKeyDown}>
        <div role="row" className="cal-row">
          {WEEKDAYS.map(([short, long]) => (
            <span key={long} role="columnheader" className="cal-wd" title={long}>
              <span aria-hidden>{short}</span>
              <span className="sr-only">{long}</span>
            </span>
          ))}
        </div>
        {weeks.map((week, w) => (
          <div key={w} role="row" className="cal-row">
            {week.map((cell, i) =>
              cell === null ? (
                <span key={`v${i}`} role="gridcell" className="cal-day is-blank" />
              ) : cell.weekend ? (
                <span key={cell.date} role="gridcell" className={`cal-day is-weekend ${cell.isToday ? 'is-today' : ''}`}>
                  <span aria-hidden>{cell.day}</span>
                </span>
              ) : (
                <span key={cell.date} role="gridcell">
                  <button
                    id={`${titleId}-${cell.date}`}
                    type="button"
                    className={`cal-day ${cell.off ? 'is-off' : ''} ${cell.isToday ? 'is-today' : ''}`}
                    aria-pressed={cell.off}
                    aria-label={`${WEEKDAYS[i]?.[1] ?? ''} ${cell.day}${cell.isToday ? ', hoy' : ''}: ${
                      cell.off ? 'día libre' : 'día laboral'
                    }`}
                    title={cell.off ? 'Día libre: clic para volverlo laboral' : 'Clic para marcarlo como libre'}
                    tabIndex={cell.date === current ? 0 : -1}
                    aria-busy={pendingDate === cell.date}
                    onFocus={() => setFocusDate(cell.date)}
                    onClick={() => {
                      // sin disabled: el boton conserva el foco mientras el server responde
                      if (!setDayOff.isPending) setDayOff.mutate({ date: cell.date, off: !cell.off });
                    }}
                  >
                    {cell.day}
                  </button>
                </span>
              ),
            )}
          </div>
        ))}
      </div>
      {setDayOff.isError ? (
        <p className="inline-error" role="alert">
          {describeApiError(setDayOff.error)}
        </p>
      ) : null}
    </section>
  );
}
