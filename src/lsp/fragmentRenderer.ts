import { basename, isAbsolute, join, relative, sep } from "path";
import { LspClient } from "./client";

/**
 * The document a folder's fragments compile as. It lives only in the renderer's memory
 * (didOpen/didChange, never written), in the chapter's folder, so relative imports and
 * image paths resolve as they do in the chapter.
 */
export const FRAGMENT_DOC = ".obsidian-tinymist-fragment.typ";

/**
 * The ink of the mark a fragment draws on its page (a 0.1pt square: an inline formula's
 * baseline marker, a paper page's foreground). A kept document template may add pages
 * before the fragment or after it: the fragment's page is the one holding the mark.
 */
export const FRAGMENT_MARK = "#010203";

/** A fragment Typst rejects: the same source fails the same way, so it may be cached. */
export class FragmentError extends Error {
  constructor(
    message: string,
    /**
     * The fragment document's line (1-based) of the first error: where Typst located it, or
     * where its trace enters the fragment (the import of a broken template, the call of a
     * template function the formula makes).
     */
    readonly line: number | null = null,
  ) {
    super(message);
  }
}

export interface FragmentRendererOptions {
  /** The tinymist binary, asked on every start (null: none found). */
  bin(): string | null;
  /** The vault root: the workspace, as for the editor's server (root-absolute imports). */
  root: string;
  /** Absolute font paths, read when a new fragment compiler starts. */
  fontPaths?(): readonly string[];
  /** Stop the process after this long without a render (5 min). */
  idleMs?: number;
  /** A render that takes longer fails (5 s). */
  timeoutMs?: number;
}

/**
 * Renders Typst fragments (a formula with the preamble it needs) to SVG through a
 * dedicated `tinymist lsp` process, separate from the editor's server: it never pins a
 * main, its diagnostics are dropped, and its compiles never queue behind the editor's.
 * The process starts on the first render, stops after `idleMs` without one or when a
 * render (its start included) takes longer than `timeoutMs`, restarts when the binary
 * setting changes, and is killed by `stop`/`dispose`.
 */
export class TypstFragmentRenderer {
  private client: LspClient | null = null;
  private clientBin: string | null = null;
  private starting: Promise<LspClient> | null = null;
  /** Virtual documents the running process has open. */
  private opened = new Set<string>();
  /** The last render queued per virtual document: change+export pairs never interleave. */
  private queues = new Map<string, Promise<unknown>>();
  private inFlight = 0;
  /** Calls of `stop`: a render they interrupt runs once more. */
  private stops = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly idleMs: number;
  private readonly timeoutMs: number;

  constructor(private opts: FragmentRendererOptions) {
    this.idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** The renderer process id while one runs. */
  get pid(): number | null {
    return this.client?.pid ?? null;
  }

  /**
   * The fragment's page of `source` compiled as the virtual document of folder `dir`, as SVG
   * text. Rejects with a FragmentError carrying Typst's message when the source fails,
   * with a plain Error when rendering is not possible (no binary, a timeout, a crash).
   */
  render(dir: string, source: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("the fragment renderer was disposed"));
    const path = join(dir, FRAGMENT_DOC);
    const prev = this.queues.get(path) ?? Promise.resolve();
    const run = prev.then(
      () => this.exportRetried(path, source),
      () => this.exportRetried(path, source),
    );
    this.queues.set(path, run);
    const done = () => {
      if (this.queues.get(path) === run) this.queues.delete(path);
    };
    run.then(done, done);
    return run;
  }

  /**
   * Kill the process (a settings save); the next render starts a new one, and renders it
   * interrupted run once more there.
   */
  stop(): void {
    this.stops++;
    this.shutdown();
  }

  /** Kill the process for good (plugin unload): later renders reject. */
  dispose(): void {
    this.disposed = true;
    this.shutdown();
  }

  private shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const client = this.client;
    this.client = null;
    this.clientBin = null;
    this.starting = null;
    this.opened.clear();
    client?.stop();
  }

  /** exportOne, once more when `stop` interrupted it: that says nothing about the formula. */
  private async exportRetried(path: string, source: string): Promise<string> {
    const stops = this.stops;
    try {
      return await this.exportOne(path, source);
    } catch (err) {
      if (this.stops === stops || this.disposed || err instanceof FragmentError) throw err;
      return this.exportOne(path, source);
    }
  }

  private async exportOne(path: string, source: string): Promise<string> {
    this.inFlight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const deadline = Date.now() + this.timeoutMs;
    try {
      const lsp = await this.started(deadline);
      if (!this.opened.has(path)) {
        this.opened.add(path);
        lsp.didOpen(path, source);
      }
      // Also right after didOpen: without a change, some server states answer "not
      // available for export: file not found" until one arrives.
      lsp.didChange(path, source);
      let res;
      try {
        res = await lsp.exportSvg(path, {}, Math.max(deadline - Date.now(), 1));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const typst = typstExportError(message, this.opts.root);
        if (typst) throw typst;
        if (!/timed out/.test(message)) throw new Error(message);
        // A compile still running would hold up every later render: start afresh.
        if (this.client === lsp) this.shutdown();
        throw this.tooLong();
      }
      const pages = (res?.items ?? []).map((item) => (item.data ? Buffer.from(item.data, "base64").toString("utf8") : ""));
      // A kept document template may add pages before the fragment or after it: the last
      // page holding its mark (FRAGMENT_MARK), else the last page (display math has none).
      const svg = pages.filter((page) => page.includes(`fill="${FRAGMENT_MARK}"`)).at(-1) ?? pages.at(-1);
      if (!svg) throw new Error("tinymist returned no SVG");
      return svg;
    } finally {
      this.inFlight--;
      this.armIdle();
    }
  }

  private tooLong(): Error {
    return new Error(`rendering took longer than ${this.timeoutMs / 1000} s`);
  }

  /**
   * The running process, once started within the render's time. A slower start goes on
   * for the next render (the first launch of a binary can be slow); one that never
   * answers ends at LspClient's initialize timeout.
   */
  private async started(deadline: number): Promise<LspClient> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), deadline - Date.now())));
    try {
      const lsp = await Promise.race([this.ensureClient(), late]);
      if (lsp) return lsp;
    } finally {
      clearTimeout(timer);
    }
    throw this.tooLong();
  }

  private ensureClient(): Promise<LspClient> {
    if (this.disposed) return Promise.reject(new Error("the fragment renderer was disposed"));
    const bin = this.opts.bin();
    if (!bin) return Promise.reject(new Error("tinymist binary not found"));
    if (this.client && (this.clientBin !== bin || this.client.status === "failed")) this.shutdown();
    const client = this.client;
    if (client?.status === "running") return Promise.resolve(client);
    if (!this.starting) {
      const next = new LspClient(bin, this.opts.root, () => {}, {
        fontPaths: this.opts.fontPaths?.() ?? [],
      });
      this.client = next;
      this.clientBin = bin;
      this.opened.clear();
      this.starting = next.start().then(
        () => {
          if (this.client === next) this.starting = null;
          return next;
        },
        (err) => {
          if (this.client === next) this.shutdown();
          throw err;
        },
      );
    }
    return this.starting;
  }

  private armIdle(): void {
    if (this.inFlight > 0 || !this.client) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight === 0) this.shutdown();
    }, this.idleMs);
  }
}

/**
 * Typst's diagnostic from a failed `tinymist.exportSvg` ("... document is not available
 * for export: \"error: unclosed delimiter\n  ┌─ <file>:6:98 ...\""): the error messages and
 * hints, with the file and line when an error lies outside the fragment document (a
 * template, an import), and the fragment document's line of the first error: its own
 * location there, else the first row of its trace there ("help: while importing" points at
 * the preamble's import of a broken template, "help: while calling" at the formula calling a
 * template function). Lines repeated verbatim (the same error reached through two imports)
 * show once. Null when the message carries no Typst error (a server state, which a later
 * render may not repeat).
 */
export function typstExportError(message: string, root: string): FragmentError | null {
  const m = /not available for export: "([\s\S]*)"\s*$/.exec(message);
  if (!m) return null;
  const text = m[1].replace(/\\(u\{([0-9a-fA-F]+)\}|.)/g, (_, c: string, hex?: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c,
  );
  const out: string[] = [];
  let line: number | null = null;
  let errors = 0;
  for (const row of text.split("\n")) {
    const error = /^error: (.*)$/.exec(row);
    const at = /^\s*┌─ (.*?):(\d+):\d+\s*$/.exec(row);
    const hint = /^\s*= hint: (.*)$/.exec(row);
    if (error) {
      out.push(error[1]);
      errors++;
    } else if (hint) out.push(`hint: ${hint[1]}`);
    else if (at && out.length) {
      if (basename(at[1]) === FRAGMENT_DOC) {
        if (line === null && errors === 1) line = +at[2];
      } else {
        out[out.length - 1] += ` (${vaultPath(at[1], root)}:${at[2]})`;
      }
    }
  }
  return out.length ? new FragmentError([...new Set(out)].join("\n"), line) : null;
}

/** A file as the vault shows it (`book/template.typ`), or its name outside the vault. */
export function vaultPath(file: string, root: string): string {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel) ? basename(file) : rel.split(sep).join("/");
}
