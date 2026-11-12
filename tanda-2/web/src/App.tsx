import { Hud } from '@/hud/Hud';
import { OfficeScene } from '@/scene/OfficeScene';
import { useOfficeStore } from '@/state/store';
import { useOfficeStream } from '@/state/useOfficeStream';

/** Sin conexion la escena se apaga (D3 E2): muestra el ultimo estado conocido, desaturado */
const OFFLINE_FILTER = 'saturate(0.35) brightness(0.5)';

export default function App() {
  useOfficeStream();
  const offline = useOfficeStore((s) => s.connection === 'offline' && !s.demo);
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div
        className="absolute inset-0"
        style={{ filter: offline ? OFFLINE_FILTER : 'none', transition: 'filter 400ms cubic-bezier(0.65, 0, 0.35, 1)' }}
      >
        <OfficeScene />
      </div>
      <Hud />
    </div>
  );
}
