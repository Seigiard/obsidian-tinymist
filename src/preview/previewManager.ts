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
  private sourceBinding = 0;
  private startGeneration = 0;
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
    const root = this.plugin.vaultBasePath();
    if (!root || !this.filePath) return null;
    const path = relative(root, this.filePath);
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    const normalized = path.split(sep).join("/");
    return this.plugin.sources.mayBeSource(normalized) ? normalized : null;
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
        this.startGeneration++;
        this.sourceBinding++;
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
    this.startGeneration++;
    this.sourceBinding++;
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
    this.startGeneration++;
    this.filePath = join(root, movedPath);
    this.notifyChange();
    const binding = ++this.sourceBinding;
    void this.rebindSource(movedPath, previous, binding);
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
    this.startGeneration++;
    this.sourceBinding++;
    this.source?.release();
    this.source = null;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
    this.changeListeners.clear();
  }

  async start(filePath: string): Promise<string | null> {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") {
      throw new Error("language server is not running");
    }
    if (this.taskId && this.taskFilePath === filePath && this.url) {
      return this.url;
    }
    const cancellation = this.startGeneration;
    await this.stopCurrent();
    if (cancellation !== this.startGeneration || this.disposed) return null;
    const generation = ++this.startGeneration;
    if (!this.handlersRegistered) this.registerHandlers();

    const root = this.plugin.vaultBasePath();
    if (!root) throw new Error("preview requires a local vault");
    const vaultPath = relative(root, filePath);
    if (!vaultPath || vaultPath === ".." || vaultPath.startsWith(`..${sep}`) || isAbsolute(vaultPath)) {
      throw new Error("preview source must be inside the vault");
    }
    const binding = this.sourceBinding;
    let source: TypstSource | null;
    try {
      source = await this.plugin.sources.hold(vaultPath.split(sep).join("/"));
    } catch (error) {
      if (generation !== this.startGeneration || this.disposed) return null;
      throw error;
    }
    if (generation !== this.startGeneration || this.disposed) {
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
      if (generation !== this.startGeneration || binding !== this.sourceBinding || this.disposed) {
        return null;
      }
      lsp.setPreviewSource();
      throw error;
    }
    if (generation !== this.startGeneration || this.disposed) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      source.release();
      return null;
    }
    const port = result?.staticServerPort;
    if (!port) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      source.release();
      if (generation !== this.startGeneration || this.disposed) return null;
      lsp.setPreviewSource();
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
    this.startGeneration++;
    await this.stopCurrent();
  }

  private async stopCurrent(): Promise<void> {
    const taskId = this.taskId;
    const source = this.source;
    this.sourceBinding++;
    this.taskId = null;
    this.taskFilePath = null;
    this.source = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
    const lsp = this.plugin.lsp;
    if (taskId && lsp && lsp.status === "running") {
      await lsp
        .executeCommand("tinymist.doKillPreview", [taskId], 5000)
        .catch(() => {});
      lsp.setPreviewSource();
      // The preview took over tinymist's main; hand it back to the editor.
      lsp.pinMain(lsp.mainFile);
    }
    source?.release();
  }

  private async rebindSource(
    vaultPath: string,
    previous: TypstSource | null,
    binding: number,
  ): Promise<void> {
    let next: TypstSource | null = null;
    try {
      next = await this.plugin.sources.hold(vaultPath);
    } catch {}
    if (binding !== this.sourceBinding || this.source !== previous || this.disposed) {
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
}
