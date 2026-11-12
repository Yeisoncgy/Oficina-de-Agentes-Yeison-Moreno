import { useEffect, useMemo, useRef } from 'react';
import { resolveSelection, type SelectionView } from '@/lib/office';
import { useOfficeStore } from './store';

/** Agente seleccionado; si sale del snapshot, conserva sus ultimos datos marcado como terminado */
export function useSelectedAgent(): SelectionView | null {
  const selectedId = useOfficeStore((s) => s.selectedAgentId);
  const snapshot = useOfficeStore((s) => s.snapshot);
  const memory = useRef<SelectionView | null>(null);
  // La memoria no es dependencia: solo importa cuando cambia el snapshot o la seleccion.
  const view = useMemo(() => resolveSelection(selectedId, snapshot, memory.current), [selectedId, snapshot]);
  useEffect(() => {
    memory.current = view;
  }, [view]);
  return view;
}
