import { useState, type FormEvent } from 'react';
import { Info, RotateCcw } from 'lucide-react';
import type { PriceRates, PriceRow, PriceRowSource } from '@shared/contract';
import { formatTokens, formatUsd } from '@/lib/format';
import { parseEsNumber } from '@/lib/history';
import { modelLabel } from '@/lib/models';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useClearPrice, usePrices, useSetPrice } from '@/state/api';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import './extras/extras.css';

const SOURCE: Record<PriceRowSource, { label: string; chip: string; hint: string }> = {
  table: { label: 'Tabla oficial', chip: 'ui-chip--ok', hint: 'Precio oficial del modelo.' },
  custom: { label: 'Propio', chip: 'ui-chip--info', hint: 'Lo fijaste tú.' },
  learned: {
    label: 'Estimado',
    chip: 'ui-chip--warn',
    hint: 'El modelo no está en la tabla: se usa el precio que reproduce lo que cobró Claude Code en su propio registro.',
  },
  family: {
    label: 'Estimado',
    chip: 'ui-chip--warn',
    hint: 'El modelo no está en la tabla: se usa el del modelo más nuevo de su familia.',
  },
  'claude-code': { label: 'De Claude Code', chip: 'ui-chip--muted', hint: 'Su costo lo reporta Claude Code; no pasa por esta tabla.' },
  none: { label: 'Sin precio', chip: 'ui-chip--error', hint: 'Familia desconocida: ponle un precio para que cuente.' },
};

const RATES: ReadonlyArray<{ key: keyof PriceRates; label: string; title: string }> = [
  { key: 'input', label: 'Entrada', title: 'Entrada sin caché' },
  { key: 'output', label: 'Salida', title: 'Respuestas' },
  { key: 'cacheRead', label: 'Leer', title: 'Caché leída' },
  { key: 'cacheWrite5m', label: 'Escr. 5m', title: 'Caché escrita a 5 minutos' },
  { key: 'cacheWrite1h', label: 'Escr. 1h', title: 'Caché escrita a 1 hora' },
];

const rateText = (n: number): string => String(n).replace('.', ',');

function PriceItem({ row, index }: { row: PriceRow; index: number }) {
  const set = useSetPrice();
  const clear = useClearPrice();
  const [draft, setDraft] = useState<Record<keyof PriceRates, string> | null>(null);
  const source = SOURCE[row.source];
  const from = row.priceOf ? ` (${modelLabel(row.priceOf)})` : '';

  const start = () =>
    setDraft({
      input: rateText(row.price?.input ?? 0),
      output: rateText(row.price?.output ?? 0),
      cacheRead: rateText(row.price?.cacheRead ?? 0),
      cacheWrite5m: rateText(row.price?.cacheWrite5m ?? 0),
      cacheWrite1h: rateText(row.price?.cacheWrite1h ?? 0),
    });

  const parsed: Partial<PriceRates> = {};
  let valid = draft !== null;
  if (draft) {
    for (const r of RATES) {
      const n = parseEsNumber(draft[r.key]);
      if (n === null || n < 0 || n > 10_000) valid = false;
      else parsed[r.key] = n;
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    set.mutate({ model: row.model, price: parsed as PriceRates }, { onSuccess: () => setDraft(null) });
  };

  return (
    <form className="ui-row x-row-price row-in" style={{ animationDelay: `${rowEnterDelay(index)}ms` }} onSubmit={submit}>
      <span className="x-ellipsis" title={`${row.model} · ${formatTokens(row.calls)} llamadas · ${formatTokens(row.tokens)} tokens`}>
        {modelLabel(row.model)}
      </span>
      <span>
        <span className={`ui-chip ${source.chip}`} title={`${source.hint}${from}`}>
          {source.label}
        </span>
      </span>
      {RATES.map((r) =>
        draft ? (
          <input
            key={r.key}
            className="num ins-input x-price-input"
            inputMode="decimal"
            aria-label={`${r.title} de ${modelLabel(row.model)}, USD por millón`}
            aria-invalid={parsed[r.key] === undefined}
            value={draft[r.key]}
            onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
        ) : (
          <span key={r.key} className="cell-num" title={r.title}>
            {row.price ? rateText(row.price[r.key]) : '—'}
          </span>
        ),
      )}
      <span className="cell-num cell-num--usd">{formatUsd(row.costUsd)}</span>
      <span className="x-edit">
        {draft ? (
          <>
            <button type="submit" className="btn btn--sm btn--primary" disabled={!valid || set.isPending}>
              Guardar
            </button>
          </>
        ) : row.source === 'custom' ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => clear.mutate(row.model)}
            disabled={clear.isPending}
            title="Volver al precio de la tabla o al estimado"
          >
            <RotateCcw size={12} strokeWidth={STROKE} aria-hidden /> Quitar
          </button>
        ) : (
          <button type="button" className="btn btn--sm" onClick={start} disabled={row.source === 'claude-code'}>
            Cambiar
          </button>
        )}
      </span>
      {set.isError || clear.isError ? (
        <span className="inline-error" role="alert" style={{ gridColumn: '1 / -1' }}>
          {describeApiError(set.error ?? clear.error)}
        </span>
      ) : null}
    </form>
  );
}

/** Precios con los que se cotiza cada modelo. Un cambio recotiza todo el historial desde la base local. */
export function PricesTab() {
  const query = usePrices();
  const data = query.data;
  if (query.isPending) return <SkeletonBlock rows={5} height={40} />;
  if (query.isError && !data) {
    return (
      <PanelState
        kind="error"
        title="No se pudieron cargar los precios"
        text={describeApiError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!data || data.rows.length === 0) {
    return <PanelState kind="empty" title="Todavía no hay modelos" text="Aparecen aquí cuando se lea la primera conversación." />;
  }
  const estimated = data.rows.filter((r) => r.source === 'learned' || r.source === 'family' || r.source === 'none');
  return (
    <>
      <div className="ins-top">
        <p className="note">
          <Info size={14} strokeWidth={STROKE} aria-hidden />
          Dólares por millón de tokens. Ningún modelo conocido queda en cero: si no está en la tabla se cotiza con un
          precio estimado, y aquí puedes fijar el correcto. Cada cambio recotiza todo el historial al instante.
        </p>
        {estimated.length > 0 ? (
          <p className="warn">
            {estimated.length === 1 ? 'Hay 1 modelo con precio estimado' : `Hay ${estimated.length} modelos con precio estimado`}:{' '}
            {estimated.map((r) => modelLabel(r.model)).join(', ')}. Revisa su precio oficial y fíjalo con «Cambiar».
          </p>
        ) : null}
      </div>
      <div className="ui-rows" role="group" aria-label="Precios por modelo">
        <div className="ui-row ui-row--head x-row-price" aria-hidden>
          <span>Modelo</span>
          <span>Origen</span>
          {RATES.map((r) => (
            <span key={r.key} className="text-right" title={r.title}>
              {r.label}
            </span>
          ))}
          <span className="text-right">Gastado</span>
          <span />
        </div>
        {data.rows.map((row, i) => (
          <PriceItem key={row.model} row={row} index={i} />
        ))}
      </div>
    </>
  );
}
