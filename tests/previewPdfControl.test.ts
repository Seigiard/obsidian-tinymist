import "./support/dom";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AutomaticPdfExporter } from "../src/automatic-pdf";
import { TypstView } from "../src/editor/typstView";
import TinymistPlugin from "../src/main";
import { PreviewView } from "../src/preview/previewView";
import { Menu, TFile, TestApp, TFolder, WorkspaceLeaf, testApp } from "./support/obsidian";

const PREVIEW_URL = "http://127.0.0.1:4321";

class PreviewControlPlugin extends TinymistPlugin {
  readonly setCalls: Array<{ path: string; enabled: boolean }> = [];
  rejectNextSet: Error | null = null;

  createAutomaticPdfExporter(): AutomaticPdfExporter {
    return {
      exportPdf: async () => new TextEncoder().encode("PDF-test"),
      stop: () => {},
    };
  }

  async startLsp(_restart: boolean): Promise<void> {}

  async setAutomaticPdf(path: string, enabled: boolean): Promise<void> {
    this.setCalls.push({ path, enabled });
    if (this.rejectNextSet) {
      const error = this.rejectNextSet;
      this.rejectNextSet = null;
      throw error;
    }
    await super.setAutomaticPdf(path, enabled);
  }
}

interface Harness {
  root: string;
  app: TestApp;
  plugin: PreviewControlPlugin;
  addSource(path: string): TFile;
  preview(path: string): PreviewView;
  close(): void;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "typst-preview-pdf-control-"));
  const app = testApp(root);
  const plugin = new PreviewControlPlugin(app as never, {} as never);
  await plugin.onload();
  return {
    root,
    app,
    plugin,
    addSource(path: string): TFile {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "= Test\n");
      app.vault.files.set(path, "= Test\n");
      return new TFile(path);
    },
    preview(path: string): PreviewView {
      plugin.preview.filePath = join(root, path);
      const view = new PreviewView(new WorkspaceLeaf(app) as never, plugin);
      view.setUrl(PREVIEW_URL);
      return view;
    },
    close(): void {
      plugin.onunload();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function controlState(view: { containerEl: HTMLElement; contentEl: HTMLElement }): {
  count: number;
  type: string | null;
  label: string | null;
  associated: boolean;
  inContent: boolean | null;
  checked: boolean | null;
  disabled: boolean | null;
} {
  const header = view.containerEl.querySelector<HTMLElement>(".view-header");
  const controls = [...(header?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
  const input = controls[0] ?? null;
  const labels = [...(header?.querySelectorAll("label") ?? [])];
  const label = input ? labels.find((candidate) => candidate.control === input) ?? null : null;
  return {
    count: controls.length,
    type: input?.type ?? null,
    label: label?.textContent?.trim() ?? null,
    associated: label?.control === input,
    inContent: input ? view.contentEl.contains(input) : null,
    checked: input?.checked ?? null,
    disabled: input?.disabled ?? null,
  };
}

function checkbox(view: { containerEl: HTMLElement }): HTMLInputElement {
  const input = view.containerEl.querySelector<HTMLInputElement>('.view-header input[type="checkbox"]');
  assert.ok(input, "preview header checkbox is present");
  return input;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("control: checkbox observer distinguishes associated, unassociated, and missing controls", () => {
  // #given
  const containerEl = document.createElement("div");
  const headerEl = containerEl.createEl("div", { cls: "view-header" });
  const contentEl = containerEl.createEl("div", { cls: "view-content" });
  contentEl.createEl("input", { attr: { type: "checkbox" } });
  const input = headerEl.createEl("input", { attr: { id: "pdf-control", type: "checkbox" } });
  input.checked = true;
  headerEl.createEl("label", { text: "Automatic PDF export", attr: { for: input.id } });
  const valid = { containerEl, contentEl };
  const unassociatedContainer = document.createElement("div");
  const unassociatedHeader = unassociatedContainer.createEl("div", { cls: "view-header" });
  const unassociatedContent = unassociatedContainer.createEl("div", { cls: "view-content" });
  unassociatedHeader.createEl("input", { attr: { type: "checkbox" } });
  unassociatedHeader.createEl("label", { text: "Automatic PDF export" });
  const missingContainer = document.createElement("div");
  const missing = {
    containerEl: missingContainer,
    contentEl: missingContainer.createEl("div", { cls: "view-content" }),
  };

  // #when
  const observed = {
    states: [controlState(valid), controlState({
      containerEl: unassociatedContainer,
      contentEl: unassociatedContent,
    }), controlState(missing)],
    requiredControl: checkbox(valid) === input,
  };

  // #then
  assert.deepEqual(observed, {
    states: [
      {
        count: 1,
        type: "checkbox",
        label: "Automatic PDF export",
        associated: true,
        inContent: false,
        checked: true,
        disabled: false,
      },
      {
        count: 1,
        type: "checkbox",
        label: null,
        associated: false,
        inContent: false,
        checked: false,
        disabled: false,
      },
      {
        count: 0,
        type: null,
        label: null,
        associated: false,
        inContent: null,
        checked: null,
        disabled: null,
      },
    ],
    requiredControl: true,
  });
});

test("preview header exposes one labeled keyboard checkbox for the selected source", async () => {
  // #given
  const h = await harness();
  h.addSource("chapters/a.typ");
  const view = h.preview("chapters/a.typ");

  // #when
  const before = controlState(view);
  checkbox(view).click();
  await settle();

  // #then
  try {
    assert.deepEqual({ before, enabledAfterClick: h.plugin.automaticPdfEnabled("chapters/a.typ") }, {
      before: {
        count: 1,
        type: "checkbox",
        label: "Automatic PDF export",
        associated: true,
        inContent: false,
        checked: false,
        disabled: false,
      },
      enabledAfterClick: true,
    });
  } finally {
    await view.onClose();
    view.unload();
    h.close();
  }
});

test("preview selection, not the active editor or wrapper, determines the checked source", async () => {
  // #given
  const h = await harness();
  h.addSource("book/a.typ");
  const active = h.addSource("book/b.typ");
  h.addSource("book/.tinymist-preview.typ");
  await h.plugin.setAutomaticPdf(active.path, true);
  const editor = new TypstView(new WorkspaceLeaf(h.app) as never, h.plugin);
  await editor.setState({ file: active.path }, { history: false });
  const view = h.preview("book/a.typ");

  // #when
  const selectedA = controlState(view).checked;
  checkbox(view).click();
  await settle();
  const actionTarget = h.plugin.setCalls.at(-1);
  const wrapperEnabled = h.plugin.automaticPdfEnabled("book/.tinymist-preview.typ");
  h.plugin.preview.filePath = join(h.root, "book/b.typ");
  view.setUrl(`${PREVIEW_URL}/b`);
  const selectedB = controlState(view).checked;

  // #then
  try {
    assert.deepEqual(
      { selectedA, actionTarget, wrapperEnabled, selectedB, activeEditor: editor.file?.path },
      {
        selectedA: false,
        actionTarget: { path: "book/a.typ", enabled: true },
        wrapperEnabled: false,
        selectedB: true,
        activeEditor: "book/b.typ",
      },
    );
  } finally {
    await view.onClose();
    view.unload();
    await editor.onClose();
    h.close();
  }
});

test("source menu and preview stay synchronized across folder rename, delete, close, and reopen", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/chapter.typ");
  const editor = new TypstView(new WorkspaceLeaf(h.app) as never, h.plugin);
  await editor.setState({ file: source.path }, { history: false });
  const view = h.preview(source.path);

  // #when
  checkbox(view).click();
  await settle();
  const menuAfterPreview = new Menu();
  editor.onPaneMenu(menuAfterPreview as never, "more-options");
  const menuToggle = menuAfterPreview.items.find((item) => item.title === "Automatic PDF export");
  await menuToggle?.trigger();
  await settle();
  const afterMenu = checkbox(view).checked;

  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("new/chapter.typ", "= Test\n");
  source.path = "new/chapter.typ";
  await h.app.vault.emit("rename", new TFolder("new"), "old");
  checkbox(view).click();
  await settle();
  const renameCall = h.plugin.setCalls.at(-1);

  const closedControl = checkbox(view);
  await view.onClose();
  view.unload();

  const reopened = h.preview("new/chapter.typ");
  const reopenedCount = controlState(reopened).count;
  const callsBeforeReopenClick = h.plugin.setCalls.length;
  checkbox(reopened).click();
  await settle();
  const closedControlChecked = closedControl.checked;

  h.app.vault.files.delete("new/chapter.typ");
  await h.app.vault.emit("delete", source);
  const afterDelete = controlState(reopened);

  // #then
  try {
    assert.deepEqual(
      {
        menuCheckedAfterPreview: menuToggle?.checked,
        afterMenu,
        renameCall,
        closedControlChecked,
        staleControlIsActionable: afterDelete.count > 0 && afterDelete.disabled === false,
        reopenedCount,
        reopenClickCalls: h.plugin.setCalls.length - callsBeforeReopenClick,
      },
      {
        menuCheckedAfterPreview: true,
        afterMenu: false,
        renameCall: { path: "new/chapter.typ", enabled: true },
        closedControlChecked: true,
        staleControlIsActionable: false,
        reopenedCount: 1,
        reopenClickCalls: 1,
      },
    );
  } finally {
    await reopened.onClose();
    reopened.unload();
    await editor.onClose();
    h.close();
  }
});

test("a stopped preview and a preview without a source expose no actionable control", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const withoutSource = new PreviewView(new WorkspaceLeaf(h.app) as never, h.plugin);
  withoutSource.setUrl(PREVIEW_URL);

  // #when
  const noSource = controlState(withoutSource);
  await withoutSource.onClose();
  withoutSource.unload();
  const active = h.preview("chapter.typ");
  const activeBeforeStop = controlState(active);
  await h.plugin.preview.stop();
  active.setUrl(PREVIEW_URL);
  const stopped = controlState(active);

  // #then
  try {
    assert.deepEqual(
      {
        activeBeforeStopActionable: activeBeforeStop.count === 1 && activeBeforeStop.disabled === false,
        noSourceActionable: noSource.count > 0 && noSource.disabled === false,
        stoppedActionable: stopped.count > 0 && stopped.disabled === false,
      },
      { activeBeforeStopActionable: true, noSourceActionable: false, stoppedActionable: false },
    );
  } finally {
    await active.onClose();
    active.unload();
    h.close();
  }
});

test("a rejected preview write restores the persisted state and handles the rejection", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const view = h.preview("chapter.typ");
  h.plugin.rejectNextSet = new Error("settings unavailable");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  // #when
  checkbox(view).click();
  await settle();
  await settle();

  // #then
  try {
    assert.deepEqual(
      { checked: checkbox(view).checked, persisted: h.plugin.automaticPdfEnabled("chapter.typ"), unhandled },
      { checked: false, persisted: false, unhandled: [] },
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await view.onClose();
    view.unload();
    h.close();
  }
});
