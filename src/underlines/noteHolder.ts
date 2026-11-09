import type { EditorView } from "@codemirror/view";
import type { LspClient, LspDiagnostic } from "../lsp/client";
import { pathToUri } from "../lsp/client";
import { SourceRegistry, type TypstSource } from "../sources";
import { setNoteDiagnostics } from "./editorDiagnostics";
import { noteDiagnostics, type NoteDiagnostic } from "./noteDiagnostics";

interface NoteHolderDeps {
  registry: SourceRegistry;
  client: () => LspClient | null;
  onDiagnostics(cb: (uri: string) => void): () => void;
  diagnostics(uri: string): LspDiagnostic[];
  leaves(): Array<{ path: string }>;
  onLayout(cb: () => void): () => void;
  onOpened(path: string): void;
  onMoved?(oldEntry: string, newEntry: string): void;
  onReleased?(path: string, entry: string): void;
}

interface HeldNote {
  path: string;
  source: TypstSource;
  entry: string;
  open: { close(): void } | null;
  lastProblems: readonly SourceProblem[];
  removeProblems: () => void;
  removeMoved: () => void;
  removeEnded: () => void;
}

type SourceProblem = NonNullable<TypstSource["problems"]>[number];

/** Keeps Typst-enabled Markdown notes open on the primary language server. */
export class NoteHolder {
  private readonly held = new Map<string, HeldNote>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly views = new Map<string, Set<EditorView>>();
  private readonly viewBuckets = new Map<EditorView, string>();
  private readonly lastDispatched = new WeakMap<EditorView, readonly NoteDiagnostic[]>();
  private readonly pendingDispatches = new WeakMap<EditorView, readonly NoteDiagnostic[]>();
  private readonly removeDiagnostics: () => void;
  private readonly removeLayout: () => void;
  private disposed = false;

  constructor(private readonly deps: NoteHolderDeps) {
    this.removeDiagnostics = deps.onDiagnostics((uri) => {
      for (const note of this.held.values()) {
        if (pathToUri(note.source.entry) === uri) this.publish(note.path);
      }
    });
    this.removeLayout = deps.onLayout(() => {
      void this.refresh().catch((error: unknown) => {
        console.error("[tinymist] note diagnostics refresh failed:", error);
      });
    });
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const wanted = new Set(
      this.deps.leaves()
        .map(({ path }) => path)
        .filter((path) => this.deps.registry.mayBeSource(path)),
    );

    for (const [path] of this.held) {
      if (!wanted.has(path)) this.release(path);
    }

    const client = this.deps.client();
    if (client) {
      for (const note of this.held.values()) {
        if (!note.open) {
          note.open = note.source.open(client);
          this.publish(note.path);
          this.deps.onOpened(note.path);
        }
      }
    }

    const pending = [...wanted]
      .filter((path) => !this.held.has(path) && !this.pending.has(path))
      .map((path) => this.hold(path));
    await Promise.all(pending);
  }

  reopen(): void {
    if (this.disposed) return;
    for (const note of this.held.values()) {
      note.open?.close();
      const client = this.deps.client();
      note.open = client ? note.source.open(client) : null;
      this.publish(note.path);
      if (note.open) this.deps.onOpened(note.path);
    }
  }

  entryOf(path: string): string | null {
    return this.held.get(path)?.source.entry ?? null;
  }

  attach(path: string, view: EditorView): void {
    const previousPath = this.viewBuckets.get(view);
    if (previousPath && previousPath !== path) {
      const previousViews = this.views.get(previousPath);
      previousViews?.delete(view);
      if (previousViews && !previousViews.size) this.views.delete(previousPath);
    }
    let views = this.views.get(path);
    if (!views) this.views.set(path, (views = new Set()));
    views.add(view);
    this.viewBuckets.set(view, path);
    if (this.held.has(path)) this.publish(path);
    else this.dispatch(path, view, []);
  }

  detach(path: string, view: EditorView): void {
    const actualPath = this.viewBuckets.get(view);
    if (!actualPath) return;
    const views = this.views.get(actualPath);
    if (!views) return;
    views.delete(view);
    if (!views.size) this.views.delete(actualPath);
    this.viewBuckets.delete(view);
  }

  documentChanged(view: EditorView): void {
    this.lastDispatched.delete(view);
    this.pendingDispatches.delete(view);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDiagnostics();
    this.removeLayout();
    for (const path of [...this.held.keys()]) this.release(path);
    for (const views of this.views.values()) {
      for (const view of views) view.dispatch({ effects: setNoteDiagnostics.of([]) });
    }
    this.views.clear();
    this.viewBuckets.clear();
  }

  private hold(path: string): Promise<void> {
    const operation = this.open(path);
    this.pending.set(path, operation);
    void operation.then(
      () => {
        if (this.pending.get(path) === operation) this.pending.delete(path);
      },
      () => {
        if (this.pending.get(path) === operation) this.pending.delete(path);
      },
    );
    return operation;
  }

  private async open(path: string): Promise<void> {
    const source = await this.deps.registry.hold(path);
    if (!source) return;
    if (this.disposed || !this.wanted(path)) {
      source.release();
      return;
    }

    const client = this.deps.client();
    let open: { close(): void } | null = null;
    try {
      open = client ? source.open(client) : null;
    } catch (error) {
      source.release();
      throw error;
    }
    const note: HeldNote = {
      path,
      source,
      entry: source.entry,
      open,
      lastProblems: [],
      removeProblems: () => {},
      removeMoved: () => {},
      removeEnded: () => {},
    };
    note.removeProblems = source.on("problems", () => this.problemsChanged(note));
    note.removeMoved = source.on("moved", () => this.moved(note));
    note.removeEnded = source.on("ended", () => this.end(note));
    this.held.set(path, note);
    this.publish(path);
    if (open) this.deps.onOpened(path);
  }

  private wanted(path: string): boolean {
    return this.deps.leaves().some(
      (leaf) => leaf.path === path && this.deps.registry.mayBeSource(path),
    );
  }

  private end(note: HeldNote): void {
    if (this.held.get(note.path) !== note) return;
    this.release(note.path);
  }

  private moved(note: HeldNote): void {
    const oldPath = note.path;
    const oldEntry = note.entry;
    const newPath = note.source.file;
    if (oldPath === newPath || this.held.get(oldPath) !== note) return;

    this.held.delete(oldPath);
    this.held.set(newPath, note);
    note.path = newPath;
    note.entry = note.source.entry;

    const oldViews = this.views.get(oldPath);
    if (oldViews) {
      this.views.delete(oldPath);
      let newViews = this.views.get(newPath);
      if (!newViews) this.views.set(newPath, (newViews = new Set()));
      for (const view of oldViews) {
        newViews.add(view);
        this.viewBuckets.set(view, newPath);
      }
    }
    this.publish(newPath);
    this.deps.onMoved?.(oldEntry, note.entry);
    if (note.open) this.deps.onOpened(newPath);
  }

  private problemsChanged(note: HeldNote): void {
    const problems = note.source.problems ?? [];
    if (sameProblems(note.lastProblems, problems)) return;
    this.publish(note.path);
  }

  private release(path: string): void {
    const note = this.held.get(path);
    if (!note) return;
    this.held.delete(path);
    note.removeProblems();
    note.removeMoved();
    note.removeEnded();
    note.open?.close();
    const entry = note.source.entry;
    this.deps.onReleased?.(path, entry);
    note.source.release();
    for (const view of this.views.get(path) ?? []) this.dispatch(path, view, []);
  }

  private publish(path: string): void {
    const note = this.held.get(path);
    if (!note) return;
    const entryUri = pathToUri(note.source.entry);
    const problems = note.source.problems ?? [];
    const diagnostics = noteDiagnostics(
      note.source,
      problems.some((problem) => problem.fatal) ? [] : this.deps.diagnostics(entryUri),
      entryUri,
    );
    note.lastProblems = [...problems];
    for (const view of this.views.get(path) ?? []) this.dispatch(path, view, diagnostics);
  }

  private dispatch(path: string, view: EditorView, diagnostics: readonly NoteDiagnostic[]): void {
    const previous = this.lastDispatched.get(view);
    if (previous && sameDiagnostics(previous, diagnostics)) return;
    const pending = this.pendingDispatches.get(view);
    if (pending && sameDiagnostics(pending, diagnostics)) return;
    const next = [...diagnostics];
    this.pendingDispatches.set(view, next);
    queueMicrotask(() => {
      if (this.pendingDispatches.get(view) !== next) return;
      this.pendingDispatches.delete(view);
      if (!this.views.get(path)?.has(view)) return;
      const current = this.lastDispatched.get(view);
      if (current && sameDiagnostics(current, next)) return;
      this.lastDispatched.set(view, next);
      view.dispatch({ effects: setNoteDiagnostics.of(next) });
    });
  }
}

function sameProblems(
  previous: readonly SourceProblem[],
  next: readonly SourceProblem[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((problem, index) => {
    const other = next[index];
    return problem.line === other.line
      && problem.message === other.message
      && problem.fatal === other.fatal;
  });
}

function sameDiagnostics(
  previous: readonly NoteDiagnostic[],
  next: readonly NoteDiagnostic[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((diagnostic, index) => {
    const other = next[index];
    return diagnostic.from.line === other.from.line
      && diagnostic.from.character === other.from.character
      && diagnostic.to.line === other.to.line
      && diagnostic.to.character === other.to.character
      && diagnostic.message === other.message
      && diagnostic.severity === other.severity;
  });
}
