import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { agentColor, lookFor } from '@/theme';
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

/** Retrato pixel del agente (busto 16x16); size multiplo de 16 para pixeles enteros */
export function AgentSprite({
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
  const grid = useMemo(() => spriteGrid(lookFor(agentType)), [agentType]);
  return (
    <PixelImage
      grid={grid}
      size={size}
      label={label}
      className={className}
      style={dim ? { opacity: 0.55, filter: 'saturate(0.45)' } : undefined}
    />
  );
}

/** Retrato sobre una losa con el color de identidad del agente (D2: marco de 2 px en su color) */
export function Portrait({ agentType, size = 48, dim = false }: { agentType: string; size?: number; dim?: boolean }) {
  const sprite = Math.max(SPRITE_SIZE, Math.floor(size / SPRITE_SIZE) * SPRITE_SIZE);
  const style = { width: size, height: size, '--tile': agentColor(agentType) } as CSSProperties;
  return (
    <span className="portrait" style={style}>
      <AgentSprite agentType={agentType} size={sprite} dim={dim} />
    </span>
  );
}

/**
 * Marca de Colmena: abeja obrera que parpadea de vez en cuando. size multiplo de 20 (grilla 20x17).
 * flap: las alas titilan (el reflejo salta de punta a base), para cuando la abeja vuela.
 */
export function PixelLogo({ size = 40, className, flap = false }: { size?: number; className?: string; flap?: boolean }) {
  return (
    <PixelImage grid={LOGO_GRID} size={size} className={className}>
      {/* parpado: la fila de arriba del ojo se vuelve dorada y queda la linea de abajo */}
      <rect className="logo-lid" x={7} y={7} width={2} height={1} fill={LOGO_COLORS.gold} />
      <rect className="logo-lid" x={11} y={7} width={2} height={1} fill={LOGO_COLORS.gold} />
      {flap ? (
        <>
          <rect className="logo-flap" x={2} y={5} width={1} height={1} fill={LOGO_COLORS.crystalLight} />
          <rect className="logo-flap" x={17} y={5} width={1} height={1} fill={LOGO_COLORS.crystalLight} />
          <rect className="logo-flap" x={1} y={4} width={3} height={1} fill={LOGO_COLORS.shine} />
          <rect className="logo-flap" x={16} y={4} width={3} height={1} fill={LOGO_COLORS.shine} />
        </>
      ) : null}
    </PixelImage>
  );
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
