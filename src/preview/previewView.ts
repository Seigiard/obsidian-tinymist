import { ItemView, WorkspaceLeaf } from "obsidian";
import type TinymistPlugin from "../main";

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

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TinymistPlugin,
  ) {
    super(leaf);
    this.mountPdfControl();
    this.removePreviewListener = this.plugin.preview.onChange(() => {
      this.pdfRequest++;
      this.syncPdfControl();
    });
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
  }

  async onClose(): Promise<void> {
    this.cleanupPdfControl();
    await this.plugin.preview.stop();
    this.iframe = null;
    await super.onClose();
  }

  unload(): void {
    this.cleanupPdfControl();
    super.unload();
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
    const sourcePath = this.plugin.preview.sourcePath();
    input.disabled = sourcePath === null;
    input.checked = sourcePath !== null && this.plugin.automaticPdfEnabled(sourcePath);
  }

  private changePdfSetting(input: HTMLInputElement): void {
    const sourcePath = this.plugin.preview.sourcePath();
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
