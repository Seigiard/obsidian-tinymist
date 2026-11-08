import "./support/dom";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeAutomaticPdfExporter } from "../src/automatic-pdf";
import type { LspClient } from "../src/lsp/client";
import TinymistPlugin from "../src/main";
import { Notice, TFile, type TestApp, testApp } from "./support/obsidian";
import { nodeFixture } from "./support/nodeFixture";

const encoder = new TextEncoder();

interface MarkdownExportRequest {
  entryPath: string;
  root: string;
  sourceInput?: string;
  open?: (client: LspClient) => { close(): void };
}

interface ExportClientCall {
  method: "didOpen" | "didChange" | "didClose";
  path: string;
  text?: string;
}

interface DeferredExport {
  promise: Promise<Uint8Array>;
  resolve(bytes: Uint8Array): void;
}

function deferredExport(): DeferredExport {
  let resolve!: (bytes: Uint8Array) => void;
  const promise = new Promise<Uint8Array>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class RecordingExportClient {
  readonly calls: ExportClientCall[] = [];

  didOpen(path: string, text: string): void {
    this.calls.push({ method: "didOpen", path, text });
  }

  didChange(path: string, text: string): void {
    this.calls.push({ method: "didChange", path, text });
  }

  didClose(path: string): void {
    this.calls.push({ method: "didClose", path });
  }
}

class ControlledExporter {
  readonly requests: MarkdownExportRequest[] = [];
  readonly responses: Array<Uint8Array | Error | Promise<Uint8Array>> = [];
  openClient: RecordingExportClient | null = null;

  async exportPdf(request: MarkdownExportRequest): Promise<Uint8Array> {
    this.requests.push(request);
    const handle = this.openClient && request.open?.(this.openClient as never);
    try {
      const response = this.responses.shift() ?? encoder.encode("PDF-default");
      if (response instanceof Error) throw response;
      return response;
    } finally {
      handle?.close();
    }
  }

  stop(): void {}
}

class TestPlugin extends TinymistPlugin {
  readonly exporter = new ControlledExporter();
  readonly confirmations: unknown[] = [];
  readonly confirmationResults: boolean[] = [];

  createAutomaticPdfExporter(): ControlledExporter {
    return this.exporter;
  }

  async confirmAutomaticPdfReplace(request: unknown): Promise<boolean> {
    this.confirmations.push(request);
    return this.confirmationResults.shift() ?? true;
  }

  async startLsp(_restart: boolean): Promise<void> {}
}

interface Harness {
  root: string;
  app: TestApp;
  plugin: TestPlugin;
  note(path: string, text?: string): TFile;
  typst(path: string): TFile;
  close(): void;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "automatic-pdf-markdown-"));
  const app = testApp(root);
  const plugin = new TestPlugin(app as never, {});
  await plugin.onload();
  return {
    root,
    app,
    plugin,
    note(path, text = "---\ntypst: true\n---\n= Note\n") {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      app.vault.files.set(path, text);
      app.metadataCache.setFrontmatter(path, { typst: true });
      return new TFile(path);
    },
    typst(path) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "= Typst\n");
      app.vault.files.set(path, "= Typst\n");
      return new TFile(path);
    },
    close() {
      plugin.onunload();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function settleUntil(predicate: () => boolean, timeout = 1200): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function bytes(app: TestApp, path: string): string | null {
  const value = app.vault.binaryFiles.get(path);
  return value ? new TextDecoder().decode(value) : null;
}

test("manual Markdown rebuild supplies the converted virtual source to the exporter", async () => {
  // #given
  const h = await harness();
  h.note("Notes/A.md");
  h.plugin.exporter.responses.push(encoder.encode("PDF-note"));

  // #when
  const receipt = await h.plugin.rebuildPdf("Notes/A.md");

  // #then
  try {
    const request = h.plugin.exporter.requests[0];
    assert.deepEqual(
      {
        request: request && {
          entryPath: request.entryPath,
          root: request.root,
          sourceInput: request.sourceInput,
          hasOpen: typeof request.open === "function",
        },
        receipt,
        pdf: bytes(h.app, "Notes/A.pdf"),
      },
      {
        request: {
          entryPath: join(h.root, "Notes/A.md.typ"),
          root: h.root,
          sourceInput: undefined,
          hasOpen: true,
        },
        receipt: { outcome: "published", generation: 1, pdfPath: "Notes/A.pdf", status: "current" },
        pdf: "PDF-note",
      },
    );
  } finally {
    h.close();
  }
});

test("automatic Markdown export rebuilds saves and declines a foreign sibling PDF", async () => {
  // #given
  const h = await harness();
  const note = h.note("Notes/A.md");
  h.plugin.exporter.responses.push(encoder.encode("PDF-owned"), encoder.encode("PDF-saved"));
  h.plugin.confirmationResults.push(false);

  // #when
  await h.plugin.setAutomaticPdf(note.path, true);
  await h.app.vault.emit("modify", note);
  const rebuilt = await settleUntil(() => bytes(h.app, "Notes/A.pdf") === "PDF-saved");
  h.app.vault.binaryFiles.set("Notes/A.pdf", encoder.encode("PDF-foreign"));
  await h.app.vault.emit("modify", note);
  const conflicted = await settleUntil(() => h.plugin.automaticPdfStatus(note.path) === "conflict");

  // #then
  try {
    assert.deepEqual(
      {
        rebuilt,
        conflicted,
        openCallbacks: h.plugin.exporter.requests.map((request) => typeof request.open === "function"),
        ownedHash: h.app.pluginData.automaticPdf as unknown,
        confirmations: h.plugin.confirmations.length,
        status: h.plugin.automaticPdfStatus(note.path),
        pdf: bytes(h.app, "Notes/A.pdf"),
      },
      {
        rebuilt: true,
        conflicted: true,
        openCallbacks: [true, true],
        ownedHash: {
          entries: {
            "Notes/A.md": {
              enabled: true,
              destinationPath: "Notes/A.pdf",
              ownedHash: "b530ed9be89e3da19d307b556fbff5eec70563b3bd09eca470fd899f9ee1383f",
              ownedPath: "Notes/A.pdf",
              declinedPath: "Notes/A.pdf",
              declinedHash: "7629f3295eb0d48e990445bc1d7561fdfa32c2d2699b3f713cd0dfa876bab5ec",
            },
          },
        },
        confirmations: 1,
        status: "conflict",
        pdf: "PDF-foreign",
      },
    );
  } finally {
    h.close();
  }
});

test("automatic export refuses a Markdown source whose PDF destination is already enabled", async () => {
  // #given
  const h = await harness();
  h.typst("Notes/A.typ");
  h.note("Notes/A.md");
  h.plugin.exporter.responses.push(encoder.encode("PDF-typst"));
  Notice.shown.length = 0;

  // #when
  await h.plugin.setAutomaticPdf("Notes/A.typ", true);
  await h.plugin.setAutomaticPdf("Notes/A.md", true);

  // #then
  try {
    assert.deepEqual(
      {
        enabled: [h.plugin.automaticPdfEnabled("Notes/A.typ"), h.plugin.automaticPdfEnabled("Notes/A.md")],
        storedPaths: Object.keys((h.app.pluginData.automaticPdf as { entries: object }).entries).sort(),
        notices: [...Notice.shown],
      },
      {
        enabled: [true, false],
        storedPaths: ["Notes/A.typ"],
        notices: ["Automatic PDF export for Notes/A.typ already writes Notes/A.pdf."],
      },
    );
  } finally {
    h.close();
  }
});

test("automatic export refuses the reverse same-destination source order", async () => {
  // #given
  const h = await harness();
  h.note("Notes/A.md");
  h.typst("Notes/A.typ");
  h.plugin.exporter.responses.push(encoder.encode("PDF-note"));
  Notice.shown.length = 0;

  // #when
  await h.plugin.setAutomaticPdf("Notes/A.md", true);
  await h.plugin.setAutomaticPdf("Notes/A.typ", true);

  // #then
  try {
    assert.deepEqual(
      {
        enabled: [h.plugin.automaticPdfEnabled("Notes/A.md"), h.plugin.automaticPdfEnabled("Notes/A.typ")],
        storedPaths: Object.keys((h.app.pluginData.automaticPdf as { entries: object }).entries).sort(),
        notices: [...Notice.shown],
      },
      {
        enabled: [true, false],
        storedPaths: ["Notes/A.md"],
        notices: ["Automatic PDF export for Notes/A.md already writes Notes/A.pdf."],
      },
    );
  } finally {
    h.close();
  }
});

test("a fatal Markdown conversion fails without exporting a virtual-address notice", async () => {
  // #given
  const h = await harness();
  h.note("Notes/A.md", "---\ntypst: true\ntypst-template: unavailable\n---\n= Note\n");
  Notice.shown.length = 0;

  // #when
  const receipt = await h.plugin.rebuildPdf("Notes/A.md");
  const stored = JSON.stringify(h.app.pluginData.automaticPdf ?? {});

  // #then
  try {
    assert.deepEqual(
      {
        receipt,
        requests: h.plugin.exporter.requests.length,
        notices: [...Notice.shown],
        virtualAddressMentioned: stored.includes(".md.typ") || Notice.shown.some((notice) => notice.includes(".md.typ")),
      },
      {
        receipt: { outcome: "failed", generation: 1, pdfPath: "Notes/A.pdf", status: "error" },
        requests: 0,
        notices: ["PDF export failed for Notes/A.md: Unknown Typst template unavailable (line 3)"],
        virtualAddressMentioned: false,
      },
    );
  } finally {
    h.close();
  }
});

test("each manual rebuild repeats the fatal Markdown conversion notice", async () => {
  // #given
  const h = await harness();
  h.note("Notes/A.md", "---\ntypst: true\ntypst-template: unavailable\n---\n= Note\n");
  Notice.shown.length = 0;

  // #when
  const first = await h.plugin.rebuildPdf("Notes/A.md");
  const second = await h.plugin.rebuildPdf("Notes/A.md");

  // #then
  try {
    assert.deepEqual(
      { first, second, notices: [...Notice.shown] },
      {
        first: { outcome: "failed", generation: 1, pdfPath: "Notes/A.pdf", status: "error" },
        second: { outcome: "failed", generation: 2, pdfPath: "Notes/A.pdf", status: "error" },
        notices: [
          "PDF export failed for Notes/A.md: Unknown Typst template unavailable (line 3)",
          "PDF export failed for Notes/A.md: Unknown Typst template unavailable (line 3)",
        ],
      },
    );
  } finally {
    h.close();
  }
});

test("an automatic save keeps the fatal Markdown conversion notice latched", async () => {
  // #given
  const h = await harness();
  const note = h.note("Notes/A.md", "---\ntypst: true\ntypst-template: unavailable\n---\n= Note\n");
  Notice.shown.length = 0;
  await h.plugin.setAutomaticPdf(note.path, true);

  // #when
  await h.app.vault.emit("modify", note);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // #then
  try {
    assert.deepEqual(
      { status: h.plugin.automaticPdfStatus(note.path), notices: [...Notice.shown] },
      {
        status: "error",
        notices: ["PDF export failed for Notes/A.md: Unknown Typst template unavailable (line 3)"],
      },
    );
  } finally {
    h.close();
  }
});

test("a Markdown export failure reports the note path and never stores its virtual address", async () => {
  // #given
  const h = await harness();
  h.note("Notes/A.md");
  h.plugin.exporter.responses.push(new Error(`${join(h.root, "Notes/A.md.typ")}:5: unknown variable`));
  Notice.shown.length = 0;

  // #when
  const receipt = await h.plugin.rebuildPdf("Notes/A.md");
  const stored = JSON.stringify(h.app.pluginData.automaticPdf ?? {});

  // #then
  try {
    assert.deepEqual(
      {
        receipt,
        hasOpen: typeof h.plugin.exporter.requests[0]?.open === "function",
        notices: [...Notice.shown],
        virtualAddressMentioned: stored.includes(".md.typ") || Notice.shown.some((notice) => notice.includes(".md.typ")),
      },
      {
        receipt: { outcome: "failed", generation: 1, pdfPath: "Notes/A.pdf", status: "error" },
        hasOpen: true,
        notices: ["PDF export failed for Notes/A.md: Notes/A.md:5: unknown variable"],
        virtualAddressMentioned: false,
      },
    );
  } finally {
    h.close();
  }
});

test("an externally changed held Markdown note opens its current file text for automatic export", async () => {
  // #given
  const h = await harness();
  const note = h.note("Notes/A.md", "---\ntypst: true\n---\n= Old heading\n");
  const held = await h.plugin.sources.hold(note.path);
  assert.ok(held, "expected the preview holder to keep the Markdown source alive");
  const client = new RecordingExportClient();
  h.plugin.exporter.openClient = client;
  await h.plugin.setAutomaticPdf(note.path, true);
  client.calls.splice(0);
  const updated = "---\ntypst: true\n---\n= New heading\n";
  writeFileSync(join(h.root, note.path), updated);
  h.app.vault.files.set(note.path, updated);

  // #when
  await h.app.vault.emit("modify", note);
  const rebuilt = await settleUntil(() => client.calls.some((call) => call.method === "didOpen"));

  // #then
  try {
    assert.deepEqual(
      {
        rebuilt,
        currentHeadingOpened: client.calls.some((call) => call.text?.includes("= New heading")),
        staleHeadingOpened: client.calls.some((call) => call.text?.includes("= Old heading")),
      },
      { rebuilt: true, currentHeadingOpened: true, staleHeadingOpened: false },
    );
  } finally {
    held.release();
    h.close();
  }
});

test("an automatic export keeps its published PDF when a held Markdown note stops being a Typst source", async () => {
  // #given
  const h = await harness();
  const note = h.note("Notes/A.md");
  const held = await h.plugin.sources.hold(note.path);
  assert.ok(held, "expected the preview holder to keep the Markdown source alive");
  h.plugin.exporter.responses.push(encoder.encode("PDF-published"));
  await h.plugin.setAutomaticPdf(note.path, true);
  h.app.vault.binaryWrites.splice(0);
  Notice.shown.length = 0;
  const noLongerSource = "---\n---\n= No longer a source\n";
  writeFileSync(join(h.root, note.path), noLongerSource);
  h.app.vault.files.set(note.path, noLongerSource);
  h.app.metadataCache.setFrontmatter(note.path, {});

  // #when
  await h.app.vault.emit("modify", note);
  const settled = await settleUntil(() => h.plugin.automaticPdfStatus(note.path) !== "building");

  // #then
  try {
    const notices = [...Notice.shown];
    assert.deepEqual(
      {
        settled,
        writes: h.app.vault.binaryWrites.map(({ path }) => path),
        status: h.plugin.automaticPdfStatus(note.path),
        pdf: bytes(h.app, "Notes/A.pdf"),
        noticeNamesNote: notices.some((notice) => notice.includes("Notes/A.md")),
        noticeNamesCause: notices.some((notice) => notice.includes("the note is no longer a Typst source")),
      },
      {
        settled: true,
        writes: [],
        status: "error",
        pdf: "PDF-published",
        noticeNamesNote: true,
        noticeNamesCause: true,
      },
    );
  } finally {
    held.release();
    h.close();
  }
});

test("a completed export does not replace a PDF after its held Markdown note stops being a Typst source", async () => {
  // #given
  const h = await harness();
  const note = h.note("Notes/A.md");
  const held = await h.plugin.sources.hold(note.path);
  assert.ok(held, "expected the preview holder to keep the Markdown source alive");
  h.plugin.exporter.responses.push(encoder.encode("PDF-X"));
  await h.plugin.rebuildPdf(note.path);
  const pending = deferredExport();
  h.plugin.exporter.responses.push(pending.promise);
  h.app.vault.binaryWrites.splice(0);
  Notice.shown.length = 0;

  // #when
  const rebuilding = h.plugin.rebuildPdf(note.path);
  const exportStarted = await settleUntil(() => h.plugin.exporter.requests.length === 2);
  const noLongerSource = "---\n---\n= No longer a source\n";
  writeFileSync(join(h.root, note.path), noLongerSource);
  h.app.vault.files.set(note.path, noLongerSource);
  pending.resolve(encoder.encode("PDF-Y"));
  const receipt = await rebuilding;

  // #then
  try {
    const notices = [...Notice.shown];
    assert.deepEqual(
      {
        exportStarted,
        receipt,
        writes: h.app.vault.binaryWrites.map(({ path, data }) => ({ path, data: new TextDecoder().decode(data) })),
        status: h.plugin.automaticPdfStatus(note.path),
        pdf: bytes(h.app, "Notes/A.pdf"),
        noticeNamesNote: notices.some((notice) => notice.includes("Notes/A.md")),
        noticeNamesCause: notices.some((notice) => notice.includes("the note is no longer a Typst source")),
      },
      {
        exportStarted: true,
        receipt: { outcome: "failed", generation: 2, pdfPath: "Notes/A.pdf", status: "error" },
        writes: [],
        status: "error",
        pdf: "PDF-X",
        noticeNamesNote: true,
        noticeNamesCause: true,
      },
    );
  } finally {
    held.release();
    h.close();
  }
});

test("native export opens the virtual document before export and closes it before stop", async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "automatic-pdf-open-order-"));
  const log = join(root, "lsp.log");
  const binary = join(root, "fake-tinymist.cjs");
  writeFileSync(binary, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
let buffer = Buffer.alloc(0);
const write = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
};
const receive = (message) => {
  appendFileSync(process.env.AUTOMATIC_PDF_LSP_LOG, message.method + "\\n");
  if (message.method === "initialize") write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  if (message.method === "workspace/executeCommand") write({ jsonrpc: "2.0", id: message.id, result: { data: Buffer.from("%PDF-fake").toString("base64") } });
  if (message.method === "shutdown") write({ jsonrpc: "2.0", id: message.id, result: null });
  if (message.method === "exit") process.exit(0);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf("\\r\\n\\r\\n");
    if (split < 0) return;
    const header = buffer.subarray(0, split).toString();
    const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1]);
    const start = split + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length);
    buffer = buffer.subarray(start + length);
    receive(JSON.parse(body.toString()));
  }
});
`);
  chmodSync(binary, 0o755);
  const exporter = new NativeAutomaticPdfExporter(binary, root);
  const request = {
    entryPath: join(root, "Notes/A.md.typ"),
    root,
    sourceInput: "/Notes/A.md",
    open: (client: LspClient) => {
      client.didOpen(join(root, "Notes/A.md.typ"), "= Converted note");
      return { close: () => client.didClose(join(root, "Notes/A.md.typ")) };
    },
  };
  const previousLog = process.env.AUTOMATIC_PDF_LSP_LOG;
  process.env.AUTOMATIC_PDF_LSP_LOG = log;
  const restoreSpawn = nodeFixture(binary);

  // #when
  try {
    const pdf = await exporter.exportPdf(request);
    const stopped = await settleUntil(() => existsSync(log) && readFileSync(log, "utf8").includes("exit\n"));

    // #then
    assert.deepEqual(
      {
        pdf: new TextDecoder().decode(pdf),
        stopped,
        calls: readFileSync(log, "utf8").trim().split("\n"),
      },
      {
        pdf: "%PDF-fake",
        stopped: true,
        calls: [
          "initialize",
          "initialized",
          "workspace/didChangeConfiguration",
          "textDocument/didOpen",
          "workspace/executeCommand",
          "textDocument/didClose",
          "shutdown",
          "exit",
        ],
      },
    );
  } finally {
    exporter.stop();
    await restoreSpawn();
    if (previousLog === undefined) delete process.env.AUTOMATIC_PDF_LSP_LOG;
    else process.env.AUTOMATIC_PDF_LSP_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});
