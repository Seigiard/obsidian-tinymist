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
  exists: boolean;
  pending: string | null;
};

/** Modal editor for the manifest-backed properties of one Typst note. */
export class NoteSettingsModal extends Modal {
  private writeQueue: Promise<void> = Promise.resolve();
  private editableFields = new Map<string, EditableField>();
  private templateProblemEl: HTMLElement | undefined;
  private closed = false;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly kit: NoteSettingsKit,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.titleEl.textContent = "Edit Typst note settings";
    try {
      const text = await this.app.vault.read(this.file);
      if (!this.closed) this.render(text);
    } catch (error) {
      if (!this.closed) new Notice(`Could not read Typst note settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onClose(): void {
    this.closed = true;
    this.writePendingFields();
    this.editableFields.clear();
    this.clearContent();
  }

  private render(text: string): void {
    this.clearContent();
    this.editableFields.clear();
    this.templateProblemEl = undefined;
    const form = noteSettingsForm(this.kit, text);
    if (form.kind === "unavailable") {
      this.contentEl.createEl("p", { text: form.reason });
      return;
    }

    this.renderTemplate(form);
    for (const parameter of form.params) this.renderParameter(parameter);
  }

  private renderTemplate(form: Extract<NoteSettingsForm, { kind: "form" }>): void {
    const setting = new Setting(this.contentEl).setName("Template").setDesc("Manifest template");
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "Default");
      const current = form.template.current;
      let currentOption = form.template.explicit ? current : "";
      const empty = form.template.problem === "Property template has no value";
      if (empty) {
        currentOption = this.currentOptionValue("");
        dropdown.addOption(currentOption, "(empty)");
      } else if (form.template.explicit && current !== "" && !form.template.options.includes(current)) {
        dropdown.addOption(current, current);
      }
      for (const option of form.template.options) dropdown.addOption(option, option);
      dropdown.setValue(currentOption);
      let selectedOption = currentOption;
      dropdown.onChange((value) => {
        if (value === selectedOption) return;
        selectedOption = value;
        if (value === "") this.writeSetting("template", undefined);
        else if (value === currentOption) this.writeSetting("template", empty ? null : current);
        else this.writeSetting("template", value);
      });
    });
    if (form.template.problem) this.templateProblemEl = this.contentEl.createEl("p", { text: form.template.problem });
  }

  private renderParameter(parameter: Extract<NoteSettingsForm, { kind: "form" }>["params"][number]): void {
    const { name, param, value, quoted, problem } = parameter;
    const setting = new Setting(this.contentEl).setName(`typst-${name}`);
    if (parameter.multiline === true) {
      setting.setDesc(problemText(`Type: ${param.type}. Multi-line value. Edit in Properties.`, problem));
      return;
    }
    if (param.type === "array") {
      setting.setDesc(problemText(`Type: array. Current: ${displayValue(value)}. Edit in Properties.`, problem));
      return;
    }
    const quotedNote = quoted && (param.type === "bool" || param.type === "int" || param.type === "float")
      ? "Quoted: the template receives a string"
      : undefined;
    setting.setDesc(problemText(
      [`Type: ${param.type}`, quotedNote].filter((part): part is string => part !== undefined).join(". "),
      problem,
    ));
    switch (param.type) {
      case "enum":
        this.addEnum(setting, name, param, value, quoted === true);
        return;
      case "bool":
        this.addBool(setting, name, value, quoted === true);
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
    quoted: boolean,
  ): void {
    setting.addDropdown((dropdown) => {
      const current = value === undefined ? "" : String(value);
      const empty = value === "" && !quoted;
      let currentOption = current;
      dropdown.addOption("", "Default");
      if (value !== undefined && (empty || !param.values.includes(current))) {
        currentOption = this.currentOptionValue(current);
        dropdown.addOption(currentOption, empty ? "(empty)" : current);
      }
      for (const option of param.values) dropdown.addOption(option, option);
      dropdown.setValue(currentOption);
      let selectedOption = currentOption;
      dropdown.onChange((next) => {
        if (next === selectedOption) return;
        selectedOption = next;
        if (next === "") this.writeSetting(name, undefined);
        else if (next === currentOption) this.writeSetting(name, empty ? null : current);
        else this.writeSetting(name, next);
      });
    });
  }

  private addBool(setting: Setting, name: string, value: unknown | undefined, quoted: boolean): void {
    setting.addDropdown((dropdown) => {
      dropdown.addOptions({ "": "Default", true: "true", false: "false" });
      const current = value === undefined ? "" : String(value);
      const isDefault = value === undefined;
      const empty = value === "" && !quoted;
      const isBoolean = !quoted && (current === "true" || current === "false");
      let currentOption = current;
      if (!isDefault && !isBoolean) {
        currentOption = this.currentOptionValue(current);
        dropdown.addOption(currentOption, empty ? "(empty)" : current);
      }
      dropdown.setValue(currentOption);
      let selectedOption = currentOption;
      dropdown.onChange((next) => {
        if (next === selectedOption) return;
        selectedOption = next;
        if (next === "") this.writeSetting(name, undefined);
        else if (next === "true") this.writeSetting(name, true);
        else if (next === "false") this.writeSetting(name, false);
        else if (next === currentOption) this.writeSetting(name, empty ? null : current);
      });
    });
  }

  private currentOptionValue(value: string): string {
    return value === "" || value === "true" || value === "false" ? `__current__${value}` : value;
  }

  private addNumber(
    setting: Setting,
    name: string,
    type: "int" | "float",
    value: unknown | undefined,
  ): void {
    setting.addText((text) => {
      text.setPlaceholder("Default").setValue(value === undefined || value === null ? "" : String(value));
      this.registerEditableField(name, type, text.inputEl, value !== undefined);
    });
  }

  private addString(setting: Setting, name: string, value: unknown | undefined): void {
    setting.addText((text) => {
      text.setPlaceholder("Default").setValue(value === undefined || value === null ? "" : String(value));
      this.registerEditableField(name, "str", text.inputEl, value !== undefined);
    });
  }

  private registerEditableField(name: string, type: EditableField["type"], input: HTMLInputElement, exists: boolean): void {
    const field: EditableField = {
      name,
      type,
      input,
      lastWritten: input.value,
      exists,
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

  private commitEditableField(field: EditableField, explicit = true): void {
    const raw = field.input.value;
    const unchanged = raw === field.lastWritten && (!explicit || !(field.exists && raw === ""));
    if (raw === field.pending || (field.pending === null && unchanged)) return;

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
      if (succeeded) {
        field.lastWritten = raw;
        field.exists = value !== undefined;
      }
    });
  }

  private writePendingFields(): void {
    for (const field of this.editableFields.values()) this.commitEditableField(field, false);
  }

  private writeSetting(name: string, value: unknown | undefined, onComplete?: (succeeded: boolean) => void): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.app.fileManager.processFrontMatter(this.file, (frontmatter: Record<string, unknown>) => {
          applyNoteSetting(frontmatter, name, value);
        });
        onComplete?.(true);
        if (!this.closed) {
          const text = await this.app.vault.read(this.file);
          if (this.closed) return;
          if (name === "template") this.render(text);
          else this.refreshProblems(text);
        }
      } catch (error) {
        onComplete?.(false);
        new Notice(`Could not update Typst note settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private clearContent(): void {
    while (this.contentEl.firstChild) this.contentEl.removeChild(this.contentEl.firstChild);
  }

  private refreshProblems(text: string): void {
    const form = noteSettingsForm(this.kit, text);
    if (form.kind === "unavailable") return;

    if (form.template.problem === undefined) {
      this.templateProblemEl?.remove();
      this.templateProblemEl = undefined;
    } else if (this.templateProblemEl !== undefined) {
      this.templateProblemEl.textContent = form.template.problem;
    } else {
      const templateRow = this.findSetting("Template");
      const problem = this.contentEl.createEl("p", { text: form.template.problem });
      if (templateRow?.parentElement !== null && templateRow?.parentElement !== undefined) {
        templateRow.parentElement.insertBefore(problem, templateRow.nextSibling);
      }
      this.templateProblemEl = problem;
    }

    for (const parameter of form.params) {
      const row = this.findSetting(`typst-${parameter.name}`);
      const description = row?.querySelector<HTMLElement>(".setting-item-description");
      if (description !== null && description !== undefined) description.textContent = this.parameterDescription(parameter);
    }
  }

  private findSetting(name: string): HTMLElement | undefined {
    return Array.from(this.contentEl.querySelectorAll<HTMLElement>(".setting-item"))
      .find((row) => row.querySelector(".setting-item-name")?.textContent === name);
  }

  private parameterDescription(parameter: Extract<NoteSettingsForm, { kind: "form" }>["params"][number]): string {
    const { param, value, quoted, problem } = parameter;
    if (parameter.multiline === true) {
      return problemText(`Type: ${param.type}. Multi-line value. Edit in Properties.`, problem);
    }
    if (param.type === "array") {
      return problemText(`Type: array. Current: ${displayValue(value)}. Edit in Properties.`, problem);
    }
    const quotedNote = quoted && (param.type === "bool" || param.type === "int" || param.type === "float")
      ? "Quoted: the template receives a string"
      : undefined;
    return problemText(
      [`Type: ${param.type}`, quotedNote].filter((part): part is string => part !== undefined).join(". "),
      problem,
    );
  }
}

function problemText(description: string, problem: string | undefined): string {
  return problem === undefined ? description : `${description}${description.endsWith(".") ? "" : "."} ${problem}`;
}

function displayValue(value: unknown | undefined): string {
  if (value === undefined || value === null) return "Default";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
