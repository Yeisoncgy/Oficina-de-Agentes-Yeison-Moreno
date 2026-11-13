// Calidad de la escena (barra de arriba): un boton que rota entre automatica, alta, media y baja. En
// automatica arranca segun la tarjeta grafica y baja sola si el equipo no da; fijarla sirve para un equipo
// justo (baja) o para forzar todo el detalle (alta). Se recuerda en el navegador.
import { Gauge } from 'lucide-react';
import { QUALITY_MODES, type QualityMode, setQualityMode, useQuality, useQualityMode } from '@/scene/quality';

const LABEL: Readonly<Record<QualityMode, string>> = { auto: 'Auto', alta: 'Alta', media: 'Media', baja: 'Baja' };
const HINT: Readonly<Record<QualityMode, string>> = {
  auto: 'se ajusta sola al equipo',
  alta: 'todo el detalle, pide tarjeta gráfica',
  media: 'sin sombreado de contacto, para gráficos integrados',
  baja: 'lo mínimo, para equipos justos',
};

export function QualityControl() {
  const mode = useQualityMode();
  const level = useQuality();
  const next = QUALITY_MODES[(QUALITY_MODES.indexOf(mode) + 1) % QUALITY_MODES.length] ?? 'auto';
  const now = mode === 'auto' ? `Automática (ahora ${LABEL[level].toLowerCase()})` : LABEL[mode];
  return (
    <div className="time-seg">
      <button
        type="button"
        className="time-opt quality-opt"
        aria-label={`Calidad de la escena: ${now}. Cambiar a ${LABEL[next].toLowerCase()}`}
        title={`Calidad: ${now} · ${HINT[mode]}. Clic para cambiar.`}
        onClick={() => setQualityMode(next)}
      >
        <Gauge size={14} strokeWidth={2} aria-hidden />
        <span className="quality-opt-label">{LABEL[mode]}</span>
      </button>
    </div>
  );
}
