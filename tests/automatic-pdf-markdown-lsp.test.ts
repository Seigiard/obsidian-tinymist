import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import TinymistPlugin from "../src/main";
import { type TestApp, testApp } from "./support/obsidian";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

class NativePdfPlugin extends TinymistPlugin {
  async startLsp(_restart: boolean): Promise<void> {}
}

function vaultFiles(root: string, path = ""): string[] {
  const directory = join(root, path);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(path, entry.name);
    return entry.isDirectory() ? vaultFiles(root, relative) : [relative];
  }).sort();
}

function writePdfToVault(root: string, app: TestApp): void {
  const createBinary = app.vault.createBinary.bind(app.vault);
  app.vault.createBinary = async (path, data) => {
    const result = await createBinary(path, data);
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), Buffer.from(data));
    return result;
  };
  const modifyBinary = app.vault.modifyBinary.bind(app.vault);
  app.vault.modifyBinary = async (file, data) => {
    await modifyBinary(file, data);
    writeFileSync(join(root, file.path), Buffer.from(data));
  };
}

test("native Markdown rebuild writes only its sibling PDF", { skip: !BIN && "tinymist not found", timeout: 45000 }, async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "automatic-pdf-markdown-lsp-"));
  const note = "Notes/A.md";
  mkdirSync(join(root, "Notes"), { recursive: true });
  writeFileSync(join(root, note), "---\ntypst: true\n---\n= Exported note\n");
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
        pdfExists: existsSync(join(root, "Notes/A.pdf")),
        header: existsSync(join(root, "Notes/A.pdf")) ? readFileSync(join(root, "Notes/A.pdf")).subarray(0, 4).toString("ascii") : null,
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
    rmSync(root, { recursive: true, force: true });
  }
});
