import { FlyingBee, HiveLoader } from '../PixelArt';
import type { FirstReadView } from './firstRead';
import './onboarding.css';

/**
 * En lugar de "Sin agentes trabajando hoy" mientras el server lee el historial. El avance va en la barra
 * (progressbar), no en la region viva: cambia cada 2 s y el lector de pantalla lo repetiria.
 */
export function FirstReadCard({ view }: { view: FirstReadView }) {
  return (
    <div className="center-card ob-reading" role="status">
      <FlyingBee size={60} />
      <h3 className="center-card-title display">Leyendo tu historial de Claude Code…</h3>
      {view.ratio === null ? (
        <HiveLoader scale={3} />
      ) : (
        <span
          className="ob-bar"
          role="progressbar"
          aria-label="Archivos leídos"
          aria-valuemin={0}
          aria-valuemax={view.total}
          aria-valuenow={view.done}
          aria-valuetext={view.text}
        >
          <span className="ob-bar-fill" style={{ width: `${Math.round(view.ratio * 100)}%` }} />
        </span>
      )}
      <span className="ob-count" aria-hidden>
        {view.text}
      </span>
      <p className="center-card-text">
        Solo lectura: no gasta tokens. Tu gasto y tu historial se completan cuando termine.
      </p>
    </div>
  );
}
