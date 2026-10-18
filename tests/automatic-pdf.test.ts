import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryCache } from "../src/editor/shared/editorKit";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { TypstView } from "../src/editor/typstView";
import type TinymistPlugin from "../src/main";
import { Menu, TFile, WorkspaceLeaf, testApp } from "./support/obsidian";

interface PaneMenuView {
  onPaneMenu?: (menu: Menu, source: string) => void;
}

interface TestTypstView extends TypstView {
  loadFile(file: TFile): Promise<void>;
}

function typstView(enabled = false): { view: TypstView; previewCalls: string[]; pdfCalls: string[] } {
  const app = testApp();
  const previewCalls: string[] = [];
  const pdfCalls: string[] = [];
  const plugin = {
    app,
    lsp: null,
    settings: { saveDebounceMs: 100000, editingMode: "source" },
    history: new HistoryCache(),
    yolo: new YoloBridge(app as never, { name: "test", enabled: () => false }),
    onDiagnostics: () => () => {},
    openPreview: async () => previewCalls.push("open"),
    togglePreview: async () => previewCalls.push("toggle"),
    syncPinnedMain: () => {},
    vaultBasePath: () => "/vault",
    preview: { cursorMoved: () => {} },
    typstRender: null,
    setAutomaticPdf: async (path: string, enabled: boolean) => pdfCalls.push(`set:${path}:${enabled}`),
    rebuildPdf: async (path: string) => pdfCalls.push(`rebuild:${path}`),
    automaticPdfEnabled: () => enabled,
    automaticPdfStatus: () => "missing",
  };
  return {
    view: new TypstView(new WorkspaceLeaf(app) as never, plugin as unknown as TinymistPlugin),
    previewCalls,
    pdfCalls,
  };
}

test("the real pane menu drives Automatic PDF export and Rebuild PDF without changing preview actions", async () => {
  // #given
  const { view: rawView, previewCalls, pdfCalls } = typstView();
  const view = rawView as TestTypstView;
  const menu = new Menu();
  try {
    await view.loadFile(new TFile("notes/chapter.typ") as never);

    // #when
    (view as unknown as PaneMenuView).onPaneMenu?.(menu, "more-options");
    const automatic = menu.items.find((item) => item.title === "Automatic PDF export");
    const rebuild = menu.items.find((item) => item.title === "Rebuild PDF");
    await automatic?.trigger();
    await rebuild?.trigger();

    // #then
    assert.deepEqual(
      {
        automatic: automatic && { checked: automatic.checked, disabled: automatic.disabled },
        rebuild: rebuild && { disabled: rebuild.disabled },
        status: menu.items.find((item) => item.title === "PDF: Missing")?.disabled,
        pdfCalls,
        previewCalls,
      },
      {
        automatic: { checked: false, disabled: false },
        rebuild: { disabled: false },
        status: true,
        pdfCalls: ["set:notes/chapter.typ:true", "rebuild:notes/chapter.typ"],
        previewCalls: [],
      },
    );
  } finally {
    await view.onClose();
  }
});

test("the pane menu shows the enabled checkmark and disables automatic PDF export when clicked", async () => {
  // #given
  const { view: rawView, previewCalls, pdfCalls } = typstView(true);
  const view = rawView as TestTypstView;
  const menu = new Menu();
  try {
    await view.loadFile(new TFile("notes/chapter.typ") as never);

    // #when
    (view as unknown as PaneMenuView).onPaneMenu?.(menu, "more-options");
    const automatic = menu.items.find((item) => item.title === "Automatic PDF export");
    await automatic?.trigger();

    // #then
    assert.deepEqual(
      {
        automatic: automatic && { checked: automatic.checked, disabled: automatic.disabled },
        pdfCalls,
        previewCalls,
      },
      {
        automatic: { checked: true, disabled: false },
        pdfCalls: ["set:notes/chapter.typ:false"],
        previewCalls: [],
      },
    );
  } finally {
    await view.onClose();
  }
});

test("the Typst pane menu preserves the superclass file-view contribution exactly once", async () => {
  // #given
  const { view: rawView } = typstView();
  const view = rawView as TestTypstView;
  const menu = new Menu();
  try {
    await view.loadFile(new TFile("notes/chapter.typ") as never);

    // #when
    (view as unknown as PaneMenuView).onPaneMenu?.(menu, "more-options");

    // #then
    assert.equal(menu.items.filter((item) => item.title === "Base file action").length, 1);
  } finally {
    await view.onClose();
  }
});
