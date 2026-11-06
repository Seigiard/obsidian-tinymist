import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convert } from "./fixtures/markdown/convert";
import { compileSample } from "./fixtures/markdown/notes";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(existsSync);

test("C9: converted Markdown sample compiles with tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-compile-"));
  const output = join(directory, "sample.typ");
  writeFileSync(output, convert(compileSample, { templates: {}, defaultTemplate: "" }).typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
