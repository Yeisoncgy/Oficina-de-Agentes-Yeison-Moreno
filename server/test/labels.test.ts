import { describe, expect, it } from 'vitest';
import { actionLabel, inputSummary } from '../src/ingest/labels';

describe('actionLabel', () => {
  it('lectura y edicion usan el basename (Windows y POSIX)', () => {
    expect(actionLabel('Read', { file_path: 'C:\\demo\\falso\\app.ts' })).toBe('Leyendo app.ts');
    expect(actionLabel('Edit', { file_path: '/tmp/falso/server.ts' })).toBe('Editando server.ts');
    expect(actionLabel('Write', { file_path: 'C:\\demo\\nuevo.md' })).toBe('Editando nuevo.md');
    expect(actionLabel('MultiEdit', { file_path: 'a/b/c.ts' })).toBe('Editando c.ts');
    expect(actionLabel('NotebookEdit', { notebook_path: 'C:\\demo\\cuaderno.ipynb' })).toBe('Editando cuaderno.ipynb');
  });

  it('comandos usan la descripcion o un texto por defecto', () => {
    expect(actionLabel('Bash', { command: 'npm test', description: 'Corre las pruebas' })).toBe('Corre las pruebas');
    expect(actionLabel('PowerShell', { command: 'npm run x' })).toBe('Ejecutando comando');
  });

  it('busquedas', () => {
    expect(actionLabel('Grep', { pattern: 'boton' })).toBe('Buscando "boton"');
    const long = actionLabel('Grep', { pattern: 'x'.repeat(50) });
    expect(long).toBe(`Buscando "${'x'.repeat(29)}…"`);
    expect(actionLabel('Glob', { pattern: '**/*.ts' })).toBe('Buscando archivos **/*.ts');
  });

  it('delegacion usa el nombre del agente', () => {
    expect(actionLabel('Agent', { subagent_type: 'tr-builder' })).toBe('Delegando a Bruno');
    expect(actionLabel('Task', { subagent_type: 'Explore' })).toBe('Delegando a Elena');
    expect(actionLabel('Agent', { subagent_type: 'tipo-sin-nombre' })).toBe('Delegando a tipo-sin-nombre');
    expect(actionLabel('Agent', {})).toBe('Delegando a Gael');
  });

  it('herramientas con texto fijo', () => {
    expect(actionLabel('WebFetch', {})).toBe('Consultando la web');
    expect(actionLabel('WebSearch', {})).toBe('Consultando la web');
    expect(actionLabel('Skill', { skill: 'tdd' })).toBe('Usando la skill tdd');
    expect(actionLabel('TodoWrite', {})).toBe('Organizando tareas');
    expect(actionLabel('ToolSearch', {})).toBe('Buscando herramientas');
    expect(actionLabel('AskUserQuestion', {})).toBe('Esperando tu respuesta');
    expect(actionLabel('ExitPlanMode', {})).toBe('Presentando el plan');
  });

  it('mcp y resto', () => {
    expect(actionLabel('mcp__servidor_falso__consulta', {})).toBe('Usando servidor_falso');
    expect(actionLabel('HerramientaFalsa', {})).toBe('Usando HerramientaFalsa');
    expect(actionLabel('SubagentHandback', {})).toBe('Entregando su reporte');
  });

  it('recorta a 60 caracteres', () => {
    const label = actionLabel('Bash', { description: 'd'.repeat(100) });
    expect(label).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('inputSummary', () => {
  it('toma ruta, comando o patron', () => {
    expect(inputSummary({ file_path: 'C:\\demo\\a.ts' })).toBe('C:\\demo\\a.ts');
    expect(inputSummary({ command: 'npm   test' })).toBe('npm test');
    expect(inputSummary({ pattern: 'foo' })).toBe('foo');
    expect(inputSummary(null)).toBe('');
  });
});
