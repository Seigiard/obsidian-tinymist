import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PREVIEW_TEMPLATE, previewEntry } from "../src/preview/previewEntry";
import { LspClient, pathToUri } from "../src/lsp/client";

test("project preview entries stay within the vault and preserve source paths", () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-preview-"));
  try {
    const chapters = join(root, "course", "chapters");
    mkdirSync(chapters, { recursive: true });
    const source = join(chapters, "02-中文 & space.typ");
    assert.deepEqual(previewEntry(source, root), { filePath: source });
    const outer = join(root, PREVIEW_TEMPLATE);
    writeFileSync(outer, "");
    assert.deepEqual(previewEntry(source, root), {
      filePath: outer,
      sourceInput: "/course/chapters/02-中文 & space.typ",
    });
    const inner = join(root, "course", PREVIEW_TEMPLATE);
    writeFileSync(inner, "");
    assert.equal(previewEntry(source, root).filePath, inner);
    assert.deepEqual(previewEntry(inner, root), { filePath: inner });
    assert.throws(() => previewEntry(join(root + "-other", "a.typ"), root));
    assert.throws(() => previewEntry(root, root));
    // A template above a vault is never picked up.
    assert.deepEqual(previewEntry(source, chapters), { filePath: source });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LSP template preview compiles unsaved source and keeps completion", {
  skip: !process.env.TINYMIST_BIN,
  timeout: 20000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-live-preview-"));
  const source = join(root, "chapter.typ");
  const wrapper = join(root, PREVIEW_TEMPLATE);
  writeFileSync(source, "= Saved chapter\n");
  writeFileSync(wrapper, '#set text(fill: blue)\n#include sys.inputs.at("preview-source")\n');
  const diagnostics = new Map<string, unknown[]>();
  const lsp = new LspClient(process.env.TINYMIST_BIN!, root, uri => {
    diagnostics.set(uri, lsp.diagnostics(uri));
  });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for LSP diagnostics");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await lsp.start();
    lsp.didOpen(source, "#let broken = [");
    lsp.setPreviewSource("/chapter.typ");
    const result = await lsp.executeCommand<{ staticServerPort: number }>(
      "tinymist.doStartPreview",
      [["--task-id", "chapter-test", "--data-plane-host", "127.0.0.1:0", wrapper]],
    );
    assert.ok(result.staticServerPort);
    await waitFor(() => (diagnostics.get(pathToUri(source))?.length ?? 0) > 0);
    assert.ok(!(diagnostics.get(pathToUri(wrapper))?.length));
    lsp.didChange(source, "#text[Unsaved chapter]");
    await waitFor(() => diagnostics.get(pathToUri(source))?.length === 0);
    const completion = await lsp.completion(source, { line: 0, character: 3 }) as {
      items?: unknown[];
    } | unknown[];
    assert.ok(Array.isArray(completion) ? completion.length : completion?.items?.length);
    await lsp.executeCommand("tinymist.doKillPreview", ["chapter-test"]);
    lsp.setPreviewSource();
  } finally {
    lsp.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});
