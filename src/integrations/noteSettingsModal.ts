import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
  applyNoteSetting,
  noteSettingsForm,
  type NoteSettingsForm,
  type NoteSettingsKit,
} from "./noteSettings";
import type { TemplateParam } from "../kit/manifest";

type EditableField = {
  name: string;
  type: "str" | "int" | "float";
  input: HTMLInputElement;
  lastWritten: string;
  pending: string | null;
};

/** Modal editor for the manifest-backed properties of one Typst note. */
export class NoteSettingsModal extends Modal {
  private frontmatter: Record<string, unknown>;
  private writeQueue: Promise<void> = Promise.resolve();
  private editableFields = new Map<string, EditableField>();
  private closed = false;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly kit: NoteSettingsKit,
    frontmatter: Record<string, unknown>,
  ) {
    super(app);
    this.frontmatter = { ...frontmatter };
  }

  onOpen(): void {
    this.closed = false;
    this.titleEl.textContent = "Edit Typst note settings";
    this.render();
  }

  onClose(): void {
    this.closed = true;
    this.writePendingFields();
    this.editableFields.clear();
    this.clearContent();
  }

  private render(): void {
    this.clearContent();
    this.editableFields.clear();
    const form = noteSettingsForm(this.kit, this.frontmatter);
    if (form.kind === "unavailable") {
      this.contentEl.createEl("p", { text: form.reason });
      return;
    }

    this.renderTemplate(form);
    for (const parameter of form.params) this.renderParameter(parameter.name, parameter.param, parameter.value);
  }

  private renderTemplate(form: Extract<NoteSettingsForm, { kind: "form" }>): void {
    const setting = new Setting(this.contentEl).setName("Template").setDesc("Manifest template");
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "Default");
      const explicit = this.frontmatter["typst-template"];
      const current = typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : "";
      if (current !== "" && !form.template.options.includes(current)) {
        dropdown.addOption(current, current);
      }
      for (const option of form.template.options) dropdown.addOption(option, option);
      dropdown.setValue(current);
      dropdown.onChange((value) => this.writeSetting("template", value === "" ? undefined : value));
    });
    if (form.unknownTemplate) {
      this.contentEl.createEl("p", { text: `Template ${form.template.current} is not in the kit manifest.` });
    }
  }

  private renderParameter(name: string, param: TemplateParam, value: unknown | undefined): void {
    const setting = new Setting(this.contentEl).setName(`typst-${name}`);
    if (param.type === "array") {
      setting.setDesc(`Type: array. Current: ${displayValue(value)}. Edit in Properties.`);
      return;
    }
    setting.setDesc(`Type: ${param.type}`);
    switch (param.type) {
      case "enum":
        this.addEnum(setting, name, param, value);
        return;
      case "bool":
        this.addBool(setting, name, value);
        return;
      case "int":
      case "float":
        this.addNumber(setting, name, param.type, value);
        return;
      case "str":
        this.addString(setting, name, value);
        return;
    }
  }

  private addEnum(
    setting: Setting,
    name: string,
    param: Extract<TemplateParam, { type: "enum" }>,
    value: unknown | undefined,
  ): void {
    setting.addDropdown((dropdown) => {
      const current = value === undefined || value === null ? "" : String(value);
      dropdown.addOption("", "Default");
      if (current !== "" && !param.values.includes(current)) dropdown.addOption(current, current);
      for (const option of param.values) dropdown.addOption(option, option);
      dropdown.setValue(current);
      dropdown.onChange((next) => this.writeSetting(name, next === "" ? undefined : next));
    });
  }

  private addBool(setting: Setting, name: string, value: unknown | undefined): void {
    setting.addDropdown((dropdown) => {
      dropdown.addOptions({ "": "Default", true: "true", false: "false" });
      const isDefault = value === undefined || value === null;
      const isBoolean = typeof value === "boolean";
      let invalidOption = "";
      if (!isDefault && !isBoolean) {
        const invalidValue = displayValue(value);
        invalidOption = invalidValue === "" || invalidValue === "true" || invalidValue === "false"
          ? `__current__${invalidValue}`
          : invalidValue;
        dropdown.addOption(invalidOption, invalidValue);
      }
      dropdown.setValue(isDefault ? "" : isBoolean ? (value ? "true" : "false") : invalidOption);
      dropdown.onChange((next) => {
        if (next === "") this.writeSetting(name, undefined);
        else if (next === "true") this.writeSetting(name, true);
        else if (next === "false") this.writeSetting(name, false);
        else if (next === invalidOption) this.writeSetting(name, value);
      });
    });
  }

  private addNumber(
    setting: Setting,
    name: string,
    type: "int" | "float",
    value: unknown | undefined,
  ): void {
    setting.addText((text) => {
      text.setPlaceholder("Default").setValue(value === undefined || value === null ? "" : String(value));
      this.registerEditableField(name, type, text.inputEl);
    });
  }

  private addString(setting: Setting, name: string, value: unknown | undefined): void {
    setting.addText((text) => {
      text.setPlaceholder("Default").setValue(value === undefined || value === null ? "" : String(value));
      this.registerEditableField(name, "str", text.inputEl);
    });
  }

  private registerEditableField(name: string, type: EditableField["type"], input: HTMLInputElement): void {
    const field: EditableField = {
      name,
      type,
      input,
      lastWritten: input.value,
      pending: null,
    };
    this.editableFields.set(name, field);
    input.addEventListener("change", () => this.commitEditableField(field));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      this.commitEditableField(field);
    }, true);
  }

  private commitEditableField(field: EditableField): void {
    const raw = field.input.value;
    if (raw === field.pending || (field.pending === null && raw === field.lastWritten)) return;

    let value: unknown | undefined;
    if (field.type === "str") {
      value = raw === "" ? undefined : raw;
    } else {
      const trimmed = raw.trim();
      if (trimmed === "") {
        value = undefined;
      } else {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || (field.type === "int" && !Number.isInteger(parsed))) return;
        value = parsed;
      }
    }

    field.pending = raw;
    this.writeSetting(field.name, value, (succeeded) => {
      if (field.pending !== raw) return;
      field.pending = null;
      if (succeeded) field.lastWritten = raw;
    });
  }

  private writePendingFields(): void {
    for (const field of this.editableFields.values()) this.commitEditableField(field);
  }

  private writeSetting(name: string, value: unknown | undefined, onComplete?: (succeeded: boolean) => void): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.app.fileManager.processFrontMatter(this.file, (frontmatter: Record<string, unknown>) => {
          applyNoteSetting(frontmatter, name, value);
          this.frontmatter = { ...frontmatter };
        });
        onComplete?.(true);
        if (!this.closed && name === "template") this.render();
      } catch (error) {
        onComplete?.(false);
        new Notice(`Could not update Typst note settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private clearContent(): void {
    while (this.contentEl.firstChild) this.contentEl.removeChild(this.contentEl.firstChild);
  }
}

function displayValue(value: unknown | undefined): string {
  if (value === undefined || value === null) return "Default";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
