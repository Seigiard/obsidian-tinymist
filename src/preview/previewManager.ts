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
  /** Every operation that replaces or ends a preview advances this value. */
  private generation = 0;
  private previewSourceSet = false;
  private resetAfterPending: { generation: number; pinMain: boolean } | null = null;
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
    const vaultPath = this.vaultRelativePath(this.filePath);
    return vaultPath && this.plugin.sources.mayBeSource(vaultPath) ? vaultPath : null;
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
        this.generation++;
        this.source?.release();
        this.source = null;
        this.taskId = null;
        this.taskFilePath = null;
        this.url = null;
        this.filePath = null;
        this.notifyChange();
      }
    });
    lsp.onNotification("tinymist/preview/scrollSource", (params) => {
      this.plugin.jumpToSource(params as SourceJump);
    });
    this.handlersRegistered = true;
  }

  /** Called by the plugin after a language-server (re)start. */
  onLspRestart(): void {
    this.generation++;
    this.source?.release();
    this.source = null;
    this.handlersRegistered = false;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
  }

  onVaultRename(newPath: string, oldPath: string): void {
    const currentPath = this.sourcePath();
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
    const previous = this.source;
    const generation = ++this.generation;
    this.filePath = join(root, movedPath);
    this.notifyChange();
    void this.rebindSource(movedPath, previous, generation);
  }

  onVaultDelete(deletedPath: string): void {
    const currentPath = this.sourcePath();
    if (this.disposed || !currentPath) return;
    if (currentPath === deletedPath || currentPath.startsWith(`${deletedPath}/`)) {
      void this.stop();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.source?.release();
    this.source = null;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
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
    void started.then(
      () => {
        this.pendingStarts.delete(started);
        this.completePendingReset();
      },
      () => {
        this.pendingStarts.delete(started);
        this.completePendingReset();
      },
    );
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
    this.previewSourceSet = true;
    args.push("--page-title", basename(filePath), source.entry);

    let result: PreviewResult;
    try {
      result = await lsp.executeCommand<PreviewResult>(
        "tinymist.doStartPreview",
        [args],
        20000,
      );
    } catch (error) {
      source.release();
      if (generation !== this.generation) {
        return null;
      }
      this.clearPreviewSource();
      throw error;
    }
    if (generation !== this.generation) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      source.release();
      this.requestPendingReset(true);
      return null;
    }
    const port = result?.staticServerPort;
    if (!port) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      source.release();
      if (generation !== this.generation) {
        this.requestPendingReset(true);
        return null;
      }
      this.clearPreviewSource();
      throw new Error("preview did not report a server port");
    }

    const url = `http://127.0.0.1:${port}`;
    this.taskId = taskId;
    this.taskFilePath = filePath;
    this.source = source;
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
    const generation = ++this.generation;
    const stopping = this.stopCurrent();
    if (stopping) {
      await stopping;
      return;
    }
    if (!this.previewSourceSet) return;
    this.resetAfterPending = { generation, pinMain: false };
    this.completePendingReset();
  }

  private stopCurrent(): Promise<void> | null {
    const taskId = this.taskId;
    const source = this.source;
    this.taskId = null;
    this.taskFilePath = null;
    this.source = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
    const lsp = this.plugin.lsp;
    if (taskId && lsp && lsp.status === "running") {
      return lsp
        .executeCommand("tinymist.doKillPreview", [taskId], 5000)
        .catch(() => {})
        .then(() => {
          this.clearPreviewSource(true);
          source?.release();
        });
    }
    source?.release();
    return null;
  }

  private async rebindSource(
    vaultPath: string,
    previous: TypstSource | null,
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
    if (!next) {
      this.source = null;
      previous?.release();
      this.notifyChange();
      return;
    }
    this.source = next;
    previous?.release();
  }

  private vaultRelativePath(filePath: string | null): string | null {
    const root = this.plugin.vaultBasePath();
    if (!root || !filePath) return null;
    const path = relative(root, filePath);
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return path.split(sep).join("/");
  }

  private requestPendingReset(pinMain: boolean): void {
    const reset = this.resetAfterPending;
    if (reset && reset.generation === this.generation && pinMain) reset.pinMain = true;
  }

  private completePendingReset(): void {
    const reset = this.resetAfterPending;
    if (!reset || this.pendingStarts.size || reset.generation !== this.generation || this.taskId) return;
    this.resetAfterPending = null;
    this.clearPreviewSource(reset.pinMain);
  }

  private clearPreviewSource(pinMain = false): void {
    const lsp = this.plugin.lsp;
    this.previewSourceSet = false;
    if (!lsp || lsp.status !== "running") return;
    lsp.setPreviewSource();
    if (pinMain) lsp.pinMain(lsp.mainFile);
  }
}
