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
  MarkdownView,
  Plugin,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  editorInfoField,
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
import { NoteSessions, noteCompletionExtension } from "./editor/noteCompletions";
import { FileEvent, TypstRender } from "./editor/typstRender";
import { LspTextEdit, TypstView, VIEW_TYPE_TYPST } from "./editor/typstView";
import { Kit, type KitStateView } from "./kit/kit";
import { parseManifest, readManifest } from "./kit/manifest";
import { LspClient, LspStatus, uriToPath } from "./lsp/client";
import { TypstFragmentRenderer } from "./lsp/fragmentRenderer";
import { PreviewManager, SourceJump } from "./preview/previewManager";
import { PreviewView, VIEW_TYPE_TYPST_PREVIEW } from "./preview/previewView";
import { installExportRedirect } from "./integrations/exportRedirect";
import { installNativeSuggestGuard } from "./integrations/nativeSuggestGuard";
import { installPropertySuggestions, type PropertySuggestionKit } from "./integrations/propertySuggestions";
import {
  mdAdapter,
  pdfDestination,
  SourceRegistry,
  typAdapter,
  typBookMain,
  type MarkdownSourceHost,
  type Position,
} from "./sources";
import { registerNoteControls } from "./integrations/noteControls";
import { editorDiagnostics } from "./underlines/editorDiagnostics";
import { NoteHolder } from "./underlines/noteHolder";
import {
  DEFAULT_SETTINGS,
  parseFontPaths,
  TinymistSettings,
  TinymistSettingTab,
} from "./settings";

const NOTE_SHADOW_ROOT = ".typst-cache/notes";

export default class TinymistPlugin extends Plugin {
  settings: TinymistSettings = DEFAULT_SETTINGS;
  lsp: LspClient | null = null;
  kit: Kit = this.createKit();
  preview: PreviewManager = new PreviewManager(this);
  sources: SourceRegistry = new SourceRegistry([
    typAdapter({
      root: () => this.vaultBasePath(),
      reveal: (document, position) =>
        this.openAndPlaceCursor(document, position.line, position.character),
    }),
    mdAdapter(this.markdownSourceHost()),
  ]);
  /** Undo history of recently closed .typ files, restored on reopen. */
  history = new HistoryCache();
  /** YOLO AI completion in our editors; one per plugin, shared by every view. */
  yolo!: YoloBridge;
  /** The second `tinymist lsp` that renders formulas (null without a vault folder). */
  fragments: TypstFragmentRenderer | null = null;
  /** Formula renders for the hover, cached across views. */
  typstRender: TypstRender | null = null;
  noteHolder: NoteHolder | null = null;
  private noteSessions: NoteSessions | null = null;
  private automaticPdfController: AutomaticPdfController | null = null;

  private diagListeners = new Set<(uri: string) => void>();
  private statusBarEl: HTMLElement | null = null;
  private resolvedBinary: string | null | undefined;
  private savedFontPaths: readonly string[] | undefined;
  private savedKitManifest = "";
  private savedDefaultTemplate = "";
  private kitReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private kitUnsubscribe: (() => void) | null = null;
  private startedFontPaths: readonly string[] | undefined;
  private kitChangePromise: Promise<void> | null = null;
  private suppressKitFontRestart = false;
  private readonly automaticPdfListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.clearNoteShadowCache();
    await this.loadSettings();
    this.kitUnsubscribe = this.kit.onChange(() => {
      void this.onKitChange().catch((error: unknown) => {
        console.error("[tinymist] kit change failed:", error);
      });
    });
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
      sources: this.sources,
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
        const path = this.activeSourcePath();
        const root = this.vaultBasePath();
        const relativePath = path && root ? this.vaultRelativePath(path) : null;
        if (!path || !relativePath || !this.sources.mayBeSource(relativePath)) return false;
        if (!checking) void this.openPreview(relativePath);
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
      callback: () => {
        void this.restartLanguageServer().catch((error: unknown) => {
          console.error("[tinymist] language server restart failed:", error);
        });
      },
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
    registerNoteControls(this);
    const restoreExportRedirect = installExportRedirect(this);
    if (restoreExportRedirect) this.register(restoreExportRedirect);
    const restorePropertySuggestions = installPropertySuggestions(this.app, () => this.propertySuggestionKit());
    if (restorePropertySuggestions) this.register(restorePropertySuggestions);
    const restoreNativeSuggestGuard = installNativeSuggestGuard(this.app, (file) =>
      file ? this.sources.mayBeSource(file.path) : false,
    );
    if (restoreNativeSuggestGuard) this.register(restoreNativeSuggestGuard);

    this.noteHolder = new NoteHolder({
      registry: this.sources,
      client: () => this.client(),
      onDiagnostics: (callback) => this.onDiagnostics(callback),
      diagnostics: (uri) => this.lsp?.diagnostics(uri) ?? [],
      leaves: () => this.app.workspace.getLeavesOfType("markdown")
        .flatMap((leaf) => leaf.view instanceof MarkdownView && leaf.view.file
          ? [{ path: leaf.view.file.path }]
          : []),
      onLayout: (callback) => {
        const ref = this.app.workspace.on("layout-change", callback);
        return () => this.app.workspace.offref(ref);
      },
      onOpened: () => this.syncPinnedMain(),
      onMoved: (oldEntry, newEntry) => this.retargetMain(oldEntry, newEntry),
      onReleased: (_path, entry) => this.retargetMain(entry, null),
    });
    this.registerEditorExtension(editorDiagnostics(
      (view) => view.state.field(editorInfoField, false)?.file?.path ?? null,
      this.noteHolder,
    ));
    this.noteSessions = new NoteSessions({
      hold: (path) => this.sources.hold(path),
      client: () => this.client(),
    });
    this.registerEditorExtension(noteCompletionExtension({
      notePath: (state) => {
        const path = state.field(editorInfoField, false)?.file?.path;
        return path && this.sources.mayBeSource(path) ? path : null;
      },
      session: (path) => this.noteSessions?.session(path) ?? Promise.resolve(null),
      triggerCharacters: () => this.lsp?.completionTriggerCharacters() ?? [],
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.refreshNoteHolder();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.refreshNoteHolder();
    }));
    const metadataCache = (this.app as unknown as {
      metadataCache?: { on(name: string, callback: (file: TFile) => void): { detach(): void } };
    }).metadataCache;
    if (metadataCache) {
      this.registerEvent(metadataCache.on("changed", (file) => {
        if (file.extension === "md") this.refreshNoteHolder();
      }));
    }

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
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.settings.kitManifest.trim()) {
          void this.kit.reload(true);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path === this.settings.kitManifest.trim()) {
          this.kit.markManifestMissing(file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const manifestPath = this.settings.kitManifest.trim();
        if (oldPath === manifestPath) {
          this.kit.markManifestMissing(oldPath);
        } else if (file.path === manifestPath) {
          void this.kit.reload(true);
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncPinnedMain()),
    );

    this.app.workspace.onLayoutReady(() => {
      void this.startLsp(false);
      void this.kit.reload();
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file.path === this.settings.kitManifest.trim()) {
            void this.kit.reload(true);
          }
        }),
      );
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
    if (this.kitReloadTimer) clearTimeout(this.kitReloadTimer);
    this.kitReloadTimer = null;
    this.kitUnsubscribe?.();
    this.kitUnsubscribe = null;
    this.kitOrNull()?.dispose();
    this.automaticPdfController?.dispose();
    this.automaticPdfController = null;
    this.automaticPdfListeners.clear();
    this.noteSessions?.dispose();
    this.noteSessions = null;
    this.noteHolder?.dispose();
    this.noteHolder = null;
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
    const kitManifest = typeof data?.kitManifest === "string" ? data.kitManifest : "";
    const defaultTemplate = typeof data?.defaultTemplate === "string" ? data.defaultTemplate : "";
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data, { fontPaths, kitManifest, defaultTemplate });
    this.savedFontPaths = [...fontPaths];
    this.savedKitManifest = this.settings.kitManifest;
    this.savedDefaultTemplate = this.settings.defaultTemplate;
  }

  async saveSettings(forceRenderInvalidation = false): Promise<void> {
    const kitManifestChanged = this.savedKitManifest !== this.settings.kitManifest;
    const defaultTemplateChanged = this.savedDefaultTemplate !== this.settings.defaultTemplate;
    const fontPaths = this.settings.fontPaths.filter((path) => path.trim() !== "");
    const fontPathsChanged =
      this.savedFontPaths === undefined || !samePaths(this.savedFontPaths, fontPaths);
    this.settings.fontPaths = fontPaths;
    this.savedFontPaths = [...fontPaths];
    this.savedKitManifest = this.settings.kitManifest;
    this.savedDefaultTemplate = this.settings.defaultTemplate;
    this.resolvedBinary = undefined;
    this.automaticPdfController?.configurationChanged();
    // The renderer restarts with the (possibly new) binary at its next render, and live
    // views try again the formulas that failed for want of it.
    this.fragments?.stop();
    if (fontPathsChanged || forceRenderInvalidation) this.typstRender?.invalidate();
    else this.typstRender?.retryFailed();
    await this.saveData(this.settings);
    if (this.kit) {
      if (kitManifestChanged) this.scheduleKitReload();
      else if (defaultTemplateChanged) this.notifyKitSettingsChanged();
    }
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
        pdfPath: pdfDestination(path),
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
    const result: string[] = [];
    const seen = new Set<string>();
    const add = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      result.push(path);
    };
    for (const path of this.settings.fontPaths) add(isAbsolute(path) ? path : join(root, path));
    const kit = this.kitOrNull();
    if (!kit) return result;
    if (kit.state.kind === "ready") {
      for (const path of kit.state.manifest.fontPaths) add(path);
    } else if (kit.state.kind === "loading" && kit.state.previous) {
      for (const path of kit.state.previous.fontPaths) add(path);
    }
    return result;
  }

  kitStatus(): string {
    const kit = this.kitOrNull();
    if (!kit) return "Kit: none";
    const state = kit.state;
    switch (state.kind) {
      case "none":
        return "Kit: none";
      case "loading":
        return "Kit: loading";
      case "ready":
        return `Kit: ready (${Object.keys(state.manifest.templates).length} templates)`;
      case "failed":
        return `Kit: failed: ${state.reason}`;
    }
  }

  /** Reconcile the primary server with the effective kit font list. */
  async onKitChange(): Promise<void> {
    const kit = this.kitOrNull();
    if (!kit) return;
    const previous = this.kitChangePromise ?? Promise.resolve();
    const current = previous.then(async () => {
      if (this.suppressKitFontRestart) return;
      if (kit.state?.kind === "loading") return;
      const root = this.vaultBasePath();
      const running = this.startedFontPaths ?? this.lsp?.cloneConfiguration().fontPaths;
      if (!root || !running) return;
      const resolved = this.resolveFontPaths(root);
      if (samePaths(running, resolved)) return;
      this.fragments?.stop();
      this.typstRender?.invalidate();
      this.automaticPdfController?.configurationChanged();
      await this.startLsp(true);
    });
    this.kitChangePromise = current;
    try {
      await current;
    } finally {
      if (this.kitChangePromise === current) this.kitChangePromise = null;
    }
  }

  onDiagnostics(cb: (uri: string) => void): () => void {
    this.diagListeners.add(cb);
    return () => this.diagListeners.delete(cb);
  }

  private refreshNoteHolder(): void {
    const holder = this.noteHolder;
    if (!holder) return;
    void holder.refresh().catch((error: unknown) => {
      console.error("[tinymist] note diagnostics refresh failed:", error);
    });
  }

  private client(): LspClient | null {
    const lsp = this.lsp;
    return lsp?.started ? lsp : null;
  }

  async startLsp(restart: boolean): Promise<void> {
    if (restart) this.resolvedBinary = undefined;
    const previewPath = restart ? this.preview.onLspRestart() : null;
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
    const fontPaths = this.resolveFontPaths(root);
    const lsp = new LspClient(
      bin,
      root,
      (uri) => {
        for (const cb of this.diagListeners) cb(uri);
      },
      { fontPaths },
    );
    this.startedFontPaths = [...fontPaths];
    lsp.onStatusChange = (s) => this.setStatusBar(s);
    this.lsp = lsp;
    try {
      await lsp.start();
    } catch (err) {
      console.error("[tinymist] failed to start language server:", err);
      new Notice("Tinymist: failed to start language server. See console.");
      return;
    }
    if (restart) this.noteHolder?.reopen();
    else {
      try {
        await this.noteHolder?.refresh();
      } catch (error) {
        console.error("[tinymist] initial note diagnostics refresh failed:", error);
      }
    }
    if (previewPath) {
      await this.preview.start(previewPath).catch((error: unknown) => {
        console.error("[tinymist] failed to reopen preview:", error);
      });
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST)) {
      if (leaf.view instanceof TypstView) leaf.view.reannounce();
    }
    this.syncPinnedMain();
  }

  private async restartLanguageServer(): Promise<void> {
    this.resolvedBinary = undefined;
    this.suppressKitFontRestart = true;
    try {
      await this.kitOrNull()?.reload(true);
      const root = this.vaultBasePath();
      const running = this.startedFontPaths ?? this.lsp?.cloneConfiguration().fontPaths;
      if (root && running && !samePaths(running, this.resolveFontPaths(root))) {
        this.fragments?.stop();
        this.typstRender?.invalidate();
        this.automaticPdfController?.configurationChanged();
      }
      await this.startLsp(true);
    } finally {
      this.suppressKitFontRestart = false;
    }
  }

  /**
   * Compile the active chapter through its book's main.typ (see bookMain), so `@`
   * completes labels from every chapter; standalone files compile on their own.
   * The active Typst editor or held Markdown note decides; other leaves leave
   * the pin alone. A running preview owns tinymist's main until it stops
   * (PreviewManager.stop).
   */
  syncPinnedMain(releasedEntry?: string): void {
    const lsp = this.lsp;
    if (!lsp || lsp.status !== "running") return;
    if (releasedEntry && this.preview.url) return;

    const typstPath = this.app.workspace.getActiveViewOfType(TypstView)?.absolutePath();
    let main: string | null;
    if (typstPath) {
      const root = this.vaultBasePath();
      if (!root) return;
      main = this.settings.pinBookMain ? typBookMain(typstPath, root) : null;
    } else {
      const notePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
      if (notePath) {
        main = this.noteHolder?.entryOf(notePath) ?? null;
        if (!main && (!releasedEntry || lsp.mainFile !== releasedEntry)) return;
      } else {
        if (!releasedEntry || lsp.mainFile !== releasedEntry) return;
        main = null;
      }
    }

    if (main === lsp.mainFile) return;
    if (this.preview.url) lsp.mainFile = main;
    else lsp.pinMain(main);
  }

  retargetMain(oldEntry: string, replacement: string | null): void {
    const lsp = this.lsp;
    if (!lsp || lsp.status !== "running" || lsp.mainFile !== oldEntry) return;

    const activeNotePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
    const main = replacement
      ?? (activeNotePath ? this.noteHolder?.entryOf(activeNotePath) ?? null : null);
    if (this.preview.url) lsp.mainFile = main;
    else lsp.pinMain(main);
  }

  /** Handle a preview-click jump pushed by the language server. */
  jumpToSource(jump: SourceJump): void {
    if (!jump?.filepath || !jump.start) return;
    void this.revealSource(jump.filepath, {
      line: jump.start[0],
      character: jump.start[1],
    });
  }

  private async revealSource(
    document: string,
    position: Position,
  ): Promise<void> {
    const held = this.sources.byDocument(document);
    if (held) {
      await held.reveal(held.toSource(position));
      return;
    }
    const file = this.vaultRelativePath(document);
    const source = file ? await this.sources.hold(file) : null;
    if (!source) {
      await this.openAndPlaceCursor(document, position.line, position.character);
      return;
    }
    try {
      await source.reveal(source.toSource(position));
    } finally {
      source.release();
    }
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
        .find((candidate) => candidate.view instanceof TypstView && candidate.view.file?.path === rel) ??
      this.app.workspace
        .getLeavesOfType("markdown")
        .find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === rel) ??
      null;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
    if (leaf.view instanceof TypstView) {
      leaf.view.setCursor(line, character);
    } else if (leaf.view instanceof MarkdownView) {
      const position = { line, ch: character };
      leaf.view.editor.setCursor(position);
      leaf.view.editor.scrollIntoView({ from: position, to: position });
    }
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
    if (path) await this.openPreview(path);
  }

  async openPreview(vaultPath: string): Promise<void> {
    const requested = typeof vaultPath === "string"
      ? vaultPath
      : (vaultPath as unknown as { absolutePath?: () => string | null }).absolutePath?.() ?? "";
    const root = typeof (this as unknown as { vaultBasePath?: () => string | null }).vaultBasePath === "function"
      ? this.vaultBasePath()
      : null;
    const path = root && !isAbsolute(requested) ? join(root, requested) : requested;
    if (!path) return;
    let url: string | null;
    try {
      url = await this.preview.start(path);
    } catch (err) {
      console.error("[tinymist] preview failed:", err);
      new Notice(`Tinymist preview failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    if (!url) return;
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST_PREVIEW)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE_TYPST_PREVIEW, active: false });
    }
    if (leaf.view instanceof PreviewView) leaf.view.setUrl(url);
    void this.app.workspace.revealLeaf(leaf);
  }

  private createKit(): Kit {
    const root = this.vaultBasePath() ?? "";
    return new Kit({
      vaultBase: root,
      bin: () => this.resolveBinary(),
      settings: () => ({
        kitManifest: this.settings.kitManifest,
        defaultTemplate: this.settings.defaultTemplate,
      }),
      readManifest: async (binPath, vaultBase, manifestAbsPath, timeoutMs) => {
        const value = await readManifest(binPath, vaultBase, manifestAbsPath, timeoutMs);
        const parsed = parseManifest(value, manifestVaultDir(manifestAbsPath, vaultBase), vaultBase);
        if ("error" in parsed) throw new Error(parsed.error);
        return parsed;
      },
    });
  }

  private kitOrNull(): Kit | null {
    return this.kit ?? null;
  }

  private kitStateView(): KitStateView {
    const kit = this.kitOrNull();
    if (kit) return kit.view();
    const defaultTemplate = this.settings.defaultTemplate;
    return defaultTemplate === ""
      ? { ready: true, kit: null }
      : { ready: true, kit: { templates: {}, defaultTemplate } };
  }

  private propertySuggestionKit(): PropertySuggestionKit | null {
    const kit = this.kitOrNull();
    if (!kit || kit.state.kind !== "ready") return null;
    return { manifest: kit.state.manifest, defaultTemplate: this.settings.defaultTemplate };
  }

  private scheduleKitReload(): void {
    if (this.kitReloadTimer) clearTimeout(this.kitReloadTimer);
    this.kitReloadTimer = setTimeout(() => {
      this.kitReloadTimer = null;
      void this.kit.reload().catch((error: unknown) => {
        console.error("[tinymist] kit reload failed:", error);
      });
    }, 500);
  }

  private notifyKitSettingsChanged(): void {
    void this.kit.reload().catch((error: unknown) => {
      console.error("[tinymist] kit settings update failed:", error);
    });
  }

  private activeSourcePath(): string | null {
    const typst = this.app.workspace.getActiveViewOfType(TypstView)?.absolutePath();
    if (typst) return typst;
    const markdown = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
    const root = this.vaultBasePath();
    return markdown && root ? join(root, markdown) : markdown ?? null;
  }

  private async clearNoteShadowCache(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (typeof adapter.exists === "function" && !(await adapter.exists(NOTE_SHADOW_ROOT))) return;
      await adapter.rmdir(NOTE_SHADOW_ROOT, true);
    } catch (error) {
      console.warn("[tinymist] note shadow cache cleanup failed:", error);
    }
  }

  private markdownSourceHost(): MarkdownSourceHost {
    const adapterExists = (adapter: unknown, path: string): Promise<boolean> => {
      const exists = (adapter as {
        exists?: (candidate: string) => Promise<boolean>;
      }).exists;
      return typeof exists === "function"
        ? exists.call(adapter, path)
        : Promise.resolve(false);
    };
    const ensureShadowParents = async (adapter: unknown, path: string): Promise<void> => {
      const parts = path.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapterExists(adapter, current))) {
          await (adapter as { mkdir(path: string): Promise<void> }).mkdir(current);
        }
      }
    };
    const shadowPath = (vaultPath: string): string => `${NOTE_SHADOW_ROOT}/${vaultPath}.typ`;
    return {
      root: () => this.vaultBasePath(),
      frontmatter: (vaultPath) => this.app.metadataCache.getCache(vaultPath)?.frontmatter ?? null,
      editorText: (vaultPath) => {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== vaultPath) continue;
          if (leaf.view.getMode() !== "source") continue;
          return leaf.view.editor.getValue();
        }
        return null;
      },
      readFile: (vaultPath) => this.app.vault.adapter.read(vaultPath),
      exists: (vaultPath) => this.app.vault.getAbstractFileByPath(vaultPath) instanceof TFile,
      writeShadow: async (vaultPath) => {
        const adapter = this.app.vault.adapter;
        const path = shadowPath(vaultPath);
        await ensureShadowParents(adapter, path.slice(0, path.lastIndexOf("/")));
        await adapter.write(path, "");
      },
      removeShadow: async (vaultPath) => {
        const adapter = this.app.vault.adapter;
        const path = shadowPath(vaultPath);
        const exists = (adapter as {
          exists?: (candidate: string) => Promise<boolean>;
        }).exists;
        if (typeof exists === "function" && !(await exists.call(adapter, path))) return;
        try {
          await adapter.remove(path);
        } catch (error) {
          if (typeof exists === "function" && !(await exists.call(adapter, path))) return;
          throw error;
        }
      },
      kit: (): KitStateView => this.kitStateView(),
      onKitChange: (listener) => this.kitOrNull()?.onChange(listener) ?? (() => {}),
      reveal: (vaultPath, position) => {
        const root = this.vaultBasePath();
        return root
          ? this.openAndPlaceCursor(join(root, vaultPath), position.line, position.character)
          : Promise.resolve();
      },
      onEditorChange: (listener) => {
        const ref = this.app.workspace.on("editor-change", (editor, info) => {
          if (!info.file) return;
          listener(info.file.path, editor.getValue());
        });
        return () => this.app.workspace.offref(ref);
      },
      onRename: (listener) => {
        const ref = this.app.vault.on("rename", (file, oldPath) => listener(oldPath, file.path));
        return () => this.app.vault.offref(ref);
      },
      onDelete: (listener) => {
        const ref = this.app.vault.on("delete", (file) => listener(file.path));
        return () => this.app.vault.offref(ref);
      },
    };
  }

  private setStatusBar(status: LspStatus | "stopped"): void {
    this.statusBarEl?.setText(`Tinymist: ${status}`);
  }
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

function manifestVaultDir(manifestAbsPath: string, vaultBase: string): string {
  const path = relative(vaultBase, manifestAbsPath).split(sep).join("/");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
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
