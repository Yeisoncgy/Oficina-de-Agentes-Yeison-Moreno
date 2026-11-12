import { useId, useState } from 'react';
import type { CostRow, CostsResponse, DiscardedRow, HistoryRange } from '@shared/contract';
import { formatDayMonth, formatPercent, formatTimeOfDay, formatTokens, formatUsd, formatUsdOrUnpriced } from '@/lib/format';
import { MODEL_FAMILY_COLOR, modelFamily, modelLabel } from '@/lib/models';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useCosts } from '@/state/api';
import { PALETTE } from '@/theme';
import {
  AGENT_ROLE_LABEL,
  costRowPricing,
  costShares,
  DISCARD_REASON_LABEL,
  isAgentRole,
  unpricedCostTokens,
} from './insights/model';
import { PeriodPicker } from './insights/PeriodPicker';
import { PricedUsd } from './insights/PricedUsd';
import { AgentSprite } from './PixelArt';
import { PanelState, SkeletonBlock } from './primitives';
import './insights.css';

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todo' },
];

/** Costos: totales con el % de cache, por modelo, rol y proyecto, y el trabajo descartado */
export function CostsTab() {
  const [range, setRange] = useState<HistoryRange>('month');
  const query = useCosts(range);
  const data = query.data;
  const empty = data ? data.totals.tokens.total === 0 && data.discarded.count === 0 : false;

  return (
    <>
      <div className="ins-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={4} height={72} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudieron cargar los costos"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : empty ? (
        <PanelState kind="empty" title="Sin gasto en este periodo" text="Prueba con Semana o Mes." />
      ) : data ? (
        <div
          key={range}
          className="flex flex-col gap-7 transition-opacity duration-150"
          style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}
        >
          <Totals data={data} />
          <div className="cost-grid">
            <CostTable title="Por modelo" rows={data.byModel} variant="model" />
            <CostTable title="Por rol" rows={data.byRole} variant="role" />
            <CostTable title="Por proyecto" rows={data.byProject} variant="project" wide />
          </div>
          <Discarded data={data.discarded} />
        </div>
      ) : null}
    </>
  );
}

const unpricedText = (tokens: number): string => `${formatTokens(tokens)} tokens sin precio no se suman`;

function Totals({ data }: { data: CostsResponse }) {
  const { totals, discarded } = data;
  const unpriced = unpricedCostTokens(data);
  // "sin precio" se dice una vez, en el pie; el monto va sin asterisco
  const pricing = costRowPricing({ costUsd: totals.costUsd, unpricedTokens: unpriced });
  return (
    <div className="ui-stats row-in">
      <div className="ui-stat ui-stat--hero">
        <span className="ui-stat-label">Gastado</span>
        <span className="ui-stat-value">
          <PricedUsd usd={totals.costUsd} pricing={pricing === 'partial' ? 'priced' : pricing} missing={unpricedText(unpriced)} />
        </span>
        <span className="ui-stat-sub">
          {formatTokens(totals.tokens.total)} tokens
          {unpriced > 0 ? <span className="cost-unpriced"> · {formatTokens(unpriced)} sin precio</span> : null}
        </span>
      </div>
      <div className="ui-stat">
        <span className="ui-stat-label">Caché</span>
        <span className="ui-stat-value">{totals.cachePct === null ? '—' : formatPercent(totals.cachePct)}</span>
        <span className="ui-stat-sub">de la entrada</span>
      </div>
      <div className={`ui-stat ${discarded.costUsd > 0 ? 'ui-stat--warn' : ''}`}>
        <span className="ui-stat-label">Descartado</span>
        <span className="ui-stat-value">{formatUsd(discarded.costUsd)}</span>
        {totals.costUsd > 0 && discarded.costUsd > 0 ? (
          <span className="ui-stat-sub">{formatPercent(discarded.costUsd / totals.costUsd)} del gasto</span>
        ) : null}
      </div>
    </div>
  );
}

function RowName({ row, variant }: { row: CostRow; variant: 'model' | 'project' | 'role' }) {
  if (variant === 'model') {
    return (
      <>
        <span className="cost-dot" style={{ background: MODEL_FAMILY_COLOR[modelFamily(row.key)] }} aria-hidden />
        <span className="cost-name-text">{modelLabel(row.key)}</span>
      </>
    );
  }
  return <span className="cost-name-text">{variant === 'role' && isAgentRole(row.key) ? AGENT_ROLE_LABEL[row.key] : row.label}</span>;
}

function CostTable({
  title,
  rows,
  variant,
  wide = false,
}: {
  title: string;
  rows: CostRow[];
  variant: 'model' | 'project' | 'role';
  wide?: boolean;
}) {
  const titleId = useId();
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total);
  const shares = costShares(sorted);
  return (
    <section aria-labelledby={titleId} className={`ui-section ${wide ? 'cost-wide' : ''}`}>
      <h4 id={titleId} className="ui-section-title">
        {title}
      </h4>
      {sorted.length === 0 ? (
        <p className="ui-hint">Sin datos en este periodo.</p>
      ) : (
        <div role="table" aria-labelledby={titleId} className="ui-rows">
          <div role="row" className="ui-row ui-row--head cost-row">
            <span role="columnheader">{variant === 'model' ? 'Modelo' : variant === 'role' ? 'Rol' : 'Proyecto'}</span>
            <span aria-hidden />
            <span role="columnheader" className="text-right">
              Tokens
            </span>
            <span role="columnheader" className="text-right">
              USD
            </span>
          </div>
          {sorted.map((row, i) => {
            const pricing = costRowPricing(row);
            const share = shares[i] ?? 0;
            return (
              <div
                key={row.key}
                role="row"
                className="ui-row cost-row row-in"
                style={{ animationDelay: `${rowEnterDelay(i)}ms` }}
              >
                <span role="cell" className={`cost-name ${variant === 'project' ? 'is-mono' : ''}`} title={row.label}>
                  <RowName row={row} variant={variant} />
                </span>
                <span className="rank-bar" aria-hidden>
                  <span
                    className="rank-bar-fill"
                    style={{ width: share > 0 ? `max(2px, ${(share * 100).toFixed(1)}%)` : 0, background: PALETTE.lavender }}
                  />
                </span>
                <span role="cell" className="cell-num">
                  {formatTokens(row.tokens.total)}
                </span>
                <span role="cell" className={`cell-num cell-num--usd ${pricing === 'unpriced' ? 'cell-num--unpriced' : ''}`}>
                  <PricedUsd usd={row.costUsd} pricing={pricing} missing={unpricedText(row.unpricedTokens ?? 0)} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function endedText(item: DiscardedRow): string {
  return item.endedAt ? `${formatDayMonth(item.endedAt)} ${formatTimeOfDay(item.endedAt)}` : '—';
}

function Discarded({ data }: { data: CostsResponse['discarded'] }) {
  if (data.count === 0 && data.items.length === 0) return null;
  return (
    <details className="ui-disclosure discard">
      <summary>
        Trabajo descartado · {formatUsd(data.costUsd)} · {data.count} {data.count === 1 ? 'agente' : 'agentes'}
      </summary>
      {data.items.length === 0 ? (
        <p className="ui-hint">Sin detalle en este periodo.</p>
      ) : (
        <div role="table" aria-label="Trabajo descartado" className="ui-rows">
          <div role="row" className="ui-row ui-row--head discard-row">
            <span role="columnheader">Agente</span>
            <span role="columnheader">Motivo</span>
            <span role="columnheader">Sala · proyecto</span>
            <span role="columnheader">Terminó</span>
            <span role="columnheader" className="text-right">
              USD
            </span>
          </div>
          {data.items.map((item, i) => {
            const where = item.roomTitle === item.projectName ? item.roomTitle : `${item.roomTitle} · ${item.projectName}`;
            return (
              <div
                key={`${item.agentId}:${item.reason}`}
                role="row"
                className="ui-row discard-row row-in"
                style={{ animationDelay: `${rowEnterDelay(i)}ms` }}
              >
                <span role="cell" className="task-agent">
                  <AgentSprite agentType={item.agentType} size={20} />
                  <span>{item.role ? AGENT_ROLE_LABEL[item.role] : item.agentType}</span>
                </span>
                <span role="cell">
                  <span className="ui-chip ui-chip--muted">{DISCARD_REASON_LABEL[item.reason]}</span>
                </span>
                <span role="cell" className="task-where" title={where}>
                  {where}
                </span>
                <span role="cell" className="cell-num text-left">
                  {endedText(item)}
                </span>
                <span
                  role="cell"
                  className={`cell-num cell-num--usd ${item.costUsd === null ? 'cell-num--unpriced' : ''}`}
                  title={`${formatTokens(item.tokens.total)} tokens`}
                >
                  {formatUsdOrUnpriced(item.costUsd)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}
