import { Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dirname, join, resolve } from "path";
import { FragmentError, vaultPath } from "../lsp/fragmentRenderer";
import { FragmentRenderer, RenderRequest, RenderResult, liveActive } from "./shared/livePreview";
import { HoverTarget, cursorPreview, hoverError, renderHover } from "./shared/renderHover";
import {
  FRAGMENT_PT,
  MathFragment,
  PAPER_MAX_IMAGE_BYTES,
  PAPER_PT,
  PreambleStatement,
  TopLevelStatement,
  chapterStatements,
  documentStatements,
  fragmentSource,
  hash,
  imageBytes,
  inChapterPreamble,
  needsEnclosingCode,
  paperSource,
  preambleLine,
  projectStatements,
  readSvg,
  typFilesNamed,
  typFilesNamedIn,
  typstMathAt,
} from "./typstFragment";
import { PreambleFailure, isTypstMathRequest } from "./typstLive";
import { scanTypst, typstCallAt } from "./typstScan";

/** What compiles a fragment source in a folder (TypstFragmentRenderer). */
export interface FragmentBackend {
  render(dir: string, source: string): Promise<string>;
}

/** A rendered formula, or a call's page (paper mode). */
export interface RenderedFragment {
  ok: true;
  /** Post-processed SVG (readSvg). */
  svg: string;
  /** A block: display math, or a page. */
  display: boolean;
  /**
   * Size and vertical-align in em (1em = FRAGMENT_PT, a page's PAPER_PT), so font-size
   * changes need no render.
   */
  wEm: number;
  hEm: number;
  vaEm: number;
}

/** How a fragment compiles: a formula (inline or display), or a call on a page. */
type FragmentMode = "inline" | "display" | "paper";

/** A call rendered on a page (the paper hover): the pointer is on its `#name`. */
export interface PaperFragment extends HoverTarget {
  /** Its `#`. */
  readonly from: number;
  /** After its name: the pointer's range is [from, to]. */
  readonly to: number;
  /** After the whole call. */
  readonly callTo: number;
  /** The call's source. */
  readonly body: string;
}

/** The call whose `#name` is at `pos`, when it renders as a page (typstCallAt), or null. */
export function typstPaperAt(doc: Text, pos: number): PaperFragment | null {
  const c = typstCallAt(doc, pos);
  return c && { from: c.from, to: c.nameTo, callTo: c.to, body: doc.sliceString(c.from, c.to) };
}

export type FragmentResult =
  | RenderedFragment
  | {
      ok: false;
      message: string;
      /**
       * The preamble line Typst's error lies on (`book/chapters/ch1.typ:3: #let f(x) = x +`),
       * when it is not the formula's own.
       */
      at?: string;
      /**
       * With `at`: the formula's last rendering under the same statements of its own file,
       * from before a statement it imports broke (the book main's, a template's).
       */
      last?: RenderedFragment;
      /** The renderer itself failed (no binary, a timeout, a crash): not the formula's fault. */
      transient?: true;
    };

/** How a .typ file changed (Obsidian's vault events). */
export type FileEvent = "modify" | "create" | "delete" | "rename";

/** A render as cached: the result, or Typst's error with its line in the fragment document. */
type Outcome = RenderedFragment | { ok: false; message: string; line: number | null };

/** Renders kept, least recently used dropped first (an SVG is about 8 KiB). */
const CACHE_SIZE = 2000;
/**
 * Renders are dropped once .typ changes have been quiet this long: well past the
 * renderer's file watcher (under 50 ms), so a render after the drop sees the last write.
 */
const CHANGE_DEBOUNCE_MS = 300;

/**
 * Typst formula renders for one vault: the preamble for a formula (project part from
 * disk, chapter part from the editor buffer), the backend call, SVG post-processing and
 * an LRU cache of formulas (paper renders are not kept: a page shows images and data
 * files no epoch follows). A key is the folder (relative imports), a hash of the preamble,
 * the mode and the formula, so buffer edits never need an invalidation. The files a
 * preamble reads are not in the key: when one of them is modified, the renders of the
 * files whose preambles read it (dependencies) are dropped and their epoch bumped. A file
 * created, deleted or renamed drops those of every other file. A file never reads itself,
 * and a book's chapters read neither each other nor the book main's includes, so a
 * chapter's autosave (at every typing pause) leaves the other open chapters alone.
 */
export class TypstRender {
  /** Per file, the times its renders were dropped or its failures retried. */
  private epochs = new Map<string, number>();
  /** Per file rendered, the .typ files its preambles may read (dependencies). */
  private reads = new Map<string, ReadonlySet<string>>();
  /** Per .typ file read for `reads`, the .typ files it names (until it changes). */
  private named = new Map<string, readonly string[]>();
  /**
   * Renders that failed for want of the renderer (not cached), by file and key, and whether
   * they were already tried again when the renderer answered another render.
   */
  private failed = new Map<string, { file: string; retried: boolean }>();
  /** Per formula of a file under its own statements above it, its last rendering. */
  private last = new Map<string, RenderedFragment>();
  private listeners = new Set<() => void>();
  private cache = new Map<string, { file: string; outcome: Outcome }>();
  /** The paths changed since the last batch, and whether one came, went or moved. */
  private changed = new Map<string, boolean>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private backend: FragmentBackend,
    private root: string,
  ) {}

  /**
   * Bumped when the renders of `file` were dropped (a file its preambles read changed; its
   * own saves are keyed through the buffer) or its renderer failures are tried again;
   * results computed across a bump are not cached.
   */
  epoch(file: string): number {
    return this.epochs.get(file) ?? 0;
  }

  /** Called after epochs may have changed (a batch of .typ changes, a retry). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * After the renderer may have been fixed (a settings save, live mode switched on): the
   * files with renders that failed for want of it get a new epoch, so live views that keep
   * those failures render them again.
   */
  retryFailed(): void {
    this.retry(() => true);
    this.failed.clear();
  }

  /** Drop every successful result after a compiler setting changes, keeping this instance alive. */
  invalidate(): void {
    const files = new Set<string>([
      ...this.epochs.keys(),
      ...this.reads.keys(),
      ...[...this.cache.values()].map((entry) => entry.file),
      ...[...this.failed.values()].map((entry) => entry.file),
    ]);
    this.cache.clear();
    this.last.clear();
    this.failed.clear();
    for (const file of files) this.epochs.set(file, this.epoch(file) + 1);
    if (files.size) this.notify();
  }

  /**
   * Bump the epochs of the files with a renderer failure `which` selects (marked retried).
   * When the renderer answers a render, each failure not retried yet is tried once more (it
   * came back from a slow start or a restart); one that fails again (its own compile passes
   * the timeout) waits for retryFailed, so retries never loop.
   */
  private retry(which: (f: { retried: boolean }) => boolean): void {
    const files = new Set<string>();
    for (const f of this.failed.values()) {
      if (!which(f)) continue;
      f.retried = true;
      files.add(f.file);
    }
    if (!files.size) return;
    for (const file of files) this.epochs.set(file, this.epoch(file) + 1);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The render of formula `m` of `file`, whose editor text is `doc`. */
  math(file: string, doc: Text, m: MathFragment): Promise<FragmentResult> {
    return this.fragment(file, doc, m.from, m.body, m.display ? "display" : "inline");
  }

  /**
   * The paper render of call `c` of `file` (the paper hover): a page PAPER_WIDTH_PT wide, as
   * tall as the call, in the book's own styles: its document template rules apply too (a
   * theorem's box, captions; the pages they add around the call are not shown). A template
   * that holds its body in a container allows the call no page of its own there: on any
   * Typst error the call renders again without them (a call's own error shows from there).
   * A call naming more than PAPER_MAX_IMAGE_BYTES of images is not rendered (a failure
   * saying so).
   */
  async paper(file: string, doc: Text, c: PaperFragment): Promise<FragmentResult> {
    const bytes = imageBytes(c.body, dirname(file), this.root);
    if (bytes > PAPER_MAX_IMAGE_BYTES) {
      const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;
      return { ok: false, message: `not rendered on hover: its images take ${mb(bytes)} (at most ${mb(PAPER_MAX_IMAGE_BYTES)})` };
    }
    const styled = await this.fragment(file, doc, c.from, c.body, "paper", true);
    if (styled.ok || styled.transient) return styled;
    return this.fragment(file, doc, c.from, c.body, "paper");
  }

  /**
   * The render of `body`, which starts at `from` in `file` (editor text `doc`), in `mode`;
   * with `templates`, the preamble keeps the document template rules (bare `#show:`).
   */
  private async fragment(
    file: string,
    doc: Text,
    from: number,
    body: string,
    mode: FragmentMode,
    templates = false,
  ): Promise<FragmentResult> {
    const epoch = this.epoch(file);
    const project = projectStatements(file, this.root, templates);
    const own = documentStatements(doc);
    this.reads.set(file, this.dependencies(file, project, own));
    const chapter = chapterStatements(own, from, templates);
    const statements: PreambleStatement[] = [
      ...project,
      ...chapter.map((s) => ({ text: s.text, file, line: doc.lineAt(s.from).number })),
    ];
    const preamble = statements.map((s) => s.text).join("\n");
    const dir = dirname(file);
    const key = `${dir}\n${hash(preamble)}\n${mode}\n${body}`;
    // The formula under its file's own statements: the book main and templates aside.
    const formula = `${file}\n${hash(chapter.map((s) => s.text).join("\n"))}\n${mode}\n${body}`;
    // A page may show files no epoch follows (an image, a CSV the call reads): paper renders
    // are not kept, here or in `last` (the hover never reuses a settled render anyway).
    const kept = mode !== "paper";
    const hit = kept ? this.cache.get(key) : undefined;
    let outcome: Outcome;
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      outcome = hit.outcome;
    } else {
      const id = `${file}\n${key}`;
      const source = mode === "paper" ? paperSource(preamble, body) : fragmentSource(preamble, { body, display: mode === "display" });
      const pt = mode === "paper" ? PAPER_PT : FRAGMENT_PT;
      try {
        const svg = readSvg(await this.backend.render(dir, source), `f${hash(key)}-`);
        outcome = svg
          ? {
              ok: true,
              svg: svg.svg,
              display: mode !== "inline",
              wEm: svg.width / pt,
              hEm: svg.height / pt,
              vaEm: svg.baseline === null ? 0 : -(svg.height - svg.baseline) / pt,
            }
          : { ok: false, message: "tinymist returned an unreadable SVG", line: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // No binary, a timeout or a crash says nothing about the formula: not cached. Only
        // formulas are tried again (live views keep their failures; nothing keeps a page's).
        if (!(err instanceof FragmentError)) {
          if (kept && !this.failed.has(id)) this.failed.set(id, { file, retried: false });
          return { ok: false, message, transient: true };
        }
        outcome = { ok: false, message, line: err.line };
      }
      if (kept && epoch === this.epoch(file)) {
        this.cache.set(key, { file, outcome });
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      }
      // The renderer answered: its failures not retried yet go again (this one too, when a
      // hover rendered what a live view keeps as failed).
      this.retry((f) => !f.retried);
      this.failed.delete(id);
    }
    if (outcome.ok) {
      if (!kept) return outcome;
      if (epoch !== this.epoch(file)) return outcome;
      this.last.delete(formula);
      this.last.set(formula, outcome);
      if (this.last.size > CACHE_SIZE) this.last.delete(this.last.keys().next().value!);
      return outcome;
    }
    // Located now, not when cached: lines above a statement may have moved since.
    const at = outcome.line === null ? null : preambleLine(statements, outcome.line);
    if (!at) return { ok: false, message: outcome.message };
    const where = `${vaultPath(at.file, this.root)}:${at.line}: ${at.text}`;
    const last = this.last.get(formula);
    const failure = { ok: false as const, message: outcome.message, at: where };
    return last ? { ...failure, last } : failure;
  }

  /**
   * The .typ files the preambles of `file`'s formulas may read: the book mains bookMain may
   * find (a `main.typ` in its folder and each one above: one may start including it), the
   * files the project statements come from, and the .typ files those statements and the
   * file's own preamble statements name, followed through the text of each file named.
   */
  private dependencies(
    file: string,
    project: readonly PreambleStatement[],
    own: readonly TopLevelStatement[],
  ): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    const add = (path: string, follow: boolean) => {
      if (path === file || out.has(path)) return;
      out.add(path);
      if (follow) queue.push(path);
    };
    const top = resolve(this.root);
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      add(join(dir, "main.typ"), false);
      if (dir === top || dirname(dir) === dir) break;
    }
    for (const s of project) {
      add(s.file, false);
      for (const path of typFilesNamed(s.text, dirname(s.file), this.root)) add(path, true);
    }
    for (const s of own) {
      if (!inChapterPreamble(s)) continue;
      for (const path of typFilesNamed(s.text, dirname(file), this.root)) add(path, true);
    }
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      let named = this.named.get(path);
      if (!named) this.named.set(path, (named = typFilesNamedIn(path, this.root)));
      for (const next of named) add(next, true);
    }
    return out;
  }

  /**
   * A .typ file (absolute path) changed, or a folder moved or went. Batched: 300 ms after
   * the last change, a modified file drops the renders of the files whose preambles read
   * it; any other change drops those of every other file.
   */
  fileChanged(path: string, event: FileEvent): void {
    this.named.delete(path);
    this.changed.set(path, this.changed.get(path) === true || event !== "modify");
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const changed = [...this.changed];
      this.changed.clear();
      if (changed.some(([, moved]) => moved)) this.named.clear();
      const dropped = new Set<string>();
      for (const [file, reads] of this.reads) {
        if (changed.some(([p, moved]) => p !== file && (moved || reads.has(p)))) dropped.add(file);
      }
      if (!dropped.size) return;
      for (const file of dropped) this.epochs.set(file, this.epoch(file) + 1);
      for (const [key, entry] of this.cache) {
        if (dropped.has(entry.file)) this.cache.delete(key);
      }
      this.notify();
    }, CHANGE_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.cache.clear();
    this.last.clear();
    this.failed.clear();
    this.reads.clear();
    this.named.clear();
    this.listeners.clear();
  }
}

/**
 * Live preview's renderer for one file (a FragmentRenderer for livePreview.ts) over the
 * plugin's TypstRender. A formula's request (typstLive.ts) carries its document, so its
 * preamble is the one the hover uses; the epoch is the file's (renders go when a file its
 * preamble reads changes). A failed render keeps the formula's source: Typst's error
 * underlines it, while math that needs the code around it and failures of the renderer
 * itself (no binary, a timeout) keep it quietly. An error on a preamble line is not the
 * formula's: its last rendering under the same statements of its file stays (a template or
 * the book main broken since, the store's cache gone with the epoch), else it is a
 * PreambleFailure (typstLive keeps the last rendering of a statement edit then).
 */
export class TypstLiveRenderer implements FragmentRenderer {
  constructor(
    private readonly typst: TypstRender,
    /** The file's absolute path. */
    readonly file: string,
    /** The document widgets are drawn in. */
    private readonly doc: () => Document,
  ) {}

  get epoch(): number {
    return this.typst.epoch(this.file);
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    if (!isTypstMathRequest(req)) return { ok: false, message: `no Typst renderer for ${req.kind}` };
    const r = await this.typst.math(this.file, req.doc, req.math);
    if (r.ok) {
      const node = fragmentElement(r, this.doc());
      return node ? { ok: true, node } : { ok: false, message: "tinymist returned an unreadable SVG" };
    }
    if (r.at) {
      const last = r.last && fragmentElement(r.last, this.doc());
      if (last) return { ok: true, node: last };
      const failure: PreambleFailure = { ok: false, message: `${r.message}\n${r.at}`, preamble: true };
      return failure;
    }
    if (r.transient || needsEnclosingCode(req.doc, req.math, r.message)) {
      return { ok: false, message: r.message, quiet: true };
    }
    return { ok: false, message: r.message };
  }

  subscribe(onChange: () => void): () => void {
    let epoch = this.epoch;
    return this.typst.onChange(() => {
      // The file's own saves leave its epoch alone: nothing to redraw.
      if (this.epoch === epoch) return;
      epoch = this.epoch;
      onChange();
    });
  }
}

/**
 * A rendered fragment as an element of `doc`: an inline span sitting on the text
 * baseline, or a centred block for display math.
 */
export function fragmentElement(r: RenderedFragment, doc: Document): HTMLElement | null {
  const Parser = doc.defaultView?.DOMParser ?? DOMParser;
  const parsed = new Parser().parseFromString(r.svg, "image/svg+xml").documentElement;
  if (parsed.nodeName !== "svg") return null;
  const svg = doc.importNode(parsed, true) as unknown as SVGSVGElement;
  svg.querySelectorAll("script").forEach((el) => el.remove());
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = `${r.wEm}em`;
  svg.style.height = `${r.hEm}em`;
  if (!r.display) svg.style.verticalAlign = `${r.vaEm}em`;
  const box = doc.createElement(r.display ? "div" : "span");
  box.className = r.display ? "tym-fragment is-display" : "tym-fragment";
  box.append(svg);
  return box;
}

/**
 * A paper render (a call's page) as an element of `doc`: a white card of the page's size,
 * inverted when `inverted` (the preview's invert setting in a dark theme).
 */
export function paperElement(r: RenderedFragment, doc: Document, inverted: boolean): HTMLElement | null {
  const el = fragmentElement(r, doc);
  if (!el) return null;
  el.classList.add("is-paper", "lsp-lp-paper");
  el.classList.toggle("is-inverted", inverted);
  return el;
}

/** What the render hover and the cursor preview need from their view. */
export interface TypstRenderHost {
  renderer(): TypstRender | null;
  path(): string | null;
  enabled(): boolean;
  /** Paper renders show inverted (the preview's invert setting, in a dark theme). */
  inverted?(): boolean;
}

/**
 * The rendering of formula or call `t` in `view` from the current buffer, Typst's error
 * with the source or the preamble line it lies on, or null: no renderer, or a fragment that
 * needs the code around it (a loop's or closure's variable; the document compiles, only the
 * fragment cannot).
 */
function renderFragment(host: TypstRenderHost, t: MathFragment | PaperFragment, view: EditorView): Promise<HTMLElement | null> | null {
  const renderer = host.renderer();
  const path = host.path();
  if (!renderer || !path) return null;
  const doc = view.dom.ownerDocument;
  const text = view.state.doc;
  const paper = "callTo" in t;
  // A call's error shows its first line, not the whole call.
  const source = paper ? t.body.split("\n", 1)[0] : t.body;
  return (paper ? renderer.paper(path, text, t) : renderer.math(path, text, t)).then((r) => {
    if (!r.ok) {
      if (!r.at && needsEnclosingCode(text, { from: t.from, to: paper ? t.callTo : t.to }, r.message)) return null;
      return hoverError(r.message, r.at ?? source, doc);
    }
    const el = paper ? paperElement(r, doc, host.inverted?.() ?? false) : fragmentElement(r, doc);
    return el ?? hoverError("tinymist returned an unreadable SVG", source, doc);
  });
}

/**
 * The render hover for Typst (a section above tinymist's text hover): the formula under the
 * pointer, or, with the pointer on the `#name` of a call that renders as a page (a content
 * body, `#figure`, `#image`; at most PAPER_MAX_CHARS), the call on a white page
 * PAPER_WIDTH_PT wide in the book's styles (paper mode). Rendered from the current buffer;
 * failures show Typst's error (see renderFragment).
 */
export function typstRenderHover(host: TypstRenderHost): Extension {
  return renderHover<MathFragment | PaperFragment>({
    enabled: host.enabled,
    target: (state, pos) => typstMathAt(state.doc, pos) ?? typstPaperAt(state.doc, pos),
    render: (t, view) => renderFragment(host, t, view),
  });
}

/**
 * The cursor preview for Typst math (setting `cursorPreview`): the formula around the main
 * cursor rendered below it while it is typed. Inline math in both modes; display math in
 * source mode, and in live preview only when it is not a block (a revealed block keeps its
 * own rendering below it, also under an error diagnostic) or live preview does not decorate
 * (a document grown past its maxLines).
 */
export function typstCursorPreview(host: TypstRenderHost): Extension {
  return cursorPreview<MathFragment>({
    enabled: host.enabled,
    target: (state) => {
      const m = typstMathAt(state.doc, state.selection.main.head);
      if (!m?.display || !liveActive(state)) return m;
      return scanTypst(state.doc).some((c) => c.kind === "math" && c.from === m.from && c.block) ? null : m;
    },
    render: (m, view) => renderFragment(host, m, view),
  });
}
