import { useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { SimBaselineRow, SimulatorResponse } from '@shared/contract';
import { formatUsd } from '@/lib/format';
import { describeApiError, useSimulator } from '@/state/api';
import {
  AGENT_ROLE_LABEL,
  FAMILY_LABEL,
  SIM_FAMILIES,
  SIM_ROLES,
  simulateScenario,
  simVerdict,
  type SimEstimate,
  type SimLine,
} from './insights/model';
import { IconButton, PanelState, SkeletonBlock, STROKE } from './primitives';
import { WhatIf } from './extras/WhatIf';
import './insights.css';

const MAX_COUNT = 50;

/**
 * primera fila del escenario: la configuracion con mas historial (o una vacia de datos si no hay). Solo
 * roles y familias que los selectores ofrecen: una fila 'other' mostraria Fable y estimaria con 'other'.
 */
function firstLine(rows: readonly SimBaselineRow[]): SimLine {
  const best = rows
    .filter(
      (r) => r.p75Usd !== null && SIM_ROLES.some((role) => role === r.role) && SIM_FAMILIES.includes(r.family),
    )
    .sort((a, b) => b.samples - a.samples)[0];
  const role = SIM_ROLES.find((r) => r === best?.role) ?? 'builder';
  return { id: 1, role, family: best?.family ?? 'sonnet', count: 1 };
}

const rangeText = (low: number, high: number): string =>
  Math.abs(high - low) < 0.005 ? `~${formatUsd(high)}` : `~${formatUsd(low)} – ${formatUsd(high)}`;

/** Simulador: cuanto costaria un encargo segun el historial (p25-p75 por agente) */
export function SimulatorTab() {
  const query = useSimulator();
  const data = query.data;

  if (query.isPending) return <SkeletonBlock rows={4} height={48} />;
  if (query.isError && !data) {
    return (
      <PanelState
        kind="error"
        title="No se pudo cargar el simulador"
        text={describeApiError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!data) return null;
  return (
    <>
      <Simulator data={data} />
      <WhatIf />
    </>
  );
}

function Simulator({ data }: { data: SimulatorResponse }) {
  const [lines, setLines] = useState<SimLine[]>(() => [firstLine(data.rows)]);
  const nextId = useRef(2);
  const estimate = simulateScenario(lines, data.rows);

  const patch = (id: number, change: Partial<SimLine>) =>
    setLines((all) => all.map((l) => (l.id === id ? { ...l, ...change } : l)));
  const add = () => {
    const last = lines[lines.length - 1];
    setLines((all) => [...all, { id: nextId.current++, role: last?.role ?? 'builder', family: last?.family ?? 'sonnet', count: 1 }]);
  };
  const remove = (id: number) => setLines((all) => (all.length > 1 ? all.filter((l) => l.id !== id) : all));

  return (
    <>
      <div className="sim">
        <section className="sim-scenario" aria-labelledby="sim-scenario-title">
          <h3 id="sim-scenario-title" className="ui-section-title">
            Escenario
          </h3>
          <div className="ui-rows">
            <div className="ui-row ui-row--head sim-line" aria-hidden>
              <span>Rol</span>
              <span>Modelo</span>
              <span>Agentes</span>
              <span className="text-right">Costo</span>
              <span />
            </div>
            <ul className="ui-rows sim-lines">
              {estimate.lines.map(({ line, baseline, lowUsd, highUsd }, i) => (
                <ScenarioLine
                  key={line.id}
                  line={line}
                  index={i}
                  cost={baseline && lowUsd !== null && highUsd !== null ? rangeText(lowUsd, highUsd) : null}
                  canRemove={lines.length > 1}
                  onChange={(change) => patch(line.id, change)}
                  onRemove={() => remove(line.id)}
                />
              ))}
            </ul>
          </div>
          <button type="button" className="btn btn--sm self-start" onClick={add}>
            <Plus size={12} strokeWidth={STROKE} aria-hidden /> Agregar fila
          </button>
        </section>
        <Result estimate={estimate} data={data} />
      </div>
      <BaselineTable rows={data.rows} windowDays={data.windowDays} />
    </>
  );
}

function ScenarioLine({
  line,
  index,
  cost,
  canRemove,
  onChange,
  onRemove,
}: {
  line: SimLine;
  index: number;
  cost: string | null;
  canRemove: boolean;
  onChange: (change: Partial<SimLine>) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  // texto mientras el campo queda vacio para reescribirlo: la fila sigue con su cantidad anterior (minimo 1)
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <li className="ui-row sim-line">
      <select
        className="ins-input"
        value={line.role}
        aria-label={`Rol de la fila ${n}`}
        onChange={(e) => {
          const role = SIM_ROLES.find((r) => r === e.target.value);
          if (role) onChange({ role });
        }}
      >
        {SIM_ROLES.map((r) => (
          <option key={r} value={r}>
            {AGENT_ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <select
        className="ins-input"
        value={line.family}
        aria-label={`Modelo de la fila ${n}`}
        onChange={(e) => {
          const family = SIM_FAMILIES.find((f) => f === e.target.value);
          if (family) onChange({ family });
        }}
      >
        {SIM_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {FAMILY_LABEL[f]}
          </option>
        ))}
      </select>
      <input
        className="ins-input num"
        type="number"
        min={1}
        max={MAX_COUNT}
        step={1}
        value={draft ?? line.count}
        aria-label={`Agentes de la fila ${n}`}
        onChange={(e) => {
          const text = e.target.value;
          const v = Math.floor(Number(text));
          if (text.trim() === '' || !Number.isFinite(v)) {
            setDraft(text);
            return;
          }
          setDraft(null);
          onChange({ count: Math.min(MAX_COUNT, Math.max(1, v)) });
        }}
        onBlur={() => setDraft(null)}
      />
      <span className={`sim-line-cost num ${cost ? '' : 'is-missing'}`}>{cost ?? 'sin histórico'}</span>
      <IconButton label={`Quitar la fila ${n}`} onClick={onRemove} disabled={!canRemove}>
        <Trash2 size={14} strokeWidth={STROKE} />
      </IconButton>
    </li>
  );
}

function Result({ estimate, data }: { estimate: SimEstimate; data: SimulatorResponse }) {
  const priced = estimate.pricedAgents > 0;
  // sin agentes con precio y sin filas sin historico: el escenario no tiene agentes
  const noAgents = !priced && estimate.missingLines === 0;
  const verdict = simVerdict(estimate, data.workflowBudgetUsd);
  return (
    <section className="sim-result" aria-label="Estimación" aria-live="polite">
      <div className="ui-stat ui-stat--hero">
        <span className="ui-stat-label">Estimación</span>
        <span className="ui-stat-value">
          {priced ? rangeText(estimate.lowUsd, estimate.highUsd) : noAgents ? 'Sin agentes' : 'Sin histórico'}
        </span>
        <span className="ui-stat-sub">
          {priced
            ? `mediana ~${formatUsd(estimate.midUsd)} · ${estimate.pricedAgents} ${estimate.pricedAgents === 1 ? 'agente' : 'agentes'}`
            : noAgents
              ? 'Pon al menos 1 agente.'
              : 'Ninguna fila tiene historial.'}
        </span>
      </div>
      {verdict ? <p className={`sim-verdict is-${verdict.tone}`}>{verdict.text}</p> : null}
      {data.availableUsd !== null ? (
        <p className="ui-hint">
          {data.availableUsd !== null && data.availableUsd < 0 ? (
            <>
              El mes ya pasó el presupuesto por <span className="num">{formatUsd(-data.availableUsd)}</span>.
            </>
          ) : (
            <>
              Quedan <span className="num">{formatUsd(data.availableUsd)}</span> del mes.
            </>
          )}
        </p>
      ) : null}
      {estimate.missingLines > 0 ? (
        <p className="ui-hint">
          {estimate.missingLines === 1
            ? '1 fila sin histórico no entra.'
            : `${estimate.missingLines} filas sin histórico no entran.`}
        </p>
      ) : null}
    </section>
  );
}

function BaselineTable({ rows, windowDays }: { rows: SimBaselineRow[]; windowDays: number }) {
  const sorted = [...rows].sort((a, b) => b.samples - a.samples);
  return (
    <details className="ui-disclosure sim-base">
      <summary>Histórico · {windowDays} días</summary>
      {sorted.length === 0 ? (
        <p className="ui-hint">Sin agentes terminados en la ventana.</p>
      ) : (
        <div role="table" aria-label={`Costo por agente terminado, últimos ${windowDays} días`} className="ui-rows">
          <div role="row" className="ui-row ui-row--head base-row">
            <span role="columnheader">Rol</span>
            <span role="columnheader">Modelo</span>
            <span role="columnheader" className="text-right">
              Muestras
            </span>
            <span role="columnheader" className="text-right">
              p25
            </span>
            <span role="columnheader" className="text-right">
              p50
            </span>
            <span role="columnheader" className="text-right">
              p75
            </span>
          </div>
          {sorted.map((row) => (
            <div key={`${row.role}:${row.family}`} role="row" className="ui-row base-row">
              <span role="cell">{AGENT_ROLE_LABEL[row.role]}</span>
              <span role="cell">{FAMILY_LABEL[row.family]}</span>
              <span role="cell" className="cell-num">
                {row.samples}
              </span>
              {row.p25Usd === null ? (
                <span role="cell" className="cell-num cell-num--unpriced base-missing">
                  sin histórico
                </span>
              ) : (
                <>
                  <span role="cell" className="cell-num">
                    {formatUsd(row.p25Usd)}
                  </span>
                  <span role="cell" className="cell-num">
                    {formatUsd(row.p50Usd)}
                  </span>
                  <span role="cell" className="cell-num">
                    {formatUsd(row.p75Usd)}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
