import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convert } from "../src/markdown/convert";
import { compileSample } from "./fixtures/markdown/notes";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(existsSync);

test("C9: converted Markdown sample compiles with tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-compile-"));
  const output = join(directory, "sample.typ");
  const conversion = convert(compileSample, { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: "= Release notes" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C13: a non-Typst fence with three backticks in its content compiles", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-fence-"));
  const output = join(directory, "sample.typ");
  const source = "---\ntypst: true\n---\n```js\nconst ticks = \"```\";\n```";
  const conversion = convert(source, { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: "````js" });
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
  const conversion = convert("---\ntypst: true\ntypst-template: echo\ntypst-title: Pilot\ntypst-pages: 2\n---\nBody", {
    templates: { echo: "template.typ" },
    defaultTemplate: "",
  });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const compile = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(compile.status, 0, compile.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: 'title: "Pilot",' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C24: a converted note with a lone prose slash compiles", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-slash-"));
  const output = join(directory, "sample.typ");
  const conversion = convert("---\ntypst: true\n---\n/", { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: "\\/" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C27: an unclosed non-typ fence with a trailing backtick compiles", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-fence-tail-"));
  const output = join(directory, "sample.typ");
  const conversion = convert("---\ntypst: true\n---\n```js\nconst a = `x`", { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[4] }, { source: true, line: "const a = `x` ```" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C39: raw blocks with non-Identifier fence words compile without tag text", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-invalid-fence-word-"));
  const output = join(directory, "sample.typ");
  const source = "---\ntypst: true\n---\n```c++\nint x;\n```\n```c#\nint x;\n```\n```.net\nint x;\n```\n```1c\nint x;\n```";
  const conversion = convert(source, { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      { source: conversion.source, fenceLines: [3, 6, 9, 12].map((line) => conversion.typ.split("\n")[line]) },
      { source: true, fenceLines: ["```", "```", "```", "```"] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C52: a converted fill-in blank line compiles with literal delimiters", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-emphasis-run-"));
  const output = join(directory, "sample.typ");
  const conversion = convert("---\ntypst: true\n---\nName: ____ Date: ____", { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: "Name: \\_\\_\\_\\_ Date: \\_\\_\\_\\_" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
