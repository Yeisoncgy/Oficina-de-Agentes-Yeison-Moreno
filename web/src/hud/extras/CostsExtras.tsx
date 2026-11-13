import type { CostsResponse, TokenTypeCost, ToolCostRow } from '@shared/contract';
import { formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { rowEnterDelay } from '@/lib/motion';
import { useReconcile } from '@/state/api';
import { PALETTE } from '@/theme';
import './extras.css';

export const TOKEN_TYPES: ReadonlyArray<{ key: keyof TokenTypeCost; label: string; hint: string; color: string }> = [
  { key: 'cacheReadUsd', label: 'Releer contexto', hint: 'caché leída: lo que ya estaba en la conversación y se vuelve a mandar en cada llamada', color: PALETTE.moon },
  { key: 'cacheWriteUsd', label: 'Contexto nuevo', hint: 'caché escrita: archivos leídos, resultados de herramientas y mensajes nuevos', color: PALETTE.lavender },
  { key: 'outputUsd', label: 'Respuestas', hint: 'lo que escribe el modelo, incluido su razonamiento', color: PALETTE.amber },
  { key: 'inputUsd', label: 'Entrada sin caché', hint: 'entrada que no pasó por la caché', color: PALETTE.neon },
];

export function tokenTypeTotal(t: TokenTypeCost): number {
  return t.inputUsd + t.outputUsd + t.cacheReadUsd + t.cacheWriteUsd;
}

/** En que se va el dinero: el costo del periodo repartido por tipo de token */
export function TokenTypeBars({ data, title = 'En qué se va el dinero' }: { data: TokenTypeCost; title?: string }) {
  const total = tokenTypeTotal(data);
  if (!(total > 0)) return null;
  const top = [...TOKEN_TYPES].sort((a, b) => data[b.key] - data[a.key])[0];
  return (
    <section className="ui-section row-in" aria-label={title}>
      <div className="ui-section-head">
        <h4 className="ui-section-title">{title}</h4>
        {top && top.key === 'cacheReadUsd' && data.cacheReadUsd / total >= 0.4 ? (
          <span className="ui-hint">
            Lo que más pesa es releer el contexto: conversaciones largas y muchas llamadas. Compactar o abrir una sesión nueva lo baja.
          </span>
        ) : null}
      </div>
      <div
        className="x-stack"
        role="img"
        aria-label={TOKEN_TYPES.map((t) => `${t.label} ${formatPercent(data[t.key] / total)}`).join(', ')}
      >
        {TOKEN_TYPES.map((t) =>
          data[t.key] > 0 ? (
            <span key={t.key} style={{ width: `${((data[t.key] / total) * 100).toFixed(2)}%`, background: t.color }} title={`${t.label}: ${formatUsd(data[t.key])}`} />
          ) : null,
        )}
      </div>
      <div className="x-legend">
        {TOKEN_TYPES.map((t) => (
          <div key={t.key} className="x-legend-item" title={t.hint}>
            <span className="x-legend-dot" style={{ background: t.color }} aria-hidden />
            <span className="x-legend-name">{t.label}</span>
            <span className="x-legend-val">
              {formatUsd(data[t.key])} · {formatPercent(data[t.key] / total)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Que herramienta llena el contexto: tamano de los resultados que cada una devuelve */
export function ToolTable({ rows }: { rows: readonly ToolCostRow[] }) {
  const shown = rows.filter((r) => r.resultChars > 0);
  if (shown.length === 0) return null;
  const max = shown.reduce((m, r) => Math.max(m, r.resultChars), 0);
  return (
    <section className="ui-section row-in" aria-label="Qué llena el contexto">
      <div className="ui-section-head">
        <h4 className="ui-section-title">Qué llena el contexto</h4>
        <span className="ui-hint">Tamaño de los resultados de cada herramienta (≈ 4 caracteres por token).</span>
      </div>
      <div role="table" aria-label="Resultados por herramienta" className="ui-rows">
        <div role="row" className="ui-row ui-row--head x-row-tool">
          <span role="columnheader">Herramienta</span>
          <span aria-hidden />
          <span role="columnheader" className="text-right">
            Llamadas
          </span>
          <span role="columnheader" className="text-right">
            Fallos
          </span>
          <span role="columnheader" className="text-right">
            ≈ Tokens
          </span>
        </div>
        {shown.map((r, i) => (
          <div key={r.tool} role="row" className="ui-row x-row-tool row-in" style={{ animationDelay: `${rowEnterDelay(i)}ms` }}>
            <span role="cell" className="x-ellipsis x-mono" title={r.tool}>
              {r.tool}
            </span>
            <span className="rank-bar" aria-hidden>
              <span className="rank-bar-fill" style={{ width: `max(2px, ${((r.resultChars / max) * 100).toFixed(1)}%)`, background: PALETTE.lavender }} />
            </span>
            <span role="cell" className="cell-num">
              {formatTokens(r.calls)}
            </span>
            <span role="cell" className={`cell-num ${r.errors > 0 ? 'x-warn' : ''}`}>
              {r.errors}
            </span>
            <span role="cell" className="cell-num cell-num--usd">
              {formatTokens(r.estTokens)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Lo que el total incluye de estimado y de gasto interno de Claude Code */
export function CostNotes({ totals }: { totals: CostsResponse['totals'] }) {
  const estimated = totals.estimatedUsd ?? 0;
  const hidden = totals.hiddenUsd ?? 0;
  if (estimated <= 0 && hidden <= 0) return null;
  return (
    <p className="ui-hint">
      {estimated > 0 ? (
        <>
          <span className="ui-chip ui-chip--warn">~{formatUsd(estimated)} estimados</span> de modelos sin precio oficial.{' '}
        </>
      ) : null}
      {hidden > 0 ? (
        <>
          <span className="ui-chip ui-chip--info">{formatUsd(hidden)}</span> de gasto interno de Claude Code (no está en las conversaciones).
        </>
      ) : null}
    </p>
  );
}

/** Conciliacion: lo que Claude Code calculo por sesion contra lo que leyo Colmena */
export function ReconcilePanel() {
  const query = useReconcile();
  const data = query.data;
  if (!data || data.sessions === 0) return null;
  const ours = data.oursUsd + data.hiddenUsd;
  const diffPct = data.claudeUsd > 0 ? Math.abs(data.diffUsd) / data.claudeUsd : 0;
  const tone = diffPct > 0.03 ? 'ui-chip--warn' : 'ui-chip--ok';
  return (
    <details className="ui-disclosure">
      <summary>
        Conciliación con Claude Code · diferencia {formatUsd(Math.abs(data.diffUsd))} ({formatPercent(diffPct)})
      </summary>
      <p className="ui-hint">
        Claude Code guarda cuánto calcula que costó cada sesión desde la última vez que la abrió. En ese mismo tramo de{' '}
        {data.sessions} de {data.sessionsTotal} sesiones dice{' '}
        <b className="num">{formatUsd(data.claudeUsd)}</b>; Colmena leyó <b className="num">{formatUsd(ours)}</b>{' '}
        <span className={`ui-chip ${tone}`}>{diffPct > 0.03 ? 'revisar precios' : 'cuadra'}</span>
        {data.hiddenUsd > 0 ? <> De eso, {formatUsd(data.hiddenUsd)} es gasto interno que no está en las conversaciones.</> : null}
      </p>
      <div role="table" aria-label="Conciliación por sesión" className="ui-rows">
        <div role="row" className="ui-row ui-row--head x-row-reconcile">
          <span role="columnheader">Sesión</span>
          <span role="columnheader" className="text-right">
            Colmena
          </span>
          <span role="columnheader" className="text-right">
            Interno
          </span>
          <span role="columnheader" className="text-right">
            Claude Code
          </span>
          <span role="columnheader" className="text-right">
            Diferencia
          </span>
        </div>
        {data.rows.slice(0, 12).map((r, i) => {
          const off = r.claudeUsd > 0 && Math.abs(r.diffUsd) / r.claudeUsd > 0.03 && Math.abs(r.diffUsd) > 0.05;
          const where = r.title === r.projectName || !r.projectName ? r.title : `${r.title} · ${r.projectName}`;
          return (
            <div key={r.sessionId} role="row" className="ui-row x-row-reconcile row-in" style={{ animationDelay: `${rowEnterDelay(i)}ms` }}>
              <span role="cell" className="x-ellipsis" title={where}>
                {where}
              </span>
              <span role="cell" className="cell-num">
                {formatUsd(r.oursUsd)}
              </span>
              <span role="cell" className="cell-num">
                {r.hiddenUsd > 0 ? formatUsd(r.hiddenUsd) : '—'}
              </span>
              <span role="cell" className="cell-num cell-num--usd">
                {formatUsd(r.claudeUsd)}
              </span>
              <span role="cell" className={`cell-num ${off ? 'x-warn' : ''}`}>
                {r.diffUsd >= 0 ? '+' : '−'}
                {formatUsd(Math.abs(r.diffUsd))}
              </span>
            </div>
          );
        })}
      </div>
    </details>
  );
}
