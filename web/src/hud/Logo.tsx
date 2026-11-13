// Marca de Colmena, rehecha desde cero: una celda de panal que es a la vez una sala vista en isometrica
// (dos paredes y el piso) y que tiene ojos: la celda es quien trabaja. Tres ambares, sin contornos, para
// que se lea igual a 16 px (icono de la pestana) que a 96 px (pantalla de carga).
import { useId } from 'react';

export function Logo({ size = 40, className, blink = true }: { size?: number; className?: string; blink?: boolean }) {
  const id = useId();
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden focusable="false">
      <clipPath id={id}>
        <path d="M21.23 5.60Q24.00 4.00 26.77 5.60L38.55 12.40Q41.32 14.00 41.32 17.20L41.32 30.80Q41.32 34.00 38.55 35.60L26.77 42.40Q24.00 44.00 21.23 42.40L9.45 35.60Q6.68 34.00 6.68 30.80L6.68 17.20Q6.68 14.00 9.45 12.40Z" />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        <polygon points="6.68,14.00 24.00,4.00 24.00,24.00 6.68,34.00" fill="#E8B04A" />
        <polygon points="24.00,4.00 41.32,14.00 41.32,34.00 24.00,24.00" fill="#C48A2C" />
        <polygon points="6.68,34.00 24.00,24.00 41.32,34.00 24.00,44.00" fill="#F9D684" />
      </g>
      <g className={blink ? 'logo-eyes' : undefined} fill="#14151C">
        <rect x={16.6} y={18.4} width={4.6} height={7.8} rx={2.3} />
        <rect x={26.8} y={18.4} width={4.6} height={7.8} rx={2.3} />
      </g>
    </svg>
  );
}
