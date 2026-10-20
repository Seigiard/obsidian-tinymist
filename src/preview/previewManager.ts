import type TinymistPlugin from "../main";
import { basename, isAbsolute, join, relative, sep } from "path";
import { previewEntry } from "./previewEntry";

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
    return normalized.endsWith(".typ") ? normalized : null;
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
    this.filePath = join(root, movedPath);
    this.notifyChange();
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
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
    this.changeListeners.clear();
  }

  async start(filePath: string): Promise<string> {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") {
      throw new Error("language server is not running");
    }
    if (this.taskId && this.taskFilePath === filePath && this.url) {
      return this.url;
    }
    await this.stop();
    if (!this.handlersRegistered) this.registerHandlers();

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
    const root = this.plugin.vaultBasePath();
    if (!root) throw new Error("preview requires a local vault");
    const entry = previewEntry(filePath, root);
    lsp.setPreviewSource(entry.sourceInput);
    args.push("--page-title", basename(filePath), entry.filePath);

    let result: PreviewResult;
    try {
      result = await lsp.executeCommand<PreviewResult>(
        "tinymist.doStartPreview",
        [args],
        20000,
      );
    } catch (error) {
      lsp.setPreviewSource();
      throw error;
    }
    const port = result?.staticServerPort;
    if (!port) {
      await lsp.executeCommand("tinymist.doKillPreview", [taskId], 5000).catch(() => {});
      lsp.setPreviewSource();
      throw new Error("preview did not report a server port");
    }

    this.taskId = taskId;
    this.taskFilePath = filePath;
    this.filePath = filePath;
    this.url = `http://127.0.0.1:${port}`;
    this.notifyChange();
    return this.url;
  }

  /** Editor cursor moved: scroll the preview to the source position. */
  cursorMoved(filepath: string, line: number, character: number): void {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running" || !this.taskId) return;
    void lsp
      .executeCommand("tinymist.scrollPreview", [
        this.taskId,
        { event: "panelScrollTo", filepath, line, character },
      ])
      .catch(() => {});
  }

  async stop(): Promise<void> {
    const taskId = this.taskId;
    this.taskId = null;
    this.taskFilePath = null;
    this.url = null;
    this.filePath = null;
    this.notifyChange();
    if (!taskId) return;
    const lsp = this.plugin.lsp;
    if (lsp && lsp.status === "running") {
      await lsp
        .executeCommand("tinymist.doKillPreview", [taskId], 5000)
        .catch(() => {});
      lsp.setPreviewSource();
      // The preview took over tinymist's main; hand it back to the editor.
      lsp.pinMain(lsp.mainFile);
    }
  }
}
