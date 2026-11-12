// Lee `export const meta = {...}` de un script del tool Workflow SIN evaluarlo: escaner de llaves
// balanceadas que respeta strings, template literals y comentarios. Solo entiende literales.

export interface WorkflowScriptMeta {
  name: string | null;
  description: string | null;
  /** titulos de meta.phases; null si el meta no declara phases */
  phases: string[] | null;
}

const META_START = /export\s+const\s+meta\s*=\s*\{/;
const IDENT = /^[A-Za-z_$][\w$]*/;
const CLOSE: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

function isQuote(c: string | undefined): boolean {
  return c === '"' || c === "'" || c === '`';
}

function isComment(s: string, i: number): boolean {
  return s[i] === '/' && (s[i + 1] === '/' || s[i + 1] === '*');
}

/** i apunta a // o /*; devuelve el indice siguiente al comentario, o -1 si no cierra */
function skipComment(s: string, i: number): number {
  if (s[i + 1] === '/') {
    const nl = s.indexOf('\n', i);
    return nl < 0 ? s.length : nl + 1;
  }
  const end = s.indexOf('*/', i + 2);
  return end < 0 ? -1 : end + 2;
}

/** i apunta a una comilla; devuelve el indice siguiente al cierre, o -1 si no cierra */
function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && s[j + 1] === '{') {
      const end = skipBalanced(s, j + 1);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (q !== '`' && c === '\n') return -1;
    j++;
  }
  return -1;
}

/** i apunta a { [ o (; devuelve el indice siguiente a su cierre, o -1 si no balancea */
function skipBalanced(s: string, i: number): number {
  const stack: string[] = [];
  let j = i;
  while (j < s.length) {
    const c = s[j] ?? '';
    if (isQuote(c)) {
      j = skipString(s, j);
      if (j < 0) return -1;
      continue;
    }
    if (isComment(s, j)) {
      j = skipComment(s, j);
      if (j < 0) return -1;
      continue;
    }
    const close = CLOSE[c];
    if (close) stack.push(close);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** salta espacios y comentarios sin pasar de `limit` */
function skipTrivia(s: string, i: number, limit: number): number {
  let j = i;
  while (j < limit) {
    if (/\s/.test(s[j] ?? '')) j++;
    else if (isComment(s, j)) {
      const next = skipComment(s, j);
      if (next < 0) return limit;
      j = next;
    } else break;
  }
  return j;
}

function unescapeJs(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_m, e: string) => {
    if (e.length > 1 && e[0] === 'u') {
      const code = parseInt(e.startsWith('u{') ? e.slice(2, -1) : e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (e.length > 1 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    switch (e) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case '\r\n':
      case '\n':
      case '\r':
      case ' ':
      case ' ':
        return '';
      default:
        return e;
    }
  });
}

/** literal de string en i: valor (null si es un template con interpolacion) e indice final */
function readLiteral(s: string, i: number): { value: string | null; end: number } | null {
  if (!isQuote(s[i])) return null;
  const end = skipString(s, i);
  if (end < 0) return null;
  const raw = s.slice(i + 1, end - 1);
  if (s[i] === '`' && /(^|[^\\])\$\{/.test(raw)) return { value: null, end };
  return { value: unescapeJs(raw), end };
}

/** tramos [inicio, fin) de cada elemento al primer nivel del { } o [ ] que abre en `open` */
function topLevelItems(s: string, open: number): Array<[number, number]> | null {
  const end = skipBalanced(s, open);
  if (end < 0) return null;
  const close = end - 1;
  const items: Array<[number, number]> = [];
  let start = open + 1;
  let j = open + 1;
  while (j < close) {
    const c = s[j] ?? '';
    let next = j + 1;
    if (isQuote(c)) next = skipString(s, j);
    else if (isComment(s, j)) next = skipComment(s, j);
    else if (CLOSE[c]) next = skipBalanced(s, j);
    else if (c === ',') {
      items.push([start, j]);
      start = j + 1;
    }
    if (next < 0) return null;
    j = next;
  }
  if (skipTrivia(s, start, close) < close) items.push([start, close]);
  return items;
}

/** propiedades `clave: valor` al primer nivel de un objeto: clave -> tramo del valor */
function objectProps(s: string, open: number): Map<string, [number, number]> | null {
  const items = topLevelItems(s, open);
  if (!items) return null;
  const props = new Map<string, [number, number]>();
  for (const [a, b] of items) {
    const k = skipTrivia(s, a, b);
    let key: string | null = null;
    let j = k;
    const id = IDENT.exec(s.slice(k, b));
    if (id) {
      key = id[0];
      j = k + id[0].length;
    } else {
      const lit = readLiteral(s, k);
      if (!lit || lit.value === null) continue;
      key = lit.value;
      j = lit.end;
    }
    j = skipTrivia(s, j, b);
    if (s[j] !== ':') continue;
    props.set(key, [skipTrivia(s, j + 1, b), b]);
  }
  return props;
}

/** valor de string plano (literal unico, sin concatenar ni interpolar) */
function stringValue(s: string, span: [number, number] | undefined): string | null {
  if (!span) return null;
  const lit = readLiteral(s, span[0]);
  if (!lit || lit.value === null) return null;
  if (skipTrivia(s, lit.end, span[1]) !== span[1]) return null;
  return lit.value.trim();
}

function phaseTitles(s: string, span: [number, number] | undefined): string[] | null {
  if (!span || s[span[0]] !== '[') return null;
  const items = topLevelItems(s, span[0]);
  if (!items) return null;
  const titles: string[] = [];
  for (const [a, b] of items) {
    const start = skipTrivia(s, a, b);
    if (s[start] !== '{') continue;
    const props = objectProps(s, start);
    const title = stringValue(s, props?.get('title'));
    if (title) titles.push(title);
  }
  return titles;
}

/** name, description y titulos de phases del meta; null si no hay un meta legible */
export function parseWorkflowMeta(src: string): WorkflowScriptMeta | null {
  const m = META_START.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const props = objectProps(src, open);
  if (!props) return null;
  return {
    name: stringValue(src, props.get('name')) || null,
    description: stringValue(src, props.get('description')),
    phases: phaseTitles(src, props.get('phases')),
  };
}
