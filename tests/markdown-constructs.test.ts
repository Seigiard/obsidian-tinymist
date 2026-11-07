import assert from "node:assert/strict";
import { test } from "node:test";
import { convert } from "../src/markdown/convert";
import { sourceNote } from "./fixtures/markdown/notes";

test("M1/M7/M8/M10: vault-shaped tables use std.table with inline cells", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "| Die | Result |",
    "|-----|--------|",
    "| 1 | d4 (2) |",
    "| 2 | d6 (3) |",
    "",
    "| One | Two | Three | Four |",
    "| :-- | --- | ---: | :-: |",
    "| left\\|right | first<br>second | three | four |",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.table(columns: 2, std.table.header([Die], [Result]),",
    "",
    "[1], [d4 (2)],",
    "[2], [d6 (3)])",
    "",
    "#std.table(columns: 4, std.table.header([One], [Two], [Three], [Four]),",
    "",
    "[left|right], [first#std.linebreak()second], [three], [four])",
  ]);
});

test("M1: tables end at prose, allow missing trailing pipes, and normalize uneven rows", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "| Die | Result",
    "| --- | --- |",
    "| 1 |",
    "| 2 | d6 | extra |",
    "after the table",
    "| this is prose without a delimiter |",
    "",
    "| Left | Right |",
    "| --- | --- |",
    "following prose",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(
    { lines: conversion.typ.split("\n").slice(3), problems: conversion.problems },
    {
      lines: [
        "#std.table(columns: 2, std.table.header([Die], [Result]),",
        "",
        "[1], [],",
        "[2], [d6])",
        "after the table",
        "| this is prose without a delimiter |",
        "",
        "#std.table(columns: 2, std.table.header([Left], [Right]))",
        "",
        "following prose",
      ],
      problems: [{ line: 6, message: "Table row has 3 cells, the header has 2", fatal: false }],
    },
  );
});

test("M2/M9/M10: a callout lowercases its kind and converts its body as Markdown", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "> [!INFO]+ Источник",
    "> Конспект **статьи** [ссылка](https://x.y/a)",
    "> - пункт",
    "> # Заголовок",
    ">",
    "> вторая строка",
    "",
    "> [!tip] Совет",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#callout(kind: "info", title: [Источник])[',
    'Конспект *статьи* #std.link("https://x.y/a")[ссылка]',
    "- пункт",
    "= Заголовок",
    "",
    "вторая строка]",
    "",
    '#callout(kind: "tip", title: [Совет])[]',
  ]);
});

test("M2: untitled and nested callouts retain their line-shaped calls", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "> [!note]-",
    "> body",
    "",
    "> [!note] Outer",
    "> > [!tip] Inner",
    "> > Child body",
    "> After",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#callout(kind: "note", title: none)[',
    "body]",
    "",
    '#callout(kind: "note", title: [Outer])[',
    '#callout(kind: "tip", title: [Inner])[',
    "Child body]",
    "After]",
  ]);
});

test("M3/M10: plain blockquotes use std.quote and preserve a blank body line", () => {
  // #given
  const text = sourceNote(["typst: true"], ["> Цитата", ">", "> вторая", "", "> Одна строка"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.quote(block: true)[Цитата",
    "",
    "вторая]",
    "",
    "#std.quote(block: true)[Одна строка]",
  ]);
});

test("M4/M8: wikilinks use their display text and Markdown links distinguish web targets", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "[[X]] [[X|Y]] [[X#H]] [[X#H|Y]] [[#H]] [[#H|Y]] [[X#^blk]]",
    "[text](https://x.y/a) [text](Note.md)",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "X Y X Y H Y X",
    '#std.link("https://x.y/a")[text] text',
  ]);
});

test("M5/M8: image embeds and Markdown images use std.image with supplied dimensions", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "![[a.png]]",
    "![[image/Dungeon World - crystallization.jpg|400]]",
    "![[a.png|300x200]]",
    "![alt](a.jpg)",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#std.image("a.png")',
    '#std.image("image/Dungeon World - crystallization.jpg", width: 400pt)',
    '#std.image("a.png", width: 300pt, height: 200pt)',
    '#std.image("a.jpg")',
  ]);
});

test("M6/M9: inline, block, and unclosed comments leave only text outside the comment", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "before %%hidden%% after",
    "kept %%",
    "hidden [[X]]",
    "%% restored",
    "visible %% never closes",
    "hidden forever",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["before  after", "kept ", "", " restored", "visible ", ""]);
});

test("M7/M8: unsupported constructs remain escaped text and report a non-fatal problem", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "![[Note]]",
    "![[Note#H]]",
    "<u>text</u>",
    "$x^2$",
    "$$display$$",
    "[^1]",
    "[^1]: text",
    "first<br />second",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(
    { lines: conversion.typ.split("\n").slice(3), problems: conversion.problems },
    {
      lines: [
        "!\\[\\[Note\\]\\]",
        "!\\[\\[Note\\#H\\]\\]",
        "\\<u>text\\<\\/u>",
        "\\$x^2\\$",
        "\\$\\$display\\$\\$",
        "\\[^1\\]",
        "\\[^1\\]: text",
        "first#std.linebreak()second",
      ],
      problems: [
        { line: 3, message: "Note embed has no Typst form", fatal: false },
        { line: 4, message: "Note embed has no Typst form", fatal: false },
        { line: 5, message: "HTML has no Typst form", fatal: false },
        { line: 6, message: "LaTeX math has no Typst form", fatal: false },
        { line: 7, message: "LaTeX math has no Typst form", fatal: false },
        { line: 8, message: "Footnote has no Typst form", fatal: false },
        { line: 9, message: "Footnote has no Typst form", fatal: false },
      ],
    },
  );
});
