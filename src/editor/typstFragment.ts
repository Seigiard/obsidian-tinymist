import { Text } from "@codemirror/state";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { FRAGMENT_MARK } from "../lsp/fragmentRenderer";
import { typBookMain } from "../sources";
import type { HoverTarget } from "./shared/renderHover";
import { typstMathSpans } from "./typstEditor";

// Typst fragments: a formula compiled on its own with the definitions it needs. The
// preamble repeats the book main's statements before its include of the chapter (or a
// `.tinymist-fragment.typ` above the file) and the chapter's own statements before the
// formula; a frame then crops the page to the ink and marks the baseline. A call's paper
// render keeps the document template rules too (the book's look) on a page of its own.

/** A project file whose statements replace the book main's in fragment preambles. */
export const FRAGMENT_PREAMBLE = ".tinymist-fragment.typ";

/** The text size fragments compile at: an SVG displays at 1em when scaled by 1/16. */
export const FRAGMENT_PT = 16;

/** Text colour of the frame, replaced by currentColor so renders follow the theme. */
const INK = "#0a0b0c";
/** Colour of the baseline marker, a 0.1pt square Typst draws first (the fragment's mark). */
const MARK = FRAGMENT_MARK;

const FRAME = [
  "#set page(width: auto, height: auto, margin: 0pt, fill: none, header: none, footer: none, background: none, foreground: none, numbering: none)",
  // Page edges at the ink bounds; the default edges clip subscripts and limits.
  `#set text(fill: rgb("${INK}"), size: ${FRAGMENT_PT}pt, top-edge: "bounds", bottom-edge: "bounds")`,
  "#set math.equation(numbering: none)",
].join("\n");

const MARKER = `#box(width: 0pt, height: 0pt, place(rect(width: 0.1pt, height: 0.1pt, fill: rgb("${MARK}"))))`;

/** The page width a call's paper render compiles at (`#theorem[…]`, `#figure(…)`). */
export const PAPER_WIDTH_PT = 400;
/**
 * Points per em of a paper render: 12pt shows at the editor's text size (16px), so the
 * page is as large as a PDF at 100%.
 */
export const PAPER_PT = 12;

/**
 * The most bytes of image files a call may name for its paper render. A page embeds its
 * images: on the scratch typst-book a 9 MB PNG took 0.2 s to render and 0.3 s to show, a
 * 25 MB one 3.5 s and 1.2 s, and one past 50 MB passed the render timeout, which stops the
 * renderer live views use.
 */
export const PAPER_MAX_IMAGE_BYTES = 10 * 2 ** 20;

/** Colour of a reference a paper render cannot resolve (link-like, as live preview's chips). */
const REF_INK = "#2a5db0";

/**
 * A page of fixed width, as tall as the call, white, without the template's chrome, marked
 * (the fragment's mark in its foreground: a kept template may add pages before or after
 * it). A call rendered alone cannot resolve what lies outside it (another chapter's label,
 * a heading numbered outside it, a bibliography entry): such references and citations show
 * as `@key` and `[key]` instead of failing the page.
 */
const PAPER_FRAME = [
  `#set page(width: ${PAPER_WIDTH_PT}pt, height: auto, margin: 6pt, fill: white, header: none, footer: none, ` +
    `background: none, foreground: place(rect(width: 0.1pt, height: 0.1pt, fill: rgb("${MARK}"))), numbering: none)`,
  `#show ref: it => if it.element == none or it.element.at("numbering", default: none) == none { text(fill: rgb("${REF_INK}"))[\\@#str(it.target)] } else { it }`,
  `#show cite: it => text(fill: rgb("${REF_INK}"))[\\[#str(it.key)\\]]`,
].join("\n");

// ---- Top-level statements ------------------------------------------------------------

export interface TopLevelStatement {
  kind: "import" | "include" | "let" | "set" | "show";
  /** From its `#` to its end, trailing spaces and a line comment excluded. */
  text: string;
  from: number;
  to: number;
}

const STATEMENT = /#(import|include|let|set|show)(?![\w-])/y;
const IDENT = /[A-Za-z_][\w-]*/y;
/** Keywords whose embedded expression runs to the end of the line (bodies included). */
export const LINE_KEYWORDS: ReadonlySet<string> = new Set([
  "let", "set", "show", "import", "include", "if", "for", "while", "context", "return",
]);

const lineEnd = (s: string, i: number) => {
  const at = s.indexOf("\n", i);
  return at < 0 ? s.length : at;
};

function blockCommentEnd(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    if (s.startsWith("/*", i)) (depth++, (i += 2));
    else if (s.startsWith("*/", i)) {
      i += 2;
      if (--depth === 0) return i;
    } else i++;
  }
  return i;
}

/** After a comment or raw text starting at `i`, or -1 when none starts there. */
export function skipTrivia(s: string, i: number): number {
  const c = s[i];
  if (c === "/" && s[i + 1] === "/" && s[i - 1] !== ":") return lineEnd(s, i);
  if (c === "/" && s[i + 1] === "*") return blockCommentEnd(s, i);
  if (c === "`") {
    let k = 1;
    while (s[i + k] === "`") k++;
    // `` is an empty raw; ``` opens a block closed by the same run.
    if (k === 2) return i + 2;
    const close = k >= 3 ? "`".repeat(k) : "`";
    const at = s.indexOf(close, i + k);
    return at < 0 ? s.length : at + close.length;
  }
  return -1;
}

/** After a code string starting at `i` (it ends at its quote or the line end). */
function skipString(s: string, i: number): number {
  i++;
  while (i < s.length && s[i] !== '"' && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * Embedded expressions (`#…` in content or math) the group skips look into, nested: deeper
 * ones (only ever pathological) are passed over as text, so the recursion through
 * skipGroup and skipEmbedded never overflows the stack (the brackets still pair).
 */
const MAX_NESTING = 100;

/**
 * skipGroup's results in the text it last scanned, by where the group opens. An unclosed
 * group falls back to its line's end (skipEmbedded, codeLineEnd), so the group around it
 * goes on and meets the next unclosed one again: unmemoized, each was scanned once per
 * unclosed group around it, and a dozen unclosed `#box[` lines took seconds (twice as
 * long with each one more). `depth` is not in the key: it only changes a result past
 * MAX_NESTING levels, where brackets still pair the same way.
 */
let endsOf = "";
const groupEnds = new Map<number, number>();

/**
 * After the group `(…)`, `{…}`, `[…]` or `$…$` opening at `i`, or -1 when it is not
 * closed. Code groups skip strings and comments; content and math skip escapes and
 * embedded `#` expressions; any of them nests the others. `depth` counts the embedded
 * expressions it lies in.
 */
export function skipGroup(s: string, i: number, depth = 0): number {
  if (s !== endsOf) groupEnds.clear();
  // Also when equal: the next comparisons then find the same string, not equal text.
  endsOf = s;
  let end = groupEnds.get(i);
  if (end === undefined) groupEnds.set(i, (end = groupEnd(s, i, depth)));
  return end;
}

function groupEnd(s: string, i: number, depth: number): number {
  const stack = [s[i]];
  i++;
  while (i < s.length) {
    const mode = stack[stack.length - 1];
    const c = s[i];
    if (mode !== "$") {
      const t = skipTrivia(s, i);
      if (t >= 0) {
        i = t;
        continue;
      }
    }
    if (mode === "[" || mode === "$") {
      if (c === "\\") i += 2;
      else if (c === "#" && depth < MAX_NESTING) i = Math.max(skipEmbedded(s, i + 1, mode === "$", depth + 1), i + 1);
      else if (mode === "$" && c === '"') i = skipString(s, i);
      else if (c === "$" && mode === "$") {
        stack.pop();
        i++;
      } else if (c === "$" || (c === "[" && mode === "[")) {
        stack.push(c);
        i++;
      } else if (c === "]" && mode === "[") {
        stack.pop();
        i++;
      } else i++;
    } else if (c === '"') {
      i = skipString(s, i);
    } else if ("([{$".includes(c)) {
      stack.push(c);
      i++;
    } else if (c === ")" || c === "}") {
      stack.pop();
      i++;
    } else i++;
    if (!stack.length) return i;
  }
  return -1;
}

/**
 * After a code line from `i`: the newline or `;` at depth 0, a line comment, or a closer
 * of the enclosing group (`#if a [b]]` inside a content block, `$` in math).
 */
function codeLineEnd(s: string, i: number, inMath = false, depth = 0): number {
  while (i < s.length) {
    const c = s[i];
    if (c === "\n" || c === "]" || c === ")" || c === "}" || (inMath && c === "$")) return i;
    if (c === ";") return i + 1;
    if (c === "/" && s[i + 1] === "/") return i;
    const t = skipTrivia(s, i);
    if (t >= 0) i = t;
    else if (c === '"') i = skipString(s, i);
    else if ("([{$".includes(c)) {
      const end = skipGroup(s, i, depth);
      // An unclosed group (typing in progress) ends the statement at its line.
      if (end < 0) return lineEnd(s, i);
      i = end;
    } else i++;
  }
  return s.length;
}

/**
 * After the embedded expression right after a `#` at `i - 1` (`#f(x)[y].z`,
 * `#(a, b).map(f)`, `#if …`); `inMath` when that `#` is in math, `depth` as for skipGroup.
 */
export function skipEmbedded(s: string, i: number, inMath = false, depth = 0): number {
  const c = s[i];
  let j: number;
  if (c === "(" || c === "[" || c === "{") {
    j = skipGroup(s, i, depth);
    if (j < 0) return lineEnd(s, i);
  } else if (c === '"') {
    j = skipString(s, i);
  } else {
    IDENT.lastIndex = i;
    const id = IDENT.exec(s);
    if (!id) return i;
    if (LINE_KEYWORDS.has(id[0])) return codeLineEnd(s, i + id[0].length, inMath, depth);
    j = i + id[0].length;
  }
  // Calls, content arguments and fields chain onto any of them, as in Typst.
  for (;;) {
    if (s[j] === "(" || s[j] === "[") {
      const end = skipGroup(s, j, depth);
      if (end < 0) return lineEnd(s, j);
      j = end;
      continue;
    }
    IDENT.lastIndex = j + 1;
    const field = s[j] === "." && IDENT.exec(s);
    if (!field) return j;
    j += 1 + field[0].length;
  }
}

/** Characters that start an escape, a comment, raw text, math or code in markup. */
const TOP_LEVEL_SPECIAL = /[\\/`$#]/g;

/**
 * The `#import/#include/#let/#set/#show` statements at the top level of a Typst markup
 * file, in order. A statement runs to the end of its line with every bracket balanced,
 * so a multi-line `#let thm(body) = block(…)[…]` is one statement; statements inside a
 * content block (`#theorem[#set …]`), comments, raw text and math are not top level.
 * The other top-level `#` expressions (`#table(…)`, `#for …`) go to `code` when given.
 */
export function topLevelStatements(text: string, code?: { from: number; to: number }[]): TopLevelStatement[] {
  const out: TopLevelStatement[] = [];
  let i = 0;
  while (i < text.length) {
    // Straight to the next character that may start something (plain text is most of it).
    TOP_LEVEL_SPECIAL.lastIndex = i;
    const next = TOP_LEVEL_SPECIAL.exec(text);
    if (!next) break;
    i = next.index;
    const c = text[i];
    const t = skipTrivia(text, i);
    if (c === "\\") {
      i += 2;
    } else if (t >= 0) {
      i = t;
    } else if (c === "$") {
      const end = skipGroup(text, i);
      i = end < 0 ? i + 1 : end;
    } else if (c === "#") {
      const stmt = statementAt(text, i);
      if (stmt) {
        out.push(stmt.statement);
        i = stmt.next;
      } else {
        const end = Math.max(skipEmbedded(text, i + 1), i + 1);
        code?.push({ from: i, to: end });
        i = end;
      }
    } else {
      i++;
    }
  }
  return out;
}

/**
 * The statement whose `#` is at `i` when it is `#import/#include/#let/#set/#show` (as
 * topLevelStatements takes it at the top level), with where scanning goes on after it.
 */
export function statementAt(text: string, i: number): { statement: TopLevelStatement; next: number } | null {
  STATEMENT.lastIndex = i;
  const m = STATEMENT.exec(text);
  if (!m) return null;
  const end = codeLineEnd(text, i + m[0].length);
  const stmt = text.slice(i, end).trimEnd();
  return {
    statement: { kind: m[1] as TopLevelStatement["kind"], text: stmt, from: i, to: i + stmt.length },
    next: Math.max(end, i + 1),
  };
}

interface TopLevel {
  statements: readonly TopLevelStatement[];
  code: readonly { from: number; to: number }[];
}

const topLevelCache = new WeakMap<Text, TopLevel>();

/** topLevelStatements of an editor document and its other top-level code, memoized per Text. */
function documentTopLevel(doc: Text): TopLevel {
  let top = topLevelCache.get(doc);
  if (!top) {
    const code: { from: number; to: number }[] = [];
    topLevelCache.set(doc, (top = { statements: topLevelStatements(doc.toString(), code), code }));
  }
  return top;
}

/** topLevelStatements of an editor document, memoized per Text. */
export function documentStatements(doc: Text): readonly TopLevelStatement[] {
  return documentTopLevel(doc).statements;
}

// ---- Preamble --------------------------------------------------------------------------

/** A bare `#show: f` applies a document template (cover, outline, page setup): dropped. */
const templateRule = (s: TopLevelStatement) => s.kind === "show" && /^#show\s*:/.test(s.text);

/** A statement of the file that joins the preambles of its fragments below it (chapterStatements). */
export const inChapterPreamble = (s: TopLevelStatement): boolean => s.kind !== "include" && !templateRule(s);

const insideRoot = (rel: string) => !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);

/**
 * A module path (`#import`/`#include`) or the leading path of a call that reads a file
 * (`image("…")`, `yaml("…")`), relative (not `/…` or `@pkg`): Typst resolves it from the
 * file it is written in. User functions (`my-image("…")`, `cfg.read("…")`) are not calls
 * of these.
 */
const RELATIVE_PATH =
  /(#(?:import|include)\s+|(?<![\w.-])(?:image|read|json|yaml|toml|csv|xml|cbor|plugin|bibliography)\(\s*)"([^"@/\n][^"\n]*)"/g;

/** Relative paths of a book main's or override's statement made root-absolute: the fragment sits in another folder. */
function rootAbsolute(stmt: TopLevelStatement, dir: string, root: string): string {
  return stmt.text.replace(RELATIVE_PATH, (whole, head: string, path: string) => {
    const rel = relative(root, resolve(dir, path));
    return insideRoot(rel) ? `${head}"/${rel.split(sep).join("/")}"` : whole;
  });
}

/** The 1-based line of each offset in `text`, for ascending offsets. */
function lineCounter(text: string): (offset: number) => number {
  let at = 0;
  let line = 1;
  return (offset) => {
    for (; at < offset; at++) if (text.charCodeAt(at) === 10) line++;
    return line;
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The nearest `.tinymist-fragment.typ` from the file's folder up to the vault root. */
function fragmentOverride(filePath: string, root: string): string | null {
  const top = resolve(root);
  if (!insideRoot(relative(top, resolve(filePath)))) return null;
  for (let dir = dirname(resolve(filePath)); ; dir = dirname(dir)) {
    const candidate = join(dir, FRAGMENT_PREAMBLE);
    if (existsSync(candidate)) return candidate;
    if (dir === top || dirname(dir) === dir) return null;
  }
}

/** A statement of a fragment preamble and where it was written (for error locations). */
export interface PreambleStatement {
  /** As it goes into the preamble (a book main's relative paths made root-absolute). */
  text: string;
  /** The file it was written in, and its first line there (1-based). */
  file: string;
  line: number;
}

/**
 * The project part of a fragment preamble, read from disk: the statements of the nearest
 * `.tinymist-fragment.typ` (all but `#include`), else those of the book main that
 * includes the file (see bookMain) before that include, without `#include` and, unless
 * `templates` (a paper render: the book's look), bare `#show:` rules. Relative import and
 * file paths (`image`, `read`, `yaml`, …) become root-absolute.
 */
export function projectStatements(filePath: string, root: string, templates = false): PreambleStatement[] {
  const override = fragmentOverride(filePath, root);
  if (override) {
    const text = readText(override);
    const lineAt = lineCounter(text);
    return topLevelStatements(text)
      .filter((s) => s.kind !== "include")
      .map((s) => ({ text: rootAbsolute(s, dirname(override), root), file: override, line: lineAt(s.from) }));
  }
  const main = typBookMain(filePath, root);
  if (!main) return [];
  const dir = dirname(main);
  const source = resolve(filePath);
  const text = readText(main);
  const lineAt = lineCounter(text);
  const out: PreambleStatement[] = [];
  for (const s of topLevelStatements(text)) {
    if (s.kind === "include") {
      const path = /^#include\s+"([^"\n]+)"/.exec(s.text)?.[1];
      if (path && resolve(path.startsWith("/") ? root : dir, path.replace(/^\/+/, "")) === source) break;
    } else if (templates || !templateRule(s)) {
      out.push({ text: rootAbsolute(s, dir, root), file: main, line: lineAt(s.from) });
    }
  }
  return out;
}

/** The literal path of an `image("…")` call (not a package's). */
const IMAGE_PATH = /(?<![\w.-])image\(\s*"([^"@\n][^"\n]*)"/g;

/**
 * The size in bytes of the image files `call`, written in folder `dir`, names as literal
 * paths (`image("…")`; `/…` from the vault root).
 */
export function imageBytes(call: string, dir: string, root: string): number {
  let bytes = 0;
  for (const [, path] of call.matchAll(IMAGE_PATH)) {
    try {
      bytes += statSync(path.startsWith("/") ? join(root, path) : resolve(dir, path)).size;
    } catch {
      // A file that cannot be read fails the render with Typst's own error.
    }
  }
  return bytes;
}

/** A quoted path of a .typ file (`#import "x.typ"`, `read("y.typ")`), not a package's. */
const TYP_PATH = /"([^"@\n][^"\n]*\.typ)"/g;

/**
 * The .typ files `text`, written in folder `dir`, names in quotes, as absolute paths
 * (`/…` from the vault root): imports and file reads, and any other such string.
 */
export function typFilesNamed(text: string, dir: string, root: string): string[] {
  return [...text.matchAll(TYP_PATH)].map(([, path]) => (path.startsWith("/") ? join(root, path) : resolve(dir, path)));
}

/** typFilesNamed of the file at `path` (none when it cannot be read). */
export function typFilesNamedIn(path: string, root: string): string[] {
  return typFilesNamed(readText(path), dirname(path), root);
}

/** projectStatements as preamble text. */
export function projectPreamble(filePath: string, root: string): string {
  return projectStatements(filePath, root)
    .map((s) => s.text)
    .join("\n");
}

/**
 * The chapter part: the file's own statements that end before `offset` (the buffer's), bare
 * `#show:` rules only with `templates` (a paper render).
 */
export function chapterStatements(
  statements: readonly TopLevelStatement[],
  offset: number,
  templates = false,
): TopLevelStatement[] {
  const out: TopLevelStatement[] = [];
  for (const s of statements) {
    if (s.to > offset) break;
    if (templates ? s.kind !== "include" : inChapterPreamble(s)) out.push(s);
  }
  return out;
}

/** chapterStatements as preamble text. */
export function chapterPreamble(statements: readonly TopLevelStatement[], offset: number): string {
  return chapterStatements(statements, offset)
    .map((s) => s.text)
    .join("\n");
}

/** cyrb53: a fast 53-bit string hash, in base 36. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The preamble of a fragment at `offset` in `filePath`, whose buffer is `text`. */
export function buildPreamble(filePath: string, text: string, offset: number, root: string): string {
  const parts = [projectPreamble(filePath, root), chapterPreamble(topLevelStatements(text), offset)];
  return parts.filter(Boolean).join("\n");
}

/**
 * The preamble line that line `line` (1-based) of a fragment document falls on, with its
 * file and line there; null past the preamble (the frame and the formula).
 */
export function preambleLine(
  statements: readonly PreambleStatement[],
  line: number,
): { file: string; line: number; text: string } | null {
  let first = 1;
  for (const s of statements) {
    const lines = s.text.split("\n");
    if (line < first + lines.length) {
      const k = line - first;
      return k < 0 ? null : { file: s.file, line: s.line + k, text: lines[k].trim() };
    }
    first += lines.length;
  }
  return null;
}

// ---- Fragments -------------------------------------------------------------------------

/** A formula of the document: a render hover target. */
export interface MathFragment extends HoverTarget {
  /** Its source, `$` delimiters included. */
  readonly body: string;
  /** Whitespace just inside both delimiters (`$ x $`): a block equation. */
  readonly display: boolean;
}

/**
 * The formula around `pos` (its `$` delimiters count as inside), or null: outside math,
 * in an unclosed or empty one, or in math inside a top-level statement (`#let ip(a, b) =
 * $…$` only makes sense with its arguments).
 */
export function typstMathAt(doc: Text, pos: number): MathFragment | null {
  const spans = typstMathSpans(doc);
  // The last formula opening at or before pos.
  let lo = 0;
  let hi = spans.length / 2 - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[2 * mid] - 1 <= pos) (k = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (k < 0) return null;
  const open = spans[2 * k];
  const close = spans[2 * k + 1];
  if (close >= doc.length || pos > close + 1) return null;
  const from = open - 1;
  const to = close + 1;
  if (documentStatements(doc).some((s) => s.from <= from && to <= s.to)) return null;
  const inner = doc.sliceString(open, close);
  if (!inner.trim()) return null;
  return { from, to, body: doc.sliceString(from, to), display: /^\s/.test(inner) && /\s$/.test(inner) };
}

/**
 * Whether formula `m` failed only for want of the code around it, which a fragment
 * leaves out: Typst's `message` is `unknown variable: x` and `x` occurs before the
 * formula in the top-level `#` expression around it (a closure parameter, a `for` or
 * `let` binding: `#rates.map(((k, r)) => [$#r$])`), or it needs a context that a
 * `context` there provides. The document compiles; only the fragment cannot.
 */
export function needsEnclosingCode(doc: Text, m: { from: number; to: number }, message: string): boolean {
  const name =
    /^unknown variable: ([\p{L}\p{N}_-]+)/u.exec(message)?.[1] ??
    (/^can only be used when context is known/.test(message) ? "context" : null);
  const scope = name && documentTopLevel(doc).code.find((c) => c.from < m.from && m.to <= c.to);
  if (!scope) return false;
  const word = new RegExp(`(?<![\\p{L}\\p{N}_-])${name}(?![\\p{L}\\p{N}_-])`, "u");
  return word.test(doc.sliceString(scope.from, m.from));
}

/**
 * The document compiled for a formula: the preamble, then the frame (a page cropped to
 * the ink, text in the ink colour at FRAGMENT_PT, no equation numbers) and the formula,
 * inline math after the baseline marker.
 */
export function fragmentSource(preamble: string, math: { body: string; display: boolean }): string {
  return `${preamble ? `${preamble}\n` : ""}${FRAME}\n${math.display ? "" : MARKER}${math.body}\n`;
}

/**
 * The document compiled for a call's paper render: the preamble (the book's own styles
 * apply, its document template's too when kept), a white page PAPER_WIDTH_PT wide and as
 * tall as the call, marked (references it cannot resolve shown as their keys), then the
 * call.
 */
export function paperSource(preamble: string, call: string): string {
  return `${preamble ? `${preamble}\n` : ""}${PAPER_FRAME}\n${call}\n`;
}

export interface FragmentSvg {
  /** The SVG without the marker, the ink as currentColor, every id prefixed. */
  svg: string;
  /** Size in pt. */
  width: number;
  height: number;
  /** The baseline in pt from the top (null without a marker: display math). */
  baseline: number | null;
}

/**
 * Post-process a fragment page: read its size and the marker's baseline, strip the
 * marker (and a paper page's mark), turn the ink into currentColor (glyphs, fraction bars
 * and rules follow the theme; explicit colours stay), and prefix ids and their references
 * with `idPrefix` (several renders share one document). Null when it is not Typst's SVG.
 */
export function readSvg(svg: string, idPrefix: string): FragmentSvg | null {
  const size = /^<svg\b[^>]*?\swidth="([\d.]+)pt"\s+height="([\d.]+)pt"/.exec(svg);
  if (!size) return null;
  const marker = new RegExp(`<g transform="translate\\(([-\\d.e]+) ([-\\d.e]+)\\)"><path fill="${MARK}"[^>]*/></g>`).exec(svg);
  const out = (marker ? svg.replace(marker[0], "") : svg)
    .replace(new RegExp(`<path fill="${MARK}"[^>]*/>`, "g"), "")
    .replace(new RegExp(`\\b(fill|stroke)="${INK}"`, "g"), '$1="currentColor"')
    .replace(/\bid="([^"]+)"/g, `id="${idPrefix}$1"`)
    .replace(/href="#([^"]+)"/g, `href="#${idPrefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${idPrefix}$1)`);
  return { svg: out, width: +size[1], height: +size[2], baseline: marker ? +marker[2] : null };
}
