import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { agentColor, lookFor } from '@/theme';
import { Logo } from './Logo';
import { gridRuns, LOGO_COLORS, LOGO_GRID, SPRITE_SIZE, spriteGrid, type PixelGrid } from '@/lib/sprite';

interface PixelImageProps {
  grid: PixelGrid;
  /** ancho en px CSS; conviene un multiplo del ancho de la grilla para que cada pixel sea entero */
  size: number;
  label?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export const PixelImage = memo(function PixelImage({ grid, size, label, className, style, children }: PixelImageProps) {
  const runs = useMemo(() => gridRuns(grid), [grid]);
  const cols = grid[0]?.length ?? 1;
  const rows = grid.length;
  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      width={size}
      height={(size * rows) / cols}
      shapeRendering="crispEdges"
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {runs.map((run) => (
        <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.w} height={1} fill={run.color} />
      ))}
      {children}
    </svg>
  );
});

/**
 * Retrato del agente: el mismo muneco de vinilo de la escena (cabeza de canto redondeado, pelo, ojos y su
 * rasgo), dibujado con formas suaves a partir de su look. size en px CSS.
 */
function AgentSpriteView({
  agentType,
  size = 32,
  label,
  className,
  dim = false,
}: {
  agentType: string;
  size?: number;
  label?: string;
  className?: string;
  /** en espera o fuera: apagado como la penumbra de la escena */
  dim?: boolean;
}) {
  const look = lookFor(agentType);
  const acc = look.accessory;
  const accent = look.accent ?? '#F3EEE4';
  const style = look.hairStyle ?? 'short';
  const hatted = acc === 'hardhat' || acc === 'explorer-hat';
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      style={dim ? { opacity: 0.55, filter: 'saturate(0.45)' } : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {acc === 'hoodie' ? <rect x={5} y={6} width={22} height={22} rx={8} fill={look.shirt} opacity={0.75} /> : null}
      {style === 'ponytail' ? <rect x={23} y={9} width={5} height={14} rx={2.5} fill={look.hair} /> : null}
      {style === 'bun' ? <circle cx={16} cy={4.5} r={3.6} fill={look.hair} /> : null}
      <rect x={3} y={24} width={26} height={14} rx={6.5} fill={look.shirt} />
      {acc === 'labcoat' ? <path d="M3 30.5a6.5 6.5 0 0 1 6.5-6.5H13l3 5 3-5h3.5a6.5 6.5 0 0 1 6.5 6.5V32H3z" fill="#F3EEE4" /> : null}
      <rect x={13} y={21} width={6} height={5} fill={look.skin} />
      <rect x={13} y={22.6} width={6} height={1.6} fill="#000" opacity={0.14} />
      <rect x={7} y={6} width={18} height={17} rx={5.5} fill={look.skin} />
      {style === 'bob' ? (
        <>
          <rect x={5.5} y={8} width={4.5} height={14} rx={2.2} fill={look.hair} />
          <rect x={22} y={8} width={4.5} height={14} rx={2.2} fill={look.hair} />
        </>
      ) : null}
      {hatted ? null : (
        <path
          d={
            style === 'buzz'
              ? 'M7 11.5V11a5.5 5.5 0 0 1 5.5-5.5h7A5.5 5.5 0 0 1 25 11v.5z'
              : style === 'swept'
                ? 'M6.4 13V10a6 6 0 0 1 6-6h7.2a6 6 0 0 1 6 6v1.2c-5 .2-9.5 1-13 3.2z'
                : 'M6.4 13.4V10a6 6 0 0 1 6-6h7.2a6 6 0 0 1 6 6v3.4h-3.2l-1.6-2.4H11.2l-1.6 2.4z'
          }
          fill={look.hair}
        />
      )}
      {acc === 'hardhat' ? (
        <>
          <path d="M6 11.2a10 10 0 0 1 20 0z" fill="#E8B04A" />
          <rect x={4.6} y={10.4} width={22.8} height={2.6} rx={1.3} fill="#CB9434" />
        </>
      ) : null}
      {acc === 'explorer-hat' ? (
        <>
          <path d="M8.5 10.6V8.2a4.4 4.4 0 0 1 4.4-4.4h6.2a4.4 4.4 0 0 1 4.4 4.4v2.4z" fill={accent} />
          <rect x={3.6} y={9.8} width={24.8} height={2.8} rx={1.4} fill={accent} />
          <rect x={8.5} y={8.4} width={15} height={1.5} fill="#000" opacity={0.25} />
        </>
      ) : null}
      <rect x={11} y={14} width={2.6} height={4.2} rx={1.3} fill="#1B1B22" />
      <rect x={18.4} y={14} width={2.6} height={4.2} rx={1.3} fill="#1B1B22" />
      <circle cx={11.8} cy={15} r={0.6} fill="#F3EEE4" />
      <circle cx={19.2} cy={15} r={0.6} fill="#F3EEE4" />
      <circle cx={9.6} cy={19.4} r={1.5} fill="#E77A6A" opacity={0.38} />
      <circle cx={22.4} cy={19.4} r={1.5} fill="#E77A6A" opacity={0.38} />
      <rect x={14.6} y={19.8} width={2.8} height={1.1} rx={0.55} fill="#000" opacity={0.42} />
      {acc === 'glasses' ? (
        <g fill="none" stroke={accent} strokeWidth={1.1}>
          <rect x={9.3} y={12.8} width={5.8} height={6} rx={2} />
          <rect x={16.9} y={12.8} width={5.8} height={6} rx={2} />
          <path d="M15.1 15.4h1.8" />
        </g>
      ) : null}
      {acc === 'headphones' ? (
        <>
          <path d="M6.4 14.5V11a9.6 9.6 0 0 1 19.2 0v3.5" fill="none" stroke="#1B1B22" strokeWidth={1.7} />
          <rect x={4.6} y={12.6} width={3.6} height={6.6} rx={1.6} fill={accent} />
          <rect x={23.8} y={12.6} width={3.6} height={6.6} rx={1.6} fill={accent} />
        </>
      ) : null}
      {acc === 'bowtie' ? <path d="M12.6 24.4l3.4 1.7 3.4-1.7v3.8L16 26.5l-3.4 1.7z" fill={accent} /> : null}
      {acc === 'badge' ? <rect x={19.6} y={27} width={3.6} height={3.2} rx={0.8} fill={accent} /> : null}
      {acc === 'security' ? <path d="M3 30.5a6.5 6.5 0 0 1 6.5-6.5h2.2l4.3 4.6 4.3-4.6h2.2a6.5 6.5 0 0 1 6.5 6.5V32H3z" fill="#2A2C36" /> : null}
    </svg>
  );
}

/** Retrato sobre una losa con el color de identidad del agente (D2: marco de 2 px en su color) */
function PortraitView({ agentType, size = 48, dim = false }: { agentType: string; size?: number; dim?: boolean }) {
  const sprite = size;
  const style = { width: size, height: size, '--tile': agentColor(agentType) } as CSSProperties;
  return (
    <span className="portrait" style={style}>
      <AgentSprite agentType={agentType} size={sprite} dim={dim} />
    </span>
  );
}

/** Marca de Colmena (Logo.tsx). El nombre se conserva para quien ya la usaba; flap ya no aplica */
export function PixelLogo({ size = 40, className }: { size?: number; className?: string; flap?: boolean }) {
  return <Logo size={size} className={className} />;
}

/** Abeja de la pantalla de carga: vuela en el lugar sobre su sombra, que se achica cuando sube */
export function FlyingBee({ size = 80 }: { size?: number }) {
  return (
    <span className="bee-flight" aria-hidden>
      <PixelLogo size={size} className="bee-fly" flap />
      <span className="bee-shadow" />
    </span>
  );
}

/** Celda de panal de 8x7 con la punta plana: [x, y, ancho] de cada tramo, relativo a la celda */
const HEX_EDGE: readonly (readonly [number, number, number])[] = [
  [2, 0, 4],
  [1, 1, 1],
  [6, 1, 1],
  [0, 2, 1],
  [7, 2, 1],
  [0, 3, 1],
  [7, 3, 1],
  [0, 4, 1],
  [7, 4, 1],
  [1, 5, 1],
  [6, 5, 1],
  [2, 6, 4],
];
const HEX_FILL: readonly (readonly [number, number, number, string])[] = [
  [2, 1, 4, LOGO_COLORS.goldLight],
  [1, 2, 6, LOGO_COLORS.gold],
  [1, 3, 6, LOGO_COLORS.gold],
  [1, 4, 6, LOGO_COLORS.goldDark],
  [2, 5, 4, LOGO_COLORS.goldDark],
];
/** cinco celdas en zigzag, como un trozo de panal: comparten los bordes diagonales */
const HIVE_CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  [6, 3],
  [12, 0],
  [18, 3],
  [24, 0],
];

/** Cargador de panal: las celdas se llenan de miel una tras otra. scale = px CSS por pixel */
export function HiveLoader({ scale = 4, className }: { scale?: number; className?: string }) {
  const cols = 32;
  const rows = 10;
  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      width={cols * scale}
      height={rows * scale}
      shapeRendering="crispEdges"
      className={`hive ${className ?? ''}`}
      aria-hidden
      focusable="false"
    >
      {HIVE_CELLS.map(([ox, oy], i) => (
        <g key={i} className="hive-cell" style={{ animationDelay: `${i * 180}ms` }}>
          {HEX_FILL.map(([x, y, w, color]) => (
            <rect key={`${x}-${y}`} x={ox + x} y={oy + y} width={w} height={1} fill={color} />
          ))}
        </g>
      ))}
      <g className="hive-edge">
        {HIVE_CELLS.flatMap(([ox, oy], i) =>
          HEX_EDGE.map(([x, y, w]) => (
            <rect key={`${i}-${x}-${y}`} x={ox + x} y={oy + y} width={w} height={1} fill={LOGO_COLORS.goldDark} />
          )),
        )}
      </g>
    </svg>
  );
}

// los retratos son lo que mas se repite en la interfaz: solo se vuelven a dibujar si cambia algo suyo
export const AgentSprite = memo(AgentSpriteView);
export const Portrait = memo(PortraitView);
