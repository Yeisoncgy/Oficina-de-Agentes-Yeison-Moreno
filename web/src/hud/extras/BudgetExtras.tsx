import { useState, type FormEvent } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import type { BudgetResponse, MonthSummary, ProjectBudgetRow } from '@shared/contract';
import { formatDayMonth, formatMonthLabel, formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { parseEsNumber } from '@/lib/history';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useMonths, useSetProjectBudget } from '@/state/api';
import { PALETTE } from '@/theme';
import { IconButton, STROKE } from '../primitives';
import './extras.css';

const dayText = (date: string): string => formatDayMonth(`${date}T12:00:00`);

/** Ritmo en vivo: gasto de la ultima hora, de hoy, de la semana y cuando se acaba (o se acabo) el presupuesto */
export function PaceNow({ data }: { data: BudgetResponse }) {
  const burn = data.burnPerHourUsd ?? 0;
  const today = data.todayUsd ?? 0;
  const perDay = data.recommendedPerDayUsd ?? null;
  const week = data.week;
  const dayOver = perDay !== null && today > perDay && data.spentUsd <= data.budgetUsd;
  const weekOver = week !== undefined && week.targetUsd > 0 && week.spentUsd > week.targetUsd;
  return (
    <div className="ui-stats row-in" aria-label="Ritmo de gasto">
      <div className={`ui-stat ${data.crossedDate ? 'ui-stat--error' : data.runOutDate ? 'ui-stat--warn' : ''}`}>
        <span className="ui-stat-label">{data.crossedDate ? 'Presupuesto superado' : 'Se acaba'}</span>
        <span className="ui-stat-value">
          {data.crossedDate ? `el ${dayText(data.crossedDate)}` : data.runOutDate ? `el ${dayText(data.runOutDate)}` : 'alcanza'}
        </span>
        <span className="ui-stat-sub">
          {data.crossedDate ? 'ese día el gasto pasó el tope' : data.runOutDate ? 'al ritmo de los últimos días' : 'para todo el mes, a este ritmo'}
        </span>
      </div>
      <div className={`ui-stat ${dayOver ? 'ui-stat--warn' : ''}`}>
        <span className="ui-stat-label">Hoy</span>
        <span className="ui-stat-value">{formatUsd(today)}</span>
        <span className="ui-stat-sub">última hora: {formatUsd(burn)}</span>
      </div>
      {week ? (
        <div className={`ui-stat ${weekOver ? 'ui-stat--warn' : ''}`}>
          <span className="ui-stat-label">Esta semana</span>
          <span className="ui-stat-value">{formatUsd(week.spentUsd)}</span>
          <span className="ui-stat-sub">le tocan {formatUsd(week.targetUsd)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Lo que el total incluye y no viene de la tabla oficial: precios estimados y gasto que no esta en los transcripts */
export function SpendNotes({ data }: { data: BudgetResponse }) {
  const estimated = data.estimatedUsd ?? 0;
  const hidden = data.hiddenUsd ?? 0;
  if (estimated <= 0 && hidden <= 0) return null;
  return (
    <p className="ui-hint">
      {estimated > 0 ? (
        <>
          <span className="ui-chip ui-chip--warn">~{formatUsd(estimated)} estimados</span> de modelos sin precio oficial
          (se cotizan con lo que cobró Claude Code o con su familia; se ajustan en Reglas › Precios).{' '}
        </>
      ) : null}
      {hidden > 0 ? (
        <>
          <span className="ui-chip ui-chip--info">{formatUsd(hidden)}</span> es gasto interno de Claude Code (búsquedas y
          resúmenes) que no aparece en las conversaciones.
        </>
      ) : null}
    </p>
  );
}

function ProjectRow({ row, index, max }: { row: ProjectBudgetRow; index: number; max: number }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const set = useSetProjectBudget();
  const parsed = parseEsNumber(value);
  const valid = parsed !== null && parsed > 0 && parsed <= 1_000_000;
  const over = row.capUsd !== null && row.spentUsd > row.capUsd;
  const base = row.capUsd ?? max;
  const share = base > 0 ? Math.min(1, row.spentUsd / base) : 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || parsed === null) return;
    set.mutate({ project: row.project, amountUsd: Math.round(parsed * 100) / 100 }, { onSuccess: () => setEditing(false) });
  };

  return (
    <div role="row" className="ui-row x-row-project row-in" style={{ animationDelay: `${rowEnterDelay(index)}ms` }}>
      <span role="cell" className="cost-name is-mono" title={row.project}>
        <span className="cost-name-text">{row.project}</span>
      </span>
      <span className="rank-bar" aria-hidden>
        <span
          className="rank-bar-fill"
          style={{
            width: share > 0 ? `max(2px, ${(share * 100).toFixed(1)}%)` : 0,
            background: over ? 'var(--color-state-error)' : PALETTE.lavender,
          }}
        />
      </span>
      <span role="cell" className={`cell-num cell-num--usd ${over ? 'x-error' : ''}`}>
        {formatUsd(row.spentUsd)}
      </span>
      <span role="cell" className="x-edit">
        {editing ? (
          <form className="x-edit" onSubmit={submit} aria-label={`Tope mensual de ${row.project}`}>
            <input
              className="num ins-input"
              inputMode="decimal"
              autoFocus
              placeholder="100"
              value={value}
              aria-label="Tope en USD"
              aria-invalid={value.trim() !== '' && !valid}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <IconButton label="Guardar tope" onClick={() => undefined} type="submit" disabled={!valid || set.isPending}>
              <Check size={14} strokeWidth={STROKE} />
            </IconButton>
          </form>
        ) : (
          <>
            <span className={`cell-num ${row.capUsd === null ? 'x-muted' : ''}`}>
              {row.capUsd === null ? 'sin tope' : `de ${formatUsd(row.capUsd)}`}
            </span>
            <IconButton
              label={row.capUsd === null ? `Poner tope a ${row.project}` : `Cambiar el tope de ${row.project}`}
              onClick={() => {
                setValue(row.capUsd === null ? '' : String(row.capUsd).replace('.', ','));
                setEditing(true);
              }}
            >
              <Pencil size={13} strokeWidth={STROKE} />
            </IconButton>
            {row.capUsd !== null ? (
              <IconButton
                label={`Quitar el tope de ${row.project}`}
                onClick={() => set.mutate({ project: row.project, amountUsd: null })}
                disabled={set.isPending}
              >
                <X size={13} strokeWidth={STROKE} />
              </IconButton>
            ) : null}
          </>
        )}
      </span>
      {set.isError ? (
        <span className="inline-error" role="alert" style={{ gridColumn: '1 / -1' }}>
          {describeApiError(set.error)}
        </span>
      ) : null}
    </div>
  );
}

/** Gasto del mes por proyecto, con un tope opcional por proyecto que avisa al pasarse */
export function ProjectCaps({ data }: { data: BudgetResponse }) {
  const rows = data.projects ?? [];
  if (rows.length === 0) return null;
  const max = rows.reduce((m, r) => Math.max(m, r.spentUsd), 0);
  return (
    <section className="ui-section row-in" aria-label="Gasto por proyecto">
      <div className="ui-section-head">
        <h4 className="ui-section-title">Por proyecto</h4>
        <span className="ui-hint">Ponle un tope a un proyecto y Colmena avisa cuando lo pase.</span>
      </div>
      <div role="table" aria-label="Gasto por proyecto" className="ui-rows">
        {rows.map((row, i) => (
          <ProjectRow key={row.project} row={row} index={i} max={max} />
        ))}
      </div>
    </section>
  );
}

function monthShare(m: MonthSummary, part: number): string {
  return m.spentUsd > 0 ? formatPercent(part / m.spentUsd) : '—';
}

/** Cierre de mes: cada mes con datos, en que se fue y como quedo contra el presupuesto */
export function MonthsTable() {
  const query = useMonths();
  const months = query.data?.months ?? [];
  if (query.isPending || months.length === 0) return null;
  const max = months.reduce((m, r) => Math.max(m, r.spentUsd, r.budgetUsd), 0);
  return (
    <details className="ui-disclosure" open={months.length > 1}>
      <summary>Cierre de mes · {months.length === 1 ? '1 mes' : `${months.length} meses`} con datos</summary>
      <div role="table" aria-label="Meses" className="ui-rows">
        <div role="row" className="ui-row ui-row--head x-row-month">
          <span role="columnheader">Mes</span>
          <span aria-hidden />
          <span role="columnheader" className="text-right">
            Gastado
          </span>
          <span role="columnheader" className="text-right">
            Del tope
          </span>
          <span role="columnheader" className="text-right">
            En flujos
          </span>
          <span role="columnheader" className="text-right">
            Descartado
          </span>
          <span role="columnheader">Lo más caro</span>
        </div>
        {months.map((m, i) => {
          const over = m.spentUsd > m.budgetUsd;
          const top = [m.topProject?.name, m.topModel?.name].filter(Boolean).join(' · ');
          return (
            <div key={m.month} role="row" className="ui-row x-row-month row-in" style={{ animationDelay: `${rowEnterDelay(i)}ms` }}>
              <span role="cell" title={`${formatTokens(m.tokens)} tokens · ${m.sessions} sesiones · ${m.subagents} subagentes`}>
                {formatMonthLabel(m.month)}
              </span>
              <span className="rank-bar" aria-hidden>
                <span
                  className="rank-bar-fill"
                  style={{
                    width: max > 0 ? `max(2px, ${((m.spentUsd / max) * 100).toFixed(1)}%)` : 0,
                    background: over ? 'var(--color-state-error)' : PALETTE.lavender,
                  }}
                />
              </span>
              <span role="cell" className={`cell-num cell-num--usd ${over ? 'x-error' : ''}`}>
                {formatUsd(m.spentUsd)}
              </span>
              <span role="cell" className={`cell-num ${over ? 'x-error' : ''}`}>
                {m.budgetUsd > 0 ? formatPercent(m.spentUsd / m.budgetUsd) : '—'}
              </span>
              <span role="cell" className="cell-num" title={formatUsd(m.workflowUsd)}>
                {monthShare(m, m.workflowUsd)}
              </span>
              <span role="cell" className="cell-num" title={monthShare(m, m.discardedUsd)}>
                {formatUsd(m.discardedUsd)}
              </span>
              <span role="cell" className="x-ellipsis x-small" title={top}>
                {top || '—'}
              </span>
            </div>
          );
        })}
      </div>
    </details>
  );
}
