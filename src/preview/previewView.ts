import { ItemView, WorkspaceLeaf } from "obsidian";
import type TinymistPlugin from "../main";
import { uriToPath } from "../lsp/client";
import type { Position } from "../sources";
import { relative, sep } from "path";

export const VIEW_TYPE_TYPST_PREVIEW = "tinymist-preview";

export class PreviewView extends ItemView {
  private iframe: HTMLIFrameElement | null = null;
  private pdfControl: HTMLInputElement | null = null;
  private pdfControlLabel: HTMLLabelElement | null = null;
  private removePreviewListener: (() => void) | null = null;
  private removePdfSettingListener: (() => void) | null = null;
  private pdfChangeHandler: (() => void) | null = null;
  private pdfRequest = 0;
  private closed = false;
  private readonly problemsEl: HTMLUListElement;
  private readonly diagnosticUris = new Set<string>();
  private removeDiagnosticsListener: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TinymistPlugin,
  ) {
    super(leaf);
    this.problemsEl = this.contentEl.createEl("ul", { cls: "tinymist-problems" });
    this.mountPdfControl();
    this.removePreviewListener = this.plugin.preview.onChange(() => {
      const url = this.plugin.preview.url;
      if (url && this.iframe?.src !== url) this.setUrl(url);
      this.pdfRequest++;
      this.syncPdfControl();
      this.syncProblems();
    });
    this.removeDiagnosticsListener = this.plugin.onDiagnostics((uri) => {
      this.diagnosticUris.add(uri);
      this.syncProblems();
    });
    for (const uri of this.plugin.lsp?.diagnosticUris() ?? []) this.diagnosticUris.add(uri);
    this.syncProblems();
    this.removePdfSettingListener = this.plugin.onAutomaticPdfChange(() => {
      this.pdfRequest++;
      this.syncPdfControl();
    });
  }

  getViewType(): string {
    return VIEW_TYPE_TYPST_PREVIEW;
  }

  getDisplayText(): string {
    return "Typst preview";
  }

  getIcon(): string {
    return "eye";
  }

  setUrl(url: string): void {
    if (!this.iframe) {
      this.contentEl.addClass("tym-preview-content");
      this.iframe = this.contentEl.createEl("iframe", {
        cls: "tym-preview-frame",
      });
    }
    if (this.iframe.src !== url) this.iframe.src = url;
    this.syncPdfControl();
    this.syncProblems();
  }

  async onClose(): Promise<void> {
    this.cleanupPdfControl();
    this.removeDiagnosticsListener?.();
    this.removeDiagnosticsListener = null;
    await this.plugin.preview.stop();
    this.syncProblems();
    this.iframe = null;
    await super.onClose();
  }

  unload(): void {
    this.cleanupPdfControl();
    this.removeDiagnosticsListener?.();
    this.removeDiagnosticsListener = null;
    super.unload();
  }

  private syncProblems(): void {
    const source = this.plugin.preview.currentSource();
    if (!source) {
      this.problemsEl.replaceChildren();
      this.problemsEl.hidden = true;
      return;
    }

    const rows: Array<{ text: string; position: Position; otherPath?: string }> = [];
    for (const problem of source.problems ?? []) {
      rows.push({
        text: `${source.file}:${problem.line + 1} ${problem.message}`,
        position: { line: problem.line, character: 0 },
      });
    }

    for (const uri of this.diagnosticUris) {
      const path = diagnosticPath(uri);
      const diagnostics = this.plugin.lsp?.diagnostics?.(uri) ?? [];
      for (const diagnostic of diagnostics) {
        if (path === source.entry) {
          const position = source.toSource(diagnostic.range.start);
          rows.push({
            text: `${source.file}:${position.line + 1} ${diagnostic.message}`,
            position,
          });
        } else {
          const relativePath = this.relativePath(path);
          rows.push({
            text: `${relativePath}:${diagnostic.range.start.line + 1} ${diagnostic.message}`,
            position: diagnostic.range.start,
            otherPath: path,
          });
        }
      }
    }

    this.problemsEl.replaceChildren(
      ...rows.map(({ text, position, otherPath }) => {
        const entry = document.createElement("li");
        entry.textContent = text;
        entry.addEventListener("click", () => {
          if (otherPath) {
            void this.plugin.openAndPlaceCursor(otherPath, position.line, position.character).catch(() => {});
          } else {
            void source.reveal(position).catch(() => {});
          }
        });
        return entry;
      }),
    );
    this.problemsEl.hidden = rows.length === 0;
  }

  private relativePath(path: string): string {
    const root = this.plugin.vaultBasePath();
    if (!root) return path;
    return relative(root, path).split(sep).join("/");
  }

  private mountPdfControl(): void {
    const header = this.containerEl.querySelector<HTMLElement>(".view-header");
    if (!header) return;
    const actions = header.querySelector<HTMLElement>(".view-actions");
    const host = actions ?? header;
    const label = document.createElement("label");
    label.className = "tym-preview-pdf-control";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `tym-preview-pdf-${Math.random().toString(36).slice(2, 9)}`;
    this.pdfChangeHandler = () => this.changePdfSetting(input);
    input.addEventListener("change", this.pdfChangeHandler);
    label.append(input, document.createTextNode("Automatic PDF export"));
    const finalNativeAction = actions?.lastElementChild;
    if (finalNativeAction) actions.insertBefore(label, finalNativeAction);
    else host.append(label);
    this.pdfControl = input;
    this.pdfControlLabel = label;
    this.syncPdfControl();
  }

  private cleanupPdfControl(): void {
    if (this.closed) return;
    this.closed = true;
    this.pdfRequest++;
    this.removePreviewListener?.();
    this.removePreviewListener = null;
    if (this.pdfControl && this.pdfChangeHandler) {
      this.pdfControl.removeEventListener("change", this.pdfChangeHandler);
    }
    this.pdfChangeHandler = null;
    this.removePdfSettingListener?.();
    this.removePdfSettingListener = null;
    this.pdfControlLabel?.remove();
    this.pdfControl = null;
    this.pdfControlLabel = null;
  }

  private syncPdfControl(): void {
    const input = this.pdfControl;
    if (!input || this.closed) return;
    const source = this.plugin.preview.currentSource();
    const sourcePath = source
      ? source.exportable ? source.file : null
      : this.plugin.preview.sourcePath();
    input.disabled = sourcePath === null;
    input.checked = sourcePath !== null && this.plugin.automaticPdfEnabled(sourcePath);
  }

  private changePdfSetting(input: HTMLInputElement): void {
    const source = this.plugin.preview.currentSource();
    const sourcePath = source
      ? source.exportable ? source.file : null
      : this.plugin.preview.sourcePath();
    if (!sourcePath || input.disabled) {
      this.syncPdfControl();
      return;
    }
    const request = ++this.pdfRequest;
    const enabled = input.checked;
    void this.plugin.setAutomaticPdf(sourcePath, enabled).then(
      () => {
        if (request !== this.pdfRequest || this.closed) return;
        this.syncPdfControl();
      },
      () => {
        if (request !== this.pdfRequest || this.closed) return;
        this.syncPdfControl();
      },
    );
  }
}

function diagnosticPath(uri: string): string {
  try {
    return uriToPath(uri);
  } catch {
    return uri;
  }
}
