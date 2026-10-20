import { App, PluginSettingTab, Setting } from "obsidian";
import type { AutomaticPdfStoredState } from "./automatic-pdf";
import type TinymistPlugin from "./main";

export interface TinymistSettings {
  /** Absolute path to the tinymist binary; empty means auto-detect. */
  binaryPath: string;
  /** Absolute or Vault-relative font paths sent to Tinymist. */
  fontPaths: readonly string[];
  /** Debounce for writing edits to disk; disk writes drive the preview. */
  saveDebounceMs: number;
  /** Passed to `tinymist preview --invert-colors` when not "never". */
  invertPreviewColors: "never" | "auto";
  /** Experimental: drive the YOLO plugin's AI tab completion in .typ files. */
  yoloTabCompletion: boolean;
  /** Compile a chapter through the book main.typ that includes it. */
  pinBookMain: boolean;
  /** Render the formula under the pointer above tinymist's hover. */
  hoverRender: boolean;
  /** Render the formula around the cursor below it while it is typed. */
  cursorPreview: boolean;
  /** The mode newly opened Typst files start in (each tab then keeps its own). */
  editingMode: "source" | "live";
  /** Per-file automatic PDF opt-ins and last plugin-owned output fingerprints. */
  automaticPdf?: AutomaticPdfStoredState;
}

export const DEFAULT_SETTINGS: TinymistSettings = {
  binaryPath: "",
  fontPaths: [],
  saveDebounceMs: 500,
  invertPreviewColors: "never",
  yoloTabCompletion: false,
  pinBookMain: true,
  hoverRender: true,
  cursorPreview: false,
  editingMode: "source",
};

export class TinymistSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TinymistPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Tinymist binary path")
      .setDesc(
        "Absolute path to the tinymist executable. Leave empty to " +
          "auto-detect from common install locations and the login shell PATH.",
      )
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/tinymist")
          .setValue(this.plugin.settings.binaryPath)
          .onChange(async (value) => {
            this.plugin.settings.binaryPath = value;
            await this.plugin.saveSettings();
          }),
      );

    let fontPathsDraft = this.plugin.settings.fontPaths.join("\n");
    new Setting(containerEl)
      .setName("Font paths")
      .setDesc(
        "One font file or folder per line. Use an absolute path or a path relative to the Vault root; blank lines are ignored and spaces in paths are kept. " +
          "Changes apply only when you click the button and restart the language server.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("fonts\n/Library/Fonts")
          .setValue(fontPathsDraft)
          .onChange((value) => {
            fontPathsDraft = value;
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Apply and restart language server")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.applyFontPaths(parseFontPaths(fontPathsDraft));
            } finally {
              button.setDisabled(false);
            }
          }),
      );

    new Setting(containerEl)
      .setName("Save debounce (ms)")
      .setDesc(
        "How long to wait after an edit before writing the file to disk. " +
          "Disk writes trigger the live preview refresh.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.saveDebounceMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 100 && n <= 10000) {
              this.plugin.settings.saveDebounceMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Compile chapters through their book")
      .setDesc(
        "When a chapter is included by a main.typ above it, compile it through " +
          "that file, so @ completes labels from every chapter and diagnostics " +
          "see the book's imports.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pinBookMain)
          .onChange(async (value) => {
            this.plugin.settings.pinBookMain = value;
            await this.plugin.saveSettings();
            this.plugin.syncPinnedMain();
          }),
      );

    const yoloDesc = () =>
      "Show the YOLO plugin's AI completion (ghost text) in Typst files: Tab " +
      "accepts, Shift-Tab or Escape dismisses, and the completion popup always " +
      "wins. Uses YOLO's own triggers and its tab-completion toggle. May break " +
      "when YOLO updates. Status: " +
      (this.plugin.settings.yoloTabCompletion
        ? this.plugin.yolo.describe()
        : "off") +
      ".";
    const yolo = new Setting(containerEl)
      .setName("YOLO tab completion (experimental)")
      .setDesc(yoloDesc())
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.yoloTabCompletion)
          .onChange(async (value) => {
            this.plugin.settings.yoloTabCompletion = value;
            await this.plugin.saveSettings();
            this.plugin.yolo.refresh();
            yolo.setDesc(yoloDesc());
          }),
      );

    new Setting(containerEl)
      .setName("Invert preview colors")
      .setDesc("Useful for dark themes; 'auto' follows the system scheme.")
      .addDropdown((dd) =>
        dd
          .addOptions({ never: "never", auto: "auto" })
          .setValue(this.plugin.settings.invertPreviewColors)
          .onChange(async (value) => {
            this.plugin.settings.invertPreviewColors =
              value === "auto" ? "auto" : "never";
            await this.plugin.saveSettings();
            this.plugin.preview.stop();
          }),
      );

    new Setting(containerEl).setName("Rendering").setHeading();

    new Setting(containerEl)
      .setName("Render formulas on hover")
      .setDesc(
        "When the pointer rests on math, show the rendered formula above tinymist's " +
          "hover; on the #name of a call with a content body (#theorem[…]), or of " +
          "#figure or #image, show the call on a page 400pt wide (inverted in a dark " +
          "theme when \"Invert preview colors\" is auto). A second tinymist process " +
          "renders it from the unsaved text with the book main's imports and rules (the " +
          "lines before it includes the chapter) and the file's own definitions above it. " +
          "A .tinymist-fragment.typ file in the file's folder or above replaces the book " +
          "main's part, e.g. to set the fonts a template applies inside its #show rule.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hoverRender)
          .onChange(async (value) => {
            this.plugin.settings.hoverRender = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Preview the formula at the cursor")
      .setDesc(
        "While the cursor is in a formula, show its rendering below it and update it as " +
          "you type (inline math in both modes, display math in source mode). Hidden while " +
          "the completion list is open.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.cursorPreview)
          .onChange(async (value) => {
            this.plugin.settings.cursorPreview = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default editing mode")
      .setDesc(
        "The mode newly opened Typst files start in. In live preview, formulas render in " +
          "place (by the same renderer as the hover) and show their source while the cursor " +
          "is on them; a formula that fails keeps its source. Each tab keeps its own mode: " +
          "switch it with the header button or the command \"Toggle live preview\". Files " +
          "over 10,000 lines stay in source mode.",
      )
      .addDropdown((dd) =>
        dd
          .addOptions({ source: "Source", live: "Live preview" })
          .setValue(this.plugin.settings.editingMode)
          .onChange(async (value) => {
            this.plugin.settings.editingMode = value === "live" ? "live" : "source";
            await this.plugin.saveSettings();
          }),
      );
  }
}

export function parseFontPaths(text: string): string[] {
  return text.split(/\r?\n/).filter((path) => path.trim() !== "");
}
