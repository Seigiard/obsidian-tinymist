import type TinymistPlugin from "../main";
import { basename, isAbsolute, join, relative, sep } from "path";
import type { TypstSource } from "../sources";

interface PreviewResult {
  dataPlanePort?: string | number;
  staticServerPort?: string | number;
  isPrimary?: boolean;
}

export interface SourceJump {
  filepath: string;
  start: [number, number] | null;
  end: [number, number] | null;
}

/**
 * Drives one preview task inside the tinymist LSP session
 * (`tinymist.doStartPreview`). The LSP compiles from in-memory buffers, so
 * unsaved edits render; ports are dynamic; clicking the preview makes the
 * server push a `tinymist/preview/scrollSource` jump handled by the plugin.
 */
export class PreviewManager {
  url: string | null = null;
  filePath: string | null = null;
  private taskId: string | null = null;
  private taskFilePath: string | null = null;
  private source: TypstSource | null = null;
  private sourceHandle: { close(): void } | null = null;
  private removeSourceProblems: (() => void) | null = null;
  private removeSourceMoved: (() => void) | null = null;
  private removeSourceEnded: (() => void) | null = null;
  /** Advanced by every start, stop, rename, dispose, server-dispose notification, and LSP restart; a pending start or rebind is current only while it keeps the value it took. */
  private generation = 0;
  private pendingTaskId: string | null = null;
  private inputSet = false;
  private mainTaken = false;
  private readonly pendingStarts = new Set<Promise<string | null>>();
  private handlersRegistered = false;
  private disposed = false;
  private readonly changeListeners = new Set<() => void>();

  constructor(private plugin: TinymistPlugin) {}

  onChange(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** The selected preview source as an Obsidian vault-relative path. */
  sourcePath(): string | null {
    if (this.source) return this.source.file;
    const vaultPath = this.vaultRelativePath(this.filePath);
    return vaultPath && this.plugin.sources.mayBeSource(vaultPath) ? vaultPath : null;
  }

  currentSource(): TypstSource | null {
    return this.source;
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  private registerHandlers(): void {
    const lsp = this.plugin.lsp;
    if (!lsp) return;
    lsp.onNotification("tinymist/preview/dispose", (params) => {
      const { taskId } = (params as { taskId?: string }) ?? {};
      if (taskId && taskId === this.taskId) {
        this.endTask();
      } else if (taskId && taskId === this.pendingTaskId) {
        this.generation++;
      }
    });
    lsp.onNotification("tinymist/preview/scrollSource", (params) => {
      this.plugin.jumpToSource(params as SourceJump);
    });
    this.handlersRegistered = true;
  }

  /** Called by the plugin after a language-server (re)start. */
  onLspRestart(): string | null {
    const activePath = this.taskId ? this.filePath : null;
    this.endTask();
    this.handlersRegistered = false;
    return activePath;
  }

  onVaultRename(newPath: string, oldPath: string): void {
    const currentPath = this.source?.file ?? this.sourcePath();
    if (this.disposed || !currentPath) return;
    const oldPrefix = `${oldPath}/`;
    const movedPath =
      currentPath === oldPath
        ? newPath
        : currentPath.startsWith(oldPrefix)
          ? `${newPath}/${currentPath.slice(oldPrefix.length)}`
          : null;
    if (!movedPath) return;
    const root = this.plugin.vaultBasePath();
    if (!root) {
      void this.stop();
      return;
    }
    const generation = ++this.generation;
    this.filePath = join(root, movedPath);
    this.notifyChange();
    void this.rebindSource(movedPath, generation);
  }

  onVaultDelete(deletedPath: string): void {
    const currentPath = this.source?.file ?? this.sourcePath();
    if (this.disposed || !currentPath) return;
    if (currentPath === deletedPath || currentPath.startsWith(`${deletedPath}/`)) {
      void this.stop();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endTask();
    this.changeListeners.clear();
  }

  /**
   * Starts a preview and resolves to its URL. It resolves to null, not an
   * error, when a later start or lifecycle event supersedes this start. A
   * start takes its generation before its first await, so the latest start wins.
   */
  start(filePath: string): Promise<string | null> {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") {
      return Promise.reject(new Error("language server is not running"));
    }
    if (this.taskId && this.taskFilePath === filePath && this.url) {
      return Promise.resolve(this.url);
    }
    const generation = ++this.generation;
    const started = this.startPreview(filePath, generation, lsp);
    this.pendingStarts.add(started);
    const settled = (): void => {
      this.pendingStarts.delete(started);
      this.settleClient();
    };
    void started.then(settled, settled);
    return started;
  }

  private async startPreview(
    filePath: string,
    generation: number,
    lsp: NonNullable<TinymistPlugin["lsp"]>,
  ): Promise<string | null> {
    const stopping = this.stopCurrent();
    if (stopping) await stopping;
    if (generation !== this.generation || this.disposed) return null;
    if (!this.handlersRegistered) this.registerHandlers();

    if (!this.plugin.vaultBasePath()) throw new Error("preview requires a local vault");
    const vaultPath = this.vaultRelativePath(filePath);
    if (!vaultPath) {
      throw new Error("preview source must be inside the vault");
    }
    let source: TypstSource | null;
    try {
      source = await this.plugin.sources.hold(vaultPath);
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
    if (generation !== this.generation) {
      source?.release();
      return null;
    }
    if (!source) throw new Error("preview source is unavailable");

    let sourceHandle: { close(): void } | null = null;
    try {
      sourceHandle = source.open(lsp);
    } catch (error) {
      source.release();
      if (generation !== this.generation) return null;
      throw describedStartError(source, error);
    }

    const taskId = Math.random().toString(36).slice(2, 9);
    const args = [
      "--task-id",
      taskId,
      "--data-plane-host",
      "127.0.0.1:0",
      // SVG in-window rendering keeps real page elements in the DOM, which
      // click-to-source jumping needs (canvas pages are not clickable).
      "--partial-rendering=true",
    ];
    if (this.plugin.settings.invertPreviewColors !== "never") {
      args.push(`--invert-colors=${this.plugin.settings.invertPreviewColors}`);
    }
    lsp.setPreviewSource(source.inputs);
    this.inputSet = true;
    args.push("--page-title", previewTitle(source), source.entry);

    let result: PreviewResult;
    try {
      this.pendingTaskId = taskId;
      result = await lsp.executeCommand<PreviewResult>(
        "tinymist.doStartPreview",
        [args],
        20000,
      );
    } catch (error) {
      if (this.pendingTaskId === taskId) this.pendingTaskId = null;
      sourceHandle?.close();
      source.release();
      if (generation !== this.generation) {
        return null;
      }
      throw describedStartError(source, error);
    }
    if (this.pendingTaskId === taskId) this.pendingTaskId = null;
    this.mainTaken = true;
    const port = result?.staticServerPort;
    if (generation !== this.generation || !port) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      sourceHandle?.close();
      source.release();
      if (generation !== this.generation) {
        return null;
      }
      throw describedStartError(source, new Error("preview did not report a server port"));
    }

    const url = `http://127.0.0.1:${port}`;
    this.taskId = taskId;
    this.taskFilePath = filePath;
    this.source = source;
    this.sourceHandle = sourceHandle;
    this.removeSourceProblems = source.on("problems", () => this.notifyChange());
    this.bindSourceLifecycle(source);
    this.filePath = filePath;
    this.url = url;
    this.notifyChange();
    return this.url;
  }

  /** Editor cursor moved: scroll the preview to the source position. */
  cursorMoved(filepath: string, line: number, character: number): void {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running" || !this.taskId) return;
    const source = this.plugin.sources.byDocument(filepath);
    const position = source?.toEntry({ line, character }) ?? { line, character };
    void lsp
      .executeCommand("tinymist.scrollPreview", [
        this.taskId,
        {
          event: "panelScrollTo",
          filepath: source?.document ?? filepath,
          line: position.line,
          character: position.character,
        },
      ])
      .catch(() => {});
  }

  async stop(): Promise<void> {
    this.generation++;
    const stopping = this.stopCurrent();
    if (stopping) await stopping;
    this.settleClient();
  }

  private stopCurrent(): Promise<void> | null {
    const taskId = this.taskId;
    const source = this.source;
    const sourceHandle = this.sourceHandle;
    this.clearTask();
    const lsp = this.plugin.lsp;
    if (taskId && lsp && lsp.status === "running") {
      return lsp
        .executeCommand("tinymist.doKillPreview", [taskId], 5000)
        .catch(() => {})
        .then(() => {
          sourceHandle?.close();
          source?.release();
          this.settleClient();
        });
    }
    sourceHandle?.close();
    source?.release();
    return null;
  }

  private endTask(): void {
    this.generation++;
    this.sourceHandle?.close();
    this.source?.release();
    this.clearTask();
  }

  private clearTask(): void {
    this.source = null;
    this.sourceHandle = null;
    this.removeSourceProblems?.();
    this.removeSourceProblems = null;
    this.removeSourceMoved?.();
    this.removeSourceMoved = null;
    this.removeSourceEnded?.();
    this.removeSourceEnded = null;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
  }

  private async rebindSource(
    vaultPath: string,
    generation: number,
  ): Promise<void> {
    let next: TypstSource | null = null;
    try {
      next = await this.plugin.sources.hold(vaultPath);
    } catch {}
    if (generation !== this.generation) {
      next?.release();
      return;
    }
    const previousHandle = this.sourceHandle;
    const previousSource = this.source;
    this.removeSourceLifecycle();
    previousHandle?.close();
    previousSource?.release();
    if (!next) {
      this.source = null;
      this.sourceHandle = null;
      this.notifyChange();
      return;
    }
    let nextHandle: { close(): void };
    try {
      const lsp = this.plugin.lsp;
      nextHandle = lsp ? next.open(lsp) : { close: () => {} };
    } catch (error) {
      next.release();
      if (generation === this.generation) throw describedStartError(next, error);
      return;
    }
    this.source = next;
    this.sourceHandle = nextHandle;
    this.removeSourceProblems = next.on("problems", () => this.notifyChange());
    this.bindSourceLifecycle(next);
  }

  private bindSourceLifecycle(source: TypstSource): void {
    this.removeSourceMoved = source.on("moved", () => {
      void this.restartMovedSource(source);
    });
    this.removeSourceEnded = source.on("ended", () => {
      void this.stop();
    });
  }

  private removeSourceLifecycle(): void {
    this.removeSourceMoved?.();
    this.removeSourceMoved = null;
    this.removeSourceEnded?.();
    this.removeSourceEnded = null;
  }

  private async restartMovedSource(source: TypstSource): Promise<void> {
    if (this.disposed || this.source !== source) return;
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") return;
    const generation = ++this.generation;
    const taskId = this.taskId;
    const previousHandle = this.sourceHandle;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.sourceHandle = null;
    this.filePath = this.absolutePath(source.file);
    this.notifyChange();
    if (taskId) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
    }
    previousHandle?.close();
    if (generation !== this.generation || this.disposed || this.source !== source) return;
    const handle = source.open(lsp);
    const nextTaskId = Math.random().toString(36).slice(2, 9);
    const args = [
      "--task-id",
      nextTaskId,
      "--data-plane-host",
      "127.0.0.1:0",
      "--partial-rendering=true",
    ];
    if (this.plugin.settings.invertPreviewColors !== "never") {
      args.push(`--invert-colors=${this.plugin.settings.invertPreviewColors}`);
    }
    lsp.setPreviewSource(source.inputs);
    args.push("--page-title", previewTitle(source), source.entry);
    let result: PreviewResult;
    try {
      result = await lsp.executeCommand<PreviewResult>(
        "tinymist.doStartPreview",
        [args],
        20000,
      );
    } catch {
      handle.close();
      if (generation === this.generation && this.source === source) {
        this.sourceHandle = null;
        this.notifyChange();
      }
      return;
    }
    const port = result?.staticServerPort;
    if (generation !== this.generation || this.disposed || this.source !== source || !port) {
      await lsp.executeCommand("tinymist.doKillPreview", [nextTaskId], 5000).catch(() => {});
      handle.close();
      return;
    }
    this.taskId = nextTaskId;
    this.taskFilePath = this.filePath;
    this.sourceHandle = handle;
    this.url = `http://127.0.0.1:${port}`;
    this.notifyChange();
  }

  private absolutePath(vaultPath: string): string | null {
    const root = this.plugin.vaultBasePath();
    return root ? join(root, vaultPath) : null;
  }

  private vaultRelativePath(filePath: string | null): string | null {
    const root = this.plugin.vaultBasePath();
    if (!root || !filePath) return null;
    const path = relative(root, filePath);
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return path.split(sep).join("/");
  }

  private settleClient(): void {
    if (this.pendingStarts.size || this.taskId !== null || this.disposed) return;
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") return;
    if (this.inputSet) lsp.setPreviewSource();
    // A started preview took over tinymist's main; hand it back to the editor.
    if (this.mainTaken) lsp.pinMain(lsp.mainFile);
    this.inputSet = false;
    this.mainTaken = false;
  }
}

function previewTitle(source: TypstSource): string {
  return source.file.toLowerCase().endsWith(".md")
    ? basename(source.file)
    : basename(source.entry);
}

function describedStartError(source: TypstSource, error: unknown): Error {
  const description = source.describe(error);
  if (description === String(error) && error instanceof Error) return error;
  return new Error(description);
}
