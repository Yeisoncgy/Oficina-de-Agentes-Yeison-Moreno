import type { BudgetRisk, WorkflowForecast, WorkflowRun } from '@shared/contract';
import { formatPercent, formatUsd, formatUsdOrUnpriced } from '@/lib/format';
import { runClose } from '@/lib/runClose';
import { forecastText, ROLE_LABEL } from '@/lib/workflows';
import './extras.css';

const RISK_TONE: Record<BudgetRisk, string> = { low: '', medium: 'x-warn', high: 'x-error' };

/** Parte de lo que queda del presupuesto del mes que se llevaria la corrida en curso */
export function MonthShare({ forecast }: { forecast: WorkflowForecast | null }) {
  if (!forecast || forecast.monthAvailableUsd === undefined || forecast.monthAvailableUsd === null) return null;
  const available = forecast.monthAvailableUsd;
  const tone = forecast.monthRisk ? RISK_TONE[forecast.monthRisk] : '';
  const text =
    available <= 0
      ? 'sin saldo'
      : forecast.monthShare !== null && forecast.monthShare !== undefined
        ? `~${formatPercent(Math.min(forecast.monthShare, 9.99))}`
        : '—';
  const title =
    available <= 0
      ? 'El presupuesto del mes ya se gastó: todo lo que cueste esta corrida es exceso'
      : `Si llega a ${formatUsd(forecast.highUsd)}, se lleva esa parte de los ${formatUsd(available)} que quedan del presupuesto del mes`;
  return (
    <div className="fx-stat" title={title}>
      <dt className="fx-stat-k">De lo que queda del mes</dt>
      <dd className={`fx-stat-v num ${tone}`}>{text}</dd>
    </div>
  );
}

const VERDICT: Record<'under' | 'within' | 'over', { text: string; cls: string }> = {
  under: { text: 'costó menos de lo previsto', cls: 'x-ok' },
  within: { text: 'dentro de lo previsto', cls: 'x-ok' },
  over: { text: 'costó más de lo previsto', cls: 'x-warn' },
};

/** Cierre de una corrida terminada: por fase, por rol, lo descartado y el primer pronostico contra el costo real */
export function RunCloseCard({ run }: { run: WorkflowRun }) {
  if (run.agents.length === 0) return null;
  const close = runClose(run);
  const total = run.costUsd;
  const share = (usd: number | null): string => (usd !== null && total !== null && total > 0 ? ` · ${formatPercent(usd / total)}` : '');
  return (
    <details className="ui-disclosure">
      <summary>
        Cierre del flujo · {formatUsdOrUnpriced(total)}
        {close.discardedUsd > 0 ? ` · ${formatUsd(close.discardedUsd)} descartados` : ''}
      </summary>
      <div className="x-legend">
        <dl className="x-kv m-0" aria-label="Costo por fase">
          {close.byPhase.map((g) => (
            <div key={g.key} className="contents">
              <dt className="x-ellipsis" title={g.key}>
                {g.key} <span className="x-muted">· {g.agents}</span>
              </dt>
              <dd>
                {formatUsdOrUnpriced(g.costUsd)}
                <span className="x-muted">{share(g.costUsd)}</span>
              </dd>
            </div>
          ))}
        </dl>
        <dl className="x-kv m-0" aria-label="Costo por rol">
          {close.byRole.map((g) => (
            <div key={g.key} className="contents">
              <dt>
                {ROLE_LABEL[g.role]} <span className="x-muted">· {g.agents}</span>
              </dt>
              <dd>
                {formatUsdOrUnpriced(g.costUsd)}
                <span className="x-muted">{share(g.costUsd)}</span>
              </dd>
            </div>
          ))}
        </dl>
        <dl className="x-kv m-0" aria-label="Descartado y pronóstico">
          <dt>Descartado (fallos y reintentos)</dt>
          <dd className={close.discardedUsd > 0 ? 'x-warn' : ''}>
            {formatUsd(close.discardedUsd)}
            <span className="x-muted"> · {close.discardedAgents} ag.</span>
          </dd>
          <dt>Primer pronóstico</dt>
          <dd>{run.firstForecast ? forecastText(run.firstForecast) : 'sin pronóstico'}</dd>
          {close.verdict ? (
            <>
              <dt>Resultado</dt>
              <dd className={VERDICT[close.verdict].cls}>{VERDICT[close.verdict].text}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </details>
  );
}
