import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ReportResponse } from '@shared/contract';
import { formatPercent, formatUsd } from '@/lib/format';
import { describeApiError, useReport } from '@/state/api';
import { TokenTypeBars } from './extras/CostsExtras';
import { PeriodPicker } from './insights/PeriodPicker';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import './extras/extras.css';

const RANGES: { value: ReportResponse['range']; label: string }[] = [
  { value: 'week', label: '7 días' },
  { value: 'month', label: 'Mes' },
];

/** " · +35 %" contra el periodo anterior; nada si el anterior es casi cero (el porcentaje no diria nada) */
export function changeText(spent: number, prev: number): string {
  if (prev < 1) return '';
  const ratio = Math.abs(spent - prev) / prev;
  if (ratio > 9.99) return spent > prev ? ' · más de 10 veces' : '';
  return ` · ${spent >= prev ? '+' : '−'}${formatPercent(ratio)}`;
}

/** Informe del periodo: lo mas caro, lo que se perdio y lo que se puede ahorrar. Se arma en local, sin modelo. */
export function ReportTab() {
  const [range, setRange] = useState<ReportResponse['range']>('week');
  const [copied, setCopied] = useState(false);
  const query = useReport(range);
  const data = query.data;

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div className="ins-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
        <button type="button" className="btn btn--sm" onClick={() => void copy()} disabled={!data}>
          {copied ? <Check size={12} strokeWidth={STROKE} aria-hidden /> : <Copy size={12} strokeWidth={STROKE} aria-hidden />}
          {copied ? 'Copiado' : 'Copiar informe'}
        </button>
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={5} height={56} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudo armar el informe"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : data ? (
        <div className="flex flex-col gap-7" style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}>
          <div className="ui-stats row-in">
            <div className="ui-stat ui-stat--hero">
              <span className="ui-stat-label">Gastado en el periodo</span>
              <span className="ui-stat-value">{formatUsd(data.spentUsd)}</span>
              <span className="ui-stat-sub">
                periodo anterior {formatUsd(data.prevSpentUsd)}
                {changeText(data.spentUsd, data.prevSpentUsd)}
              </span>
            </div>
            <div className={`ui-stat ${data.monthSpentUsd > data.budgetUsd ? 'ui-stat--error' : ''}`}>
              <span className="ui-stat-label">Mes</span>
              <span className="ui-stat-value">{formatUsd(data.monthSpentUsd)}</span>
              <span className="ui-stat-sub">de {formatUsd(data.budgetUsd)}</span>
            </div>
            <div className={`ui-stat ${data.discardedUsd > 0 ? 'ui-stat--warn' : ''}`}>
              <span className="ui-stat-label">Descartado</span>
              <span className="ui-stat-value">{formatUsd(data.discardedUsd)}</span>
              <span className="ui-stat-sub">fallos, detenidos y reintentos</span>
            </div>
            <div className={`ui-stat ${data.potentialSavingsUsd > 0 ? 'ui-stat--ok' : ''}`}>
              <span className="ui-stat-label">Ahorro posible</span>
              <span className="ui-stat-value">~{formatUsd(data.potentialSavingsUsd)}</span>
              <span className="ui-stat-sub">según los hábitos detectados</span>
            </div>
          </div>
          <TokenTypeBars data={data.byTokenType} />
          <section className="ui-section row-in" aria-label="Informe en texto">
            <h4 className="ui-section-title">Informe listo para copiar</h4>
            <pre className="x-report">{data.text}</pre>
          </section>
        </div>
      ) : null}
    </>
  );
}
