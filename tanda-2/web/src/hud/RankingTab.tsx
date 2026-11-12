import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { HistoryRange, RankingRow } from '@shared/contract';
import { formatTokens, formatUsd } from '@/lib/format';
import { rankRows } from '@/lib/history';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useRanking } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { agentColor } from '@/theme';
import { PeriodPicker } from './insights/PeriodPicker';
import { AgentSprite } from './PixelArt';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import './insights.css';

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todo' },
];

/** Boton "Mostrar gasto": Tokens y USD ocultos por defecto porque la pantalla se proyecta; se recuerda (store.showSpend) */
export function SpendToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn btn--sm" aria-pressed={shown} onClick={onToggle}>
      {shown ? <EyeOff size={14} strokeWidth={STROKE} aria-hidden /> : <Eye size={14} strokeWidth={STROKE} aria-hidden />}
      {shown ? 'Ocultar gasto' : 'Mostrar gasto'}
    </button>
  );
}

export function RankingTab() {
  const [range, setRange] = useState<HistoryRange>('month');
  const showSpend = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const query = useRanking(range);
  const rows = query.data?.byAgent ?? [];

  return (
    <>
      <div className="ins-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
        <SpendToggle shown={showSpend} onToggle={toggleSpend} />
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={6} height={34} />
      ) : query.isError && !query.data ? (
        <PanelState
          kind="error"
          title="No se pudo cargar el ranking"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <PanelState kind="empty" title="Sin datos para este periodo" text="Prueba con Semana o Mes." />
      ) : (
        <div key={range} className="transition-opacity duration-150" style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}>
          <RankingTable rows={rows} showSpend={showSpend} />
        </div>
      )}
    </>
  );
}

function RankingTable({ rows, showSpend }: { rows: RankingRow[]; showSpend: boolean }) {
  const ranked = rankRows(rows);
  const rowClass = `ui-row rank-row ${showSpend ? '' : 'rank-row--private'}`;
  return (
    <div role="table" aria-label="Ranking por agente" className="ui-rows">
      <div role="row" className={`${rowClass} ui-row--head`}>
        <span role="columnheader" className="text-right">
          <span aria-hidden>#</span>
          <span className="sr-only">Posición</span>
        </span>
        <span role="columnheader">Agente</span>
        <span aria-hidden />
        {showSpend && (
          <>
            <span role="columnheader" className="text-right">
              Tokens
            </span>
            <span role="columnheader" className="text-right">
              USD
            </span>
          </>
        )}
        <span role="columnheader" className="text-right">
          Tareas
        </span>
      </div>
      {ranked.map(({ row, rank, share }, i) => (
        <div key={row.key} role="row" className={`${rowClass} row-in`} style={{ animationDelay: `${rowEnterDelay(i)}ms` }}>
          <span role="cell" className="cell-num">
            {rank}
          </span>
          <span role="cell" className="rank-name" title={row.label}>
            <AgentSprite agentType={row.key} size={24} />
            <span>{row.label}</span>
          </span>
          <span className="rank-bar" aria-hidden>
            <span
              className="rank-bar-fill"
              style={{ width: share > 0 ? `max(2px, ${(share * 100).toFixed(1)}%)` : 0, background: agentColor(row.key) }}
            />
          </span>
          {showSpend && (
            <>
              <span role="cell" className="cell-num">
                {formatTokens(row.tokens.total)}
              </span>
              <span role="cell" className="cell-num cell-num--usd">
                {formatUsd(row.costUsd)}
              </span>
            </>
          )}
          <span role="cell" className="cell-num">
            {row.tasks}
          </span>
        </div>
      ))}
    </div>
  );
}
