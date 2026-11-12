import { afterEach, describe, expect, it } from 'vitest';
import { runBackfill } from '../src/app';
import { migrate, openDb } from '../src/db/connection';
import {
  apiErrorCategory,
  cmdClass,
  commandName,
  compactData,
  inputHash,
  instructionsData,
  instructionsDup,
  interruptOf,
  mcpServersFrom,
  readPartial,
  textHash,
} from '../src/ingest/signals';
import { line, loadFixture, TempHome } from './helpers';

const LONG = 'Regla falsa de prueba que se repite entre dos archivos de instrucciones';
const LONG2 = 'Otra regla falsa y larga que aparece una sola vez en todo el adjunto';

describe('clase de comando', () => {
  it('pruebas, build, git de lectura y el resto', () => {
    const cases: Array<[string, string]> = [
      ['npx vitest run', 'test'],
      ['npm test', 'test'],
      ['npm run test -w server -- test/signals.test.ts', 'test'],
      ['cargo test --all', 'test'],
      ['pytest -q', 'test'],
      ['npm run build && npm test', 'test'],
      ['cd web && npx vitest run test/falso.test.ts', 'test'],
      ['python -m pytest -q', 'test'],
      ['CI=1 npm test', 'test'],
      ['./node_modules/.bin/vitest run', 'test'],
      // el runner solo nombrado (config, instalacion, git de lectura sobre su config) no es una corrida
      ['cat web/vitest.config.ts', 'other'],
      ['npm i -D vitest', 'other'],
      ['pnpm add -D jest', 'other'],
      ['npx playwright install', 'other'],
      ['git diff web/vitest.config.ts', 'git_read'],
      ['git log --grep "npm test"', 'git_read'],
      ['echo "npm test"', 'other'],
      ['npm run typecheck -w web', 'build'],
      ['npx tsc --noEmit', 'build'],
      ['vite build', 'build'],
      ['dotnet build', 'build'],
      ['git status', 'git_read'],
      ['  git log --oneline -5', 'git_read'],
      ['git commit -m "falso"', 'other'],
      ['cd demo && git status', 'other'],
      ['ls', 'other'],
    ];
    for (const [command, expected] of cases) {
      expect(cmdClass('Bash', { command }), command).toBe(expected);
    }
    expect(cmdClass('PowerShell', { command: 'npm run lint' })).toBe('build');
    expect(cmdClass('Bash', {})).toBe('other');
    expect(cmdClass('Read', { command: 'npm test' })).toBeNull();
  });

  it('lectura parcial solo en Read', () => {
    expect(readPartial('Read', { file_path: 'a.ts' })).toBe(0);
    expect(readPartial('Read', { file_path: 'a.ts', offset: 10 })).toBe(1);
    expect(readPartial('Read', { file_path: 'a.ts', limit: 50 })).toBe(1);
    expect(readPartial('Grep', { pattern: 'x', limit: 5 })).toBeNull();
  });
});

describe('huellas', () => {
  it('el mismo input da el mismo hash aunque sus claves lleguen en otro orden', () => {
    const a = inputHash({ command: 'npm test', description: 'Pruebas', opts: { b: 1, a: [{ y: 1, x: 2 }] } });
    const b = inputHash({ opts: { a: [{ x: 2, y: 1 }], b: 1 }, description: 'Pruebas', command: 'npm test' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(inputHash({ command: 'npm test', description: 'Otra' })).not.toBe(inputHash({ command: 'npm test', description: 'Pruebas' }));
    // el orden de un arreglo si importa
    expect(inputHash({ x: [1, 2] })).not.toBe(inputHash({ x: [2, 1] }));
    expect(inputHash(undefined)).toBe(inputHash(null));
  });

  it('textHash es sha1 corto', () => {
    expect(textHash('')).toBe('da39a3ee5e6b4b0d');
    expect(textHash('Error: fallo falso')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('instrucciones', () => {
  it('dupChars cuenta lo que sobra de las lineas largas repetidas', () => {
    const a = `${LONG}\nlinea corta repetida\n${LONG2}`;
    const b = `  ${LONG}\t\r\nlinea corta repetida`;
    expect(instructionsDup([a, b])).toBe(LONG.length);
    expect(instructionsDup([LONG, LONG, LONG])).toBe(LONG.length * 2);
    expect(instructionsDup([a])).toBe(0);
  });

  it('guarda basenames, tipos y tamanos, nunca el contenido', () => {
    const data = instructionsData([
      { path: 'C:\\demo\\proyecto-falso\\CLAUDE.md', type: 'Project', content: `${LONG}\n${LONG}` },
      { path: '/home/falso/.claude/CLAUDE.md', type: 'User', content: 'x' },
    ]);
    expect(data).toEqual({
      files: [
        { name: 'CLAUDE.md', type: 'Project', chars: LONG.length * 2 + 1 },
        { name: 'CLAUDE.md', type: 'User', chars: 1 },
      ],
      totalChars: LONG.length * 2 + 2,
      dupChars: LONG.length,
    });
    expect(JSON.stringify(data)).not.toContain('Regla falsa');
    expect(instructionsData([])).toBeNull();
    expect(instructionsData('x')).toBeNull();
  });
});

describe('servidores MCP', () => {
  it('salen de los nombres mcp__<server>__<tool> y cuentan herramientas distintas', () => {
    expect(
      mcpServersFrom([
        'Read',
        'mcp__claude_ai_Falso__buscar',
        'mcp__claude_ai_Falso__leer',
        'mcp__claude_ai_Falso__leer',
        'mcp__otro__x',
        'mcp__raro',
        'servidor sin prefijo',
        42,
      ]),
    ).toEqual([
      { name: 'claude_ai_Falso', tools: 2 },
      { name: 'otro', tools: 1 },
    ]);
    expect(mcpServersFrom(undefined)).toEqual([]);
  });
});

describe('eventos sueltos', () => {
  it('interrupcion, comando, compactacion y error de API', () => {
    expect(interruptOf('[Request interrupted by user for tool use]')).toEqual({ forTool: true });
    expect(interruptOf(' [Request interrupted by user]')).toEqual({ forTool: false });
    expect(interruptOf('texto normal')).toBeNull();
    expect(commandName('<command-message>x</command-message>\n<command-name>/mi-skill</command-name>')).toBe('mi-skill');
    expect(commandName('sin comando')).toBeNull();
    expect(compactData({ trigger: 'auto', preTokens: 180000, postTokens: 9000, durationMs: 5 })).toEqual({
      trigger: 'auto',
      preTokens: 180000,
      postTokens: 9000,
    });
    expect(compactData(undefined)).toEqual({ trigger: null, preTokens: null, postTokens: null });
    expect(apiErrorCategory({ status: 529, message: 'x' })).toBe('http_529');
    expect(apiErrorCategory({ connection: { code: 'X' }, isNetworkDown: false })).toBe('connection');
    expect(apiErrorCategory({ message: 'x' })).toBeNull();
  });
});

// ---- ingesta de un CLAUDE_HOME temporal (fuera del arbol) ----

const SID = '55555555-6666-4777-8888-999999999999';
const PROJECT = 'C--demo-senales-falso';
const SUB_ID = 'asenales0000000001';
const LEAD_REL = `projects/${PROJECT}/${SID}.jsonl`;
const SUB_REL = `projects/${PROJECT}/${SID}/subagents/agent-${SUB_ID}.jsonl`;
const FILE = 'C:\\demo\\senales-falso\\grande.ts';
const base = { sessionId: SID, cwd: 'C:\\demo\\senales-falso', isSidechain: false, gitBranch: 'main' };
const sub = { ...base, isSidechain: true, agentId: SUB_ID, gitBranch: 'rama-del-subagente' };
const t = (s: number) => `2026-03-02T10:00:${String(s).padStart(2, '0')}.000Z`;
const usage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const assistant = (b: object, uuid: string, s: number, id: string, content: unknown[]) =>
  line({ ...b, type: 'assistant', uuid, timestamp: t(s), message: { id, model: 'claude-sonnet-5', role: 'assistant', content, usage } });
const result = (b: object, uuid: string, s: number, toolUseId: string, content: unknown, extra: object = {}, isError = false) =>
  line({
    ...b,
    type: 'user',
    uuid,
    timestamp: t(s),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
    ...extra,
  });

function writeHome(home: TempHome): void {
  const lead =
    line({ ...base, type: 'user', uuid: 'u-p1', timestamp: t(0), message: { role: 'user', content: 'Tarea falsa de senales' } }) +
    line({
      ...base,
      type: 'attachment',
      uuid: 'at-ins',
      timestamp: t(1),
      attachment: {
        type: 'instructions',
        files: [
          { path: 'C:\\demo\\senales-falso\\CLAUDE.md', type: 'Project', content: `${LONG}\ncorta\n${LONG2}` },
          { path: 'C:\\Users\\falso\\.claude\\CLAUDE.md', type: 'User', content: `  ${LONG}  ` },
        ],
      },
    }) +
    line({
      ...base,
      type: 'attachment',
      uuid: 'at-mcp',
      timestamp: t(1),
      attachment: { type: 'deferred_tools_delta', addedNames: ['Read', 'mcp__srv_falso__buscar', 'mcp__srv_falso__leer', 'mcp__otro__x'], removedNames: [] },
    }) +
    line({ ...base, type: 'attachment', uuid: 'at-mcpi', timestamp: t(1), attachment: { type: 'mcp_instructions_delta', addedNames: ['srv falso'], removedNames: [] } }) +
    assistant(base, 'a-1', 2, 'msg_1', [{ type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: FILE } }]) +
    result(base, 'u-r1', 3, 'toolu_r1', 'linea falsa\n'.repeat(3), {
      toolUseResult: { type: 'text', file: { filePath: FILE, content: 'x', numLines: 3, startLine: 1, totalLines: 900 } },
    }) +
    assistant(base, 'a-2', 4, 'msg_2', [
      { type: 'tool_use', id: 'toolu_r2', name: 'Read', input: { file_path: FILE, offset: 10, limit: 50 } },
      { type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'npm run test -w server', description: 'Corre pruebas falsas' } },
      { type: 'tool_use', id: 'toolu_b2', name: 'Bash', input: { description: 'Corre pruebas falsas', command: 'npm run test -w server' } },
    ]) +
    result(base, 'u-r2', 5, 'toolu_r2', [{ type: 'text', text: 'abc' }], {
      toolUseResult: { type: 'text', file: { filePath: FILE, content: 'abc', numLines: 50, startLine: 10, totalLines: 900 } },
    }) +
    result(base, 'u-b1', 6, 'toolu_b1', 'Error: fallo falso', { toolUseResult: 'Error: fallo falso' }, true) +
    result(base, 'u-b2', 7, 'toolu_b2', 'Permiso negado falso', { toolUseResult: 'Permiso negado falso', toolDenialKind: 'user-rejected' }, true) +
    assistant(base, 'a-3', 8, 'msg_3', [
      { type: 'tool_use', id: 'toolu_p1', name: 'PowerShell', input: { command: 'git status' } },
      { type: 'tool_use', id: 'toolu_s1', name: 'Skill', input: { skill: 'mi-skill-falsa' } },
    ]) +
    line({ ...base, type: 'user', uuid: 'u-int', timestamp: t(9), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) +
    line({
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 's-cmp',
      timestamp: t(10),
      compactMetadata: { trigger: 'manual', preTokens: 150000, postTokens: 20000, durationMs: 1 },
    }) +
    line({ ...base, type: 'system', subtype: 'api_error', uuid: 's-err', timestamp: t(11), retryAttempt: 2, maxRetries: 10, error: { status: 529, message: 'falso' } }) +
    line({
      ...base,
      type: 'assistant',
      uuid: 'a-err',
      timestamp: t(12),
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error falso' }] },
    }) +
    line({
      ...base,
      gitBranch: 'feature/senales',
      type: 'user',
      uuid: 'u-cmd',
      timestamp: t(13),
      message: { role: 'user', content: '<command-message>mi-comando</command-message>\n<command-name>/mi-comando</command-name>\n<command-args>argumento secreto falso</command-args>' },
    }) +
    line({ ...base, gitBranch: 'feature/senales', type: 'user', uuid: 'u-meta', timestamp: t(13), isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'contenido falso de la skill' }] } }) +
    line({ ...base, gitBranch: 'feature/senales', type: 'user', uuid: 'u-cmd2', timestamp: t(14), message: { role: 'user', content: '<command-name>/compact</command-name>' } }) +
    line({ ...base, gitBranch: 'feature/senales', type: 'user', uuid: 'u-out', timestamp: t(15), message: { role: 'user', content: '<local-command-stdout>Compactado falso</local-command-stdout>' } });
  home.write(LEAD_REL, lead);

  const subLines =
    line({ ...sub, type: 'user', uuid: 'su-1', timestamp: t(20), message: { role: 'user', content: 'tarea falsa del subagente' } }) +
    line({ ...sub, type: 'attachment', uuid: 'sat-ins', timestamp: t(20), attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', type: 'Project', content: 'x' }] } }) +
    line({ ...sub, type: 'system', subtype: 'compact_boundary', uuid: 'ss-cmp', timestamp: t(21), compactMetadata: { trigger: 'auto', preTokens: 1, postTokens: 1 } }) +
    line({
      ...sub,
      type: 'assistant',
      uuid: 'sa-err',
      timestamp: t(22),
      isApiErrorMessage: true,
      error: 'server_error',
      message: { id: 'msg_serr', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error falso' }] },
    }) +
    assistant(sub, 'sa-sk', 23, 'msg_s1', [{ type: 'tool_use', id: 'toolu_ss', name: 'Skill', input: { skill: 'otra-skill' } }]) +
    line({ ...sub, type: 'user', uuid: 'su-int', timestamp: t(24), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  home.write(SUB_REL, subLines);
}

type Row = Record<string, unknown>;

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

describe('ingesta de senales v13', () => {
  it('llena las columnas nuevas de actions, la rama del lead y session_events', async () => {
    home = new TempHome();
    writeHome(home);
    const ctx = await loadFixture('2026-03-02T10:05:00.000Z', home.root);
    const all = (sql: string) => ctx.db.prepare(sql).all() as Row[];
    const actions = () =>
      all(`SELECT tool_use_id, tool, input_hash, cmd_class, read_partial, result_chars, result_lines, result_hash, denied, is_error
           FROM actions ORDER BY tool_use_id`);
    const events = () => all(`SELECT id, agent_id, kind, ts, data FROM session_events ORDER BY id`);

    const byId = new Map(actions().map((a) => [a.tool_use_id, a]));
    expect(byId.get('toolu_r1')).toEqual({
      tool_use_id: 'toolu_r1',
      tool: 'Read',
      input_hash: inputHash({ file_path: FILE }),
      cmd_class: null,
      read_partial: 0,
      result_chars: 36,
      result_lines: 900,
      result_hash: null,
      denied: null,
      is_error: 0,
    });
    expect(byId.get('toolu_r2')).toMatchObject({ read_partial: 1, result_chars: 3, result_lines: 900, result_hash: null });
    expect(byId.get('toolu_b1')).toMatchObject({
      cmd_class: 'test',
      read_partial: null,
      result_lines: null,
      is_error: 1,
      result_hash: textHash('Error: fallo falso'),
      denied: null,
    });
    // mismo input con las claves en otro orden: misma huella
    expect(byId.get('toolu_b2')).toMatchObject({ input_hash: byId.get('toolu_b1')?.input_hash, denied: 'user-rejected', is_error: 1 });
    expect(byId.get('toolu_p1')?.cmd_class).toBe('git_read');
    expect(byId.get('toolu_s1')).toMatchObject({ cmd_class: null, read_partial: null });

    expect(ctx.db.prepare(`SELECT git_branch FROM sessions WHERE session_id = ?`).get(SID)).toEqual({ git_branch: 'feature/senales' });

    const got = events().map((e) => ({ ...e, data: JSON.parse(String(e.data)) as unknown }));
    expect(got).toEqual([
      { id: 'a-3:skill', agent_id: SID, kind: 'skill', ts: Date.parse(t(8)), data: { name: 'mi-skill-falsa', via: 'tool' } },
      { id: 'a-err:api_error', agent_id: SID, kind: 'api_error', ts: Date.parse(t(12)), data: { retryAttempt: null, maxRetries: null, category: 'rate_limit' } },
      {
        id: 'at-ins:instructions',
        agent_id: SID,
        kind: 'instructions',
        ts: Date.parse(t(1)),
        data: {
          files: [
            { name: 'CLAUDE.md', type: 'Project', chars: LONG.length + LONG2.length + 7 },
            { name: 'CLAUDE.md', type: 'User', chars: LONG.length + 4 },
          ],
          totalChars: LONG.length * 2 + LONG2.length + 11,
          dupChars: LONG.length,
        },
      },
      {
        id: 'at-mcp:mcp_loaded',
        agent_id: SID,
        kind: 'mcp_loaded',
        ts: Date.parse(t(1)),
        data: { servers: [{ name: 'srv_falso', tools: 2 }, { name: 'otro', tools: 1 }] },
      },
      { id: 's-cmp:compact', agent_id: SID, kind: 'compact', ts: Date.parse(t(10)), data: { trigger: 'manual', preTokens: 150000, postTokens: 20000 } },
      { id: 's-err:api_error', agent_id: SID, kind: 'api_error', ts: Date.parse(t(11)), data: { retryAttempt: 2, maxRetries: 10, category: 'http_529' } },
      { id: 'sa-err:api_error', agent_id: SUB_ID, kind: 'api_error', ts: Date.parse(t(22)), data: { retryAttempt: null, maxRetries: null, category: 'server_error' } },
      { id: 'sa-sk:skill', agent_id: SUB_ID, kind: 'skill', ts: Date.parse(t(23)), data: { name: 'otra-skill', via: 'tool' } },
      { id: 'su-int:interrupt', agent_id: SUB_ID, kind: 'interrupt', ts: Date.parse(t(24)), data: { forTool: false } },
      { id: 'u-cmd:skill', agent_id: SID, kind: 'skill', ts: Date.parse(t(13)), data: { name: 'mi-comando', via: 'command' } },
      { id: 'u-int:interrupt', agent_id: SID, kind: 'interrupt', ts: Date.parse(t(9)), data: { forTool: true } },
    ]);
    // nada de texto de mensajes ni contenido de archivos
    const raw = JSON.stringify(events());
    for (const secret of ['argumento secreto', 'Regla falsa', 'contenido falso', 'fallo falso']) expect(raw).not.toContain(secret);

    // relectura desde cero sobre una DB vieja (lo que hace la v13): llena todo de nuevo sin duplicar
    const before = { actions: actions(), events: events() };
    ctx.db.exec(`
      UPDATE actions SET input_hash = NULL, cmd_class = NULL, read_partial = NULL, result_chars = NULL,
        result_lines = NULL, result_hash = NULL, denied = NULL;
      UPDATE sessions SET git_branch = NULL;
      DELETE FROM file_offsets;
    `);
    await runBackfill(ctx);
    expect({ actions: actions(), events: events() }).toEqual(before);
    expect(ctx.db.prepare(`SELECT git_branch FROM sessions WHERE session_id = ?`).get(SID)).toEqual({ git_branch: 'feature/senales' });
    ctx.db.close();
  });
});

describe('migracion v13', () => {
  it('agrega columnas y session_events, reclasifica subagentes y relee todo; repetirla no falla', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO agents (agent_id, session_id, kind, agent_type, role, look_type) VALUES ('a1', 's1', 'subagent', 'general-purpose', 'reviewer', 'claude-code-guide')`,
    ).run();
    db.prepare(`INSERT INTO agents (agent_id, session_id, kind, agent_type, role) VALUES ('s1', 's1', 'lead', 'lead', 'orchestrator')`).run();
    db.prepare(`INSERT INTO file_offsets (path_key, path, byte_offset, size, mtime_ms) VALUES ('k', 'p', 1, 1, 1)`).run();
    db.pragma('user_version = 12');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(db.prepare(`SELECT agent_id, role, look_type FROM agents ORDER BY agent_id`).all()).toEqual([
      { agent_id: 'a1', role: null, look_type: null },
      { agent_id: 's1', role: 'orchestrator', look_type: null },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM file_offsets`).get()).toEqual({ n: 0 });
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('actions')).toEqual(
      expect.arrayContaining(['input_hash', 'cmd_class', 'read_partial', 'result_chars', 'result_lines', 'result_hash', 'denied']),
    );
    expect(cols('sessions')).toContain('git_branch');
    expect(cols('session_events')).toEqual(['id', 'session_id', 'agent_id', 'ts', 'kind', 'data']);
    db.close();
  });
});
