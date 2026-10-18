import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

interface PdfExportClient {
  exportPdf?: (path: string) => Promise<{ data?: string; path?: string } | null>;
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
