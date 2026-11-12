import { formatUsd } from '@/lib/format';
import type { Pricing } from './model';

/**
 * Monto que el server suma solo con lo que tiene precio. Sin nada con precio dice "sin precio" (nunca
 * $0,00); con una parte fuera lleva un asterisco discreto y `missing` explica que quedo fuera.
 */
export function PricedUsd({ usd, pricing, missing }: { usd: number | null; pricing: Pricing; missing: string }) {
  if (pricing === 'unpriced') {
    return (
      <span className="unpriced" title={missing}>
        sin precio
      </span>
    );
  }
  if (usd === null) return <>—</>;
  if (pricing === 'priced') return <>{formatUsd(usd)}</>;
  return (
    <>
      {formatUsd(usd)}
      <span className="unpriced-mark" title={missing} aria-hidden>
        *
      </span>
      <span className="sr-only"> ({missing})</span>
    </>
  );
}
