import "./support/dom";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import TinymistPlugin from "../src/main";
import { Notice, TFile, TFolder, TestApp, testApp } from "./support/obsidian";

const encoder = new TextEncoder();

interface ExportRequest {
  entryPath: string;
  root: string;
  sourceInput?: string;
}

interface ReplaceRequest {
  sourcePath: string;
  destinationPath: string;
  observedBytes: Uint8Array;
}

interface AutomaticPdfFacade {
  setAutomaticPdf?: (path: string, enabled: boolean) => Promise<void>;
  rebuildPdf?: (path: string) => Promise<void>;
  automaticPdfStatus?: (path: string) => "building" | "current" | "error" | "conflict" | "stale" | "missing";
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ControlledExporter {
  readonly requests: ExportRequest[] = [];
  readonly responses: Array<Uint8Array | Error | Promise<Uint8Array>> = [];
  stopCalls = 0;
  active = 0;
  maxActive = 0;

  async exportPdf(request: ExportRequest): Promise<Uint8Array> {
    this.requests.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const response = this.responses.shift() ?? encoder.encode("PDF-default");
      if (response instanceof Error) throw response;
      return await response;
    } finally {
      this.active--;
    }
  }

  stop(): void {
    this.stopCalls++;
  }
}

class TestPlugin extends TinymistPlugin {
  readonly exporter = new ControlledExporter();
  readonly exporterFactorySettings: string[] = [];
  readonly confirmations: ReplaceRequest[] = [];
  readonly confirmationResults: Array<boolean | Promise<boolean>> = [];
  lspStarts = 0;
  saveDataError: Error | null = null;

  createAutomaticPdfExporter(): ControlledExporter {
    this.exporterFactorySettings.push(this.settings.binaryPath);
    return this.exporter;
  }

  async confirmAutomaticPdfReplace(request: ReplaceRequest): Promise<boolean> {
    this.confirmations.push(request);
    return this.confirmationResults.shift() ?? true;
  }

  async startLsp(_restart: boolean): Promise<void> {
    this.lspStarts++;
  }

  async saveData(data: unknown): Promise<void> {
    if (this.saveDataError) throw this.saveDataError;
    await super.saveData(data);
  }
}

interface Harness {
  root: string;
  app: TestApp;
  plugin: TestPlugin;
  feature: AutomaticPdfFacade;
  addSource(path: string, text?: string): TFile;
  close(): void;
}

async function harness(existingApp?: TestApp, existingRoot?: string): Promise<Harness> {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "automatic-pdf-"));
  const app = existingApp ?? testApp(root);
  const plugin = new TestPlugin(app as never, {} as never);
  await plugin.onload();
  return {
    root,
    app,
    plugin,
    feature: plugin as unknown as AutomaticPdfFacade,
    addSource(path: string, text = "= Source\n"): TFile {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
      app.vault.files.set(path, text);
      return new TFile(path);
    },
    close(): void {
      plugin.onunload();
      if (!existingRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function settleUntil(predicate: () => boolean, timeout = 1200): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

function bytes(app: TestApp, path: string): string | null {
  const value = app.vault.binaryFiles.get(path);
  return value ? new TextDecoder().decode(value) : null;
}

async function setEnabled(h: Harness, path: string, enabled: boolean): Promise<void> {
  await h.feature.setAutomaticPdf?.(path, enabled);
}

test("external compiler and Vault recorders distinguish bytes, events, renames, and failures", async () => {
  // #given
  const exporter = new ControlledExporter();
  exporter.responses.push(encoder.encode("PDF-control"));
  const app = testApp("/control");
  let modifyEvents = 0;
  app.vault.on("modify", () => modifyEvents++);

  // #when
  const exported = await exporter.exportPdf({ entryPath: "/control/a.typ", root: "/control" });
  const pdf = await app.vault.createBinary("a.pdf", encoder.encode("PDF-A").buffer);
  await app.vault.modifyBinary(pdf, encoder.encode("PDF-B").buffer);
  await app.vault.emit("modify", new TFile("a.typ"));
  await app.fileManager.renameFile(pdf, "renamed.pdf");
  app.vault.failNextBinaryWrite = new Error("disk full");
  let failure: string | null = null;
  try {
    await app.vault.createBinary("failed.pdf", encoder.encode("PDF-C").buffer);
  } catch (error) {
    failure = String(error);
  }

  // #then
  assert.deepEqual(
    {
      exported: new TextDecoder().decode(exported),
      requests: exporter.requests,
      writes: app.vault.binaryWrites.map((write) => new TextDecoder().decode(write.data)),
      renamedBytes: bytes(app, "renamed.pdf"),
      renames: app.fileManager.renames,
      modifyEvents,
      failure,
    },
    {
      exported: "PDF-control",
      requests: [{ entryPath: "/control/a.typ", root: "/control" }],
      writes: ["PDF-A", "PDF-B"],
      renamedBytes: "PDF-B",
      renames: [{ from: "a.pdf", to: "renamed.pdf" }],
      modifyEvents: 1,
      failure: "Error: disk full",
    },
  );
});

test("opt-in builds immediately, coalesces closed-file saves to the latest result, and disable suppresses output", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("notes/chapter.typ");
  const stale = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-initial"), stale.promise, encoder.encode("PDF-latest"));
  try {
    await h.app.vault.emit("modify", source);
    await setEnabled(h, source.path, true);
    await settleUntil(() => h.plugin.exporter.requests.length === 1);
    const beforeRapidSaves = h.feature.automaticPdfStatus?.(source.path);
    h.app.vault.files.set(source.path, "= Saved once\n");
    await h.app.vault.emit("modify", source);
    await settleUntil(() => h.plugin.exporter.requests.length === 2);
    const whileBuilding = h.feature.automaticPdfStatus?.(source.path);

    // #when
    h.app.vault.files.set(source.path, "= Saved latest\n");
    await h.app.vault.emit("modify", source);
    stale.resolve(encoder.encode("PDF-stale"));
    await settleUntil(() => h.app.vault.binaryWrites.length === 2);
    await setEnabled(h, source.path, false);
    await h.app.vault.emit("modify", source);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // #then
    assert.deepEqual(
      {
        requestCount: h.plugin.exporter.requests.length,
        writes: h.app.vault.binaryWrites.map((write) => ({ path: write.path, data: new TextDecoder().decode(write.data) })),
        finalBytes: bytes(h.app, "notes/chapter.pdf"),
        beforeRapidSaves,
        whileBuilding,
      },
      {
        requestCount: 3,
        writes: [
          { path: "notes/chapter.pdf", data: "PDF-initial" },
          { path: "notes/chapter.pdf", data: "PDF-latest" },
        ],
        finalBytes: "PDF-latest",
        beforeRapidSaves: "current",
        whileBuilding: "building",
      },
    );
  } finally {
    h.close();
  }
});

test("persisted opt-ins rebuild every root at startup without opening a view", async () => {
  // #given
  const first = await harness();
  first.addSource("a.typ");
  first.addSource("chapters/b.typ");
  first.plugin.exporter.responses.push(encoder.encode("A-first"), encoder.encode("B-first"));
  await setEnabled(first, "a.typ", true);
  await setEnabled(first, "chapters/b.typ", true);
  await settleUntil(() => first.app.vault.binaryWrites.length === 2);
  const stored = structuredClone(first.app.pluginData);
  first.plugin.onunload();

  const app = testApp(first.root);
  app.pluginData = stored;
  app.vault.files.set("a.typ", "= A\n");
  app.vault.files.set("chapters/b.typ", "= B\n");
  app.vault.binaryFiles.set("a.pdf", encoder.encode("A-first"));
  app.vault.binaryFiles.set("chapters/b.pdf", encoder.encode("B-first"));
  const second = await harness(app, first.root);
  second.plugin.exporter.responses.push(encoder.encode("A-startup"), encoder.encode("B-startup"));

  // #when
  await app.workspace.runLayoutReady();
  await settleUntil(() => app.vault.binaryWrites.length === 2);

  // #then
  try {
    assert.deepEqual(
      {
        entries: second.plugin.exporter.requests.map((request) => request.entryPath).sort(),
        writes: app.vault.binaryWrites.map((write) => write.path).sort(),
        lspStarts: second.plugin.lspStarts,
        maxActive: second.plugin.exporter.maxActive,
        confirmations: second.plugin.confirmations.length,
      },
      {
        entries: [join(first.root, "a.typ"), join(first.root, "chapters/b.typ")].sort(),
        writes: ["a.pdf", "chapters/b.pdf"],
        lspStarts: 1,
        maxActive: 1,
        confirmations: 0,
      },
    );
  } finally {
    second.close();
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("manual rebuild uses previewEntry wrapper inputs but publishes the selected source sibling", async () => {
  // #given
  const h = await harness();
  h.addSource("book/chapter.typ");
  h.addSource("book/.tinymist-preview.typ", "#include sys.inputs.at(\"preview-source\")\n");
  h.plugin.exporter.responses.push(encoder.encode("PDF-wrapper"));
  const primaryCalls: string[] = [];
  const fragmentCalls: string[] = [];
  h.plugin.lsp = {
    stop: () => primaryCalls.push("stop"),
    setPreviewSource: (value?: string) => primaryCalls.push(`input:${value ?? "clear"}`),
    pinMain: (value: string | null) => primaryCalls.push(`main:${value ?? "clear"}`),
  } as never;
  h.plugin.fragments = {
    stop: () => fragmentCalls.push("stop"),
    dispose: () => fragmentCalls.push("dispose"),
  } as never;

  // #when
  await h.feature.rebuildPdf?.("book/chapter.typ");
  await settleUntil(() => h.app.vault.binaryWrites.length === 1);

  // #then
  try {
    assert.deepEqual(
      {
        request: h.plugin.exporter.requests[0],
        write: h.app.vault.binaryWrites[0] && {
          path: h.app.vault.binaryWrites[0].path,
          data: new TextDecoder().decode(h.app.vault.binaryWrites[0].data),
        },
        primaryCalls,
        fragmentCalls,
      },
      {
        request: {
          entryPath: join(h.root, "book/.tinymist-preview.typ"),
          root: h.root,
          sourceInput: "/book/chapter.typ",
        },
        write: { path: "book/chapter.pdf", data: "PDF-wrapper" },
        primaryCalls: [],
        fragmentCalls: [],
      },
    );
  } finally {
    h.plugin.lsp = null;
    h.plugin.fragments = null;
    h.close();
  }
});

test("replacement consent is bound to the observed destination bytes", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-A"));
  h.plugin.exporter.responses.push(encoder.encode("PDF-new"));
  const permission = deferred<boolean>();
  h.plugin.confirmationResults.push(permission.promise);
  const enabling = h.feature.setAutomaticPdf?.("chapter.typ", true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.confirmations.length === 1);

  // #when
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-B"));
  permission.resolve(true);
  await enabling;
  await new Promise((resolve) => setTimeout(resolve, 20));

  // #then
  try {
    const confirmation = h.plugin.confirmations[0];
    assert.deepEqual(
      {
        confirmation: confirmation && {
          sourcePath: confirmation.sourcePath,
          destinationPath: confirmation.destinationPath,
          observedBytes: new TextDecoder().decode(confirmation.observedBytes),
        },
        finalBytes: bytes(h.app, "chapter.pdf"),
        writes: h.app.vault.binaryWrites.length,
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      {
        confirmation: {
          sourcePath: "chapter.typ",
          destinationPath: "chapter.pdf",
          observedBytes: "PDF-external-A",
        },
        finalBytes: "PDF-external-B",
        writes: 0,
        status: "conflict",
      },
    );
  } finally {
    h.close();
  }
});

test("declining replacement preserves a pre-existing PDF", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external"));
  h.plugin.exporter.responses.push(encoder.encode("PDF-new"));
  h.plugin.confirmationResults.push(false);

  // #when
  await setEnabled(h, "chapter.typ", true);

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writes: h.app.vault.binaryWrites.length,
        confirmations: h.plugin.confirmations.length,
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      { bytes: "PDF-external", writes: 0, confirmations: 1, status: "conflict" },
    );
  } finally {
    h.close();
  }
});

test("an externally changed plugin-owned PDF is not overwritten when export finishes", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const pending = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise);
  await setEnabled(h, "chapter.typ", true);
  h.plugin.confirmationResults.push(false);
  const rebuilding = h.feature.rebuildPdf?.("chapter.typ") ?? Promise.resolve();
  await settleUntil(() => h.plugin.exporter.requests.length === 2);

  // #when
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-during-export"));
  pending.resolve(encoder.encode("PDF-new"));
  await rebuilding;

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writeCount: h.app.vault.binaryWrites.length,
        confirmationBytes: h.plugin.confirmations[0]
          ? new TextDecoder().decode(h.plugin.confirmations[0].observedBytes)
          : null,
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      {
        bytes: "PDF-external-during-export",
        writeCount: 1,
        confirmationBytes: "PDF-external-during-export",
        status: "conflict",
      },
    );
  } finally {
    h.close();
  }
});

test("a first build failure reports an error without inventing a PDF", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(new Error("first compile failed"));
  Notice.shown.length = 0;

  // #when
  await setEnabled(h, "chapter.typ", true);

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
        notices: Notice.shown.length,
      },
      { bytes: null, status: "error", notices: 1 },
    );
  } finally {
    h.close();
  }
});

test("failed rebuild keeps the last good PDF stale, notifies once per error episode, and recovers quietly", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(
    encoder.encode("PDF-good"),
    new Error("compiler failed"),
    new Error("compiler failed again"),
    encoder.encode("PDF-recovered"),
  );
  Notice.shown.length = 0;
  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", recordUnhandled);
  try {
    await setEnabled(h, "chapter.typ", true);
    await h.feature.rebuildPdf?.("chapter.typ");
    await h.feature.rebuildPdf?.("chapter.typ");
    const failed = {
      bytes: bytes(h.app, "chapter.pdf"),
      status: h.feature.automaticPdfStatus?.("chapter.typ"),
      notices: Notice.shown.length,
    };

    // #when
    await h.feature.rebuildPdf?.("chapter.typ");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // #then
    assert.deepEqual(
      {
        failed,
        recoveredBytes: bytes(h.app, "chapter.pdf"),
        recoveredStatus: h.feature.automaticPdfStatus?.("chapter.typ"),
        finalNotices: Notice.shown.length,
        unhandled,
      },
      {
        failed: { bytes: "PDF-good", status: "stale", notices: 1 },
        recoveredBytes: "PDF-recovered",
        recoveredStatus: "current",
        finalNotices: 1,
        unhandled: [],
      },
    );
  } finally {
    process.off("unhandledRejection", recordUnhandled);
    h.close();
  }
});

test("a Vault write failure keeps the last good PDF and settles the rebuild action", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-good"), encoder.encode("PDF-new"));
  Notice.shown.length = 0;
  await setEnabled(h, "chapter.typ", true);
  h.app.vault.failNextBinaryWrite = new Error("disk full");
  let actionError: unknown = null;

  // #when
  try {
    await h.feature.rebuildPdf?.("chapter.typ");
  } catch (error) {
    actionError = error;
  }

  // #then
  try {
    assert.deepEqual(
      {
        actionError,
        bytes: bytes(h.app, "chapter.pdf"),
        writeCount: h.app.vault.binaryWrites.length,
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
        notices: Notice.shown.length,
      },
      { actionError: null, bytes: "PDF-good", writeCount: 1, status: "stale", notices: 1 },
    );
  } finally {
    h.close();
  }
});

test("file rename moves only unchanged owned output and stale exports never recreate old paths", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/chapter.typ");
  const pending = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise, encoder.encode("PDF-renamed"));
  await setEnabled(h, source.path, true);
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.plugin.exporter.requests.length === 2);

  // #when
  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("old/renamed.typ", "= Source\n");
  source.path = "old/renamed.typ";
  await h.app.vault.emit("rename", source, "old/chapter.typ");
  pending.resolve(encoder.encode("PDF-stale-old-path"));
  await settleUntil(() => bytes(h.app, "old/renamed.pdf") === "PDF-renamed");

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old/chapter.pdf"),
        newBytes: bytes(h.app, "old/renamed.pdf"),
        writePaths: h.app.vault.binaryWrites.map((write) => write.path),
      },
      {
        renames: [{ from: "old/chapter.pdf", to: "old/renamed.pdf" }],
        oldBytes: null,
        newBytes: "PDF-renamed",
        writePaths: ["old/chapter.pdf", "old/renamed.pdf"],
      },
    );
  } finally {
    h.close();
  }
});

test("folder rename recognizes the PDF moved by the Vault and recompiles only in the new folder", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/chapter.typ");
  const pending = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise, encoder.encode("PDF-new-folder"));
  await setEnabled(h, source.path, true);
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.plugin.exporter.requests.length === 2);

  // #when
  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("new/chapter.typ", "= Source\n");
  const movedPdf = h.app.vault.binaryFiles.get("old/chapter.pdf");
  h.app.vault.binaryFiles.delete("old/chapter.pdf");
  if (movedPdf) h.app.vault.binaryFiles.set("new/chapter.pdf", movedPdf);
  source.path = "new/chapter.typ";
  await h.app.vault.emit("rename", new TFolder("new"), "old");
  pending.resolve(encoder.encode("PDF-stale-old-folder"));
  await settleUntil(() => bytes(h.app, "new/chapter.pdf") === "PDF-new-folder");

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old/chapter.pdf"),
        newBytes: bytes(h.app, "new/chapter.pdf"),
        writePaths: h.app.vault.binaryWrites.map((write) => write.path),
      },
      {
        renames: [],
        oldBytes: null,
        newBytes: "PDF-new-folder",
        writePaths: ["old/chapter.pdf", "new/chapter.pdf"],
      },
    );
  } finally {
    h.close();
  }
});

test("an externally altered PDF is not moved when its source is renamed", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-new-path"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("old.pdf", encoder.encode("PDF-externally-altered"));

  // #when
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Source\n");
  source.path = "renamed.typ";
  await h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => bytes(h.app, "renamed.pdf") === "PDF-new-path");

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        alteredBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
      },
      { renames: [], alteredBytes: "PDF-externally-altered", newBytes: "PDF-new-path" },
    );
  } finally {
    h.close();
  }
});

test("a failed owned-PDF move does not roll back the source rename or publish to its old path", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-new-path"));
  await setEnabled(h, source.path, true);
  h.app.fileManager.failNext = new Error("move failed");
  Notice.shown.length = 0;

  // #when
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Source\n");
  source.path = "renamed.typ";
  await h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => bytes(h.app, "renamed.pdf") === "PDF-new-path");

  // #then
  try {
    assert.deepEqual(
      {
        sourceAtNewPath: h.app.vault.files.get("renamed.typ"),
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
        writePaths: h.app.vault.binaryWrites.map((write) => write.path),
        notices: Notice.shown.length,
      },
      {
        sourceAtNewPath: "= Source\n",
        renames: [{ from: "old.pdf", to: "renamed.pdf" }],
        oldBytes: "PDF-owned",
        newBytes: "PDF-new-path",
        writePaths: ["old.pdf", "renamed.pdf"],
        notices: 1,
      },
    );
  } finally {
    h.close();
  }
});

test("rename collision leaves both PDFs untouched and disabling invalidates pending publication", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-unrelated"));
  h.plugin.confirmationResults.push(false);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("taken.typ", "= Source\n");
  source.path = "taken.typ";
  await h.app.vault.emit("rename", source, "old.typ");
  const afterCollision = {
    owned: bytes(h.app, "old.pdf"),
    unrelated: bytes(h.app, "taken.pdf"),
    renames: [...h.app.fileManager.renames],
    confirmations: h.plugin.confirmations.length,
  };
  const disabled = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(disabled.promise);
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.feature.automaticPdfStatus?.("taken.typ") === "building");

  // #when
  await setEnabled(h, "taken.typ", false);
  disabled.resolve(encoder.encode("PDF-after-disable"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const beforeUnload = bytes(h.app, "taken.pdf");
  h.close();

  // #then
  assert.deepEqual(
    {
      afterCollision,
      beforeUnload,
      afterUnload: bytes(h.app, "taken.pdf"),
      exporterStops: h.plugin.exporter.stopCalls,
    },
    {
      afterCollision: { owned: "PDF-owned", unrelated: "PDF-unrelated", renames: [], confirmations: 1 },
      beforeUnload: "PDF-unrelated",
      afterUnload: "PDF-unrelated",
      exporterStops: 1,
    },
  );
});

test("deleting a source retains its PDF and removes the opt-in across reload", async () => {
  // #given
  const first = await harness();
  const source = first.addSource("chapter.typ");
  const pending = deferred<Uint8Array>();
  first.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise);
  await setEnabled(first, source.path, true);
  await settleUntil(() => first.app.vault.binaryWrites.length === 1);
  await first.app.vault.emit("modify", source);
  await settleUntil(() => first.plugin.exporter.requests.length === 2);

  // #when
  first.app.vault.files.delete(source.path);
  await first.app.vault.emit("delete", source);
  pending.resolve(encoder.encode("PDF-after-delete"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stored = structuredClone(first.app.pluginData);
  const retained = bytes(first.app, "chapter.pdf");
  first.plugin.onunload();
  const app = testApp(first.root);
  app.pluginData = stored;
  app.vault.files.set("chapter.typ", "= Recreated later\n");
  app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-owned"));
  const second = await harness(app, first.root);
  await app.workspace.runLayoutReady();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // #then
  try {
    assert.deepEqual(
      {
        retained,
        writeCountAfterDelete: first.app.vault.binaryWrites.length,
        startupRequests: second.plugin.exporter.requests.length,
        startupWrites: app.vault.binaryWrites.length,
      },
      { retained: "PDF-owned", writeCountAfterDelete: 1, startupRequests: 0, startupWrites: 0 },
    );
  } finally {
    second.close();
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("unload stops the exporter and invalidates an in-flight publication", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const pending = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise);
  await setEnabled(h, source.path, true);
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.plugin.exporter.requests.length === 2);

  // #when
  h.plugin.onunload();
  pending.resolve(encoder.encode("PDF-after-unload"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writeCount: h.app.vault.binaryWrites.length,
        exporterStops: h.plugin.exporter.stopCalls,
      },
      { bytes: "PDF-owned", writeCount: 1, exporterStops: 1 },
    );
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a persistence failure is reported and does not reject the opt-in action", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.saveDataError = new Error("settings storage unavailable");
  Notice.shown.length = 0;
  let actionError: unknown = null;

  // #when
  try {
    await setEnabled(h, "chapter.typ", true);
  } catch (error) {
    actionError = error;
  }

  // #then
  try {
    assert.deepEqual(
      { actionError, notices: Notice.shown.length },
      { actionError: null, notices: 1 },
    );
  } finally {
    h.close();
  }
});

test("saving PDF opt-in preserves unrelated settings and does not restart the primary LSP", async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "automatic-pdf-settings-"));
  const app = testApp(root);
  app.pluginData = { binaryPath: "/custom/tinymist", saveDebounceMs: 777, unrelatedFutureSetting: "keep-me" };
  const h = await harness(app, root);
  h.addSource("chapter.typ");
  let primaryStops = 0;
  h.plugin.lsp = { stop: () => primaryStops++ } as never;

  // #when
  await setEnabled(h, "chapter.typ", true);
  const afterOptIn = { primaryStops, exporterStops: h.plugin.exporter.stopCalls };
  h.plugin.settings.binaryPath = "/new/tinymist";
  await h.plugin.saveSettings();
  await h.feature.rebuildPdf?.("chapter.typ");
  const data = app.pluginData as Record<string, unknown>;
  const beforeUnload = {
    data: {
      binaryPath: data.binaryPath,
      saveDebounceMs: data.saveDebounceMs,
      unrelatedFutureSetting: data.unrelatedFutureSetting,
    },
    primaryStops,
    exporterStops: h.plugin.exporter.stopCalls,
    exporterFactorySettings: [...h.plugin.exporterFactorySettings],
  };
  h.close();

  // #then
  try {
    assert.deepEqual(
      {
        afterOptIn,
        beforeUnload,
        afterUnload: { primaryStops, exporterStops: h.plugin.exporter.stopCalls },
      },
      {
        afterOptIn: { primaryStops: 0, exporterStops: 0 },
        beforeUnload: {
          data: {
            binaryPath: "/new/tinymist",
            saveDebounceMs: 777,
            unrelatedFutureSetting: "keep-me",
          },
          primaryStops: 0,
          exporterStops: 1,
          exporterFactorySettings: ["/custom/tinymist", "/new/tinymist"],
        },
        afterUnload: { primaryStops: 1, exporterStops: 2 },
      },
    );
  } finally {
    h.plugin.lsp = null;
    rmSync(root, { recursive: true, force: true });
  }
});
