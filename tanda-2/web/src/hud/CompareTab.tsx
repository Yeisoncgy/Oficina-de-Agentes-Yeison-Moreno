import { useId, useState } from 'react';
import type { CompareResponse, CompareRow, CompareSummary } from '@shared/contract';
import { formatDuration, formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useCompare, type CompareRange } from '@/state/api';
import { AGENT_ROLE_LABEL, compareRowPricing, FAMILY_LABEL } from './insights/model';
import { PeriodPicker } from './insights/PeriodPicker';
import { PricedUsd } from './insights/PricedUsd';
import { PanelState, SkeletonBlock } from './primitives';
import './insights.css';

const RANGES: { value: CompareRange; label: string }[] = [
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todo' },
];

const ROLE_ORDER = Object.keys(AGENT_ROLE_LABEL);
const FAMILY_ORDER = Object.keys(FAMILY_LABEL);

const orNone = (value: number | null, format: (n: number) => string): string => (value === null ? '—' : format(value));

/** Comparador: eficiencia por configuracion (familia de modelo x rol), con/sin skill y flujos */
export function CompareTab() {
  const [range, setRange] = useState<CompareRange>('month');
  const query = useCompare(range);
  const data = query.data;

  return (
    <>
      <div className="ins-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={5} height={40} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudo cargar el comparador"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : data && data.rows.length === 0 ? (
        <PanelState kind="empty" title="Sin tareas en este periodo" text="Prueba con Mes o Todo." />
      ) : data ? (
        <div key={range} className="transition-opacity duration-150" style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}>
          <CompareTable rows={data.rows} />
          <SkillCompare skill={data.skill} />
          <WorkflowsLine workflows={data.workflows} />
        </div>
      ) : null}
    </>
  );
}

function sortRows(rows: readonly CompareRow[]): CompareRow[] {
  return [...rows].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family),
  );
}

const COLUMNS = ['Modelo · rol', 'Agentes', 'Completadas', '$ / completada', 'Duración', 'Errores'] as const;

/** metricas que no entran en la tabla: van en el title de la fila */
function rowDetail(row: CompareRow): string {
  return [
    `Archivos ${row.filesChanged}`,
    `Tokens por archivo ${orNone(row.tokensPerFileChanged, formatTokens)}`,
    `Reintentos ${row.retries}`,
    `Tests ${row.testRuns === 0 ? '—' : `${row.testRuns} · ${orNone(row.testPassPct, formatPercent)}`}`,
    `Caché ${orNone(row.cachePct, formatPercent)}`,
    `Descartado ${formatUsd(row.discardedUsd)}`,
  ].join(' · ');
}

function CompareTable({ rows }: { rows: CompareRow[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="ui-section">
      <h3 id={titleId} className="ui-section-title">
        Por modelo y rol
      </h3>
      <div role="table" aria-labelledby={titleId} className="ui-rows">
        <div role="row" className="ui-row ui-row--head cmp-row cmp-row--head">
          {COLUMNS.map((c, i) => (
            <span key={c} role="columnheader" className={i === 0 ? '' : 'text-right'}>
              {c}
            </span>
          ))}
        </div>
        {sortRows(rows).map((row, i) => (
          <div
            key={row.key}
            role="row"
            className="ui-row cmp-row row-in"
            title={rowDetail(row)}
            style={{ animationDelay: `${rowEnterDelay(i)}ms` }}
          >
            <span role="cell" className="cmp-config">
              {FAMILY_LABEL[row.family]} · {AGENT_ROLE_LABEL[row.role]}
            </span>
            <span role="cell" className="cell-num">
              {row.tasks}
            </span>
            <span role="cell" className="cell-num" title={`${row.completed} de ${row.tasks}`}>
              {row.tasks > 0 ? formatPercent(row.completed / row.tasks) : '—'}
            </span>
            <CostPerCompletedCell row={row} />
            <span role="cell" className="cell-num">
              {orNone(row.avgDurationMs, formatDuration)}
            </span>
            <span role="cell" className="cell-num">
              {row.errors}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** $ por completada: sin completadas con precio completo dice "sin precio" si hubo tareas sin precio */
function CostPerCompletedCell({ row }: { row: CompareRow }) {
  const pricing = compareRowPricing(row);
  const n = row.unpricedTasks ?? 0;
  const missing = `${n} ${n === 1 ? 'tarea sin precio no entra' : 'tareas sin precio no entran'} en el promedio`;
  return (
    <span role="cell" className={`cell-num cell-num--usd ${pricing === 'unpriced' ? 'cell-num--unpriced' : ''}`}>
      <PricedUsd usd={row.costPerCompletedUsd} pricing={pricing} missing={missing} />
    </span>
  );
}

function SkillCompare({ skill }: { skill: CompareResponse['skill'] }) {
  return (
    <section className="ui-section cmp-skill" aria-label="Con skill y sin skill">
      <SkillColumn title="Con skill" summary={skill.with} />
      <SkillColumn title="Sin skill" summary={skill.without} />
    </section>
  );
}

function SkillColumn({ title, summary }: { title: string; summary: CompareSummary }) {
  return (
    <div className="cmp-skill-col">
      <h3 className="ui-section-title">
        {title} <span className="ui-muted">· {summary.tasks} {summary.tasks === 1 ? 'tarea' : 'tareas'}</span>
      </h3>
      <div className="ui-stats">
        <div className="ui-stat">
          <span className="ui-stat-label">$ por completada</span>
          <span className="ui-stat-value">{orNone(summary.costPerCompletedUsd, formatUsd)}</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-label">Duración</span>
          <span className="ui-stat-value">{orNone(summary.avgDurationMs, formatDuration)}</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-label">Errores</span>
          <span className="ui-stat-value">{summary.errors}</span>
        </div>
      </div>
    </div>
  );
}

function WorkflowsLine({ workflows }: { workflows: CompareResponse['workflows'] }) {
  if (workflows.runs === 0) return null;
  return (
    <p className="ui-muted cmp-flows">
      Flujos: {workflows.runs} {workflows.runs === 1 ? 'corrida' : 'corridas'} · mediana{' '}
      <span className="num">{orNone(workflows.p50CostUsd, formatUsd)}</span> · duración promedio{' '}
      <span className="num">{orNone(workflows.avgDurationMs, formatDuration)}</span>
    </p>
  );
}
