import { createHash } from 'node:crypto';
import { baseName } from './labels';

// Senales de consumo que la ingesta guarda para el motor de habitos (actions.* de la v13 y session_events).
// Funciones puras: nunca guardan texto de prompts, comandos ni contenido de archivos; solo clases, conteos,
// basenames y hashes cortos.

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type SessionEventKind = 'compact' | 'api_error' | 'interrupt' | 'instructions' | 'mcp_loaded' | 'skill';

/** system/compact_boundary.compactMetadata */
export interface CompactData {
  trigger: 'manual' | 'auto' | null;
  preTokens: number | null;
  postTokens: number | null;
}

/** reintento (system/api_error) o error final que ve el usuario (assistant isApiErrorMessage, sin reintentos) */
export interface ApiErrorData {
  retryAttempt: number | null;
  maxRetries: number | null;
  /** assistant: su campo `error` ('rate_limit'...) · system: 'http_<status>' o 'connection' */
  category: string | null;
}

export interface InterruptData {
  /** "[Request interrupted by user for tool use]": corto una herramienta, no una respuesta */
  forTool: boolean;
}

/** CLAUDE.md y demas instrucciones que Claude Code adjunta (attachment instructions) */
export interface InstructionsData {
  files: Array<{ name: string; type: string; chars: number }>;
  totalChars: number;
  /** caracteres de lineas repetidas que sobran (ver instructionsDup) */
  dupChars: number;
}

export interface McpLoadedData {
  servers: Array<{ name: string; tools: number }>;
}

export interface SkillData {
  name: string;
  /** tool: el modelo uso el tool Skill · command: el usuario la invoco con /nombre */
  via: 'tool' | 'command';
}

export interface SessionEventData {
  compact: CompactData;
  api_error: ApiErrorData;
  interrupt: InterruptData;
  instructions: InstructionsData;
  mcp_loaded: McpLoadedData;
  skill: SkillData;
}

// ---- acciones ----

export type CmdClass = 'test' | 'build' | 'git_read' | 'other';

const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'playwright', 'cypress']);
/** lanzadores y flags que pueden ir antes del runner: npx vitest, python -m pytest, pnpm exec jest */
const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun', 'exec', 'dlx', 'python', 'python3', 'py']);
const TEST_SCRIPT = /^(npm\s+(run\s+)?test|(go|cargo|dotnet)\s+test)\b/i;
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const BUILD_CMD = /\bnpm\s+run\s+(build|typecheck|lint)\b|\btsc\b|\bvite\s+build\b|\b(cargo|dotnet)\s+build\b/i;
const GIT_READ_CMD = /^\s*git\s+(status|log|diff|show|branch|rev-parse|ls-files|blame|remote)\b/i;

/**
 * El tramo corre pruebas: el runner va en posicion de comando (solo, tras un lanzador o como ruta a su
 * binario). No cuentan `cat vitest.config.ts`, `npm i -D vitest` ni `npx playwright install`.
 */
function runsTests(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i] ?? '')) i++;
  if (TEST_SCRIPT.test(words.slice(i).join(' ').replace(/^[&(]\s*/, ''))) return true;
  for (; i < words.length; i++) {
    const word = (words[i] ?? '').replace(/^['"&(]+|['")]+$/g, '').toLowerCase();
    const name = (word.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe|js|mjs|cjs)$/, '');
    if (!name || name.startsWith('-')) continue;
    if (TEST_RUNNERS.has(name)) return !/^(install|init)$/i.test(words[i + 1] ?? '');
    if (!LAUNCHERS.has(name)) return false;
  }
  return false;
}

/** clase del comando de Bash/PowerShell (el comando no se guarda); null en otras herramientas */
export function cmdClass(tool: string, input: unknown): CmdClass | null {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : '';
  if (command.split(SEGMENT_SPLIT).some(runsTests)) return 'test';
  if (BUILD_CMD.test(command)) return 'build';
  if (GIT_READ_CMD.test(command)) return 'git_read';
  return 'other';
}

/** Read: 1 si pidio un tramo (offset o limit), 0 si leyo el archivo completo; null en otras herramientas */
export function readPartial(tool: string, input: unknown): 0 | 1 | null {
  if (tool !== 'Read') return null;
  if (!isRecord(input)) return 0;
  return (input.offset !== undefined && input.offset !== null) || (input.limit !== undefined && input.limit !== null) ? 1 : 0;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isRecord(v)) return v;
  const out: Rec = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

/** JSON con las claves ordenadas: el mismo input da el mismo texto aunque llegue en otro orden */
export function stableJson(v: unknown): string {
  return JSON.stringify(sortKeys(v)) ?? 'null';
}

/** 16 hex de sha1 */
export function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** huella del input de una herramienta (detecta la misma llamada repetida sin guardar el input) */
export function inputHash(input: unknown): string {
  return textHash(stableJson(input ?? null));
}

// ---- eventos de sesion ----

export function compactData(meta: unknown): CompactData {
  const m = isRecord(meta) ? meta : {};
  return {
    trigger: m.trigger === 'manual' || m.trigger === 'auto' ? m.trigger : null,
    preTokens: num(m.preTokens),
    postTokens: num(m.postTokens),
  };
}

/** system/api_error: el objeto `error` trae el status HTTP o el fallo de conexion */
export function apiErrorCategory(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const status = num(error.status);
  if (status !== null) return `http_${status}`;
  if (isRecord(error.connection) || error.isNetworkDown === true) return 'connection';
  return null;
}

const INTERRUPT = '[Request interrupted by user';

export function interruptOf(text: string): InterruptData | null {
  const t = text.trim();
  if (!t.startsWith(INTERRUPT)) return null;
  return { forTool: t.includes('for tool use]') };
}

const COMMAND_NAME = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

/** nombre del /comando que escribio el usuario, sin la barra (los argumentos nunca se leen) */
export function commandName(text: string): string | null {
  if (!text.includes('<command-name>')) return null;
  return COMMAND_NAME.exec(text)?.[1] ?? null;
}

/** lineas mas cortas no cuentan como repetidas (titulos, separadores, listas cortas) */
const DUP_MIN_LINE = 40;

/**
 * Caracteres de lineas repetidas entre todos los archivos de un mismo attachment: cada linea (sin
 * espacios a los lados, >= 40 caracteres) que aparece n >= 2 veces suma su largo x (n - 1), lo que
 * sobra si se deja una sola copia.
 */
export function instructionsDup(contents: string[]): number {
  const seen = new Map<string, number>();
  for (const content of contents) {
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length >= DUP_MIN_LINE) seen.set(line, (seen.get(line) ?? 0) + 1);
    }
  }
  let dup = 0;
  for (const [line, n] of seen) if (n >= 2) dup += line.length * (n - 1);
  return dup;
}

/** attachment instructions -> basenames, tipos y tamanos (el contenido no se guarda); null sin archivos */
export function instructionsData(files: unknown): InstructionsData | null {
  if (!Array.isArray(files)) return null;
  const out: InstructionsData['files'] = [];
  const contents: string[] = [];
  for (const f of files) {
    if (!isRecord(f)) continue;
    const content = typeof f.content === 'string' ? f.content : '';
    out.push({
      name: typeof f.path === 'string' ? baseName(f.path) : '',
      type: typeof f.type === 'string' ? f.type : '',
      chars: content.length,
    });
    contents.push(content);
  }
  if (out.length === 0) return null;
  return { files: out, totalChars: out.reduce((s, f) => s + f.chars, 0), dupChars: instructionsDup(contents) };
}

const MCP_TOOL = /^mcp__(.+?)__./;

/** servidores MCP y cuantas herramientas distintas trae cada uno, de nombres `mcp__<server>__<tool>` */
export function mcpServersFrom(names: unknown): McpLoadedData['servers'] {
  if (!Array.isArray(names)) return [];
  const byServer = new Map<string, Set<string>>();
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const server = MCP_TOOL.exec(n)?.[1];
    if (!server) continue;
    let tools = byServer.get(server);
    if (!tools) byServer.set(server, (tools = new Set()));
    tools.add(n);
  }
  return [...byServer].map(([name, tools]) => ({ name, tools: tools.size }));
}
