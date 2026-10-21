import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, sep } from "path";
import { startCompletion } from "@codemirror/autocomplete";
import {
  App,
  FileSystemAdapter,
  Modal,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  AutomaticPdfController,
  AutomaticPdfReceipt,
  AutomaticPdfReplaceRequest,
  AutomaticPdfStatus,
  AutomaticPdfStoredState,
  NativeAutomaticPdfExporter,
  AutomaticPdfExporter,
} from "./automatic-pdf";
import { HistoryCache } from "./editor/shared/editorKit";
import { YoloBridge } from "./editor/shared/yoloBridge";
import { FileEvent, TypstRender } from "./editor/typstRender";
import { LspTextEdit, TypstView, VIEW_TYPE_TYPST } from "./editor/typstView";
import { LspClient, LspStatus, uriToPath } from "./lsp/client";
import { TypstFragmentRenderer } from "./lsp/fragmentRenderer";
import { bookMain } from "./preview/previewEntry";
import { PreviewManager, SourceJump } from "./preview/previewManager";
import { PreviewView, VIEW_TYPE_TYPST_PREVIEW } from "./preview/previewView";
import {
  DEFAULT_SETTINGS,
  parseFontPaths,
  TinymistSettings,
  TinymistSettingTab,
} from "./settings";

export default class TinymistPlugin extends Plugin {
  settings: TinymistSettings = DEFAULT_SETTINGS;
  lsp: LspClient | null = null;
  preview: PreviewManager = new PreviewManager(this);
  /** Undo history of recently closed .typ files, restored on reopen. */
  history = new HistoryCache();
  /** YOLO AI completion in our editors; one per plugin, shared by every view. */
  yolo!: YoloBridge;
  /** The second `tinymist lsp` that renders formulas (null without a vault folder). */
  fragments: TypstFragmentRenderer | null = null;
  /** Formula renders for the hover, cached across views. */
  typstRender: TypstRender | null = null;
  private automaticPdfController: AutomaticPdfController | null = null;

  private diagListeners = new Set<(uri: string) => void>();
  private statusBarEl: HTMLElement | null = null;
  private resolvedBinary: string | null | undefined;
  private savedFontPaths: readonly string[] | undefined;
  private readonly automaticPdfListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.yolo = new YoloBridge(this.app, {
      name: "tinymist",
      enabled: () => this.settings.yoloTabCompletion,
    });
    const root = this.vaultBasePath();
    if (root) {
      this.fragments = new TypstFragmentRenderer({
        bin: () => this.resolveBinary(),
        root,
        fontPaths: () => this.resolveFontPaths(root),
      });
      this.typstRender = new TypstRender(this.fragments, root);
    }
    this.automaticPdfController = new AutomaticPdfController({
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      root: () => this.vaultBasePath(),
      onLayoutReady: (callback) => this.app.workspace.onLayoutReady(callback),
      registerEvent: (event) => this.registerEvent(event),
      createExporter: () => this.createAutomaticPdfExporter(),
      confirmReplace: (request) => this.confirmAutomaticPdfReplace(request),
      persist: (state) => this.persistAutomaticPdfState(state),
      notice: (message) => new Notice(message, 8000),
      storedState: () => this.settings.automaticPdf,
    });
    this.automaticPdfController.start();

    this.registerView(VIEW_TYPE_TYPST, (leaf) => new TypstView(leaf, this));
    this.registerView(
      VIEW_TYPE_TYPST_PREVIEW,
      (leaf) => new PreviewView(leaf, this),
    );
    this.registerExtensions(["typ"], VIEW_TYPE_TYPST);

    this.statusBarEl = this.addStatusBarItem();
    this.setStatusBar("stopped");

    this.addCommand({
      id: "open-preview",
      name: "Open preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view?.absolutePath()) return false;
        if (!checking) void this.openPreview(view);
        return true;
      },
    });

    this.addCommand({
      id: "toggle-live-preview",
      name: "Toggle live preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view) return false;
        if (!checking) view.toggleMode();
        return true;
      },
    });

    this.addCommand({
      id: "show-render-statistics",
      name: "Show render statistics",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (view?.editingMode !== "live") return false;
        if (!checking) new Notice(`Tinymist live preview: ${view.renderStatistics() ?? "not rendering"}`, 10000);
        return true;
      },
    });

    this.addCommand({
      id: "restart-language-server",
      name: "Restart language server",
      callback: () => void this.startLsp(true),
    });

    this.addCommand({
      id: "goto-definition",
      name: "Go to definition",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view) return false;
        if (!checking) void view.gotoDefinition();
        return true;
      },
    });

    this.addCommand({
      id: "format-document",
      name: "Format document",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view) return false;
        if (!checking) void view.formatDocument();
        return true;
      },
    });

    this.addCommand({
      id: "rename-symbol",
      name: "Rename symbol at cursor",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view || this.lsp?.status !== "running") return false;
        if (!checking) new RenameModal(this.app, this, view).open();
        return true;
      },
    });

    this.addCommand({
      id: "trigger-completion",
      name: "Trigger completion",
      checkCallback: (checking) => {
        const cm = this.app.workspace.getActiveViewOfType(TypstView)?.cm;
        if (!cm) return false;
        if (!checking) startCompletion(cm);
        return true;
      },
    });

    this.addCommand({
      id: "trigger-ai-completion",
      name: "Trigger AI completion (YOLO)",
      checkCallback: (checking) => {
        const cm = this.app.workspace.getActiveViewOfType(TypstView)?.cm;
        if (!cm || !this.settings.yoloTabCompletion) return false;
        if (!checking && !this.yolo.triggerNow(cm)) {
          new Notice(`Tinymist: no AI completion here (${this.yolo.describe()}).`);
        }
        return true;
      },
    });

    this.addSettingTab(new TinymistSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        {
          this.history.rename(oldPath, file.path);
          this.preview.onVaultRename(file.path, oldPath);
        },
      ),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.history.delete(file.path);
        this.preview.onVaultDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncPinnedMain()),
    );

    this.app.workspace.onLayoutReady(() => {
      void this.startLsp(false);
      // Formula renders depend on the files their preamble reads (the book main, templates,
      // alias files). Registered after layout-ready, so the vault's initial create events do
      // not count; a folder counts when it goes or moves (it may hold .typ files).
      const typ = (file: TAbstractFile) => !(file instanceof TFile) || file.extension === "typ";
      const changed = (event: FileEvent, ...paths: string[]) => {
        const root = this.vaultBasePath();
        if (root) for (const p of paths) this.typstRender?.fileChanged(join(root, p), event);
      };
      this.registerEvent(
        this.app.vault.on("modify", (file) => file instanceof TFile && typ(file) && changed("modify", file.path)),
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => file instanceof TFile && typ(file) && changed("create", file.path)),
      );
      this.registerEvent(this.app.vault.on("delete", (file) => typ(file) && changed("delete", file.path)));
      this.registerEvent(
        this.app.vault.on(
          "rename",
          (file, oldPath) => (typ(file) || oldPath.endsWith(".typ")) && changed("rename", file.path, oldPath),
        ),
      );
    });
  }

  onunload(): void {
    this.automaticPdfController?.dispose();
    this.automaticPdfController = null;
    this.automaticPdfListeners.clear();
    this.yolo.destroy();
    this.lsp?.stop();
    this.lsp = null;
    this.preview.stop();
    this.preview.dispose();
    this.fragments?.dispose();
    this.typstRender?.dispose();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<TinymistSettings> | null;
    const fontPaths = Array.isArray(data?.fontPaths)
      ? data.fontPaths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
      : [];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data, { fontPaths });
    this.savedFontPaths = [...fontPaths];
  }

  async saveSettings(forceRenderInvalidation = false): Promise<void> {
    const fontPaths = this.settings.fontPaths.filter((path) => path.trim() !== "");
    const fontPathsChanged =
      this.savedFontPaths === undefined || !samePaths(this.savedFontPaths, fontPaths);
    this.settings.fontPaths = fontPaths;
    this.savedFontPaths = [...fontPaths];
    this.resolvedBinary = undefined;
    this.automaticPdfController?.configurationChanged();
    // The renderer restarts with the (possibly new) binary at its next render, and live
    // views try again the formulas that failed for want of it.
    this.fragments?.stop();
    if (fontPathsChanged || forceRenderInvalidation) this.typstRender?.invalidate();
    else this.typstRender?.retryFailed();
    await this.saveData(this.settings);
  }

  async applyFontPaths(fontPaths: readonly string[]): Promise<void> {
    this.settings.fontPaths = parseFontPaths(fontPaths.join("\n"));
    await this.saveSettings(true);
    await this.startLsp(true);
  }

  async setAutomaticPdf(path: string, enabled: boolean): Promise<void> {
    const write = this.automaticPdfController?.setAutomaticPdf(path, enabled);
    for (const listener of this.automaticPdfListeners) listener();
    try {
      await write;
    } finally {
      for (const listener of this.automaticPdfListeners) listener();
    }
  }

  onAutomaticPdfChange(listener: () => void): () => void {
    this.automaticPdfListeners.add(listener);
    return () => this.automaticPdfListeners.delete(listener);
  }

  /**
   * Rebuild a source PDF and return the result for this request. Pass
   * `{ interactive: false }` for agent calls; `busy` means retry later, and
   * `superseded` means a newer request for the same source replaced the agent job.
   * Other outcomes are `published`, `conflict`, `failed`, and `cancelled`.
   */
  async rebuildPdf(
    path: string,
    options: { interactive?: boolean } = {},
  ): Promise<AutomaticPdfReceipt> {
    const controller = this.automaticPdfController;
    if (!controller) {
      return {
        outcome: "cancelled",
        generation: 0,
        pdfPath: path.replace(/\.typ$/i, ".pdf"),
        status: "missing",
      };
    }
    return await controller.rebuildPdf(path, options);
  }

  automaticPdfStatus(path: string): AutomaticPdfStatus {
    return this.automaticPdfController?.automaticPdfStatus(path) ?? "missing";
  }

  automaticPdfEnabled(path: string): boolean {
    return this.automaticPdfController?.automaticPdfEnabled(path) ?? false;
  }

  /** Factory seam for the controller and for native compatibility checks. */
  createAutomaticPdfExporter(): AutomaticPdfExporter {
    const root = this.vaultBasePath();
    const binary = this.resolveBinary();
    if (!root || !binary) {
      return {
        exportPdf: async () => {
          throw new Error("Tinymist binary or filesystem vault is unavailable");
        },
        stop: () => {},
      };
    }
    return new NativeAutomaticPdfExporter(binary, root, {
      ...this.lsp?.cloneConfiguration(),
      // Font Apply can requeue exports before the primary LSP has restarted.
      fontPaths: this.resolveFontPaths(root),
    });
  }

  async confirmAutomaticPdfReplace(request: AutomaticPdfReplaceRequest): Promise<boolean> {
    return new Promise((resolve) => {
      new AutomaticPdfConfirmModal(this.app, request, resolve).open();
    });
  }

  private async persistAutomaticPdfState(state: AutomaticPdfStoredState): Promise<void> {
    this.settings.automaticPdf = state;
    await this.saveData(this.settings);
  }

  vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  resolveBinary(): string | null {
    if (this.resolvedBinary !== undefined) return this.resolvedBinary;
    const candidates: string[] = [];
    if (this.settings.binaryPath.trim()) {
      candidates.push(this.settings.binaryPath.trim());
    }
    if (process.platform === "win32") {
      candidates.push(
        join(homedir(), ".cargo", "bin", "tinymist.exe"),
        join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Microsoft",
          "WinGet",
          "Links",
          "tinymist.exe",
        ),
      );
    } else {
      candidates.push(
        "/opt/homebrew/bin/tinymist",
        "/usr/local/bin/tinymist",
        join(homedir(), ".cargo", "bin", "tinymist"),
      );
    }
    for (const c of candidates) {
      if (existsSync(c)) {
        this.resolvedBinary = c;
        return c;
      }
    }
    // GUI apps get a minimal PATH; probe it through the platform helper.
    const probe = spawnSync(
      process.platform === "win32" ? "where.exe" : "/bin/sh",
      process.platform === "win32"
        ? ["tinymist"]
        : ["-lc", "command -v tinymist"],
      {
        encoding: "utf8",
        timeout: 4000,
      },
    );
    const found =
      probe.status === 0
        ? probe.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? ""
        : "";
    this.resolvedBinary = found || null;
    return this.resolvedBinary;
  }

  resolveFontPaths(root: string | null = this.vaultBasePath()): string[] {
    if (!root) return [];
    return this.settings.fontPaths.map((path) =>
      isAbsolute(path) ? path : join(root, path),
    );
  }

  onDiagnostics(cb: (uri: string) => void): () => void {
    this.diagListeners.add(cb);
    return () => this.diagListeners.delete(cb);
  }

  async startLsp(restart: boolean): Promise<void> {
    if (restart) this.resolvedBinary = undefined;
    if (restart) this.preview.onLspRestart();
    if (this.lsp) {
      if (!restart && this.lsp.status === "running") return;
      this.lsp.stop();
      this.lsp = null;
    }
    const bin = this.resolveBinary();
    const root = this.vaultBasePath();
    if (!root) return;
    if (!bin) {
      this.setStatusBar("failed");
      new Notice(
        "Tinymist: binary not found. Install tinymist (brew install " +
          "tinymist) or set its path in the plugin settings.",
        10000,
      );
      return;
    }
    const lsp = new LspClient(
      bin,
      root,
      (uri) => {
        for (const cb of this.diagListeners) cb(uri);
      },
      { fontPaths: this.resolveFontPaths(root) },
    );
    lsp.onStatusChange = (s) => this.setStatusBar(s);
    this.lsp = lsp;
    try {
      await lsp.start();
    } catch (err) {
      console.error("[tinymist] failed to start language server:", err);
      new Notice("Tinymist: failed to start language server. See console.");
      return;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST)) {
      if (leaf.view instanceof TypstView) leaf.view.reannounce();
    }
    this.syncPinnedMain();
  }

  /**
   * Compile the active chapter through its book's main.typ (see bookMain), so `@`
   * completes labels from every chapter; standalone files compile on their own.
   * Only the active Typst editor decides; other leaves leave the pin alone. A
   * running preview owns tinymist's main until it stops (PreviewManager.stop).
   */
  syncPinnedMain(): void {
    const lsp = this.lsp;
    const path = this.app.workspace.getActiveViewOfType(TypstView)?.absolutePath();
    const root = this.vaultBasePath();
    if (!lsp || lsp.status !== "running" || !path || !root) return;
    const main = this.settings.pinBookMain ? bookMain(path, root) : null;
    if (main === lsp.mainFile) return;
    if (this.preview.url) lsp.mainFile = main;
    else lsp.pinMain(main);
  }

  /** Handle a preview-click jump pushed by the language server. */
  jumpToSource(jump: SourceJump): void {
    if (!jump?.filepath || !jump.start) return;
    void this.openAndPlaceCursor(jump.filepath, jump.start[0], jump.start[1]);
  }

  /** Open an absolute vault file path and place the cursor. */
  async openAndPlaceCursor(
    absPath: string,
    line: number,
    character: number,
  ): Promise<void> {
    const rel = this.vaultRelativePath(absPath);
    if (!rel) return;
    const file = this.app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) return;

    let leaf =
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_TYPST)
        .find(
          (l) => l.view instanceof TypstView && l.view.file?.path === rel,
        ) ?? null;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
    if (leaf.view instanceof TypstView) leaf.view.setCursor(line, character);
  }

  /** Apply an LSP WorkspaceEdit across open views and on-disk files. */
  async applyWorkspaceEdit(edit: unknown): Promise<number> {
    const perFile = new Map<string, LspTextEdit[]>();
    const e = edit as {
      changes?: Record<string, LspTextEdit[]>;
      documentChanges?: Array<{
        textDocument?: { uri?: string };
        edits?: LspTextEdit[];
      }>;
    } | null;
    if (e?.changes) {
      for (const [uri, edits] of Object.entries(e.changes)) {
        perFile.set(uriToPath(uri), edits);
      }
    } else if (e?.documentChanges) {
      for (const dc of e.documentChanges) {
        if (dc.textDocument?.uri && dc.edits) {
          perFile.set(uriToPath(dc.textDocument.uri), dc.edits);
        }
      }
    }
    let count = 0;
    for (const [absPath, edits] of perFile) {
      if (!edits.length) continue;
      count += edits.length;
      const view = this.app.workspace
        .getLeavesOfType(VIEW_TYPE_TYPST)
        .map((l) => l.view)
        .find(
          (v): v is TypstView =>
            v instanceof TypstView && v.absolutePath() === absPath,
        );
      if (view) {
        view.applyTextEdits(edits);
      } else {
        await this.applyEditsToFile(absPath, edits);
      }
    }
    return count;
  }

  private async applyEditsToFile(
    absPath: string,
    edits: LspTextEdit[],
  ): Promise<void> {
    const rel = this.vaultRelativePath(absPath);
    if (!rel) return;
    const adapter = this.app.vault.adapter;
    let text: string;
    try {
      text = await adapter.read(rel);
    } catch {
      return;
    }
    // Line-start offsets for position -> offset conversion.
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    const toOffset = (p: { line: number; character: number }): number => {
      const lineStart = starts[Math.min(p.line, starts.length - 1)];
      const lineEnd =
        p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
      return Math.min(lineStart + p.character, lineEnd);
    };
    const resolved = edits
      .map((e2) => ({
        from: toOffset(e2.range.start),
        to: toOffset(e2.range.end),
        insert: e2.newText,
      }))
      .sort((a, b) => b.from - a.from);
    for (const r of resolved) {
      text = text.slice(0, r.from) + r.insert + text.slice(r.to);
    }
    await adapter.write(rel, text);
  }

  private vaultRelativePath(absPath: string): string | null {
    const base = this.vaultBasePath();
    if (!base) return null;
    const rel = relative(base, absPath);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      return null;
    }
    return rel.split(sep).join("/");
  }

  /** Mod-E: close the preview of this file, or open one. */
  async togglePreview(view: TypstView): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST_PREVIEW)[0];
    const path = view.absolutePath();
    if (leaf && path && this.preview.filePath === path) {
      leaf.detach();
      return;
    }
    await this.openPreview(view);
  }

  async openPreview(view: TypstView): Promise<void> {
    const path = view.absolutePath();
    if (!path) return;
    let url: string;
    try {
      url = await this.preview.start(path);
    } catch (err) {
      console.error("[tinymist] preview failed:", err);
      new Notice(`Tinymist preview failed: ${String(err)}`, 8000);
      return;
    }
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST_PREVIEW)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE_TYPST_PREVIEW, active: false });
    }
    if (leaf.view instanceof PreviewView) leaf.view.setUrl(url);
    void this.app.workspace.revealLeaf(leaf);
  }

  private setStatusBar(status: LspStatus | "stopped"): void {
    this.statusBarEl?.setText(`Tinymist: ${status}`);
  }
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

class AutomaticPdfConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly request: AutomaticPdfReplaceRequest,
    private readonly answer: (accepted: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Replace sibling PDF?");
    this.contentEl.createEl("p", {
      text:
        `The PDF next to ${this.request.sourcePath} already exists or changed outside ` +
        "Automatic PDF export. Replace it?",
    });
    const buttons = this.contentEl.createDiv({ cls: "tym-pdf-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(false));
    buttons.createEl("button", { text: "Replace" }).addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.finish(false);
  }

  private finish(accepted: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(accepted);
    this.close();
  }
}

class RenameModal extends Modal {
  private input: HTMLInputElement | null = null;

  constructor(
    app: App,
    private plugin: TinymistPlugin,
    private view: TypstView,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename symbol");
    this.input = this.contentEl.createEl("input", {
      type: "text",
      cls: "tym-rename-input",
      attr: { placeholder: "New name" },
    });
    this.input.focus();
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  private async submit(): Promise<void> {
    const newName = this.input?.value.trim();
    this.view.syncLsp();
    const pos = this.view.cursorPosition();
    const path = this.view.absolutePath();
    this.close();
    if (!newName || !pos || !path) return;
    const lsp = this.plugin.lsp;
    if (lsp?.status !== "running") return;
    try {
      const edit = await lsp.rename(path, pos, newName);
      if (!edit) {
        new Notice("Tinymist: nothing to rename here.");
        return;
      }
      const count = await this.plugin.applyWorkspaceEdit(edit);
      new Notice(`Tinymist: renamed ${count} occurrence(s).`);
    } catch (err) {
      new Notice(`Tinymist rename failed: ${String(err)}`, 6000);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
