import { APP_CREDIT, APP_NAME, APP_TAGLINE } from '@/lib/brand';
import { PixelLogo } from './PixelArt';

/** Marca en la esquina de abajo a la izquierda: la celda con ojos, el nombre y el credito */
export function BrandCorner() {
  return (
    <div className="brand-corner" title={`${APP_NAME} · ${APP_TAGLINE}. ${APP_CREDIT}`}>
      <span className="brand-logo">
        <PixelLogo size={30} />
      </span>
      <span className="brand-text">
        <h1 className="display brand-name m-0">{APP_NAME}</h1>
        <span className="brand-credit">{APP_CREDIT}</span>
      </span>
    </div>
  );
}
