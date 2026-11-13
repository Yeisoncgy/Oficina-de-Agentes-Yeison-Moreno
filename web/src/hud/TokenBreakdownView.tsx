import type { TokenBreakdown } from '@shared/contract';
import { formatTokens, formatUsdOrUnpriced } from '@/lib/format';
import { tokenSegments, type TokenKind } from '@/lib/office';
import { PALETTE } from '@/theme';

/** Colores del desglose (D3): luna, cian, lavanda y ambar */
export const TOKEN_COLOR: Record<TokenKind, string> = {
  input: PALETTE.moon,
  output: PALETTE.cyan,
  cacheRead: PALETTE.lavender,
  cacheWrite: PALETTE.amber,
};

export function TokenBreakdownView({
  tokens,
  costUsd,
  model,
}: {
  tokens: TokenBreakdown;
  costUsd: number | null;
  model: string | null;
}) {
  const segments = tokenSegments(tokens);
  return (
    <>
      <div className="sec-head">
        <span className="label">Tokens</span>
        {model ? <span className="sec-aside">{model}</span> : null}
      </div>
      <div className="tok-grid">
        {segments.map((segment) => (
          <div key={segment.key} className="contents">
            <span className="tok-k">{segment.label}</span>
            <span className="tok-bar" aria-hidden>
              <span
                className="tok-fill"
                style={{
                  width: segment.value > 0 ? `max(2px, ${(segment.ofMax * 100).toFixed(1)}%)` : 0,
                  background: TOKEN_COLOR[segment.key],
                }}
              />
            </span>
            <span className="tok-v">{formatTokens(segment.value)}</span>
          </div>
        ))}
      </div>
      <div className="tok-total">
        <div className="tok-col">
          <span className="label">Total</span>
          <span className="tok-total-v">{formatTokens(tokens.total)} tok</span>
        </div>
        <div className="tok-col tok-col--end">
          <span className={`tok-usd ${costUsd === null ? 'is-unpriced' : ''}`}>{formatUsdOrUnpriced(costUsd)}</span>
          <span className="api-note">{costUsd === null ? 'modelo sin precio conocido' : 'valor equivalente API'}</span>
        </div>
      </div>
    </>
  );
}
