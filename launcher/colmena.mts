// Lanzador de Colmena. Levanta server y web sin el ruido de `npm run dev`, espera a que respondan y abre el
// navegador. Los hijos comparten esta consola: cerrar la ventana o Ctrl+C apaga todo, asi que no hace falta
// matar procesos. Solo en un fallo se cierran por su handle (child.kill).
// Con --oculto (lo usa launcher/Colmena.js, el del acceso directo) la consola no se ve: el server se apaga
// solo cuando no queda ninguna pestana abierta, este proceso cierra la web y sale; si algo falla, deja el
// motivo en ERROR_FILE para que Colmena.js lo muestre en un mensaje.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type { HealthResponse } from '../web/src/hud/onboarding/firstRead.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = 4317;
const WEB_PORT = 5317;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/api/health`;
const START_TIMEOUT_MS = 90_000;
const POLL_MS = 700;
const TAIL_LINES = 14;
// Codigo de salida de un proceso cortado con Ctrl+C en Windows (STATUS_CONTROL_C_EXIT)
const CTRL_C_EXIT = 0xc000013a;

const HIDDEN = process.argv.includes('--oculto');
/** Sin pestanas abiertas durante este tiempo, la Colmena oculta se apaga (cubre recargas y cortes cortos) */
const HIDDEN_IDLE_EXIT_MS = 180_000;
// UTF-16 con BOM: es lo que Scripting.FileSystemObject lee sin romper las tildes
const ERROR_FILE = path.join(ROOT, 'server', 'data', 'lanzador-error.txt');
// Solo para las pruebas del modo oculto: no abre el navegador
const NO_BROWSER = process.env.COLMENA_NO_ABRIR === '1';
if (HIDDEN) fs.rmSync(ERROR_FILE, { force: true });

function writeError(lines: string[]): void {
  fs.mkdirSync(path.dirname(ERROR_FILE), { recursive: true });
  fs.writeFileSync(ERROR_FILE, `﻿${lines.join('\r\n')}`, 'utf16le');
}

const webTsconfig = path.join(ROOT, 'web', 'tsconfig.json');
const loadWeb = (rel: string) =>
  tsImport(pathToFileURL(path.join(ROOT, 'web', 'src', rel)).href, { parentURL: import.meta.url, tsconfig: webTsconfig });

const { APP_NAME, APP_TAGLINE, APP_CREDIT } = (await loadWeb('lib/brand.ts')) as Record<string, string>;
let logo: ReadonlyArray<ReadonlyArray<string | null>> | null = null;
try {
  logo = (await loadWeb('lib/sprite.ts')).LOGO_GRID;
} catch {
  logo = null;
}

// ---------- pintura en la consola ----------

const out = process.stdout;
const TTY = out.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR && out.hasColors(2 ** 24);

const GOLD = '#F2C14E';
const TEAL = '#33D9C1';
const AMBER = '#F0A04B';
const RED = '#F2665E';

function rgb(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
}
const paint = (hex: string, s: string) => (COLOR ? `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m` : s);
const bold = (s: string) => (COLOR ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[22m` : s);

/** Dos filas del dibujo por linea de texto: medio bloque con frente arriba y fondo abajo */
function logoLines(grid: ReadonlyArray<ReadonlyArray<string | null>>): string[] {
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    const width = grid[y]?.length ?? 0;
    for (let x = 0; x < width; x += 1) {
      const top = grid[y]?.[x] ?? null;
      const bottom = grid[y + 1]?.[x] ?? null;
      if (top && bottom) line += `\x1b[38;2;${rgb(top)};48;2;${rgb(bottom)}m▀\x1b[0m`;
      else if (top) line += `\x1b[38;2;${rgb(top)}m▀\x1b[0m`;
      else if (bottom) line += `\x1b[38;2;${rgb(bottom)}m▄\x1b[0m`;
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

function printHeader(): void {
  if (TTY) out.write(`\x1b]0;${APP_NAME}\x07`);
  const text = ['', '', bold(paint(GOLD, APP_NAME)), APP_TAGLINE, '', dim(APP_CREDIT), ''];
  if (COLOR && logo) {
    const art = logoLines(logo);
    out.write(`\n${art.map((l, i) => `   ${l}   ${text[i] ?? ''}`).join('\n')}\n`);
  } else {
    out.write(`\n   ${bold(APP_NAME)} · ${APP_TAGLINE}\n   ${dim(APP_CREDIT)}\n`);
  }
}

type Tone = 'wait' | 'ok' | 'bad';
interface Row {
  label: string;
  tone: Tone;
  text: string;
}

const rows: Record<'server' | 'web' | 'history', Row> = {
  server: { label: 'Servidor', tone: 'wait', text: 'arrancando…' },
  web: { label: 'Oficina', tone: 'wait', text: 'arrancando…' },
  history: { label: 'Historial', tone: 'wait', text: 'esperando al servidor' },
};
let footer: string[] = [];
let drawnLines = 0;
let lastFrame = '';

const LED: Record<Tone, string> = { wait: AMBER, ok: TEAL, bad: RED };

function render(): void {
  const lines = [
    '',
    ...Object.values(rows).map((r) => `   ${paint(LED[r.tone], '●')}  ${r.label.padEnd(10)} ${r.text}`),
    '',
    ...footer,
  ];
  const frame = lines.join('\n');
  if (frame === lastFrame) return;
  lastFrame = frame;
  // Sin TTY no se puede reescribir en el lugar: cada cambio sale como bloque nuevo
  const rewind = TTY && drawnLines > 0 ? `\x1b[${drawnLines}F\x1b[J` : '';
  out.write(`${rewind}${frame}\n`);
  drawnLines = lines.length;
}

// ---------- procesos ----------

interface Proc {
  row: Row;
  child: ChildProcess;
  tail: string[];
}

const procs: Proc[] = [];
let stopping = false;

function launch(row: Row, cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Proc {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const proc = { row, child, tail };
  child.on('error', (err) => void fail(`${row.label}: no se pudo arrancar.`, [err.message], proc));
  child.on('exit', (code) => {
    if (stopping || code === CTRL_C_EXIT) return;
    // Modo oculto: el server salio bien porque no quedaban pestanas abiertas; se cierra la web y listo
    if (HIDDEN && row === rows.server && code === 0) {
      stopping = true;
      for (const p of procs) if (p.child.exitCode === null) p.child.kill();
      process.exit(0);
    }
    // Con Ctrl+C el hijo puede salir antes de que llegue el SIGINT de este proceso: se espera un poco
    setTimeout(() => {
      if (!stopping) void fail(`${row.label} se detuvo${code === null ? '' : ` (código ${code})`}.`, [], proc);
    }, 400);
  });
  procs.push(proc);
  return proc;
}

/** fecha del archivo mas nuevo de una carpeta (sin node_modules ni dist) */
function newestIn(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestIn(full));
    else {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        // se borro entre el listado y la lectura: no cuenta
      }
    }
  }
  return newest;
}

/** la oficina compilada existe y es mas nueva que todo el codigo del que sale */
function buildIsFresh(): boolean {
  const web = path.join(ROOT, 'web');
  let built = 0;
  try {
    built = fs.statSync(path.join(web, 'dist', 'index.html')).mtimeMs;
  } catch {
    return false;
  }
  const sources = [
    newestIn(path.join(web, 'src')),
    newestIn(path.join(web, 'public')),
    newestIn(path.join(ROOT, 'shared')),
    ...['index.html', 'vite.config.ts', 'package.json'].map((f) => {
      try {
        return fs.statSync(path.join(web, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  ];
  return built >= Math.max(...sources);
}

/** compila la oficina; false si falla (se abre en modo de desarrollo) */
function runBuild(viteBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [viteBin, 'build'], { cwd: path.join(ROOT, 'web'), stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function health(url: string): Promise<HealthResponse | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as HealthResponse;
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

async function responds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(): void {
  if (NO_BROWSER) return;
  spawn('explorer.exe', [WEB_URL], { stdio: 'ignore', detached: true }).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitEnter(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: out });
  return new Promise((resolve) =>
    rl.question(dim('   Pulsa Enter para cerrar esta ventana.'), () => {
      rl.close();
      resolve();
    }),
  );
}

async function fail(title: string, detail: string[], culprit?: Proc): Promise<never> {
  if (stopping) return new Promise<never>(() => {});
  stopping = true;
  if (culprit) {
    culprit.row.tone = 'bad';
    culprit.row.text = 'detenido';
  }
  footer = [`   ${paint(RED, title)}`, ...detail.map((d) => `   ${d}`), ''];
  render();
  if (culprit && culprit.tail.length > 0) {
    const width = Math.max(40, (out.columns ?? 100) - 6);
    out.write(`   ${dim('Lo último que escribió:')}\n`);
    for (const line of culprit.tail) out.write(`   ${dim(`  ${line.slice(0, width)}`)}\n`);
    out.write('\n');
  }
  if (HIDDEN) writeError([title, ...detail, ...(culprit?.tail.length ? ['', 'Lo último que escribió:', ...culprit.tail] : [])]);
  for (const p of procs) if (p.child.exitCode === null) p.child.kill();
  if (!HIDDEN) await waitEnter();
  process.exit(1);
}

function historyRow(h: HealthResponse): boolean {
  const row = rows.history;
  if (h.backfill === 'listo') {
    row.tone = 'ok';
    row.text = 'al día';
    return true;
  }
  if (h.backfill === 'error') {
    row.tone = 'bad';
    row.text = 'no se pudo leer todo (la oficina sigue funcionando)';
    return true;
  }
  row.tone = 'wait';
  row.text =
    h.filesTotal > 0 ? `leyendo ${h.filesDone} de ${h.filesTotal} archivos` : 'buscando archivos…';
  return false;
}

process.on('SIGINT', () => {
  if (stopping) return;
  stopping = true;
  footer = [`   ${dim('Cerrando Colmena…')}`];
  render();
  const alive = procs.filter((p) => p.child.exitCode === null);
  const force = setTimeout(() => {
    for (const p of alive) if (p.child.exitCode === null) p.child.kill();
    process.exit(0);
  }, 5_000);
  void Promise.all(alive.map((p) => new Promise((r) => p.child.once('exit', r)))).then(() => {
    clearTimeout(force);
    process.exit(0);
  });
});

// ---------- arranque ----------

printHeader();

// Otra Colmena ya abierta (doble clic repetido o `npm run dev` en otra terminal): solo abre el navegador
if (await health(`${WEB_URL}/api/health`)) {
  out.write(`\n   ${paint(TEAL, '●')}  Colmena ya estaba abierta. La abro en el navegador.\n\n`);
  openBrowser();
  if (!HIDDEN) await sleep(3_000);
  process.exit(0);
}

const busy: number[] = [];
for (const port of [SERVER_PORT, WEB_PORT]) if (!(await isFree(port))) busy.push(port);
// Dos clics seguidos en el acceso directo: la primera Colmena ya tomo los puertos pero aun no responde
if (busy.length > 0 && HIDDEN) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await health(`${WEB_URL}/api/health`)) {
      openBrowser();
      process.exit(0);
    }
    await sleep(1_000);
  }
}
if (busy.length > 0) {
  const what = busy.length > 1 ? `Los puertos ${busy.join(' y ')} están ocupados.` : `El puerto ${busy[0]} está ocupado.`;
  const hint = 'Si Colmena sigue abierta en otra terminal, ciérrala con Ctrl+C y vuelve a abrirla.';
  out.write(`\n   ${paint(RED, what)}\n   ${hint}\n\n`);
  if (HIDDEN) writeError([what, hint]);
  else await waitEnter();
  process.exit(1);
}

const viteBin = path.join(
  path.dirname(createRequire(path.join(ROOT, 'web', 'package.json')).resolve('vite/package.json')),
  'bin',
  'vite.js',
);
const serverEnv = HIDDEN
  ? { ...process.env, OFFICE_IDLE_EXIT_MS: process.env.OFFICE_IDLE_EXIT_MS ?? String(HIDDEN_IDLE_EXIT_MS) }
  : process.env;
launch(rows.server, path.join(ROOT, 'server'), ['--import', 'tsx', 'src/index.ts'], serverEnv);
render();

// La oficina se sirve compilada: React optimizado y un puñado de archivos en vez de cientos de modulos
// sin compilar, asi que carga antes y se mueve mucho mas suelta que en modo de desarrollo. Se compila sola
// la primera vez y cuando cambia el codigo (unos segundos); si la compilacion falla, abre en modo de
// desarrollo como antes. COLMENA_DEV=1 fuerza el modo de desarrollo.
const WEB_DIR = path.join(ROOT, 'web');
let compiled = process.env.COLMENA_DEV !== '1';
if (compiled && !buildIsFresh()) {
  rows.web.text = 'preparando la oficina (solo la primera vez o tras un cambio)…';
  render();
  compiled = await runBuild(viteBin);
  rows.web.text = 'arrancando…';
}
if (!stopping) launch(rows.web, WEB_DIR, compiled ? [viteBin, 'preview'] : [viteBin]);
render();

const deadline = Date.now() + START_TIMEOUT_MS;
let serverUp = false;
let webUp = false;
let historyDone = false;

while (!stopping && !(serverUp && webUp && historyDone)) {
  if (!serverUp || !historyDone) {
    const h = await health(HEALTH_URL);
    if (h) {
      serverUp = true;
      rows.server.tone = 'ok';
      rows.server.text = 'listo';
      historyDone = historyRow(h);
    }
  }
  if (!webUp && (await responds(WEB_URL))) {
    webUp = true;
    rows.web.tone = 'ok';
    rows.web.text = 'lista';
  }
  if (stopping) break;
  if (serverUp && webUp && footer.length === 0) {
    openBrowser();
    footer = [
      `   Abierta en ${bold(paint(GOLD, WEB_URL))}`,
      `   ${dim('Cierra esta ventana para apagar Colmena.')}`,
      '',
    ];
  }
  if (!(serverUp && webUp) && Date.now() > deadline) {
    const culprit = procs.find((p) => p.row.tone !== 'ok');
    await fail('Colmena no terminó de arrancar en 90 s.', [], culprit);
  }
  render();
  await sleep(POLL_MS);
}
