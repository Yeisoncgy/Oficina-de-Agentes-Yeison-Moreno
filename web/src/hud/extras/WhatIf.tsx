import { useMemo, useState } from 'react';
import type { AgentRole, PriceRates, WhatIfResponse, WhatIfRow } from '@shared/contract';
import { formatPercent, formatUsd } from '@/lib/format';
import { modelLabel } from '@/lib/models';
import { rowEnterDelay } from '@/lib/motion';
import { useWhatIf } from '@/state/api';
import { AGENT_ROLE_LABEL } from '../insights/model';
import { PeriodPicker } from '../insights/PeriodPicker';
import './extras.css';

const RANGES: { value: WhatIfResponse['range']; label: string }[] = [
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todo' },
];

export function repriced(row: WhatIfRow, price: PriceRates): number {
  const t = row.tokens;
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      t.cacheWrite5m * price.cacheWrite5m +
      t.cacheWrite1h * price.cacheWrite1h) /
    1_000_000
  );
}

/** total del escenario: cada fila con el modelo elegido para su rol ('' = el que se uso) */
export function whatIfTotal(
  rows: readonly WhatIfRow[],
  choice: Partial<Record<AgentRole, string>>,
  prices: ReadonlyMap<string, PriceRates>,
): number {
  return rows.reduce((sum, r) => {
    const price = prices.get(choice[r.role] ?? '');
    return sum + (price ? repriced(r, price) : r.costUsd);
  }, 0);
}

/** "Y si": el mismo trabajo del periodo cotizado con otro modelo por rol. Solo aritmetica sobre lo ya gastado. */
export function WhatIf() {
  const [range, setRange] = useState<WhatIfResponse['range']>('month');
  const [choice, setChoice] = useState<Partial<Record<AgentRole, string>>>({});
  const query = useWhatIf(range);
  const data = query.data;
  const prices = useMemo(() => new Map((data?.models ?? []).map((m) => [m.model, m.price])), [data]);
  if (!data || data.rows.length === 0) return null;
  const actual = data.rows.reduce((sum, r) => sum + r.costUsd, 0);
  const scenario = whatIfTotal(data.rows, choice, prices);
  const delta = scenario - actual;
  const roles = [...new Set(data.rows.map((r) => r.role))];

  return (
    <section className="ui-section row-in" aria-label="Y si usaras otros modelos">
      <div className="ui-section-head">
        <h4 className="ui-section-title">¿Y si el mismo trabajo corriera en otro modelo?</h4>
        <PeriodPicker options={RANGES} value={range} onChange={setRange} label="Periodo del escenario" />
      </div>
      <p className="ui-hint">
        Elige un modelo por rol y se recotizan los mismos tokens que ya se gastaron. Es una cuenta, no una promesa: otro
        modelo puede necesitar más o menos pasos para lo mismo.
      </p>
      <div className="ui-stats">
        <div className="ui-stat">
          <span className="ui-stat-label">Se gastó</span>
          <span className="ui-stat-value">{formatUsd(actual)}</span>
        </div>
        <div className={`ui-stat ui-stat--hero ${delta < -0.005 ? 'ui-stat--ok' : delta > 0.005 ? 'ui-stat--warn' : ''}`}>
          <span className="ui-stat-label">Con este escenario</span>
          <span className="ui-stat-value">{formatUsd(scenario)}</span>
          <span className="ui-stat-sub">
            {Math.abs(delta) < 0.005
              ? 'sin cambios'
              : `${delta < 0 ? 'ahorra' : 'cuesta'} ${formatUsd(Math.abs(delta))}${actual > 0 ? ` (${formatPercent(Math.abs(delta) / actual)})` : ''}`}
          </span>
        </div>
      </div>
      <div role="table" aria-label="Escenario por rol" className="ui-rows">
        <div role="row" className="ui-row ui-row--head x-row-whatif">
          <span role="columnheader">Rol</span>
          <span role="columnheader">Se usó</span>
          <span role="columnheader">Cambiar a</span>
          <span role="columnheader" className="text-right">
            Gastado
          </span>
          <span role="columnheader" className="text-right">
            Escenario
          </span>
        </div>
        {roles.map((role, i) => {
          const rows = data.rows.filter((r) => r.role === role);
          const spent = rows.reduce((sum, r) => sum + r.costUsd, 0);
          const next = whatIfTotal(rows, choice, prices);
          const used = rows.map((r) => modelLabel(r.model)).join(', ');
          return (
            <div key={role} role="row" className="ui-row x-row-whatif row-in" style={{ animationDelay: `${rowEnterDelay(i)}ms` }}>
              <span role="cell">{AGENT_ROLE_LABEL[role]}</span>
              <span role="cell" className="x-ellipsis x-small" title={used}>
                {used}
              </span>
              <span role="cell">
                <select
                  className="ins-input"
                  aria-label={`Modelo para ${AGENT_ROLE_LABEL[role]}`}
                  value={choice[role] ?? ''}
                  onChange={(e) => setChoice({ ...choice, [role]: e.target.value })}
                >
                  <option value="">Igual</option>
                  {data.models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {modelLabel(m.model)}
                    </option>
                  ))}
                </select>
              </span>
              <span role="cell" className="cell-num">
                {formatUsd(spent)}
              </span>
              <span role="cell" className={`cell-num cell-num--usd ${next < spent - 0.005 ? 'x-ok' : next > spent + 0.005 ? 'x-warn' : ''}`}>
                {formatUsd(next)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
