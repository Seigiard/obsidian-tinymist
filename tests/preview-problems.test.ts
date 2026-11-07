import { iframeSrcAssignmentCount } from "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LspDiagnostic } from "../src/lsp/client";
import { PreviewManager } from "../src/preview/previewManager";
import { PreviewView } from "../src/preview/previewView";
import type { Position, TypstSource } from "../src/sources";
import { WorkspaceLeaf, testApp } from "./support/obsidian";
import { fileUri, vaultPath, virtualAddress } from "./support/virtualAddress";

const VAULT_ROOT = vaultPath("/vault", ".");
const A_FILE = "Notes/A.md";
const B_FILE = "Notes/B.md";
const A_PATH = vaultPath(VAULT_ROOT, A_FILE);
const KIT_PATH = vaultPath(VAULT_ROOT, "_typst/kit.typ");
const A_ENTRY = virtualAddress(VAULT_ROOT, A_FILE);
const B_ENTRY = virtualAddress(VAULT_ROOT, B_FILE);

interface Problem {
  line: number;
  message: string;
  fatal: boolean;
}

interface ProblemSource extends TypstSource {
  problems: Problem[];
}

interface ProblemHarness {
  manager: PreviewManager;
  source: ProblemSource;
  view: PreviewView;
  reveals: Position[];
  opened: Array<{ path: string; line: number; character: number }>;
  move(file: string, entry: string): void;
  emitProblems(): void;
  setDiagnostics(path: string, diagnostics: LspDiagnostic[]): void;
  emitDiagnostics(path: string): void;
  close(): Promise<void>;
}

async function problemHarness(
  problems: Problem[],
  initialDiagnostics: Array<{ path: string; diagnostics: LspDiagnostic[] }> = [],
): Promise<ProblemHarness> {
  const app = testApp(VAULT_ROOT);
  const reveals: Position[] = [];
  const opened: Array<{ path: string; line: number; character: number }> = [];
  const sourceListeners = new Map<string, Set<() => void>>();
  const diagnostics = new Map<string, LspDiagnostic[]>();
  const diagnosticListeners = new Set<(uri: string) => void>();
  let sourceFile = A_FILE;
  let sourceEntry = A_ENTRY;
  let previewPort = 4320;
  for (const initial of initialDiagnostics) {
    diagnostics.set(fileUri(initial.path), initial.diagnostics);
  }
  const source: ProblemSource = {
    get file(): string { return sourceFile; },
    get entry(): string { return sourceEntry; },
    get document(): string { return sourceEntry; },
    inputs: undefined,
    pinnable: false,
    exportable: false,
    pdf: "Notes/A.pdf",
    problems,
    open: () => ({ close: () => {} }),
    toSource: (position) => ({ line: position.line, character: position.character + 2 }),
    toEntry: (position) => ({ line: position.line, character: position.character - 2 }),
    reveal: async (position) => {
      reveals.push(position);
    },
    describe: String,
    on: (event, listener) => {
      let listeners = sourceListeners.get(event);
      if (!listeners) sourceListeners.set(event, (listeners = new Set()));
      listeners.add(listener);
      return () => listeners?.delete(listener);
    },
    release: () => {},
  } as ProblemSource & { exportable: boolean };
  const lsp = {
    status: "running",
    mainFile: null,
    onNotification: () => {},
    setPreviewSource: () => {},
    pinMain: () => {},
    executeCommand: async (command: string) =>
      command === "tinymist.doStartPreview" ? { staticServerPort: ++previewPort } : {},
    diagnostics: (uri: string) => diagnostics.get(uri) ?? [],
    diagnosticUris: () => [...diagnostics.keys()],
  };
  const plugin = {
    app,
    lsp,
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => VAULT_ROOT,
    sources: {
      hold: async () => source,
      byDocument: (document: string) => document === source.document ? source : null,
      mayBeSource: () => true,
    },
    jumpToSource: () => {},
    onDiagnostics: (listener: (uri: string) => void) => {
      diagnosticListeners.add(listener);
      return () => diagnosticListeners.delete(listener);
    },
    onAutomaticPdfChange: () => () => {},
    automaticPdfEnabled: () => false,
    setAutomaticPdf: async () => {},
    openAndPlaceCursor: async (path: string, line: number, character: number) => {
      opened.push({ path, line, character });
    },
  };
  const manager = new PreviewManager(plugin as never);
  Object.assign(plugin, { preview: manager });
  await manager.start(A_PATH);
  const view = new PreviewView(new WorkspaceLeaf(app) as never, plugin as never);
  view.setUrl(manager.url!);
  return {
    manager,
    source,
    view,
    reveals,
    opened,
    move: (file, entry) => {
      sourceFile = file;
      sourceEntry = entry;
      for (const listener of sourceListeners.get("moved") ?? []) listener();
    },
    emitProblems: () => {
      for (const listener of sourceListeners.get("problems") ?? []) listener();
    },
    setDiagnostics: (path, next) => diagnostics.set(fileUri(path), next),
    emitDiagnostics: (path) => {
      for (const listener of diagnosticListeners) listener(fileUri(path));
    },
    close: async () => {
      await view.onClose();
      manager.dispose();
    },
  };
}

test("the bound preview pane follows the replacement task URL after its Markdown source moves", async () => {
  // #given
  const h = await problemHarness([]);
  const iframe = h.view.contentEl.querySelector<HTMLIFrameElement>("iframe")!;
  const assignmentsBeforeMove = iframeSrcAssignmentCount(iframe);

  // #when
  h.move(B_FILE, B_ENTRY);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  try {
    assert.deepEqual(
      {
        assignments: iframeSrcAssignmentCount(iframe) - assignmentsBeforeMove,
        src: iframe.getAttribute("src"),
      },
      { assignments: 1, src: h.manager.url },
    );
  } finally {
    await h.close();
  }
});

test("the bound preview pane follows the replacement task URL after an LSP restart", async () => {
  // #given
  const h = await problemHarness([]);
  const iframe = h.view.contentEl.querySelector<HTMLIFrameElement>("iframe")!;
  const assignmentsBeforeRestart = iframeSrcAssignmentCount(iframe);

  // #when
  const previewPath = h.manager.onLspRestart()!;
  await h.manager.start(previewPath);

  // #then
  try {
    assert.deepEqual(
      {
        assignments: iframeSrcAssignmentCount(iframe) - assignmentsBeforeRestart,
        src: iframe.getAttribute("src"),
      },
      { assignments: 1, src: h.manager.url },
    );
  } finally {
    await h.close();
  }
});

test("the bound preview pane assigns src only when a change notification has a new URL", async () => {
  // #given
  const h = await problemHarness([]);
  const iframe = h.view.contentEl.querySelector<HTMLIFrameElement>("iframe")!;
  const assignmentsBeforeProblems = iframeSrcAssignmentCount(iframe);

  // #when
  h.emitProblems();
  const assignmentsAfterProblems = iframeSrcAssignmentCount(iframe);
  h.move(B_FILE, B_ENTRY);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  try {
    assert.deepEqual(
      {
        unchangedUrl: assignmentsAfterProblems - assignmentsBeforeProblems,
        newUrl: iframeSrcAssignmentCount(iframe) - assignmentsAfterProblems,
        src: iframe.getAttribute("src"),
      },
      { unchangedUrl: 0, newUrl: 1, src: h.manager.url },
    );
  } finally {
    await h.close();
  }
});

test("the preview lists converter, translated note, and kit diagnostics and activates each target", async () => {
  // #given
  const h = await problemHarness([
    { line: 1, message: "Property typst is repeated", fatal: false },
  ]);
  h.setDiagnostics(h.source.entry, [{
    range: {
      start: { line: 3, character: 8 },
      end: { line: 3, character: 9 },
    },
    message: "unknown variable",
  }]);
  h.setDiagnostics(KIT_PATH, [{
    range: {
      start: { line: 1, character: 4 },
      end: { line: 1, character: 5 },
    },
    message: "template failed",
  }]);

  // #when
  h.emitDiagnostics(h.source.entry);
  h.emitDiagnostics(KIT_PATH);
  const list = h.view.contentEl.querySelector<HTMLUListElement>("ul.tinymist-problems");
  const entries = [...(list?.querySelectorAll("li") ?? [])];
  for (const entry of entries) entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await Promise.resolve();
  const text = entries.map((entry) => entry.textContent);
  const hiddenBeforeStop = list?.hidden ?? null;
  await h.manager.stop();
  const countAfterStop = list?.querySelectorAll("li").length ?? -1;

  // #then
  try {
    assert.deepEqual(
      { text, hiddenBeforeStop, reveals: h.reveals, opened: h.opened, countAfterStop },
      {
        text: [
          "Notes/A.md:2 Property typst is repeated",
          "Notes/A.md:4 unknown variable",
          "_typst/kit.typ:2 template failed",
        ],
        hiddenBeforeStop: false,
        reveals: [
          { line: 1, character: 0 },
          { line: 3, character: 10 },
        ],
        opened: [{ path: KIT_PATH, line: 1, character: 4 }],
        countAfterStop: 0,
      },
    );
  } finally {
    await h.close();
  }
});

test("the preview problems list exists hidden when there are no problems", async () => {
  // #given
  const h = await problemHarness([]);

  // #when
  const list = h.view.contentEl.querySelector<HTMLUListElement>("ul.tinymist-problems");

  // #then
  try {
    assert.deepEqual(
      { count: h.view.contentEl.querySelectorAll("ul.tinymist-problems").length, hidden: list?.hidden ?? null },
      { count: 1, hidden: true },
    );
  } finally {
    await h.close();
  }
});

test("the preview lists diagnostics that the client stored before the view was bound", async () => {
  // #given
  const h = await problemHarness([], [{
    path: A_ENTRY,
    diagnostics: [{
      range: {
        start: { line: 3, character: 8 },
        end: { line: 3, character: 9 },
      },
      message: "unknown variable",
    }],
  }]);

  // #when
  const list = h.view.contentEl.querySelector<HTMLUListElement>("ul.tinymist-problems");
  const text = [...(list?.querySelectorAll("li") ?? [])].map((entry) => entry.textContent);

  // #then
  try {
    assert.deepEqual(
      { text, hidden: list?.hidden ?? null },
      { text: ["Notes/A.md:4 unknown variable"], hidden: false },
    );
  } finally {
    await h.close();
  }
});
