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
    "[left|right], [first#std.linebreak();second], [three], [four])",
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
    'Конспект *статьи* #std.link("https://x.y/a")[ссылка];',
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

test("M4/M8/Y1: wikilinks and internal Markdown links use terminated content blocks", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "[[X]] [[X|Y]] [[X#H]] [[X#H|Y]] [[#H]] [[#H|Y]] [[X#^blk]]",
    "[text](https://x.y/a) [text](Note.md)",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#[X]; #[Y]; #[X]; #[Y]; #[H]; #[Y]; #[X];",
    '#std.link("https://x.y/a")[text]; #[text];',
  ]);
});

test("M5/M8: image embeds and Markdown images use std.image with supplied dimensions", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "![[fig.png]]",
    "![[image/Dungeon World - crystallization.jpg|400]]",
    "![[fig.png|300x200]]",
    "![](fig.png)",
    "![alt](sub/fig.jpg)",
  ]);
  // #when
  const conversion = convert(text, null, { vaultPath: "Notes/Page.md" });
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#std.image("/Notes/fig.png");',
    '#std.image("/Notes/image/Dungeon World - crystallization.jpg", width: 400pt);',
    '#std.image("/Notes/fig.png", width: 300pt, height: 200pt);',
    '#std.image("/Notes/fig.png");',
    '#std.image("/Notes/sub/fig.jpg");',
  ]);
});

test("image targets at the vault root stay root-absolute without changing line maps", () => {
  // #given
  const text = sourceNote(["typst: true"], ["![[fig.png]]"]);

  // #when
  const conversion = convert(text, null, { vaultPath: "Plan.md" });

  // #then
  assert.deepEqual(
    {
      line: conversion.typ.split("\n")[3],
      toMd: [conversion.toMd(3, 0), conversion.toMd(3, 23)],
      toTyp: [conversion.toTyp(3, 0), conversion.toTyp(3, 12)],
    },
    {
      line: '#std.image("/fig.png");',
      toMd: [0, 0],
      toTyp: [0, 0],
    },
  );
});

test("image parent segments resolve lexically but a target that escapes the vault stays unchanged", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "![](../fig.png)",
    "![](sub/../diagram.svg)",
    "![](../../../outside.png)",
    "![](/assets/logo.png)",
  ]);

  // #when
  const conversion = convert(text, null, { vaultPath: "Notes/Chapters/Plan.md" });

  // #then
  assert.deepEqual(
    { lines: conversion.typ.split("\n").slice(3), problems: conversion.problems },
    {
      lines: [
        '#std.image("/Notes/fig.png");',
        '#std.image("/Notes/Chapters/diagram.svg");',
        '#std.image("../../../outside.png");',
        '#std.image("/assets/logo.png");',
      ],
      problems: [],
    },
  );
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
        "first#std.linebreak();second",
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

test("N1: block comments hide every block form until their closing delimiter", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "%%",
    "```js",
    "secret()",
    "```",
    '/typst #text[SECRET]',
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "> quoted",
    "%% restored",
    "after",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["", "", "", "", "", "", "", "", "", " restored", "after"]);
});

test("N1: comment delimiters inside inline code remain literal text", () => {
  // #given
  const text = sourceNote(["typst: true"], ["`a %% b` c", "next"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["`a %% b` c", "next"]);
});

test("Z1: comment boundaries exclude stray code delimiters and preserve real code spans", () => {
  // #given
  const texts = [
    sourceNote(["typst: true"], ["%% draft ` %% visible `code`", "Next paragraph"]),
    sourceNote(["typst: true"], ["%% draft %% visible `code`", "Next paragraph"]),
    sourceNote(["typst: true"], ["`a %% b` %% c %%"]),
  ];
  // #when
  const lines = texts.map((text) => convert(text, null).typ.split("\n").slice(3));
  // #then
  assert.deepEqual(lines, [
    [" visible `code`", "Next paragraph"],
    [" visible `code`", "Next paragraph"],
    ["`a %% b` "],
  ]);
});

test("N2: table rows trim trailing whitespace without adding a column", () => {
  // #given
  const text = sourceNote(["typst: true"], ["| a | b |  ", "|---|---|\t", "| 1 | 2 | ", "| x | y"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.table(columns: 2, std.table.header([a], [b]),",
    "",
    "[1], [2],",
    "[x], [y])",
  ]);
});

test("N3: a callout body converts a table and keeps its list as markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["> [!example] Roll", "> | d6 | Result |", "> |---|---|", "> | 1 | Goblin |", "> - item"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#callout(kind: "example", title: [Roll])[',
    "#std.table(columns: 2, std.table.header([d6], [Result]),",
    "",
    "[1], [Goblin])",
    "- item]",
  ]);
});

test("N3: a plain quote body passes a typ fence through and keeps its list as markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["> Quote", "> ```typ", "> #let answer = 42", "> ```", "> - item"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["#std.quote(block: true)[Quote", "", "#let answer = 42", "", "- item]"]);
});

test("N4: remote Markdown images become links and report non-fatal problems", () => {
  // #given
  const text = sourceNote(["typst: true"], ["![alt](http://x.y/a.png)", "![](https://x.y/a.png)"]);
  // #when
  const conversion = convert(text, null, { vaultPath: "Notes/Page.md" });
  // #then
  assert.deepEqual(
    { lines: conversion.typ.split("\n").slice(3), problems: conversion.problems },
    {
      lines: ['#std.link("http://x.y/a.png")[alt];', '#std.link("https://x.y/a.png");'],
      problems: [
        { line: 3, message: "Remote image has no Typst form", fatal: false },
        { line: 4, message: "Remote image has no Typst form", fatal: false },
      ],
    },
  );
});

test("N5: Markdown link and image titles are omitted from their targets", () => {
  // #given
  const text = sourceNote(["typst: true"], ['[t](https://x.y/a "Title")', '![a](a.png "Title")']);
  // #when
  const conversion = convert(text, null, { vaultPath: "Notes/Page.md" });
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ['#std.link("https://x.y/a")[t];', '#std.image("/Notes/a.png");']);
});

test("N6: table cells and callout titles escape Markdown line-start markers", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "| A | B | C | D |",
    "|---|---|---|---|",
    "| - one | + two | 1. three | = four |",
    "> [!note] - item",
    "",
    "> [!note] + item",
    "",
    "> [!note] 1. item",
    "",
    "> [!note] = heading",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.table(columns: 4, std.table.header([A], [B], [C], [D]),",
    "",
    "[\\- one], [\\+ two], [1\\. three], [\\= four])",
    '#callout(kind: "note", title: [\\- item])[]',
    "",
    '#callout(kind: "note", title: [\\+ item])[]',
    "",
    '#callout(kind: "note", title: [1\\. item])[]',
    "",
    '#callout(kind: "note", title: [\\= heading])[]',
  ]);
});

test("Q1: every plain quote line passes through the block rules", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "> ```js",
    "> let x = 1;",
    "> ```",
    "",
    "> | a | b |",
    "> |---|---|",
    "> | 1 | 2 |",
    "",
    "> > nested",
    "> > more",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.quote(block: true)[```js",
    "let x = 1;",
    "```]",
    "",
    "#std.quote(block: true)[#std.table(columns: 2, std.table.header([a], [b]),",
    "",
    "[1], [2])]",
    "",
    "#std.quote(block: true)[#std.quote(block: true)[nested",
    "more]]",
  ]);
});

test("Q2: an unclosed fence inside a callout closes before the container does", () => {
  // #given
  const text = sourceNote(["typst: true"], ["> [!note] Code", "> ```js", "> let x = 1;", "", "after"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#callout(kind: "note", title: [Code])[',
    "```js",
    "let x = 1; ```]",
    "",
    "after",
  ]);
});

test("Q3: hostile nested labels, quotes, and emphasis remain bounded and line-shaped", () => {
  // #given
  const notes = [
    sourceNote(["typst: true"], ["[".repeat(5_000) + "x" + "](a.md)".repeat(5_000)]),
    sourceNote(["typst: true"], ["> ".repeat(5_000) + "x"]),
    sourceNote(["typst: true"], ["**".repeat(5_000) + "x"]),
    sourceNote(["typst: true"], ["[".repeat(33) + "x" + "](https://x.y)".repeat(33)]),
  ];
  // #when
  const summaries = notes.map((text) => {
    const conversion = convert(text, null);
    return {
      source: conversion.source,
      inputLines: text.split("\n").length,
      outputLines: conversion.typ.split("\n").length,
      linkCalls: conversion.typ.split("#std.link(").length - 1,
    };
  });
  // #then
  assert.deepEqual(summaries, [
    { source: true, inputLines: 4, outputLines: 4, linkCalls: 0 },
    { source: true, inputLines: 4, outputLines: 4, linkCalls: 0 },
    { source: true, inputLines: 4, outputLines: 4, linkCalls: 0 },
    { source: true, inputLines: 4, outputLines: 4, linkCalls: 32 },
  ]);
});

test("R1: generated inline calls terminate before adjacent Typst postfix syntax", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "Total<br>(approx.)",
    "[docs](https://x.com)(see)",
    "![x](pic.png)(figure 1)",
    "end<br>.hidden",
  ]);
  // #when
  const conversion = convert(text, null, { vaultPath: "Notes/Page.md" });
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "Total#std.linebreak();(approx.)",
    '#std.link("https://x.com")[docs];(see)',
    '#std.image("/Notes/pic.png");(figure 1)',
    "end#std.linebreak();.hidden",
  ]);
});

test("X1: final raw Typst container lines pass through verbatim before their closing bracket", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "> [!tip] Syntax",
    "> /typst Use `//` for a comment",
    "",
    "> [!tip] Link",
    "> /typst See https://typst.app for docs",
    "",
    "> /typst #text[https://example.com]",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    '#callout(kind: "tip", title: [Syntax])[',
    " Use `//` for a comment]",
    "",
    '#callout(kind: "tip", title: [Link])[',
    " See https://typst.app for docs]",
    "",
    "#std.quote(block: true)[ #text[https://example.com]]",
  ]);
});

test("X2/Y1: wikilink displays and Markdown link labels escape line-start markers", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "[[- draft]] is a note title",
    "| Left | Right |",
    "| --- | --- |",
    "| [[- draft]] | [[+ idea]] |",
    "| kept | row |",
    "[[1. Intro]] covers",
    "> [!note] [[1. Intro]]",
    "",
    "[- item](https://x.com)",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#[\\- draft]; is a note title",
    "#std.table(columns: 2, std.table.header([Left], [Right]),",
    "",
    "[#[\\- draft];], [#[\\+ idea];],",
    "[kept], [row])",
    "#[1\\. Intro]; covers",
    '#callout(kind: "note", title: [#[1\\. Intro];])[]',
    "",
    '#std.link("https://x.com")[\\- item];',
  ]);
});

test("Y1: terminated internal-link blocks keep adjacent emphasis outside word text", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "**[[Note]]**s",
    "See [[Note]]*draft*",
    "_u_[[Note]]",
    "*a*[x](n.md)",
    "[[X|Y]]",
    "[[- draft]] is a note title",
    "| A | B |",
    "| --- | --- |",
    "| _em_[[Note]] | b |",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "*#[Note];*s",
    "See #[Note];_draft_",
    "_u_#[Note];",
    "_a_#[x];",
    "#[Y];",
    "#[\\- draft]; is a note title",
    "#std.table(columns: 2, std.table.header([A], [B]),",
    "",
    "[_em_#[Note];], [b])",
  ]);
});

test("Y2: table problems inside a callout use their source lines", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "> [!note] T",
    "> intro",
    "> more",
    "> | a | b |",
    "> |---|---|",
    "> | 1 | 2 | 3 |",
    "> | $x$ | y |",
    "> tail",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.problems, [
    { line: 8, message: "Table row has 3 cells, the header has 2", fatal: false },
    { line: 9, message: "LaTeX math has no Typst form", fatal: false },
  ]);
});

test("Y3: table cells, callout titles, and web-link labels escape heading runs", () => {
  // #given
  const text = sourceNote(["typst: true"], [
    "| A |",
    "| --- |",
    "| == important == |",
    "",
    "> [!note] == x",
    "",
    "[== h](https://x.com)",
  ]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), [
    "#std.table(columns: 1, std.table.header([A]),",
    "",
    "[\\== important ==])",
    "",
    '#callout(kind: "note", title: [\\== x])[]',
    "",
    '#std.link("https://x.com")[\\== h];',
  ]);
});
