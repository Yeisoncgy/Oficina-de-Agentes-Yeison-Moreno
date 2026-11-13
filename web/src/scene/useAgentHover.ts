// Puntero sobre un agente (su cuerpo o su escritorio): despliega su etiqueta completa via store.hoveredAgentId.
// Suelta el id que marco al entrar, no el actual: el ocupante de un puesto o la sala del lider pueden cambiar
// con el puntero encima. Tambien suelta al cambiar de agente o al desmontarse, porque R3F no emite
// pointerout cuando el objeto desaparece.

import { useCallback, useEffect, useRef } from 'react';
import { useOfficeStore } from '@/state/store';
import { setSceneCursor } from './sceneEvents';

export function useAgentHover(selectId: string | null): { over: () => void; out: () => void } {
  const marked = useRef<string | null>(null);

  const out = useCallback(() => {
    const id = marked.current;
    if (!id) return;
    marked.current = null;
    setSceneCursor(false);
    useOfficeStore.getState().hoverAgent(null, id);
  }, []);

  useEffect(() => out, [selectId, out]);

  const over = useCallback(() => {
    if (!selectId) return;
    marked.current = selectId;
    setSceneCursor(true);
    useOfficeStore.getState().hoverAgent(selectId);
  }, [selectId]);

  return { over, out };
}
