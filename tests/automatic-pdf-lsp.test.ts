import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client";
import TinymistPlugin from "../src/main";
import { testApp } from "./support/obsidian";
import { pdfMetadataTitle } from "./support/pdf-metadata";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

interface PdfExportClient {
  exportPdf?: (path: string) => Promise<{ data?: string; path?: string } | null>;
}

interface AutomaticPdfExporter {
  exportPdf(request: { entryPath: string; root: string; sourceInput?: string }): Promise<Uint8Array>;
  stop(): void;
}

interface AutomaticPdfExporterFactory {
  createAutomaticPdfExporter?: () => AutomaticPdfExporter;
}

interface NativeExporterInspection {
  client?: LspClient | null;
}

interface ServerInfo {
  primary?: { inputs?: Record<string, string> };
}

async function exportTitle(
  exporter: AutomaticPdfExporter | undefined,
  request: { entryPath: string; root: string; sourceInput?: string },
): Promise<string> {
  if (!exporter) return "missing-exporter";
  try {
    return pdfMetadataTitle(await exporter.exportPdf(request)) ?? "missing-title";
  } catch {
    return "rejected";
  }
}

async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("native PDF export returns in-memory bytes and creates no sibling file", { skip: !BIN && "tinymist not found", timeout: 30000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "tinymist-pdf-export-"));
  const source = join(root, "chapter.typ");
  writeFileSync(source, "= Native PDF export\n");
  const lsp = new LspClient(BIN!, root, () => {});
  try {
    await lsp.start();

    // #when
    const result = await (lsp as unknown as PdfExportClient).exportPdf?.(source);

    // #then
    assert.deepEqual(
      {
        dataPrefix: result?.data ? Buffer.from(result.data, "base64").subarray(0, 8).toString("ascii") : null,
        sourceSiblingExists: existsSync(join(root, "chapter.pdf")),
        files: readdirSync(root).sort(),
      },
      {
        dataPrefix: "%PDF-1.7",
        sourceSiblingExists: false,
        files: ["chapter.typ"],
      },
    );
  } finally {
    lsp.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("default plugin exporter keeps the primary preview input isolated across wrapper and direct exports", { skip: !BIN && "tinymist not found", timeout: 30000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "tinymist-default-pdf-export-"));
  const wrapper = join(root, ".tinymist-preview.typ");
  const selected = join(root, "selected.typ");
  const direct = join(root, "direct.typ");
  writeFileSync(wrapper, "#include sys.inputs.at(\"preview-source\")\n");
  writeFileSync(selected, "#set document(title: \"WRAPPER-SELECTED\")\n= Selected source\n");
  writeFileSync(
    direct,
    "#let marker = sys.inputs.at(\"preview-source\", default: \"DIRECT-CLEAR\")\n#set document(title: marker)\n= #marker\n",
  );
  const app = testApp(root);
  const plugin = new TinymistPlugin(app as never, {} as never);
  plugin.settings = { ...plugin.settings, binaryPath: BIN! };
  const primary = new LspClient(BIN!, root, () => {});
  plugin.lsp = primary;
  let exporter: AutomaticPdfExporter | undefined;
  try {
    await primary.start();
    primary.setPreviewSource("/sentinel.typ");
    const before = await primary.executeCommand<ServerInfo>("tinymist.getServerInfo", []);
    exporter = (plugin as unknown as AutomaticPdfExporterFactory).createAutomaticPdfExporter?.();

    // #when
    const wrapperPdf = await exporter?.exportPdf({ entryPath: wrapper, root, sourceInput: "/selected.typ" });
    const directPdf = await exporter?.exportPdf({ entryPath: direct, root });
    const after = await primary.executeCommand<ServerInfo>("tinymist.getServerInfo", []);

    // #then
    assert.deepEqual(
      {
        wrapperHeader: wrapperPdf ? Buffer.from(wrapperPdf).subarray(0, 8).toString("ascii") : null,
        directHeader: directPdf ? Buffer.from(directPdf).subarray(0, 8).toString("ascii") : null,
        wrapperTitle: pdfMetadataTitle(wrapperPdf),
        directTitle: pdfMetadataTitle(directPdf),
        primaryBefore: before?.primary?.inputs?.["preview-source"] ?? null,
        primaryAfter: after?.primary?.inputs?.["preview-source"] ?? null,
        files: readdirSync(root).sort(),
      },
      {
        wrapperHeader: "%PDF-1.7",
        directHeader: "%PDF-1.7",
        wrapperTitle: "WRAPPER-SELECTED",
        directTitle: "DIRECT-CLEAR",
        primaryBefore: "/sentinel.typ",
        primaryAfter: "/sentinel.typ",
        files: [".tinymist-preview.typ", "direct.typ", "selected.typ"],
      },
    );
  } finally {
    exporter?.stop();
    plugin.lsp = null;
    primary.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("default native exporter reads fresh direct, wrapper, and dependency bytes and recovers after invalid source", { skip: !BIN && "tinymist not found", timeout: 45000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "tinymist-fresh-pdf-export-"));
  const direct = join(root, "direct.typ");
  const wrapper = join(root, ".tinymist-preview.typ");
  const selected = join(root, "selected.typ");
  const dependencyEntry = join(root, "dependency.typ");
  const dependency = join(root, "marker.txt");
  writeFileSync(direct, "#set document(title: \"DIRECT-V1\")\n= Direct\n");
  writeFileSync(
    wrapper,
    "#let source = sys.inputs.at(\"preview-source\")\n#set document(title: read(source).trim())\n#include source\n",
  );
  writeFileSync(selected, "WRAPPER-V1\n");
  writeFileSync(dependencyEntry, "#set document(title: read(\"marker.txt\").trim())\n= Dependency\n");
  writeFileSync(dependency, "DEPENDENCY-V1\n");
  const app = testApp(root);
  const plugin = new TinymistPlugin(app as never, {} as never);
  plugin.settings = { ...plugin.settings, binaryPath: BIN! };
  const primary = new LspClient(BIN!, root, () => {});
  plugin.lsp = primary;
  let exporter: AutomaticPdfExporter | undefined;
  try {
    await primary.start();
    primary.setPreviewSource("/primary-sentinel.typ");
    const before = await primary.executeCommand<ServerInfo>("tinymist.getServerInfo", []);
    exporter = (plugin as unknown as AutomaticPdfExporterFactory).createAutomaticPdfExporter?.();
    const directV1 = await exportTitle(exporter, { entryPath: direct, root });
    writeFileSync(direct, "#set document(title: \"DIRECT-V2\")\n= Direct\n");
    const directV2 = await exportTitle(exporter, { entryPath: direct, root });
    const wrapperV1 = await exportTitle(exporter, { entryPath: wrapper, root, sourceInput: "/selected.typ" });
    writeFileSync(selected, "WRAPPER-V2\n");
    const wrapperV2 = await exportTitle(exporter, { entryPath: wrapper, root, sourceInput: "/selected.typ" });
    const dependencyV1 = await exportTitle(exporter, { entryPath: dependencyEntry, root });
    writeFileSync(dependency, "DEPENDENCY-V2\n");
    const dependencyV2 = await exportTitle(exporter, { entryPath: dependencyEntry, root });

    // #when
    writeFileSync(direct, "#let unfinished = (\n");
    const invalidResult = await exportTitle(exporter, { entryPath: direct, root });
    writeFileSync(direct, "#set document(title: \"DIRECT-V3\")\n= Direct recovered\n");
    const recovered = await exportTitle(exporter, { entryPath: direct, root });
    const after = await primary.executeCommand<ServerInfo>("tinymist.getServerInfo", []);

    // #then
    assert.deepEqual(
      {
        direct: [directV1, directV2],
        wrapper: [wrapperV1, wrapperV2],
        dependency: [dependencyV1, dependencyV2],
        invalidResult,
        recovered,
        primaryBefore: before?.primary?.inputs?.["preview-source"] ?? null,
        primaryAfter: after?.primary?.inputs?.["preview-source"] ?? null,
        files: readdirSync(root).sort(),
      },
      {
        direct: ["DIRECT-V1", "DIRECT-V2"],
        wrapper: ["WRAPPER-V1", "WRAPPER-V2"],
        dependency: ["DEPENDENCY-V1", "DEPENDENCY-V2"],
        invalidResult: "rejected",
        recovered: "DIRECT-V3",
        primaryBefore: "/primary-sentinel.typ",
        primaryAfter: "/primary-sentinel.typ",
        files: [".tinymist-preview.typ", "dependency.typ", "direct.typ", "marker.txt", "selected.typ"],
      },
    );
  } finally {
    exporter?.stop();
    plugin.lsp = null;
    primary.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("default native exporter recovers after its active process dies", { skip: !BIN && "tinymist not found", timeout: 20000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "tinymist-recover-pdf-export-"));
  const source = join(root, "chapter.typ");
  writeFileSync(
    source,
    '#set document(title: "INTERRUPTED")\n#let total = range(2000000).fold(0, (sum, value) => sum + value)\n= #total\n',
  );
  const app = testApp(root);
  const plugin = new TinymistPlugin(app as never, {} as never);
  plugin.settings = { ...plugin.settings, binaryPath: BIN! };
  const primary = new LspClient(BIN!, root, () => {});
  plugin.lsp = primary;
  let exporter: AutomaticPdfExporter | undefined;
  let laterExport: Promise<string> | null = null;
  try {
    await primary.start();
    exporter = (plugin as unknown as AutomaticPdfExporterFactory).createAutomaticPdfExporter?.();
    const primaryPid = primary.pid;

    // #when
    let interruptedSettled = false;
    const interruptedExport = exportTitle(exporter, { entryPath: source, root }).finally(() => {
      interruptedSettled = true;
    });
    let interruptedPid: number | null = null;
    const faultInjected = await waitUntil(() => {
      const client = (exporter as unknown as NativeExporterInspection).client;
      const pid = client?.pid ?? null;
      if (pid === null || client?.status !== "running" || interruptedSettled) return false;
      process.kill(pid, "SIGKILL");
      interruptedPid = pid;
      return true;
    });
    const interruptedOutcome = await interruptedExport;
    writeFileSync(source, '#set document(title: "RECOVERED-CLIENT")\n= Recovery\n');
    laterExport = exportTitle(exporter, { entryPath: source, root });
    const outcome = await Promise.race([
      laterExport,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    const finalOwnedPid = (exporter as unknown as NativeExporterInspection).client?.pid ?? null;
    exporter?.stop();
    await laterExport;
    const ownedProcessesStopped = await waitUntil(
      () =>
        interruptedPid !== null &&
        !processIsAlive(interruptedPid) &&
        (finalOwnedPid === null || !processIsAlive(finalOwnedPid)),
    );

    // #then
    assert.deepEqual(
      {
        faultInjected,
        interruptedOutcome,
        outcome,
        primaryPidBefore: primaryPid,
        primaryPidAfter: primary.pid,
        primaryStatus: primary.status,
        ownedProcessesStopped,
        files: readdirSync(root).sort(),
      },
      {
        faultInjected: true,
        interruptedOutcome: "rejected",
        outcome: "RECOVERED-CLIENT",
        primaryPidBefore: primaryPid,
        primaryPidAfter: primaryPid,
        primaryStatus: "running",
        ownedProcessesStopped: true,
        files: ["chapter.typ"],
      },
    );
  } finally {
    exporter?.stop();
    if (laterExport) await laterExport;
    plugin.lsp = null;
    primary.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});
