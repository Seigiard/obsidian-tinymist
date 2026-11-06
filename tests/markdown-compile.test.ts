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

test("C13: a non-Typst fence with three backticks in its content compiles", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-fence-"));
  const output = join(directory, "sample.typ");
  const source = "---\ntypst: true\n---\n```js\nconst ticks = \"```\";\n```";
  writeFileSync(output, convert(source, { templates: {}, defaultTemplate: "" }).typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C22: a real template receives converted named arguments", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-template-"));
  const output = join(directory, "sample.typ");
  writeFileSync(
    join(directory, "template.typ"),
    '#let template(body, title: none, pages: none) = { assert(title == "Pilot" and pages == 2); body }',
  );
  writeFileSync(
    output,
    convert("---\ntypst: true\ntypst-template: echo\ntypst-title: Pilot\ntypst-pages: 2\n---\nBody", {
      templates: { echo: "template.typ" },
      defaultTemplate: "",
    }).typ,
  );
  try {
    // #when
    const compile = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(compile.status, 0, compile.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
