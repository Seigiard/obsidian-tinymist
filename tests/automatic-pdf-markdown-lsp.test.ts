import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import TinymistPlugin from "../src/main";
import { type TestApp, testApp } from "./support/obsidian";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", path.join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

class NativePdfPlugin extends TinymistPlugin {
  async startLsp(_restart: boolean): Promise<void> {}
}

function vaultFiles(root: string, relativePath = ""): string[] {
  const directory = path.join(root, relativePath);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(relativePath, entry.name);
    return entry.isDirectory() ? vaultFiles(root, relative) : [relative];
  }).sort();
}

function writePdfToVault(root: string, app: TestApp): void {
  const createBinary = app.vault.createBinary.bind(app.vault);
  app.vault.createBinary = async (vaultPath, data) => {
    const result = await createBinary(vaultPath, data);
    mkdirSync(path.join(root, vaultPath, ".."), { recursive: true });
    writeFileSync(path.join(root, vaultPath), Buffer.from(data));
    return result;
  };
  const modifyBinary = app.vault.modifyBinary.bind(app.vault);
  app.vault.modifyBinary = async (file, data) => {
    await modifyBinary(file, data);
    writeFileSync(path.join(root, file.path), Buffer.from(data));
  };
}

test("native Markdown rebuild writes only its sibling PDF", { skip: !BIN && "tinymist not found", timeout: 45000 }, async () => {
  // #given
  const root = mkdtempSync(path.join(tmpdir(), "automatic-pdf-markdown-lsp-"));
  const note = "Notes/A.md";
  mkdirSync(path.join(root, "Notes"), { recursive: true });
  writeFileSync(path.join(root, note), "---\ntypst: true\n---\n= Exported note\n");
  const app = testApp(root);
  app.vault.files.set(note, "---\ntypst: true\n---\n= Exported note\n");
  app.metadataCache.setFrontmatter(note, { typst: true });
  writePdfToVault(root, app);
  const plugin = new NativePdfPlugin(app as never, {});
  await plugin.onload();
  plugin.settings = { ...plugin.settings, binaryPath: BIN! };
  const before = vaultFiles(root);

  // #when
  const receipt = await plugin.rebuildPdf(note);
  const after = vaultFiles(root);

  // #then
  try {
    assert.deepEqual(
      {
        receipt,
        pdfExists: existsSync(path.join(root, "Notes/A.pdf")),
        header: existsSync(path.join(root, "Notes/A.pdf")) ? readFileSync(path.join(root, "Notes/A.pdf")).subarray(0, 4).toString("ascii") : null,
        before,
        after,
      },
      {
        receipt: { outcome: "published", generation: 1, pdfPath: "Notes/A.pdf", status: "current" },
        pdfExists: true,
        header: "%PDF",
        before: ["Notes/A.md"],
        after: ["Notes/A.md", "Notes/A.pdf"],
      },
    );
  } finally {
    plugin.onunload();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});
