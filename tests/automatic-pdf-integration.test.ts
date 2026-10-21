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

type AutomaticPdfOutcome = "published" | "conflict" | "failed" | "superseded" | "cancelled" | "busy";

interface AutomaticPdfReceipt {
  outcome: AutomaticPdfOutcome;
  generation: number;
  pdfPath: string;
  status: "building" | "current" | "error" | "conflict" | "stale" | "missing";
}

interface AutomaticPdfFacade {
  setAutomaticPdf?: (path: string, enabled: boolean) => Promise<void>;
  rebuildPdf?: (
    path: string,
    options?: { interactive?: boolean },
  ) => Promise<AutomaticPdfReceipt>;
  automaticPdfEnabled?: (path: string) => boolean;
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

function rebuildPdf(
  h: Harness,
  path: string,
  options?: { interactive?: boolean },
): Promise<AutomaticPdfReceipt> {
  if (!h.feature.rebuildPdf) throw new Error("Automatic PDF rebuild is unavailable");
  return h.feature.rebuildPdf(path, options);
}

async function receiptWithin(
  receipt: Promise<AutomaticPdfReceipt>,
  timeout = 150,
): Promise<AutomaticPdfReceipt | "timed out"> {
  return await Promise.race([
    receipt,
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), timeout)),
  ]);
}

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

test("accepted initial replacement authorizes the latest coalesced save for unchanged destination bytes", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const firstExport = deferred<Uint8Array>();
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-A"));
  h.plugin.exporter.responses.push(firstExport.promise, encoder.encode("PDF-latest"));
  h.plugin.confirmationResults.push(true);
  const enabling = h.feature.setAutomaticPdf?.(source.path, true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.confirmations.length === 1 && h.plugin.exporter.requests.length === 1);

  // #when
  h.app.vault.files.set(source.path, "= Latest source\n");
  await h.app.vault.emit("modify", source);
  firstExport.resolve(encoder.encode("PDF-superseded"));
  await settleUntil(() => bytes(h.app, "chapter.pdf") === "PDF-latest");
  await enabling;

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        writes: h.app.vault.binaryWrites.map((write) => ({
          path: write.path,
          bytes: new TextDecoder().decode(write.data),
        })),
        finalBytes: bytes(h.app, "chapter.pdf"),
        status: h.feature.automaticPdfStatus?.(source.path),
      },
      {
        confirmations: [{ path: "chapter.pdf", bytes: "PDF-external-A" }],
        writes: [{ path: "chapter.pdf", bytes: "PDF-latest" }],
        finalBytes: "PDF-latest",
        status: "current",
      },
    );
  } finally {
    h.close();
  }
});

test("accepted final recheck authorizes a save that supersedes its pending confirmation", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const firstExport = deferred<Uint8Array>();
  const permission = deferred<boolean>();
  h.plugin.exporter.responses.push(firstExport.promise, encoder.encode("PDF-latest"));
  h.plugin.confirmationResults.push(permission.promise);
  const enabling = h.feature.setAutomaticPdf?.(source.path, true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.exporter.requests.length === 1);
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-B"));
  firstExport.resolve(encoder.encode("PDF-superseded"));
  await settleUntil(() => h.plugin.confirmations.length === 1);

  // #when
  h.app.vault.files.set(source.path, "= Latest source\n");
  await h.app.vault.emit("modify", source);
  permission.resolve(true);
  await settleUntil(() => bytes(h.app, "chapter.pdf") === "PDF-latest");
  await enabling;

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        writes: h.app.vault.binaryWrites.map((write) => ({
          path: write.path,
          bytes: new TextDecoder().decode(write.data),
        })),
        finalBytes: bytes(h.app, "chapter.pdf"),
        status: h.feature.automaticPdfStatus?.(source.path),
      },
      {
        confirmations: [{ path: "chapter.pdf", bytes: "PDF-external-B" }],
        writes: [{ path: "chapter.pdf", bytes: "PDF-latest" }],
        finalBytes: "PDF-latest",
        status: "current",
      },
    );
  } finally {
    h.close();
  }
});

test("accepted rename-collision replacement authorizes a newer save before its export starts", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  const renamedExport = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), renamedExport.promise, encoder.encode("PDF-latest"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-external"));
  h.plugin.confirmationResults.push(true);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("taken.typ", "= Renamed\n");
  source.path = "taken.typ";
  await h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => h.plugin.confirmations.length === 1 && h.plugin.exporter.requests.length === 2);

  // #when
  h.app.vault.files.set(source.path, "= Latest renamed source\n");
  await h.app.vault.emit("modify", source);
  renamedExport.resolve(encoder.encode("PDF-superseded"));
  await settleUntil(() => bytes(h.app, "taken.pdf") === "PDF-latest");

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "taken.pdf"),
        writes: h.app.vault.binaryWrites.map((write) => ({
          path: write.path,
          bytes: new TextDecoder().decode(write.data),
        })),
        status: h.feature.automaticPdfStatus?.(source.path),
      },
      {
        confirmations: [{ path: "taken.pdf", bytes: "PDF-external" }],
        oldBytes: "PDF-owned",
        newBytes: "PDF-latest",
        writes: [
          { path: "old.pdf", bytes: "PDF-owned" },
          { path: "taken.pdf", bytes: "PDF-latest" },
        ],
        status: "current",
      },
    );
  } finally {
    h.close();
  }
});

test("changed destination bytes require a new replacement decision after an accepted stale export", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const firstExport = deferred<Uint8Array>();
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-A"));
  h.plugin.exporter.responses.push(firstExport.promise, encoder.encode("PDF-latest"));
  h.plugin.confirmationResults.push(true, true);
  const enabling = h.feature.setAutomaticPdf?.(source.path, true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.confirmations.length === 1 && h.plugin.exporter.requests.length === 1);

  // #when
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external-B"));
  h.app.vault.files.set(source.path, "= Latest source\n");
  await h.app.vault.emit("modify", source);
  firstExport.resolve(encoder.encode("PDF-superseded"));
  await settleUntil(() => bytes(h.app, "chapter.pdf") === "PDF-latest");
  await enabling;

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        writes: h.app.vault.binaryWrites.map((write) => ({
          path: write.path,
          bytes: new TextDecoder().decode(write.data),
        })),
        finalBytes: bytes(h.app, "chapter.pdf"),
      },
      {
        confirmations: [
          { path: "chapter.pdf", bytes: "PDF-external-A" },
          { path: "chapter.pdf", bytes: "PDF-external-B" },
        ],
        writes: [{ path: "chapter.pdf", bytes: "PDF-latest" }],
        finalBytes: "PDF-latest",
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

test("disabling during replacement confirmation revokes accepted authority before re-enable", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external"));
  h.plugin.exporter.responses.push(encoder.encode("PDF-new"));
  const confirmation = deferred<boolean>();
  h.plugin.confirmationResults.push(confirmation.promise);
  Notice.shown.length = 0;
  const enabling = h.feature.setAutomaticPdf?.("chapter.typ", true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.confirmations.length === 1);

  // #when
  await setEnabled(h, "chapter.typ", false);
  confirmation.resolve(true);
  await enabling;
  await setEnabled(h, "chapter.typ", true);

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writes: h.app.vault.binaryWrites.length,
        confirmations: h.plugin.confirmations.length,
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
        notices: Notice.shown.length,
      },
      { bytes: "PDF-new", writes: 1, confirmations: 2, status: "current", notices: 0 },
    );
  } finally {
    h.close();
  }
});

test("unloading while replacement confirmation is open leaves no stale notice or publication", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-external"));
  h.plugin.exporter.responses.push(encoder.encode("PDF-new"));
  const confirmation = deferred<boolean>();
  h.plugin.confirmationResults.push(confirmation.promise);
  Notice.shown.length = 0;
  const enabling = h.feature.setAutomaticPdf?.("chapter.typ", true) ?? Promise.resolve();
  await settleUntil(() => h.plugin.confirmations.length === 1);

  // #when
  h.plugin.onunload();
  confirmation.resolve(true);
  await enabling;

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writes: h.app.vault.binaryWrites.length,
        notices: Notice.shown.length,
      },
      { bytes: "PDF-external", writes: 0, notices: 0 },
    );
  } finally {
    rmSync(h.root, { recursive: true, force: true });
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

test("disabled and manual-only renamed sources stay quiet until an explicit rebuild replaces foreign PDFs", async () => {
  // #given
  const h = await harness();
  const disabled = h.addSource("off/owned.typ");
  const manualOnly = h.addSource("manual/owned.typ");
  const safe = h.addSource("safe/owned.typ");
  h.plugin.exporter.responses.push(
    encoder.encode("PDF-disabled-owned"),
    encoder.encode("PDF-manual-owned"),
    encoder.encode("PDF-safe-owned"),
    encoder.encode("PDF-disabled-rebuilt"),
    encoder.encode("PDF-manual-rebuilt"),
  );
  await setEnabled(h, disabled.path, true);
  await setEnabled(h, disabled.path, false);
  await h.feature.rebuildPdf?.(manualOnly.path);
  await setEnabled(h, safe.path, true);
  await setEnabled(h, safe.path, false);
  h.app.vault.files.delete("off/owned.typ");
  h.app.vault.files.set("off/foreign.typ", "= Disabled\n");
  h.app.vault.binaryFiles.set("off/foreign.pdf", encoder.encode("PDF-disabled-foreign"));
  disabled.path = "off/foreign.typ";
  h.app.vault.files.delete("manual/owned.typ");
  h.app.vault.files.set("manual/foreign.typ", "= Manual\n");
  h.app.vault.binaryFiles.set("manual/foreign.pdf", encoder.encode("PDF-manual-foreign"));
  manualOnly.path = "manual/foreign.typ";
  h.app.vault.files.delete("safe/owned.typ");
  h.app.vault.files.set("safe/renamed.typ", "= Safe\n");
  safe.path = "safe/renamed.typ";
  Notice.shown.length = 0;

  // #when
  await h.app.vault.emit("rename", disabled, "off/owned.typ");
  await h.app.vault.emit("rename", manualOnly, "manual/owned.typ");
  await h.app.vault.emit("rename", safe, "safe/owned.typ");
  const quiet = {
    confirmations: h.plugin.confirmations.length,
    notices: Notice.shown.length,
    requests: h.plugin.exporter.requests.map((request) => request.entryPath),
    writes: h.app.vault.binaryWrites.map((write) => write.path),
  };
  h.plugin.confirmationResults.push(true, true);
  await h.feature.rebuildPdf?.("off/foreign.typ");
  await h.feature.rebuildPdf?.("manual/foreign.typ");

  // #then
  try {
    assert.deepEqual(
      {
        quiet,
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        enabled: [
          h.feature.automaticPdfEnabled?.("off/foreign.typ"),
          h.feature.automaticPdfEnabled?.("manual/foreign.typ"),
          h.feature.automaticPdfEnabled?.("safe/renamed.typ"),
        ],
        bytes: {
          disabledOld: bytes(h.app, "off/owned.pdf"),
          disabledForeign: bytes(h.app, "off/foreign.pdf"),
          manualOld: bytes(h.app, "manual/owned.pdf"),
          manualForeign: bytes(h.app, "manual/foreign.pdf"),
          safeOld: bytes(h.app, "safe/owned.pdf"),
          safeRenamed: bytes(h.app, "safe/renamed.pdf"),
        },
        renames: h.app.fileManager.renames,
      },
      {
        quiet: {
          confirmations: 0,
          notices: 0,
          requests: [
            join(h.root, "off/owned.typ"),
            join(h.root, "manual/owned.typ"),
            join(h.root, "safe/owned.typ"),
          ],
          writes: ["off/owned.pdf", "manual/owned.pdf", "safe/owned.pdf"],
        },
        confirmations: [
          { path: "off/foreign.pdf", bytes: "PDF-disabled-foreign" },
          { path: "manual/foreign.pdf", bytes: "PDF-manual-foreign" },
        ],
        enabled: [false, false, false],
        bytes: {
          disabledOld: "PDF-disabled-owned",
          disabledForeign: "PDF-disabled-rebuilt",
          manualOld: "PDF-manual-owned",
          manualForeign: "PDF-manual-rebuilt",
          safeOld: null,
          safeRenamed: "PDF-safe-owned",
        },
        renames: [{ from: "safe/owned.pdf", to: "safe/renamed.pdf" }],
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

test("folder rename waits for the Vault index after owned descendants move physically", async () => {
  // #given
  const h = await harness();
  h.addSource("old/a.typ", "= A\n");
  h.addSource("old/b.typ", "= B\n");
  h.plugin.exporter.responses.push(
    encoder.encode("PDF-owned-A"),
    encoder.encode("PDF-owned-B"),
    encoder.encode("PDF-new-A"),
    encoder.encode("PDF-new-B"),
  );
  await setEnabled(h, "old/a.typ", true);
  await setEnabled(h, "old/b.typ", true);
  const ownedA = h.app.vault.binaryFiles.get("old/a.pdf");
  const ownedB = h.app.vault.binaryFiles.get("old/b.pdf");
  h.app.vault.files.delete("old/a.typ");
  h.app.vault.files.delete("old/b.typ");
  h.app.vault.files.set("new/a.typ", "= A\n");
  h.app.vault.files.set("new/b.typ", "= B\n");
  h.app.vault.binaryFiles.delete("old/a.pdf");
  h.app.vault.binaryFiles.delete("old/b.pdf");
  if (ownedA) h.app.vault.binaryFiles.set("new/a.pdf", ownedA);
  if (ownedB) h.app.vault.binaryFiles.set("new/b.pdf", ownedB);
  Notice.shown.length = 0;
  h.app.vault.beginFolderRenameIndexDelay("old", "new");
  const oldIndexedPdf = h.app.vault.getAbstractFileByPath("old/a.pdf");
  const newIndexedPdf = h.app.vault.getAbstractFileByPath("new/a.pdf");
  let oldReadError: string | null = null;
  if (oldIndexedPdf instanceof TFile) {
    try {
      await h.app.vault.readBinary(oldIndexedPdf);
    } catch (error) {
      oldReadError = String(error);
    }
  }
  const newPhysicalBytes = new TextDecoder().decode(
    new Uint8Array(await h.app.vault.readBinary(new TFile("new/a.pdf"))),
  );

  // #when
  const renamed = h.app.vault.dispatchFolderRenameAfterPhysicalMove(new TFolder("new"), "old");
  const indexAfterDispatch = {
    old: h.app.vault.getAbstractFileByPath("old/a.pdf")?.path ?? null,
    next: h.app.vault.getAbstractFileByPath("new/a.pdf")?.path ?? null,
  };
  await renamed;
  const rebuilt = await settleUntil(
    () => bytes(h.app, "new/a.pdf") === "PDF-new-A" && bytes(h.app, "new/b.pdf") === "PDF-new-B",
  );

  // #then
  try {
    assert.deepEqual(
      {
        delayedIndex: {
          old: oldIndexedPdf?.path ?? null,
          next: newIndexedPdf?.path ?? null,
          oldReadError,
          newPhysicalBytes,
        },
        indexAfterDispatch,
        rebuilt,
        requests: h.plugin.exporter.requests.map((request) => request.entryPath),
        writesAfterRename: h.app.vault.binaryWrites.slice(2).map((write) => ({
          path: write.path,
          bytes: new TextDecoder().decode(write.data),
        })),
        statuses: [
          h.feature.automaticPdfStatus?.("new/a.typ"),
          h.feature.automaticPdfStatus?.("new/b.typ"),
        ],
        confirmations: h.plugin.confirmations.length,
        renames: h.app.fileManager.renames,
        notices: Notice.shown.length,
      },
      {
        delayedIndex: {
          old: "old/a.pdf",
          next: null,
          oldReadError: "Error: Missing binary file: old/a.pdf",
          newPhysicalBytes: "PDF-owned-A",
        },
        indexAfterDispatch: { old: null, next: "new/a.pdf" },
        rebuilt: true,
        requests: [
          join(h.root, "old/a.typ"),
          join(h.root, "old/b.typ"),
          join(h.root, "new/a.typ"),
          join(h.root, "new/b.typ"),
        ],
        writesAfterRename: [
          { path: "new/a.pdf", bytes: "PDF-new-A" },
          { path: "new/b.pdf", bytes: "PDF-new-B" },
        ],
        statuses: ["current", "current"],
        confirmations: 0,
        renames: [],
        notices: 0,
      },
    );
  } finally {
    h.close();
  }
});

test("folder rename asks before replacing a physically moved foreign PDF after the index settles", async () => {
  // #given
  const h = await harness();
  h.addSource("old/chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, "old/chapter.typ", true);
  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("new/chapter.typ", "= Source\n");
  h.app.vault.binaryFiles.delete("old/chapter.pdf");
  h.app.vault.binaryFiles.set("new/chapter.pdf", encoder.encode("PDF-foreign"));
  h.plugin.confirmationResults.push(false);
  Notice.shown.length = 0;
  h.app.vault.beginFolderRenameIndexDelay("old", "new");

  // #when
  await h.app.vault.dispatchFolderRenameAfterPhysicalMove(new TFolder("new"), "old");

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "new/chapter.pdf"),
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        writesAfterRename: h.app.vault.binaryWrites.slice(1).length,
        requests: h.plugin.exporter.requests.map((request) => request.entryPath),
        status: h.feature.automaticPdfStatus?.("new/chapter.typ"),
        notices: Notice.shown.length,
      },
      {
        bytes: "PDF-foreign",
        confirmations: [{ path: "new/chapter.pdf", bytes: "PDF-foreign" }],
        writesAfterRename: 0,
        requests: [join(h.root, "old/chapter.typ")],
        status: "conflict",
        notices: 1,
      },
    );
  } finally {
    h.close();
  }
});

test("folder rename keeps a post-settlement binary read error as an error", async () => {
  // #given
  const h = await harness();
  h.addSource("old/chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, "old/chapter.typ", true);
  const owned = h.app.vault.binaryFiles.get("old/chapter.pdf");
  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("new/chapter.typ", "= Source\n");
  h.app.vault.binaryFiles.delete("old/chapter.pdf");
  if (owned) h.app.vault.binaryFiles.set("new/chapter.pdf", owned);
  const readBinary = h.app.vault.readBinary.bind(h.app.vault);
  let newPathReadFaultObserved = false;
  h.app.vault.readBinary = async (file: TFile): Promise<ArrayBuffer> => {
    if (file.path === "new/chapter.pdf") {
      newPathReadFaultObserved = true;
      throw new Error("EIO: disk read failed");
    }
    return readBinary(file);
  };
  Notice.shown.length = 0;
  h.app.vault.beginFolderRenameIndexDelay("old", "new");

  // #when
  await h.app.vault.dispatchFolderRenameAfterPhysicalMove(new TFolder("new"), "old");

  // #then
  try {
    assert.deepEqual(
      {
        bytes: bytes(h.app, "new/chapter.pdf"),
        newPathReadFaultObserved,
        writesAfterRename: h.app.vault.binaryWrites.slice(1).length,
        requests: h.plugin.exporter.requests.map((request) => request.entryPath),
        status: h.feature.automaticPdfStatus?.("new/chapter.typ"),
        notices: Notice.shown.length,
      },
      {
        bytes: "PDF-owned",
        newPathReadFaultObserved: true,
        writesAfterRename: 0,
        requests: [join(h.root, "old/chapter.typ")],
        status: "stale",
        notices: 1,
      },
    );
  } finally {
    h.app.vault.readBinary = readBinary;
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

test("accepting a file rename collision replaces the observed destination once", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-renamed"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-external"));
  h.plugin.confirmationResults.push(true);
  Notice.shown.length = 0;
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("taken.typ", "= Renamed\n");
  source.path = "taken.typ";

  // #when
  await h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => bytes(h.app, "taken.pdf") === "PDF-renamed");

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "taken.pdf"),
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        notices: Notice.shown.length,
      },
      {
        confirmations: [{ path: "taken.pdf", bytes: "PDF-external" }],
        oldBytes: "PDF-owned",
        newBytes: "PDF-renamed",
        writes: ["old.pdf", "taken.pdf"],
        notices: 0,
      },
    );
  } finally {
    h.close();
  }
});

test("a rejected identical-byte foreign copy never becomes owned after its source namespace changes", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-owned"));
  h.plugin.confirmationResults.push(false, false, false);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("taken.typ", "= Renamed\n");
  source.path = "taken.typ";
  await h.app.vault.emit("rename", source, "old.typ");
  const afterRename = h.plugin.confirmations.length;

  // #when
  await h.app.vault.emit("modify", source);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterAutosave = h.plugin.confirmations.length;
  await h.feature.rebuildPdf?.("taken.typ");
  const afterManual = h.plugin.confirmations.length;
  h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-external-changed"));
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.plugin.confirmations.length === 3);

  // #then
  try {
    assert.deepEqual(
      {
        confirmationCounts: [afterRename, afterAutosave, afterManual, h.plugin.confirmations.length],
        observed: h.plugin.confirmations.map((request) => new TextDecoder().decode(request.observedBytes)),
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "taken.pdf"),
        renames: h.app.fileManager.renames,
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        status: h.feature.automaticPdfStatus?.("taken.typ"),
      },
      {
        confirmationCounts: [1, 1, 2, 3],
        observed: ["PDF-owned", "PDF-owned", "PDF-external-changed"],
        oldBytes: "PDF-owned",
        newBytes: "PDF-external-changed",
        renames: [],
        writes: ["old.pdf"],
        status: "conflict",
      },
    );
  } finally {
    h.close();
  }
});

test("a rejected identical-byte foreign PDF remains unowned after its source folder changes", async () => {
  // #given
  const h = await harness();
  h.addSource("old/a.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, "old/a.typ", true);
  h.app.vault.files.delete("old/a.typ");
  h.app.vault.files.set("new/a.typ", "= Renamed\n");
  h.app.vault.binaryFiles.set("new/a.pdf", encoder.encode("PDF-owned"));
  h.plugin.confirmationResults.push(false, false);
  Notice.shown.length = 0;

  // #when
  await h.app.vault.emit("rename", new TFolder("new"), "old");
  const afterRename = h.plugin.confirmations.length;
  await h.app.vault.emit("modify", new TFile("new/a.typ"));
  const afterAutosave = h.plugin.confirmations.length;
  await h.feature.rebuildPdf?.("new/a.typ");

  // #then
  try {
    assert.deepEqual(
      {
        confirmationCounts: [afterRename, afterAutosave, h.plugin.confirmations.length],
        observed: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        bytes: { old: bytes(h.app, "old/a.pdf"), foreign: bytes(h.app, "new/a.pdf") },
        renames: h.app.fileManager.renames,
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        status: h.feature.automaticPdfStatus?.("new/a.typ"),
        notices: Notice.shown.length,
      },
      {
        confirmationCounts: [1, 1, 2],
        observed: [
          { path: "new/a.pdf", bytes: "PDF-owned" },
          { path: "new/a.pdf", bytes: "PDF-owned" },
        ],
        bytes: { old: "PDF-owned", foreign: "PDF-owned" },
        renames: [],
        writes: ["old/a.pdf"],
        status: "conflict",
        notices: 1,
      },
    );
  } finally {
    h.close();
  }
});

test("a declined file collision still requires consent after its foreign PDF moves with a folder", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/a.typ");
  h.plugin.exporter.responses.push(
    encoder.encode("PDF-owned"),
    encoder.encode("PDF-file-collision"),
    encoder.encode("PDF-folder-collision"),
    encoder.encode("PDF-manual-collision"),
  );
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("taken/a.pdf", encoder.encode("PDF-owned"));
  h.plugin.confirmationResults.push(false, false, false);
  h.app.vault.files.delete("old/a.typ");
  h.app.vault.files.set("taken/a.typ", "= Taken\n");
  source.path = "taken/a.typ";
  await h.app.vault.emit("rename", source, "old/a.typ");
  h.app.vault.files.delete("taken/a.typ");
  h.app.vault.files.set("final/a.typ", "= Final\n");
  const foreign = h.app.vault.binaryFiles.get("taken/a.pdf");
  h.app.vault.binaryFiles.delete("taken/a.pdf");
  if (foreign) h.app.vault.binaryFiles.set("final/a.pdf", foreign);

  // #when
  await h.app.vault.emit("rename", new TFolder("final"), "taken");
  const afterFolderMove = h.plugin.confirmations.length;
  await h.app.vault.emit("modify", new TFile("final/a.typ"));
  const afterAutosave = h.plugin.confirmations.length;
  await h.feature.rebuildPdf?.("final/a.typ");

  // #then
  try {
    assert.deepEqual(
      {
        confirmationCounts: [afterFolderMove, afterAutosave, h.plugin.confirmations.length],
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        bytes: { old: bytes(h.app, "old/a.pdf"), final: bytes(h.app, "final/a.pdf") },
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        status: h.feature.automaticPdfStatus?.("final/a.typ"),
      },
      {
        confirmationCounts: [2, 2, 3],
        confirmations: [
          { path: "taken/a.pdf", bytes: "PDF-owned" },
          { path: "final/a.pdf", bytes: "PDF-owned" },
          { path: "final/a.pdf", bytes: "PDF-owned" },
        ],
        bytes: { old: "PDF-owned", final: "PDF-owned" },
        writes: ["old/a.pdf"],
        status: "conflict",
      },
    );
  } finally {
    h.close();
  }
});

test("a disabled source asks before a manually rebuilt foreign PDF follows a folder move", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/a.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-manual-collision"));
  await setEnabled(h, source.path, true);
  await setEnabled(h, source.path, false);
  h.app.vault.binaryFiles.set("taken/a.pdf", encoder.encode("PDF-owned"));
  h.app.vault.files.delete("old/a.typ");
  h.app.vault.files.set("taken/a.typ", "= Taken\n");
  source.path = "taken/a.typ";
  await h.app.vault.emit("rename", source, "old/a.typ");
  h.app.vault.files.delete("taken/a.typ");
  h.app.vault.files.set("final/a.typ", "= Final\n");
  const foreign = h.app.vault.binaryFiles.get("taken/a.pdf");
  h.app.vault.binaryFiles.delete("taken/a.pdf");
  if (foreign) h.app.vault.binaryFiles.set("final/a.pdf", foreign);
  Notice.shown.length = 0;

  // #when
  await h.app.vault.emit("rename", new TFolder("final"), "taken");
  const quiet = {
    confirmations: h.plugin.confirmations.length,
    notices: Notice.shown.length,
    requests: h.plugin.exporter.requests.map((request) => request.entryPath),
    writes: h.app.vault.binaryWrites.map((write) => write.path),
  };
  h.plugin.confirmationResults.push(false);
  await h.feature.rebuildPdf?.("final/a.typ");

  // #then
  try {
    assert.deepEqual(
      {
        quiet,
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        bytes: { old: bytes(h.app, "old/a.pdf"), final: bytes(h.app, "final/a.pdf") },
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        enabled: h.feature.automaticPdfEnabled?.("final/a.typ"),
        status: h.feature.automaticPdfStatus?.("final/a.typ"),
        notices: Notice.shown.length,
      },
      {
        quiet: {
          confirmations: 0,
          notices: 0,
          requests: [join(h.root, "old/a.typ")],
          writes: ["old/a.pdf"],
        },
        confirmations: [{ path: "final/a.pdf", bytes: "PDF-owned" }],
        bytes: { old: "PDF-owned", final: "PDF-owned" },
        writes: ["old/a.pdf"],
        enabled: false,
        status: "conflict",
        notices: 1,
      },
    );
  } finally {
    h.close();
  }
});

test("accepting a folder rename collision prompts once and publishes in the final folder", async () => {
  // #given
  const h = await harness();
  h.addSource("old/chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-new-folder"));
  await setEnabled(h, "old/chapter.typ", true);
  h.app.vault.binaryFiles.set("new/chapter.pdf", encoder.encode("PDF-external"));
  h.plugin.confirmationResults.push(true);
  Notice.shown.length = 0;
  h.app.vault.files.delete("old/chapter.typ");
  h.app.vault.files.set("new/chapter.typ", "= Renamed\n");

  // #when
  await h.app.vault.emit("rename", new TFolder("new"), "old");
  await settleUntil(() => bytes(h.app, "new/chapter.pdf") === "PDF-new-folder");

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.map((request) => new TextDecoder().decode(request.observedBytes)),
        oldBytes: bytes(h.app, "old/chapter.pdf"),
        newBytes: bytes(h.app, "new/chapter.pdf"),
        notices: Notice.shown.length,
      },
      {
        confirmations: ["PDF-external"],
        oldBytes: "PDF-owned",
        newBytes: "PDF-new-folder",
        notices: 0,
      },
    );
  } finally {
    h.close();
  }
});

test("a dispatched Vault write records ownership even when disable supersedes its completion", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const write = deferred<void>();
  h.app.vault.binaryWriteBarriers.push(write.promise);
  h.plugin.exporter.responses.push(encoder.encode("PDF-dispatched"), encoder.encode("PDF-reenabled"));
  const enabling = h.feature.setAutomaticPdf?.("chapter.typ", true) ?? Promise.resolve();
  await settleUntil(() => h.app.vault.binaryWriteStarted.length === 1);

  // #when
  await setEnabled(h, "chapter.typ", false);
  write.resolve();
  await enabling;
  await setEnabled(h, "chapter.typ", true);

  // #then
  try {
    assert.deepEqual(
      {
        confirmations: h.plugin.confirmations.length,
        bytes: bytes(h.app, "chapter.pdf"),
        writes: h.app.vault.binaryWrites.map((item) => new TextDecoder().decode(item.data)),
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      {
        confirmations: 0,
        bytes: "PDF-reenabled",
        writes: ["PDF-dispatched", "PDF-reenabled"],
        status: "current",
      },
    );
  } finally {
    h.close();
  }
});

test("an unrelated settings save requeues active and pending roots under current configuration", async () => {
  // #given
  const h = await harness();
  const a = h.addSource("a.typ");
  const b = h.addSource("b.typ");
  h.plugin.exporter.responses.push(encoder.encode("A-initial"), encoder.encode("B-initial"));
  await setEnabled(h, a.path, true);
  await setEnabled(h, b.path, true);
  const active = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(active.promise, encoder.encode("A-current"), encoder.encode("B-current"));
  await h.app.vault.emit("modify", a);
  await settleUntil(() => h.plugin.exporter.requests.length === 3);
  await h.app.vault.emit("modify", b);

  // #when
  h.plugin.settings.cursorPreview = !h.plugin.settings.cursorPreview;
  h.plugin.settings.binaryPath = "/current/tinymist";
  await h.plugin.saveSettings();
  active.resolve(encoder.encode("A-superseded"));
  await settleUntil(() => h.plugin.exporter.requests.length === 5 && bytes(h.app, "b.pdf") === "B-current");

  // #then
  try {
    assert.deepEqual(
      {
        requestCount: h.plugin.exporter.requests.length,
        retriedEntries: h.plugin.exporter.requests.slice(3).map((request) => request.entryPath).sort(),
        bytes: { a: bytes(h.app, "a.pdf"), b: bytes(h.app, "b.pdf") },
        statuses: {
          a: h.feature.automaticPdfStatus?.("a.typ"),
          b: h.feature.automaticPdfStatus?.("b.typ"),
        },
        maxActive: h.plugin.exporter.maxActive,
        factorySettings: h.plugin.exporterFactorySettings,
      },
      {
        requestCount: 5,
        retriedEntries: [join(h.root, "a.typ"), join(h.root, "b.typ")].sort(),
        bytes: { a: "A-current", b: "B-current" },
        statuses: { a: "current", b: "current" },
        maxActive: 1,
        factorySettings: ["", "/current/tinymist"],
      },
    );
  } finally {
    h.close();
  }
});

test("renaming an opted-in Typst source to another extension invalidates its in-flight publication", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const pending = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), pending.promise);
  await setEnabled(h, source.path, true);
  await h.app.vault.emit("modify", source);
  await settleUntil(() => h.plugin.exporter.requests.length === 2);
  h.app.vault.files.delete("chapter.typ");
  h.app.vault.files.set("chapter.txt", "= No longer Typst\n");
  source.path = "chapter.txt";

  // #when
  await h.app.vault.emit("rename", source, "chapter.typ");
  pending.resolve(encoder.encode("PDF-after-extension-change"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // #then
  try {
    const entries = (h.app.pluginData.automaticPdf as { entries?: Record<string, unknown> } | undefined)?.entries ?? {};
    assert.deepEqual(
      {
        bytes: bytes(h.app, "chapter.pdf"),
        writeCount: h.app.vault.binaryWrites.length,
        enabledOld: h.feature.automaticPdfEnabled?.("chapter.typ"),
        enabledNew: h.feature.automaticPdfEnabled?.("chapter.txt"),
        storedPaths: Object.keys(entries),
      },
      {
        bytes: "PDF-owned",
        writeCount: 1,
        enabledOld: false,
        enabledNew: false,
        storedPaths: [],
      },
    );
  } finally {
    h.close();
  }
});

test("two rapid physical folder renames keep owned PDFs on the final prefix without consent", async () => {
  // #given
  const h = await harness();
  h.addSource("old/a.typ");
  h.addSource("old/b.typ");
  h.plugin.exporter.responses.push(
    encoder.encode("A-owned"),
    encoder.encode("B-owned"),
    encoder.encode("A-final"),
    encoder.encode("B-final"),
  );
  await setEnabled(h, "old/a.typ", true);
  await setEnabled(h, "old/b.typ", true);
  const ownedA = h.app.vault.binaryFiles.get("old/a.pdf");
  const ownedB = h.app.vault.binaryFiles.get("old/b.pdf");
  const read = deferred<void>();
  h.app.vault.binaryReadBarriers.push(read.promise);
  h.app.vault.files.delete("old/a.typ");
  h.app.vault.files.delete("old/b.typ");
  h.app.vault.files.set("middle/a.typ", "= A\n");
  h.app.vault.files.set("middle/b.typ", "= B\n");
  h.app.vault.binaryFiles.delete("old/a.pdf");
  h.app.vault.binaryFiles.delete("old/b.pdf");
  if (ownedA) h.app.vault.binaryFiles.set("middle/a.pdf", ownedA);
  if (ownedB) h.app.vault.binaryFiles.set("middle/b.pdf", ownedB);
  const firstRename = h.app.vault.emit("rename", new TFolder("middle"), "old");
  const firstMiddleReadBlocked = await settleUntil(() => h.app.vault.binaryReadStarted.includes("middle/a.pdf"));
  h.app.vault.files.delete("middle/a.typ");
  h.app.vault.files.delete("middle/b.typ");
  h.app.vault.files.set("final/a.typ", "= A\n");
  h.app.vault.files.set("final/b.typ", "= B\n");
  const middleA = h.app.vault.binaryFiles.get("middle/a.pdf");
  const middleB = h.app.vault.binaryFiles.get("middle/b.pdf");
  h.app.vault.binaryFiles.delete("middle/a.pdf");
  h.app.vault.binaryFiles.delete("middle/b.pdf");
  if (middleA) h.app.vault.binaryFiles.set("final/a.pdf", middleA);
  if (middleB) h.app.vault.binaryFiles.set("final/b.pdf", middleB);
  Notice.shown.length = 0;

  // #when
  const secondRename = h.app.vault.emit("rename", new TFolder("final"), "middle");
  read.resolve();
  await Promise.all([firstRename, secondRename]);
  await settleUntil(() => bytes(h.app, "final/a.pdf") === "A-final" && bytes(h.app, "final/b.pdf") === "B-final");

  // #then
  try {
    assert.deepEqual(
      {
        enabled: [
          h.feature.automaticPdfEnabled?.("final/a.typ"),
          h.feature.automaticPdfEnabled?.("final/b.typ"),
        ],
        intermediateEnabled: [
          h.feature.automaticPdfEnabled?.("middle/a.typ"),
          h.feature.automaticPdfEnabled?.("middle/b.typ"),
        ],
        finalBytes: [bytes(h.app, "final/a.pdf"), bytes(h.app, "final/b.pdf")],
        statuses: [
          h.feature.automaticPdfStatus?.("final/a.typ"),
          h.feature.automaticPdfStatus?.("final/b.typ"),
        ],
        firstMiddleReadBlocked,
        requests: h.plugin.exporter.requests.map((request) => request.entryPath),
        confirmations: h.plugin.confirmations.length,
        notices: Notice.shown.length,
        oldWritePaths: h.app.vault.binaryWrites
          .map((write) => write.path)
          .filter((path) => path.startsWith("old/") || path.startsWith("middle/")),
      },
      {
        enabled: [true, true],
        intermediateEnabled: [false, false],
        finalBytes: ["A-final", "B-final"],
        statuses: ["current", "current"],
        firstMiddleReadBlocked: true,
        requests: [
          join(h.root, "old/a.typ"),
          join(h.root, "old/b.typ"),
          join(h.root, "final/a.typ"),
          join(h.root, "final/b.typ"),
        ],
        confirmations: 0,
        notices: 0,
        oldWritePaths: ["old/a.pdf", "old/b.pdf"],
      },
    );
  } finally {
    h.close();
  }
});

test("disabling a renamed source while its owned PDF read is pending prevents a stale move", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, source.path, true);
  const read = deferred<void>();
  h.app.vault.binaryReadBarriers.push(read.promise);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Renamed\n");
  source.path = "renamed.typ";
  const renaming = h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => h.app.vault.binaryReadStarted.includes("old.pdf"));

  // #when
  await setEnabled(h, "renamed.typ", false);
  read.resolve();
  await renaming;

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
        enabled: h.feature.automaticPdfEnabled?.("renamed.typ"),
      },
      { renames: [], oldBytes: "PDF-owned", newBytes: null, enabled: false },
    );
  } finally {
    h.close();
  }
});

test("deleting a renamed source while its owned PDF read is pending prevents a stale move", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, source.path, true);
  const read = deferred<void>();
  h.app.vault.binaryReadBarriers.push(read.promise);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Renamed\n");
  source.path = "renamed.typ";
  const renaming = h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => h.app.vault.binaryReadStarted.includes("old.pdf"));

  // #when
  h.app.vault.files.delete("renamed.typ");
  await h.app.vault.emit("delete", source);
  read.resolve();
  await renaming;

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
        enabled: h.feature.automaticPdfEnabled?.("renamed.typ"),
      },
      { renames: [], oldBytes: "PDF-owned", newBytes: null, enabled: false },
    );
  } finally {
    h.close();
  }
});

test("unloading while an owned PDF read is pending prevents a stale move and notice", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  await setEnabled(h, source.path, true);
  const read = deferred<void>();
  h.app.vault.binaryReadBarriers.push(read.promise);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Renamed\n");
  source.path = "renamed.typ";
  Notice.shown.length = 0;
  const renaming = h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => h.app.vault.binaryReadStarted.includes("old.pdf"));

  // #when
  h.plugin.onunload();
  read.resolve();
  await renaming;

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
        notices: Notice.shown.length,
      },
      { renames: [], oldBytes: "PDF-owned", newBytes: null, notices: 0 },
    );
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an owned PDF changed after an asynchronous read is not moved with its source", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-new-path"));
  await setEnabled(h, source.path, true);
  const read = deferred<void>();
  h.app.vault.binaryReadBarriers.push(read.promise);
  h.app.vault.files.delete("old.typ");
  h.app.vault.files.set("renamed.typ", "= Renamed\n");
  source.path = "renamed.typ";
  const renaming = h.app.vault.emit("rename", source, "old.typ");
  await settleUntil(() => h.app.vault.binaryReadStarted.includes("old.pdf"));

  // #when
  h.app.vault.binaryFiles.set("old.pdf", encoder.encode("PDF-external-after-read"));
  read.resolve();
  await renaming;
  await settleUntil(() => bytes(h.app, "renamed.pdf") === "PDF-new-path");

  // #then
  try {
    assert.deepEqual(
      {
        renames: h.app.fileManager.renames,
        oldBytes: bytes(h.app, "old.pdf"),
        newBytes: bytes(h.app, "renamed.pdf"),
      },
      { renames: [], oldBytes: "PDF-external-after-read", newBytes: "PDF-new-path" },
    );
  } finally {
    h.close();
  }
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

test("a superseded rename decline cannot authorize an equal-byte foreign PDF after a folder move", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/a.typ");
  const read = deferred<void>();
  let renaming: Promise<void> | null = null;
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-foreign-overwritten"));
  try {
    await setEnabled(h, source.path, true);
    h.app.vault.binaryFiles.set("taken/a.pdf", encoder.encode("PDF-owned"));
    h.plugin.confirmationResults.push(false, false);
    h.app.vault.binaryReadBarriers.push(read.promise);
    h.app.vault.files.delete("old/a.typ");
    h.app.vault.files.set("taken/a.typ", "= Taken\n");
    source.path = "taken/a.typ";
    renaming = h.app.vault.emit("rename", source, "old/a.typ");
    const oldReadReached = await settleUntil(() => h.app.vault.binaryReadStarted.includes("old/a.pdf"));
    h.app.vault.files.set("taken/a.typ", "= Latest taken\n");
    await h.app.vault.emit("modify", source);
    const takenDeclined = await settleUntil(() => h.plugin.confirmations.length === 1);
    h.app.vault.files.delete("taken/a.typ");
    h.app.vault.files.set("final/a.typ", "= Final\n");
    const foreign = h.app.vault.binaryFiles.get("taken/a.pdf");
    h.app.vault.binaryFiles.delete("taken/a.pdf");
    if (foreign) h.app.vault.binaryFiles.set("final/a.pdf", foreign);

    // #when
    await h.app.vault.emit("rename", new TFolder("final"), "taken");
    const finalDeclined = await settleUntil(() => h.plugin.confirmations.length === 2);
    const beforeOldReadRelease = {
      old: bytes(h.app, "old/a.pdf"),
      final: bytes(h.app, "final/a.pdf"),
      writes: h.app.vault.binaryWrites.map((write) => write.path),
      status: h.feature.automaticPdfStatus?.("final/a.typ"),
    };
    read.resolve();
    await renaming;

    // #then
    assert.deepEqual(
      {
        oldReadReached,
        takenDeclined,
        finalDeclined,
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        beforeOldReadRelease,
        afterOldReadRelease: {
          old: bytes(h.app, "old/a.pdf"),
          final: bytes(h.app, "final/a.pdf"),
          writes: h.app.vault.binaryWrites.map((write) => write.path),
          status: h.feature.automaticPdfStatus?.("final/a.typ"),
        },
      },
      {
        oldReadReached: true,
        takenDeclined: true,
        finalDeclined: true,
        confirmations: [
          { path: "taken/a.pdf", bytes: "PDF-owned" },
          { path: "final/a.pdf", bytes: "PDF-owned" },
        ],
        beforeOldReadRelease: {
          old: "PDF-owned",
          final: "PDF-owned",
          writes: ["old/a.pdf"],
          status: "conflict",
        },
        afterOldReadRelease: {
          old: "PDF-owned",
          final: "PDF-owned",
          writes: ["old/a.pdf"],
          status: "conflict",
        },
      },
    );
  } finally {
    read.resolve();
    await renaming;
    h.close();
  }
});

test("an unanswered old-path replacement cannot authorize a foreign PDF after a folder move", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old/a.typ");
  const read = deferred<void>();
  const oldPermission = deferred<boolean>();
  let renaming: Promise<void> | null = null;
  let folderMove: Promise<void> | null = null;
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-foreign-overwritten"));
  try {
    await setEnabled(h, source.path, true);
    h.app.vault.binaryFiles.set("taken/a.pdf", encoder.encode("PDF-owned"));
    h.plugin.confirmationResults.push(oldPermission.promise, false);
    h.app.vault.binaryReadBarriers.push(read.promise);
    h.app.vault.files.delete("old/a.typ");
    h.app.vault.files.set("taken/a.typ", "= Taken\n");
    source.path = "taken/a.typ";
    renaming = h.app.vault.emit("rename", source, "old/a.typ");
    const oldReadReached = await settleUntil(() => h.app.vault.binaryReadStarted.includes("old/a.pdf"));
    h.app.vault.files.set("taken/a.typ", "= Latest taken\n");
    await h.app.vault.emit("modify", source);
    const oldPathPrompted = await settleUntil(() => h.plugin.confirmations.length === 1);
    h.app.vault.files.delete("taken/a.typ");
    h.app.vault.files.set("final/a.typ", "= Final\n");
    const foreign = h.app.vault.binaryFiles.get("taken/a.pdf");
    h.app.vault.binaryFiles.delete("taken/a.pdf");
    if (foreign) h.app.vault.binaryFiles.set("final/a.pdf", foreign);

    // #when
    folderMove = h.app.vault.emit("rename", new TFolder("final"), "taken");
    const finalPathPromptedBeforeOldAcceptance = await settleUntil(() => h.plugin.confirmations.length === 2);
    oldPermission.resolve(true);
    read.resolve();
    await Promise.all([renaming, folderMove]);
    const finalSettled = await settleUntil(
      () =>
        h.feature.automaticPdfStatus?.("final/a.typ") === "conflict" ||
        h.app.vault.binaryWrites.some((write) => write.path === "final/a.pdf"),
    );

    // #then
    assert.deepEqual(
      {
        oldReadReached,
        oldPathPrompted,
        finalPathPromptedBeforeOldAcceptance,
        finalSettled,
        confirmations: h.plugin.confirmations.map((request) => ({
          path: request.destinationPath,
          bytes: new TextDecoder().decode(request.observedBytes),
        })),
        old: bytes(h.app, "old/a.pdf"),
        final: bytes(h.app, "final/a.pdf"),
        writes: h.app.vault.binaryWrites.map((write) => write.path),
        status: h.feature.automaticPdfStatus?.("final/a.typ"),
      },
      {
        oldReadReached: true,
        oldPathPrompted: true,
        finalPathPromptedBeforeOldAcceptance: true,
        finalSettled: true,
        confirmations: [
          { path: "taken/a.pdf", bytes: "PDF-owned" },
          { path: "final/a.pdf", bytes: "PDF-owned" },
        ],
        old: "PDF-owned",
        final: "PDF-owned",
        writes: ["old/a.pdf"],
        status: "conflict",
      },
    );
  } finally {
    oldPermission.resolve(true);
    read.resolve();
    await Promise.all([renaming, folderMove]);
    h.close();
  }
});

test("an agent rebuild publishes a missing PDF and returns its receipt", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-agent"));
  try {
    // #when
    const receipt = await rebuildPdf(h, "chapter.typ", { interactive: false });

    // #then
    assert.deepEqual(
      { receipt, bytes: bytes(h.app, "chapter.pdf") },
      {
        receipt: { outcome: "published", generation: 1, pdfPath: "chapter.pdf", status: "current" },
        bytes: "PDF-agent",
      },
    );
  } finally {
    h.close();
  }
});

test("an agent rebuild rejects a foreign PDF without consuming a replacement decision", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-agent"));
  await setEnabled(h, source.path, true);
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
  Notice.shown.length = 0;
  try {
    // #when
    const agent = await rebuildPdf(h, source.path, { interactive: false });
    const afterAgent = {
      bytes: bytes(h.app, "chapter.pdf"),
      confirmations: h.plugin.confirmations.length,
      requests: h.plugin.exporter.requests.length,
      notices: Notice.shown.length,
      receipt: agent,
    };
    h.plugin.confirmationResults.push(false);
    await h.app.vault.emit("modify", source);
    const automatic = await settleUntil(
      () =>
        h.plugin.confirmations.length === 1 &&
        h.feature.automaticPdfStatus?.(source.path) === "conflict",
    );

    // #then
    assert.deepEqual(
      {
        afterAgent,
        automatic: {
          settled: automatic,
          confirmations: h.plugin.confirmations.length,
          status: h.feature.automaticPdfStatus?.(source.path),
        },
      },
      {
        afterAgent: {
          bytes: "PDF-foreign",
          confirmations: 0,
          requests: 1,
          notices: 0,
          receipt: { outcome: "conflict", generation: 3, pdfPath: "chapter.pdf", status: "conflict" },
        },
        automatic: { settled: true, confirmations: 1, status: "conflict" },
      },
    );
  } finally {
    h.close();
  }
});

test("an agent rebuild preserves foreign bytes that arrive during export", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const exported = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(exported.promise);
  try {
    const rebuilding = rebuildPdf(h, "chapter.typ", { interactive: false });
    const exportStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);

    // #when
    h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
    exported.resolve(encoder.encode("PDF-agent"));
    const receipt = await rebuilding;

    // #then
    assert.deepEqual(
      {
        exportStarted,
        receipt,
        bytes: bytes(h.app, "chapter.pdf"),
        confirmations: h.plugin.confirmations.length,
        writes: h.app.vault.binaryWrites.length,
      },
      {
        exportStarted: true,
        receipt: { outcome: "conflict", generation: 1, pdfPath: "chapter.pdf", status: "conflict" },
        bytes: "PDF-foreign",
        confirmations: 0,
        writes: 0,
      },
    );
  } finally {
    exported.resolve(encoder.encode("PDF-agent"));
    h.close();
  }
});

test("an agent rebuild returns failed when the exporter throws", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(new Error("agent compile failed"));
  try {
    // #when
    const receipt = await rebuildPdf(h, "chapter.typ", { interactive: false });

    // #then
    assert.deepEqual(receipt, {
      outcome: "failed",
      generation: 1,
      pdfPath: "chapter.pdf",
      status: "error",
    });
  } finally {
    h.close();
  }
});

test("an agent rebuild settles as cancelled when the plugin unloads during export", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const exported = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(exported.promise);
  try {
    const rebuilding = rebuildPdf(h, "chapter.typ", { interactive: false });
    const exportStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);

    // #when
    h.plugin.onunload();
    const receipt = await receiptWithin(rebuilding);

    // #then
    assert.deepEqual(
      { exportStarted, receipt },
      {
        exportStarted: true,
        receipt: { outcome: "cancelled", generation: 1, pdfPath: "chapter.pdf", status: "building" },
      },
    );
  } finally {
    exported.resolve(encoder.encode("PDF-agent"));
    h.close();
  }
});

test("an agent rebuild is busy while another source is active", async () => {
  // #given
  const h = await harness();
  h.addSource("a.typ");
  h.addSource("b.typ");
  const active = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(active.promise);
  const automatic = setEnabled(h, "a.typ", true);
  try {
    const activeStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);

    // #when
    const receipt = await receiptWithin(rebuildPdf(h, "b.typ", { interactive: false }));
    const whileBusy = {
      receipt,
      requests: h.plugin.exporter.requests.length,
      activeStatus: h.feature.automaticPdfStatus?.("a.typ"),
      untouchedStatus: h.feature.automaticPdfStatus?.("b.typ"),
    };
    active.resolve(encoder.encode("PDF-a"));
    await automatic;
    const completed = {
      bytes: bytes(h.app, "a.pdf"),
      status: h.feature.automaticPdfStatus?.("a.typ"),
    };

    // #then
    assert.deepEqual(
      { activeStarted, whileBusy, completed },
      {
        activeStarted: true,
        whileBusy: {
          receipt: { outcome: "busy", generation: 0, pdfPath: "b.pdf", status: "missing" },
          requests: 1,
          activeStatus: "building",
          untouchedStatus: "missing",
        },
        completed: { bytes: "PDF-a", status: "current" },
      },
    );
  } finally {
    active.resolve(encoder.encode("PDF-a"));
    h.close();
  }
});

test("an agent rebuild is busy while another source is pending", async () => {
  // #given
  const h = await harness();
  h.addSource("a.typ");
  h.addSource("b.typ");
  h.addSource("c.typ");
  const active = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(active.promise, encoder.encode("PDF-a"), encoder.encode("PDF-b"));
  const bAutomatic = setEnabled(h, "b.typ", true);
  try {
    const activeStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);
    const aAutomatic = setEnabled(h, "a.typ", true);
    const aPending = await settleUntil(() => h.feature.automaticPdfStatus?.("a.typ") === "building");

    // #when
    const receipt = await receiptWithin(rebuildPdf(h, "c.typ", { interactive: false }));
    const whileBusy = {
      receipt,
      requests: h.plugin.exporter.requests.length,
      statuses: [h.feature.automaticPdfStatus?.("a.typ"), h.feature.automaticPdfStatus?.("b.typ")],
      untouchedStatus: h.feature.automaticPdfStatus?.("c.typ"),
    };
    active.resolve(encoder.encode("PDF-b"));
    await Promise.all([aAutomatic, bAutomatic]);
    const completed = {
      a: { bytes: bytes(h.app, "a.pdf"), status: h.feature.automaticPdfStatus?.("a.typ") },
      b: { bytes: bytes(h.app, "b.pdf"), status: h.feature.automaticPdfStatus?.("b.typ") },
    };

    // #then
    assert.deepEqual(
      { activeStarted, aPending, whileBusy, completed },
      {
        activeStarted: true,
        aPending: true,
        whileBusy: {
          receipt: { outcome: "busy", generation: 0, pdfPath: "c.pdf", status: "missing" },
          requests: 1,
          statuses: ["building", "building"],
          untouchedStatus: "missing",
        },
        completed: {
          a: { bytes: "PDF-a", status: "current" },
          b: { bytes: "PDF-b", status: "current" },
        },
      },
    );
  } finally {
    active.resolve(encoder.encode("PDF-b"));
    h.close();
  }
});

test("an agent rebuild is busy while its source is active", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  const active = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), active.promise);
  try {
    await setEnabled(h, source.path, true);
    await h.app.vault.emit("modify", source);
    const activeStarted = await settleUntil(() => h.plugin.exporter.requests.length === 2);

    // #when
    const receipt = await receiptWithin(rebuildPdf(h, source.path, { interactive: false }));
    const whileBusy = {
      receipt,
      requests: h.plugin.exporter.requests.length,
      status: h.feature.automaticPdfStatus?.(source.path),
    };
    active.resolve(encoder.encode("PDF-current"));
    await settleUntil(() => h.feature.automaticPdfStatus?.(source.path) === "current");
    const completed = {
      bytes: bytes(h.app, "chapter.pdf"),
      status: h.feature.automaticPdfStatus?.(source.path),
    };

    // #then
    assert.deepEqual(
      { activeStarted, whileBusy, completed },
      {
        activeStarted: true,
        whileBusy: {
          receipt: { outcome: "busy", generation: 3, pdfPath: "chapter.pdf", status: "building" },
          requests: 2,
          status: "building",
        },
        completed: { bytes: "PDF-current", status: "current" },
      },
    );
  } finally {
    active.resolve(encoder.encode("PDF-current"));
    h.close();
  }
});

test("an agent rebuild is busy while its source is pending", async () => {
  // #given
  const h = await harness();
  h.addSource("a.typ");
  h.addSource("b.typ");
  const active = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(active.promise, encoder.encode("PDF-a"), encoder.encode("PDF-b"));
  const bAutomatic = setEnabled(h, "b.typ", true);
  try {
    const activeStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);
    const aAutomatic = setEnabled(h, "a.typ", true);
    const aPending = await settleUntil(() => h.feature.automaticPdfStatus?.("a.typ") === "building");

    // #when
    const receipt = await receiptWithin(rebuildPdf(h, "a.typ", { interactive: false }));
    const whileBusy = {
      receipt,
      requests: h.plugin.exporter.requests.length,
      status: h.feature.automaticPdfStatus?.("a.typ"),
    };
    active.resolve(encoder.encode("PDF-b"));
    await Promise.all([aAutomatic, bAutomatic]);
    const completed = {
      a: { bytes: bytes(h.app, "a.pdf"), status: h.feature.automaticPdfStatus?.("a.typ") },
      b: { bytes: bytes(h.app, "b.pdf"), status: h.feature.automaticPdfStatus?.("b.typ") },
    };

    // #then
    assert.deepEqual(
      { activeStarted, aPending, whileBusy, completed },
      {
        activeStarted: true,
        aPending: true,
        whileBusy: {
          receipt: { outcome: "busy", generation: 2, pdfPath: "a.pdf", status: "building" },
          requests: 1,
          status: "building",
        },
        completed: {
          a: { bytes: "PDF-a", status: "current" },
          b: { bytes: "PDF-b", status: "current" },
        },
      },
    );
  } finally {
    active.resolve(encoder.encode("PDF-b"));
    h.close();
  }
});

test("an agent rebuild is busy while a build-path confirmation is open", async () => {
  // #given
  const h = await harness();
  h.addSource("a.typ");
  h.addSource("b.typ");
  h.app.vault.binaryFiles.set("a.pdf", encoder.encode("PDF-foreign"));
  const permission = deferred<boolean>();
  h.plugin.confirmationResults.push(permission.promise);
  Notice.shown.length = 0;
  const human = rebuildPdf(h, "a.typ");
  try {
    const prompted = await settleUntil(() => h.plugin.confirmations.length === 1);

    // #when
    const receipt = await receiptWithin(rebuildPdf(h, "b.typ", { interactive: false }));
    const whilePrompted = {
      receipt,
      confirmations: h.plugin.confirmations.length,
      requests: h.plugin.exporter.requests.length,
      notices: Notice.shown.length,
    };
    permission.resolve(true);
    const humanReceipt = await human;
    const completed = {
      bytes: bytes(h.app, "a.pdf"),
      status: h.feature.automaticPdfStatus?.("a.typ"),
    };

    // #then
    assert.deepEqual(
      { prompted, whilePrompted, humanReceipt, completed },
      {
        prompted: true,
        whilePrompted: {
          receipt: { outcome: "busy", generation: 0, pdfPath: "b.pdf", status: "missing" },
          confirmations: 1,
          requests: 0,
          notices: 0,
        },
        humanReceipt: { outcome: "published", generation: 1, pdfPath: "a.pdf", status: "current" },
        completed: { bytes: "PDF-default", status: "current" },
      },
    );
  } finally {
    permission.resolve(true);
    h.close();
  }
});

test("a human rebuild supersedes an active agent rebuild and publishes after one replacement decision", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const agentExport = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), agentExport.promise, encoder.encode("PDF-human"));
  try {
    await rebuildPdf(h, "chapter.typ");
    const agent = rebuildPdf(h, "chapter.typ", { interactive: false });
    const agentStarted = await settleUntil(() => h.plugin.exporter.requests.length === 2);
    h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
    const human = rebuildPdf(h, "chapter.typ");

    // #when
    agentExport.resolve(encoder.encode("PDF-agent"));
    const agentReceipt = await agent;
    const prompted = await settleUntil(() => h.plugin.confirmations.length === 1);
    const humanReceipt = await human;

    // #then
    assert.deepEqual(
      {
        agentStarted,
        prompted,
        agentReceipt,
        humanReceipt,
        confirmations: h.plugin.confirmations.length,
        bytes: bytes(h.app, "chapter.pdf"),
      },
      {
        agentStarted: true,
        prompted: true,
        agentReceipt: { outcome: "superseded", generation: 2, pdfPath: "chapter.pdf", status: "building" },
        humanReceipt: { outcome: "published", generation: 3, pdfPath: "chapter.pdf", status: "current" },
        confirmations: 1,
        bytes: "PDF-human",
      },
    );
  } finally {
    agentExport.resolve(encoder.encode("PDF-agent"));
    h.close();
  }
});

test("an automatic rebuild supersedes an active agent rebuild without repeating a remembered decline", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("chapter.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"));
  try {
    await setEnabled(h, source.path, true);
    h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
    h.plugin.confirmationResults.push(false);
    await h.app.vault.emit("modify", source);
    const firstDeclined = await settleUntil(
      () =>
        h.plugin.confirmations.length === 1 &&
        h.feature.automaticPdfStatus?.(source.path) === "conflict",
    );
    h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-owned"));
    const agentExport = deferred<Uint8Array>();
    h.plugin.exporter.responses.push(agentExport.promise);
    const agent = rebuildPdf(h, source.path, { interactive: false });
    const agentStarted = await settleUntil(() => h.plugin.exporter.requests.length === 2);

    // #when
    h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
    await h.app.vault.emit("modify", source);
    agentExport.resolve(encoder.encode("PDF-agent"));
    const agentReceipt = await agent;
    const automaticSettled = await settleUntil(() => h.feature.automaticPdfStatus?.(source.path) === "conflict");

    // #then
    assert.deepEqual(
      {
        agentStarted,
        firstDeclined,
        automaticSettled,
        agentReceipt,
        confirmations: h.plugin.confirmations.length,
        bytes: bytes(h.app, "chapter.pdf"),
      },
      {
        agentStarted: true,
        firstDeclined: true,
        automaticSettled: true,
        agentReceipt: { outcome: "superseded", generation: 4, pdfPath: "chapter.pdf", status: "building" },
        confirmations: 1,
        bytes: "PDF-foreign",
      },
    );
  } finally {
    h.close();
  }
});

test("a default rebuild still asks once before replacing a foreign PDF", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  h.app.vault.binaryFiles.set("chapter.pdf", encoder.encode("PDF-foreign"));
  h.plugin.exporter.responses.push(encoder.encode("PDF-human"));
  h.plugin.confirmationResults.push(true);
  try {
    // #when
    const receipt = await rebuildPdf(h, "chapter.typ");

    // #then
    assert.deepEqual(
      { receipt, confirmations: h.plugin.confirmations.length, bytes: bytes(h.app, "chapter.pdf") },
      {
        receipt: { outcome: "published", generation: 1, pdfPath: "chapter.pdf", status: "current" },
        confirmations: 1,
        bytes: "PDF-human",
      },
    );
  } finally {
    h.close();
  }
});

test("an agent rebuild is busy while a rename-collision confirmation remains open", async () => {
  // #given
  const h = await harness();
  const source = h.addSource("old.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-renamed"));
  const permission = deferred<boolean>();
  try {
    await setEnabled(h, source.path, true);
    h.app.vault.binaryFiles.set("taken.pdf", encoder.encode("PDF-foreign"));
    h.plugin.confirmationResults.push(permission.promise);
    h.app.vault.files.delete("old.typ");
    h.app.vault.files.set("taken.typ", "= Renamed\n");
    source.path = "taken.typ";
    const renaming = h.app.vault.emit("rename", source, "old.typ");
    const prompted = await settleUntil(() => h.plugin.confirmations.length === 1);

    // #when
    const agentReceipt = await receiptWithin(rebuildPdf(h, source.path, { interactive: false }));
    const whilePrompted = {
      agentReceipt,
      confirmations: h.plugin.confirmations.length,
      bytes: bytes(h.app, "taken.pdf"),
      requests: h.plugin.exporter.requests.length,
      status: h.feature.automaticPdfStatus?.(source.path),
    };
    permission.resolve(true);
    await renaming;
    const published = await settleUntil(() => bytes(h.app, "taken.pdf") === "PDF-renamed");
    const completed = {
      bytes: bytes(h.app, "taken.pdf"),
      status: h.feature.automaticPdfStatus?.(source.path),
    };

    // #then
    assert.deepEqual(
      { prompted, whilePrompted, published, completed },
      {
        prompted: true,
        whilePrompted: {
          agentReceipt: { outcome: "busy", generation: 3, pdfPath: "taken.pdf", status: "current" },
          confirmations: 1,
          bytes: "PDF-foreign",
          requests: 1,
          status: "current",
        },
        published: true,
        completed: { bytes: "PDF-renamed", status: "current" },
      },
    );
  } finally {
    permission.resolve(true);
    h.close();
  }
});

test("an agent rebuild is cancelled when settings save advances its manual-only generation", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const exported = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(exported.promise);
  try {
    const rebuilding = rebuildPdf(h, "chapter.typ", { interactive: false });
    const exportStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);

    // #when
    await h.plugin.saveSettings();
    exported.resolve(encoder.encode("PDF-agent"));
    const receipt = await rebuilding;

    // #then
    assert.deepEqual(
      {
        exportStarted,
        receipt,
        bytes: bytes(h.app, "chapter.pdf"),
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      {
        exportStarted: true,
        receipt: { outcome: "cancelled", generation: 1, pdfPath: "chapter.pdf", status: "building" },
        bytes: null,
        status: "building",
      },
    );
  } finally {
    exported.resolve(encoder.encode("PDF-agent"));
    h.close();
  }
});

test("an agent rebuild is cancelled when its source is disabled during export", async () => {
  // #given
  const h = await harness();
  h.addSource("chapter.typ");
  const exported = deferred<Uint8Array>();
  h.plugin.exporter.responses.push(exported.promise);
  try {
    const rebuilding = rebuildPdf(h, "chapter.typ", { interactive: false });
    const exportStarted = await settleUntil(() => h.plugin.exporter.requests.length === 1);

    // #when
    await setEnabled(h, "chapter.typ", false);
    exported.resolve(encoder.encode("PDF-agent"));
    const receipt = await rebuilding;

    // #then
    assert.deepEqual(
      {
        exportStarted,
        receipt,
        bytes: bytes(h.app, "chapter.pdf"),
        status: h.feature.automaticPdfStatus?.("chapter.typ"),
      },
      {
        exportStarted: true,
        receipt: { outcome: "cancelled", generation: 1, pdfPath: "chapter.pdf", status: "missing" },
        bytes: null,
        status: "missing",
      },
    );
  } finally {
    exported.resolve(encoder.encode("PDF-agent"));
    h.close();
  }
});
