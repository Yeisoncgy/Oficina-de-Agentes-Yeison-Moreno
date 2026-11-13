import { useEffect, useState } from 'react';
import { perf } from '@/scene/pacer';
import { getQuality, getQualityMode } from '@/scene/quality';

/**
 * ?perf=1: lectura en vivo del rendimiento de la escena, para comparar equipos. Cuadros por segundo reales
 * y buscados, lo que tarda la tarjeta en un cuadro, llamadas de dibujo, triangulos y nivel de calidad.
 */
export function PerfBadge() {
  const [, tick] = useState(0);
  useEffect(() => {
    // sin ?perf=1 no hay nada que refrescar
    if (!perf.probe) return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  if (!perf.probe) return null;
  const mode = getQualityMode();
  return (
    <div className="perf-badge" role="status" aria-label="Rendimiento de la escena">
      <b>{perf.fps.toFixed(0)}</b> / {perf.target} cuadros · {perf.state}
      <br />
      tarjeta {perf.costMs > 0 ? `${perf.costMs.toFixed(1)} ms` : '…'} · pantalla {perf.hz.toFixed(0)} Hz
      <br />
      {perf.calls} dibujos · {(perf.triangles / 1000).toFixed(0)}k triángulos · sombras {perf.shadowHz.toFixed(0)}/s
      <br />
      calidad {getQuality()}
      {mode === 'auto' ? ' (auto)' : ''}
    </div>
  );
}
