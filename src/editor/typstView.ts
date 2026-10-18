import { ChangeSet, EditorState, Extension, Text } from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { join } from "path";
import { Menu, Notice, Scope, TextFileView, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { pathToUri, uriToPath } from "../lsp/client";
import type TinymistPlugin from "../main";
import {
  lspDiagnosticsToCm,
  lspHoverTooltip,
  markdownInfoRenderer,
  offsetToPos,
  posToOffset,
} from "./lspExtensions";
import {
  SemanticLegend,
  StaleRange,
  decodeSemanticTokens,
  markSemanticStale,
  setSemanticActive,
  setSemanticTokens,
} from "./semanticTokens";
import {
  EditorEphemeralState,
  applyEphemeralState,
  getEphemeralState,
  registerEditorScope,
  setDocText,
  setTypingDiagnostics,
  showSearch,
  syncDarkTheme,
} from "./shared/editorKit";
import {
  LIVE_MAX_LINES,
  isLive,
  livePreview,
  livePreviewCompartment,
  renderStats,
} from "./shared/livePreview";
import {
  LspDocument,
  tinymistBackend,
  typstEditorExtensions,
} from "./typstEditor";
import { typstMathAt } from "./typstFragment";
import { typstLiveLanguage } from "./typstLive";
import { TypstLiveRenderer, TypstRenderHost, typstCursorPreview, typstRenderHover } from "./typstRender";

interface LspRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspTextEdit {
  range: LspRangeLike;
  newText: string;
}

export const VIEW_TYPE_TYPST = "tinymist-typst";

/** Source, or live preview (formulas render in place; typstLive.ts). */
export type EditingMode = "source" | "live";

/** The number of lines of `text`, counted up to `max + 1`. */
function linesUpTo(text: string, max: number): number {
  let n = 1;
  for (let at = text.indexOf("\n"); at >= 0 && n <= max; at = text.indexOf("\n", at + 1)) n++;
  return n;
}

export class TypstView extends TextFileView {
  private editor: EditorView | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticGeneration = 0;
  /** Edits since the in-flight semantic-token request; its response is mapped through them. */
  private semanticEdits: ChangeSet | null = null;
  private detachDiagListener: (() => void) | null = null;
  /** The server's copy of the open file. */
  private lspFile: LspDocument;
  /** A save was skipped because an IME composition was open; compositionend reschedules it. */
  private saveAfterComposition = false;
  /** The file uses CRLF line breaks (CodeMirror keeps LF); saves write them back. */
  private crlf = false;
  /** Ephemeral state that arrived before the editor existed. */
  private pendingEState: EditorEphemeralState | null = null;
  /** Kept in the view state (getState/setState), as Markdown views keep theirs. */
  private mode: EditingMode;
  /** The header action that switches the mode. */
  private modeAction: HTMLElement;
  /** Live preview's renderer for the open file (its renders survive mode switches). */
  private liveRenderer: TypstLiveRenderer | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TinymistPlugin,
  ) {
    super(leaf);
    this.lspFile = new LspDocument(() => this.plugin.lsp);
    this.detachDiagListener = plugin.onDiagnostics((uri) =>
      this.applyDiagnostics(uri),
    );
    this.mode = this.defaultMode();
    this.modeAction = this.addAction("book-open", "Switch to live preview", () => this.toggleMode());
    this.addAction("eye", "Open preview", () => {
      void this.plugin.openPreview(this);
    });
    this.syncModeUi();
    // Obsidian's global hotkeys consume these keys before CodeMirror sees them.
    // Mod-S (save) and Mod-F (showSearch below) keep their Obsidian meaning.
    this.scope = new Scope(this.app.scope);
    registerEditorScope(this.scope, () => this.editor, {
      bold: ["*", "*"],
      italic: ["_", "_"],
      togglePreview: () => void this.plugin.togglePreview(this),
    });
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.editor) syncDarkTheme(this.editor);
      }),
    );
  }

  getViewType(): string {
    return VIEW_TYPE_TYPST;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Typst";
  }

  getIcon(): string {
    return "sigma";
  }

  onPaneMenu(menu: Menu, _source: string): void {
    const path = this.file?.path;
    if (!path) return;
    const enabled = this.plugin.automaticPdfEnabled?.(path) ?? false;
    const status = this.plugin.automaticPdfStatus?.(path) ?? "missing";
    menu.addItem((item) =>
      item
        .setTitle("Automatic PDF export")
        .setChecked(enabled)
        .onClick(() => this.plugin.setAutomaticPdf?.(path, !enabled)),
    );
    menu.addItem((item) =>
      item.setTitle("Rebuild PDF").onClick(() => this.plugin.rebuildPdf?.(path)),
    );
    const label = status[0].toUpperCase() + status.slice(1);
    menu.addItem((item) => item.setTitle(`PDF: ${label}`).setDisabled(true));
  }

  /** The CodeMirror view, for plugin commands. */
  get cm(): EditorView | null {
    return this.editor;
  }

  get editingMode(): EditingMode {
    return this.mode;
  }

  /** The view state with the editing mode: it survives a restart through workspace.json. */
  getState(): Record<string, unknown> {
    return { ...super.getState(), mode: this.mode };
  }

  /**
   * A state's mode applies (a restored leaf, history navigation); a state without one (a
   * file opened in this leaf) keeps the leaf's, as Markdown views do. A new view starts in
   * the default mode.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const mode = (state as { mode?: unknown } | null)?.mode;
    if (mode === "live" || mode === "source") this.mode = mode;
    await super.setState(state, result);
    this.applyMode(); // the same file (not reloaded), or a live mode the file refused
  }

  /**
   * Switch between source and live preview: the header action and the command "Toggle live
   * preview". Only the compartment changes, so the document, selection, undo history and
   * scroll stay. Live preview is refused for files over LIVE_MAX_LINES lines (a Notice).
   */
  setMode(mode: EditingMode): boolean {
    if (mode === "live") {
      const typst = this.plugin.typstRender;
      if (!typst) {
        new Notice("Tinymist: live preview needs a vault on the local file system.");
        return false;
      }
      const lines = this.editor?.state.doc.lines ?? 0;
      if (lines > LIVE_MAX_LINES) {
        new Notice(
          `Tinymist: live preview is limited to ${LIVE_MAX_LINES.toLocaleString("en-US")} lines ` +
            `(this file has ${lines.toLocaleString("en-US")}).`,
        );
        return false;
      }
      // Renders that failed for want of the renderer (binary, timeout) are tried again.
      typst.retryFailed();
    }
    if (mode === this.mode) return true;
    this.mode = mode;
    this.applyMode();
    this.app.workspace.requestSaveLayout();
    return true;
  }

  toggleMode(): void {
    this.setMode(this.mode === "live" ? "source" : "live");
  }

  private defaultMode(): EditingMode {
    return this.plugin.settings.editingMode === "live" && this.plugin.typstRender ? "live" : "source";
  }

  /** "Show render statistics": the live renderer's numbers, or null in source mode. */
  renderStatistics(): string | null {
    if (!this.editor || !isLive(this.editor.state)) return null;
    const s = renderStats(this.editor);
    return (
      `${s.renders} renders (p50 ${s.p50} ms, p95 ${s.p95} ms), ${s.pending} pending; ` +
      `cache ${s.cached} held, ${s.hits} hits, ${s.misses} misses; ` +
      `${s.builds} decoration builds (p50 ${s.buildP50} ms, p95 ${s.buildP95} ms)`
    );
  }

  getViewData(): string {
    if (!this.editor) return this.data;
    const text = this.editor.state.doc.toString();
    return this.crlf ? text.replace(/\n/g, "\r\n") : text;
  }

  setViewData(data: string, clear: boolean): void {
    // CodeMirror joins lines with LF; keep a CRLF file CRLF (its first line break decides),
    // so opening and switching away never rewrites it.
    this.crlf = /^[^\n]*\r\n/.test(data);
    // A file too long for live preview opens in source mode.
    if (clear && this.mode === "live" && linesUpTo(data, LIVE_MAX_LINES) > LIVE_MAX_LINES) this.mode = "source";
    if (!this.editor) {
      this.contentEl.addClasses(["tym-editor-content", "lsp-cm-view"]);
      this.editor = new EditorView({
        state: this.stateFor(data),
        parent: this.contentEl,
      });
    } else if (clear) {
      this.dropSemanticRequest();
      this.editor.setState(this.stateFor(data));
    } else {
      // A change from outside (another editor, git, a second pane): apply the
      // difference so the cursor, scroll and undo history survive.
      setDocText(this.editor, data);
    }
    if (clear && this.pendingEState) {
      applyEphemeralState(this.editor, this.pendingEState);
      this.pendingEState = null;
    }
    if (clear) this.syncModeUi();
    this.syncLspOpen();
    if (clear) this.plugin.syncPinnedMain();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    if (this.editor) this.plugin.history.save(file.path, this.editor.state);
    this.clearTimers();
    await super.onUnloadFile(file);
    this.lspFile.close();
  }

  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.syncLspOpen();
    // Renders depend on the file's folder and book: start afresh under the new path.
    if (this.editor && this.mode === "live") {
      this.editor.dispatch({ effects: livePreviewCompartment.reconfigure(this.liveExtension()) });
    }
  }

  clear(): void {
    this.clearTimers();
    this.lspFile.close();
  }

  async onClose(): Promise<void> {
    this.clearTimers();
    // FileView.onClose unloads the file: history cache, pending save, didClose.
    await super.onClose();
    this.detachDiagListener?.();
    this.detachDiagListener = null;
    this.editor?.destroy();
    this.editor = null;
  }

  getEphemeralState(): Record<string, unknown> {
    const state = super.getEphemeralState();
    return this.editor ? { ...state, ...getEphemeralState(this.editor) } : state;
  }

  /** Cursor/scroll round trip and `{focus: true}` when Obsidian activates the leaf. */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    if (!state || typeof state !== "object") return;
    if (this.editor) applyEphemeralState(this.editor, state as EditorEphemeralState);
    else this.pendingEState = state as EditorEphemeralState;
  }

  /** Obsidian's "Search current file" (Mod-F) calls this. */
  showSearch(replace = false): void {
    if (this.editor) showSearch(this.editor, replace);
  }

  /** Absolute filesystem path of the open file, or null. */
  absolutePath(): string | null {
    const base = this.plugin.vaultBasePath();
    if (!base || !this.file) return null;
    return join(base, this.file.path);
  }

  /** Re-announce the open buffer, e.g. after a language-server restart. */
  reannounce(): void {
    this.lspFile.reset();
    this.syncLspOpen();
  }

  /** Bring the server's copy of the file up to the editor (before a request). */
  syncLsp(): void {
    if (this.editor) this.syncLspDoc(this.editor.state.doc);
  }

  /**
   * Never writes uncommitted IME text (Pinyin before a candidate is picked): a second
   * pane, sync and git would see it. The save debounce below and Obsidian's own
   * requestSave both come here; closing the file (`clear`) still writes.
   */
  async save(clear?: boolean): Promise<void> {
    if (!clear && this.editor?.compositionStarted) {
      this.saveAfterComposition = true;
      return;
    }
    this.saveAfterComposition = false;
    await super.save(clear);
  }

  /** A state for `data`: the cached one when this file was open before (undo history). */
  private stateFor(data: string): EditorState {
    const extensions = [
      typstEditorExtensions(
        {
          completion: tinymistBackend(
            () => this.plugin.lsp,
            () => this.absolutePath(),
            (state) => this.syncLspDoc(state.doc),
          ),
          inline: () => this.plugin.yolo.inline,
          yolo: this.plugin.yolo.extension(() => this.file?.name ?? null),
          // The formula's (or a call's page) render first, then tinymist's text hover
          // (signatures of aliases); the cursor preview floats below the formula being typed.
          hover: [
            typstRenderHover(this.renderHost(() => this.plugin.settings.hoverRender)),
            typstCursorPreview(this.renderHost(() => this.plugin.settings.cursorPreview)),
            lspHoverTooltip(
              this.plugin.app,
              () => this.plugin.lsp,
              () => this.absolutePath(),
              // In a rendered formula a symbol's sampled values only repeat the render.
              (state, pos, md) =>
                this.plugin.settings.hoverRender &&
                md.startsWith("### Sampled Values") &&
                typstMathAt(state.doc, pos) !== null,
            ),
          ],
          live: this.liveExtension(),
          renderInfo: markdownInfoRenderer(
            this.plugin.app,
            () => this.file?.path ?? null,
          ),
          onEdit: (_view, changes, startDoc) => this.onEdited(changes, startDoc),
          onUpdate: (update) => this.onUpdate(update),
          gotoDefinition: () => void this.gotoDefinition(),
        },
        data,
      ),
      // After the editor stack, so keyArbiter stays the first extension.
      EditorView.domEventHandlers({
        compositionend: () => {
          if (this.saveAfterComposition) this.scheduleSave();
          return false;
        },
      }),
    ];
    const key = this.file?.path;
    return (
      (key && this.plugin.history.restore(key, data, { extensions })) ||
      EditorState.create({ doc: data, extensions })
    );
  }

  /**
   * The render hover's and cursor preview's view of this file, gated by `enabled`. Paper
   * renders invert as the preview does: with "Invert preview colors" auto, in a dark theme.
   */
  private renderHost(enabled: () => boolean): TypstRenderHost {
    return {
      renderer: () => this.plugin.typstRender,
      path: () => this.absolutePath(),
      enabled,
      inverted: () =>
        this.plugin.settings.invertPreviewColors === "auto" && this.contentEl.ownerDocument.body.classList.contains("theme-dark"),
    };
  }

  /**
   * The content of livePreviewCompartment for the mode (also what HistoryCache.restore
   * gets): live preview with this file's renderer, or nothing.
   */
  private liveExtension(): Extension {
    const typst = this.plugin.typstRender;
    const path = this.absolutePath();
    if (this.mode !== "live" || !typst || !path) return [];
    if (this.liveRenderer?.file !== path) {
      this.liveRenderer = new TypstLiveRenderer(typst, path, () => this.contentEl.ownerDocument);
    }
    return livePreview({ language: typstLiveLanguage(), renderer: this.liveRenderer });
  }

  /** The editor's compartment and the header action as the mode says. */
  private applyMode(): void {
    const editor = this.editor;
    if (editor && this.mode === "live" && editor.state.doc.lines > LIVE_MAX_LINES) this.mode = "source";
    if (editor && isLive(editor.state) !== (this.mode === "live")) {
      editor.dispatch({ effects: livePreviewCompartment.reconfigure(this.liveExtension()) });
    }
    this.syncModeUi();
  }

  private syncModeUi(): void {
    const live = this.mode === "live";
    setIcon(this.modeAction, live ? "code" : "book-open");
    this.modeAction.setAttribute("aria-label", live ? "Switch to source mode" : "Switch to live preview");
    this.contentEl.classList.toggle("is-live-preview", live);
  }

  /** A committed edit (never mid-composition): sync the server, save, re-highlight. */
  private onEdited(changes: ChangeSet, startDoc: Text): void {
    if (!this.editor) return;
    this.syncLspDoc(this.editor.state.doc, { changes, startDoc });
    this.scheduleSemanticTokens();
    // Marks the view dirty, so Obsidian merges an external change into unsaved
    // edits instead of dropping them; the short debounce below drives the preview.
    this.requestSave();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().then(() => {
        const path = this.absolutePath();
        // Not when the save was put off until the composition ends.
        if (path && !this.saveAfterComposition) this.plugin.lsp?.didSave(path);
      });
    }, this.plugin.settings.saveDebounceMs);
  }

  private onUpdate(update: ViewUpdate): void {
    const edits = this.semanticEdits;
    if (update.docChanged && edits) {
      this.semanticEdits =
        edits.newLength === update.changes.length ? edits.compose(update.changes) : null;
    }
    if (update.selectionSet || update.docChanged) this.onCursorMoved();
  }

  private onCursorMoved(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      const path = this.absolutePath();
      if (!path || !this.editor) return;
      const pos = offsetToPos(
        this.editor.state.doc,
        this.editor.state.selection.main.head,
      );
      this.plugin.preview.cursorMoved(path, pos.line, pos.character);
    }, 300);
  }

  /** Current cursor position in LSP line/character terms. */
  cursorPosition(): { line: number; character: number } | null {
    if (!this.editor) return null;
    return offsetToPos(
      this.editor.state.doc,
      this.editor.state.selection.main.head,
    );
  }

  /** Place the cursor, scroll it into view, and focus the editor. */
  setCursor(line: number, character: number): void {
    if (!this.editor) return;
    const pos = posToOffset(this.editor.state.doc, { line, character });
    this.editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    this.editor.focus();
  }

  /** Apply LSP text edits (offsets resolved against the current doc). */
  applyTextEdits(edits: LspTextEdit[]): void {
    if (!this.editor || !edits.length) return;
    const doc = this.editor.state.doc;
    this.editor.dispatch({
      changes: edits.map((e) => ({
        from: posToOffset(doc, e.range.start),
        to: posToOffset(doc, e.range.end),
        insert: e.newText,
      })),
    });
  }

  async gotoDefinition(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    if (!path || !this.editor || lsp?.status !== "running") return;
    this.syncLsp();
    const pos = offsetToPos(
      this.editor.state.doc,
      this.editor.state.selection.main.head,
    );
    let raw: unknown;
    try {
      raw = await lsp.definition(path, pos);
    } catch {
      return;
    }
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first) return;
    const loc = first as {
      uri?: string;
      range?: LspRangeLike;
      targetUri?: string;
      targetSelectionRange?: LspRangeLike;
      targetRange?: LspRangeLike;
    };
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    if (!uri || !range) return;
    let targetPath: string;
    try {
      targetPath = uriToPath(uri);
    } catch {
      return;
    }
    await this.plugin.openAndPlaceCursor(
      targetPath,
      range.start.line,
      range.start.character,
    );
  }

  async formatDocument(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    if (!path || !this.editor || lsp?.status !== "running") return;
    this.syncLsp();
    const requestDoc = this.editor.state.doc;
    let edits: unknown;
    try {
      edits = await lsp.formatting(path);
    } catch {
      return;
    }
    // Edits for an older text would land in the wrong places.
    if (this.editor?.state.doc !== requestDoc) return;
    if (Array.isArray(edits) && edits.length) {
      this.applyTextEdits(edits as LspTextEdit[]);
    }
  }

  private scheduleSemanticTokens(): void {
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    this.semanticTimer = setTimeout(() => {
      this.semanticTimer = null;
      void this.fetchSemanticTokens();
    }, 150);
  }

  private async fetchSemanticTokens(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    const editor = this.editor;
    // A composition's text is not committed yet; its compositionend edit reschedules.
    if (!path || !editor || lsp?.status !== "running" || editor.compositionStarted) {
      return;
    }
    const provider = (
      lsp.serverCapabilities as {
        semanticTokensProvider?: { legend?: SemanticLegend };
      } | null
    )?.semanticTokensProvider;
    const legend = provider?.legend;
    if (!legend?.tokenTypes?.length) return;

    this.syncLspDoc(editor.state.doc);
    const generation = ++this.semanticGeneration;
    const requestDoc = editor.state.doc;
    this.semanticEdits = ChangeSet.empty(requestDoc.length);
    let res: unknown;
    try {
      res = await lsp.semanticTokensFull(path);
    } catch {
      return;
    }
    const data = (res as { data?: number[] } | null)?.data;
    const edits = this.semanticEdits;
    // A newer request, a file switch or a closed editor supersedes this one.
    if (
      !data ||
      !edits ||
      generation !== this.semanticGeneration ||
      this.editor !== editor
    ) {
      return;
    }
    this.semanticEdits = null;
    // Typing during the round trip: map the tokens instead of dropping them, and
    // let the baseline tokenizer draw the lines edited since the request.
    const stale: StaleRange[] = [];
    edits.iterChangedRanges((_fA, _tA, fromB, toB) => stale.push({ from: fromB, to: toB }));
    editor.dispatch({
      effects: [
        setSemanticActive.of(true),
        setSemanticTokens.of(
          decodeSemanticTokens(requestDoc, data, legend).map(edits),
        ),
        markSemanticStale.of(stale),
      ],
    });
  }

  private dropSemanticRequest(): void {
    this.semanticGeneration++;
    this.semanticEdits = null;
  }

  private clearTimers(): void {
    for (const timer of [this.cursorTimer, this.semanticTimer, this.saveTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.cursorTimer = this.semanticTimer = this.saveTimer = null;
    this.dropSemanticRequest();
  }

  private syncLspOpen(): void {
    const path = this.absolutePath();
    if (!path || !this.editor) return;
    if (this.lspFile.open(path, this.editor.state.doc)) {
      this.applyDiagnostics(pathToUri(path));
      this.scheduleSemanticTokens();
    }
  }

  private syncLspDoc(
    doc: Text,
    edit?: { changes: ChangeSet; startDoc: Text },
  ): void {
    // Mid-rename the old path is still open; onRename reopens it.
    if (this.lspFile.path === this.absolutePath()) this.lspFile.sync(doc, edit);
  }

  /**
   * The server's current diagnostics for the open file, into the editor's lint layer only
   * (never `setDiagnostics` directly): new ones on the line being typed wait for a pause
   * or for the cursor to leave the line (typingDiagnostics), so tinymist's per-keystroke
   * publishes do not flash while typing.
   */
  private applyDiagnostics(uri: string): void {
    const path = this.absolutePath();
    if (!path || !this.editor) return;
    if (uri !== pathToUri(path)) return;
    const diags = this.plugin.lsp?.diagnostics(uri) ?? [];
    setTypingDiagnostics(this.editor, lspDiagnosticsToCm(this.editor.state, diags));
  }
}
