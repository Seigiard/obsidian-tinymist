import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { convert } from "../src/markdown/convert";
import { compileSample, constructCompileSample } from "./fixtures/markdown/notes";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(existsSync);

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function onePixelPng(): Buffer {
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const pixel = deflateSync(Buffer.from([0, 0, 0, 0, 255]));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixel),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

test("M1–M10/N3/N4: a note with every Markdown construct compiles with tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-constructs-"));
  const output = join(directory, "sample.typ");
  mkdirSync(join(directory, "image"));
  writeFileSync(join(directory, "image.png"), onePixelPng());
  const conversion = convert(constructCompileSample, { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.equal(conversion.typ.split("\n")[3], "#std.table(columns: 2, std.table.header([Die], [Result]),");
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

test("C70: a real template sets the PDF title from converted named arguments", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-template-"));
  const output = join(directory, "note.typ");
  copyFileSync(join(process.cwd(), "tests/fixtures/markdown/template.typ"), join(directory, "template.typ"));
  const conversion = convert("---\ntypst: true\ntypst-template: echo\ntypst-title: Pilot\ntypst-pages: 2\n---\nBody", {
    templates: { echo: "template.typ" },
    defaultTemplate: "",
  });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const compile = spawnSync(BIN!, ["compile", "note.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(compile.status, 0, compile.stderr);
    assert.deepEqual({ source: conversion.source, line: conversion.typ.split("\n")[3] }, { source: true, line: 'title: "Pilot",' });
    assert.match(readFileSync(join(directory, "note.pdf"), "latin1"), /Pilot-2/);
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

test("C78: parenthesized URLs compile with their stripped punctuation", { skip: !BIN && "tinymist not found", timeout: 120000 }, () => {
  // #given
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-parenthesized-url-"));
  const output = join(directory, "sample.typ");
  const source = "---\ntypst: true\n---\n(see https://example.com/a(b))\nhttps://x.y/a(b)*)";
  const conversion = convert(source, { templates: {}, defaultTemplate: "" });
  writeFileSync(output, conversion.typ);
  try {
    // #when
    const result = spawnSync(BIN!, ["compile", "sample.typ"], { cwd: directory, encoding: "utf8" });
    // #then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      { source: conversion.source, lines: conversion.typ.split("\n").slice(3) },
      { source: true, lines: ['(see #std.link("https://example.com/a(b)");)', '#std.link("https://x.y/a(b)");\\*)'] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
