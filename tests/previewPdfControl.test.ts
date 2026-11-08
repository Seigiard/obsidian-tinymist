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
import { mdAdapter, type MarkdownSourceHost, type TypstSource } from "../src/sources";
import { Menu, TFile, TestApp, TFolder, WorkspaceLeaf, testApp } from "./support/obsidian";

const PREVIEW_URL = "http://127.0.0.1:4321";

class PreviewControlPlugin extends TinymistPlugin {
  readonly setCalls: Array<{ path: string; enabled: boolean }> = [];
  rejectNextSet: Error | null = null;
  private exportBarrier: Promise<void> | null = null;
  private releaseExportBarrier: (() => void) | null = null;

  createAutomaticPdfExporter(): AutomaticPdfExporter {
    return {
      exportPdf: async () => {
        const barrier = this.exportBarrier;
        if (barrier) await barrier;
        return new TextEncoder().encode("PDF-test");
      },
      stop: () => {},
    };
  }

  deferExporter(): () => void {
    this.exportBarrier = new Promise((resolve) => {
      this.releaseExportBarrier = resolve;
    });
    return () => {
      const release = this.releaseExportBarrier;
      this.exportBarrier = null;
      this.releaseExportBarrier = null;
      release?.();
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

test("Markdown and Typst previews enable Automatic PDF for exportable sources", async () => {
  // #given
  const app = testApp("/vault");
  const makeSource = (file: string, exportable: boolean): TypstSource => ({
    file,
    entry: `/vault/${file}${exportable ? "" : ".typ"}`,
    document: `/vault/${file}${exportable ? "" : ".typ"}`,
    inputs: undefined,
    pinnable: exportable,
    exportable,
    pdf: file.replace(/\.[^.]+$/u, ".pdf"),
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release: () => {},
  } as TypstSource & { exportable: boolean });
  const markdownHost: MarkdownSourceHost = {
    root: () => "/vault",
    frontmatter: () => ({ typst: true }),
    editorText: () => "---\ntypst: true\n---\n= Note",
    readFile: async () => "---\ntypst: true\n---\n= Note",
    exists: () => false,
    kit: () => ({ ready: true, kit: null }),
    onKitChange: () => () => {},
    reveal: async () => {},
    onEditorChange: () => () => {},
    onRename: () => () => {},
    onDelete: () => () => {},
  };
  const markdown = await mdAdapter(markdownHost).create("Notes/A.md", () => {});
  assert.ok(markdown, "expected a flagged Markdown source");
  const typst = makeSource("Notes/A.typ", true);
  let selected = markdown;
  const setCalls: Array<{ path: string; enabled: boolean }> = [];
  const plugin = {
    preview: {
      onChange: () => () => {},
      currentSource: () => selected,
      sourcePath: () => selected.file,
      stop: async () => {},
    },
    onDiagnostics: () => () => {},
    onAutomaticPdfChange: () => () => {},
    automaticPdfEnabled: () => true,
    setAutomaticPdf: async (path: string, enabled: boolean) => {
      setCalls.push({ path, enabled });
    },
    lsp: null,
    vaultBasePath: () => "/vault",
  } as unknown as TinymistPlugin;
  const markdownView = new PreviewView(new WorkspaceLeaf(app) as never, plugin);
  const markdownState = controlState(markdownView);
  checkbox(markdownView).click();
  await settle();
  selected = typst;
  const typstView = new PreviewView(new WorkspaceLeaf(app) as never, plugin);

  // #when
  const typstState = controlState(typstView);

  // #then
  try {
    assert.deepEqual(
      {
        markdown: {
          disabled: markdownState.disabled,
          checked: markdownState.checked,
          label: markdownState.label,
          setCalls,
        },
        typst: { disabled: typstState.disabled, checked: typstState.checked, label: typstState.label },
      },
      {
        markdown: {
          disabled: false,
          checked: true,
          label: "Automatic PDF export",
          setCalls: [{ path: "Notes/A.md", enabled: false }],
        },
        typst: { disabled: false, checked: true, label: "Automatic PDF export" },
      },
    );
  } finally {
    await markdownView.onClose();
    markdownView.unload();
    await typstView.onClose();
    typstView.unload();
  }
});

test("preview header places automatic PDF export before native More options", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const view = h.preview("chapter.typ");

  // #when
  const input = checkbox(view);
  const label = input.closest("label");
  const actions = view.containerEl.querySelector(".view-header .view-actions");
  const moreOptions = actions?.querySelector('button[aria-label="More options"]') ?? null;

  // #then
  try {
    assert.deepEqual([...(actions?.children ?? [])], [label, moreOptions]);
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
  const sourcePathAfterRename = h.plugin.preview.sourcePath();
  const reboundSource = h.plugin.sources.byDocument(join(h.root, "new/chapter.typ"));
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
        sourcePathAfterRename,
        reboundSource: reboundSource?.file ?? null,
        renameCall,
        closedControlChecked,
        staleControlIsActionable: afterDelete.count > 0 && afterDelete.disabled === false,
        reopenedCount,
        reopenClickCalls: h.plugin.setCalls.length - callsBeforeReopenClick,
      },
      {
        menuCheckedAfterPreview: true,
        afterMenu: false,
        sourcePathAfterRename: "new/chapter.typ",
        reboundSource: "new/chapter.typ",
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

test("source menu enable updates the preview checkbox before export completes", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const editor = new TypstView(new WorkspaceLeaf(h.app) as never, h.plugin);
  await editor.setState({ file: source.path }, { history: false });
  const view = h.preview(source.path);
  const menu = new Menu();
  editor.onPaneMenu(menu as never, "more-options");
  const menuToggle = menu.items.find((item) => item.title === "Automatic PDF export");
  assert.ok(menuToggle, "source menu automatic PDF item is present");
  const releaseExporter = h.plugin.deferExporter();
  let writeSettled = false;
  let menuWrite: Promise<void> | null = null;

  // #when
  try {
    menuWrite = menuToggle.trigger().then(() => {
      writeSettled = true;
    });
    await settle();

    // #then
    assert.deepEqual(
      {
        enabled: h.plugin.automaticPdfEnabled(source.path),
        checked: checkbox(view).checked,
        writeSettled,
      },
      { enabled: true, checked: true, writeSettled: false },
    );
  } finally {
    releaseExporter();
    let writeError: unknown;
    try {
      await menuWrite;
    } catch (error) {
      writeError = error;
    }
    await view.onClose();
    view.unload();
    await editor.onClose();
    h.close();
    if (writeError) throw writeError;
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
