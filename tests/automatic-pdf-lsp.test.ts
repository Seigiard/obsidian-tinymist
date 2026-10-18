import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client";
import TinymistPlugin from "../src/main";
import { testApp } from "./support/obsidian";

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

interface ServerInfo {
  primary?: { inputs?: Record<string, string> };
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("default plugin exporter keeps the primary preview input isolated across wrapper and direct exports", { skip: !BIN && "tinymist not found", timeout: 30000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "tinymist-default-pdf-export-"));
  const wrapper = join(root, ".tinymist-preview.typ");
  const selected = join(root, "selected.typ");
  const direct = join(root, "direct.typ");
  writeFileSync(wrapper, "#include sys.inputs.at(\"preview-source\")\n");
  writeFileSync(selected, "= Selected source\n");
  writeFileSync(direct, "= Direct source\n");
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
        primaryBefore: before?.primary?.inputs?.["preview-source"] ?? null,
        primaryAfter: after?.primary?.inputs?.["preview-source"] ?? null,
        files: readdirSync(root).sort(),
      },
      {
        wrapperHeader: "%PDF-1.7",
        directHeader: "%PDF-1.7",
        primaryBefore: "/sentinel.typ",
        primaryAfter: "/sentinel.typ",
        files: [".tinymist-preview.typ", "direct.typ", "selected.typ"],
      },
    );
  } finally {
    exporter?.stop();
    plugin.lsp = null;
    primary.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
