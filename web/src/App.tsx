import { lazy, Suspense } from 'react';
import { Hud } from '@/hud/Hud';
import { isLiteMode } from '@/lib/stream';
import { useOfficeStore } from '@/state/store';
import { useOfficeStream } from '@/state/useOfficeStream';

// la escena (three.js) solo se descarga cuando se va a dibujar: la vista ligera no la necesita
const OfficeScene = lazy(() => import('@/scene/OfficeScene').then((m) => ({ default: m.OfficeScene })));

/** Sin conexion la escena se apaga (D3 E2): muestra el ultimo estado conocido, desaturado */
const OFFLINE_FILTER = 'saturate(0.35) brightness(0.5)';

export default function App() {
  useOfficeStream();
  const offline = useOfficeStore((s) => s.connection === 'offline' && !s.demo);
  const lite = isLiteMode(window.location.search);
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {lite ? null : (
        <div
          className="absolute inset-0"
          style={{ filter: offline ? OFFLINE_FILTER : 'none', transition: 'filter 400ms cubic-bezier(0.65, 0, 0.35, 1)' }}
        >
          <Suspense fallback={null}>
            <OfficeScene />
          </Suspense>
        </div>
      )}
      <Hud lite={lite} />
    </div>
  );
}
