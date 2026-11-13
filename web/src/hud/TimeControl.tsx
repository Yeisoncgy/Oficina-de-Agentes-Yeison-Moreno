// Control de la hora de la oficina (barra de arriba): automatica (la hora real), o fija en dia, atardecer
// o noche. Solo cambia la luz de la escena; el reloj de pared de las salas sigue marcando la hora real.
import { Clock, Moon, Sun, Sunset } from 'lucide-react';
import { setTimeMode, TIME_MODES, type TimeMode, useTimeMode } from '@/scene/daylight';

const OPTIONS: Readonly<Record<TimeMode, { label: string; hint: string; Icon: typeof Clock }>> = {
  auto: { label: 'Automática', hint: 'Sigue la hora real', Icon: Clock },
  dia: { label: 'Día', hint: 'Siempre de día', Icon: Sun },
  atardecer: { label: 'Atardecer', hint: 'Siempre al atardecer', Icon: Sunset },
  noche: { label: 'Noche', hint: 'Siempre de noche', Icon: Moon },
};

export function TimeControl() {
  const mode = useTimeMode();
  return (
    <div className="time-seg" role="group" aria-label="Hora de la oficina">
      {TIME_MODES.map((m) => {
        const { label, hint, Icon } = OPTIONS[m];
        return (
          <button
            key={m}
            type="button"
            className="time-opt"
            aria-pressed={mode === m}
            aria-label={`Hora de la oficina: ${label}`}
            title={`${label} · ${hint}`}
            onClick={() => setTimeMode(m)}
          >
            <Icon size={14} strokeWidth={2} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
