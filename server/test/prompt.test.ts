import { describe, expect, it } from 'vitest';
import { extractPrompt, promptTitle } from '../src/ingest/prompt';

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});

describe('extractPrompt', () => {
  it('acepta texto string y bloques text', () => {
    expect(extractPrompt(user('Hola prueba'))?.title).toBe('Hola prueba');
    expect(extractPrompt(user([{ type: 'text', text: 'Bloque falso' }, { type: 'image' }]))?.title).toBe('Bloque falso');
  });

  it('quita tags y toma la primera linea no vacia', () => {
    const p = extractPrompt(
      user('<ide_selection>codigo\nfalso</ide_selection>\n\n  Primera linea real  \nsegunda <system-reminder>x</system-reminder>'),
    );
    expect(p?.title).toBe('Primera linea real');
    expect(p?.text).toBe('Primera linea real  \nsegunda');
  });

  it('recorta el titulo a 90 caracteres', () => {
    const title = extractPrompt(user('a'.repeat(200)))?.title ?? '';
    expect(title).toHaveLength(90);
    expect(title.endsWith('…')).toBe(true);
  });

  it('descarta lo que no escribio una persona', () => {
    expect(extractPrompt(user('<command-name>/clear</command-name>'))).toBeNull();
    expect(extractPrompt(user('  <local-command-stdout>x</local-command-stdout>'))).toBeNull();
    expect(extractPrompt(user('Caveat: algo'))).toBeNull();
    expect(extractPrompt(user('<task-notification><task-id>a1</task-id></task-notification>'))).toBeNull();
    expect(extractPrompt(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toBeNull();
    expect(extractPrompt(user('Hola', { isMeta: true }))).toBeNull();
    expect(extractPrompt(user('Resumen', { isCompactSummary: true }))).toBeNull();
    expect(extractPrompt(user('Hola', { toolUseResult: { ok: true } }))).toBeNull();
    expect(extractPrompt(user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]))).toBeNull();
    expect(extractPrompt(user('<system-reminder>solo tags</system-reminder>'))).toBeNull();
    expect(extractPrompt({ type: 'assistant', message: { content: 'x' } })).toBeNull();
  });
});

describe('promptTitle', () => {
  it('vacio si no hay texto', () => {
    expect(promptTitle('\n\n')).toBe('');
  });
});
