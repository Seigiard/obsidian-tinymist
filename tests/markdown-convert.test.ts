import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convert } from "../src/markdown/convert";
import { sourceNote } from "./fixtures/markdown/notes";

const KIT = {
  templates: { reference: "/_typst/md/reference.typ" },
  defaultTemplate: "reference",
};

const BUILT_INS =
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";

/** Counts the characters that Typst itself treats as line breaks. */
function typstLineCount(text: string): number {
  return text.split(/[\n\r\u000b\f\u0085\u2028\u2029]/u).length;
}

function outputLines(text: string): string[] {
  return text.split("\n");
}

test("C1: conversion is total for hostile text", () => {
  // #given
  const hostileInputs = ["", "---", "---\ntypst: true", "```typ\n#x", "\0\u000b\u2029"];
  // #when
  const convertAll = () => hostileInputs.forEach((text) => convert(text, KIT));
  // #then
  assert.doesNotThrow(convertAll);
});

test("C1–C2: a non-source has the complete empty Conversion shape", () => {
  // #given
  const text = "A note without converter frontmatter";
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    {
      source: conversion.source,
      typ: conversion.typ,
      toMd: [conversion.toMd(0, 4), conversion.toMd(9, 3)],
      toTyp: [conversion.toTyp(0, 4), conversion.toTyp(9, 3)],
      problems: conversion.problems,
    },
    { source: false, typ: "", toMd: [4, 3], toTyp: [4, 3], problems: [] },
  );
});

test("C2: only literal typst true in opening frontmatter selects a source", () => {
  // #given
  const notes = [
    sourceNote(["typst: true"]),
    sourceNote(["typst:   true   "]),
    sourceNote(['typst: "true"']),
    sourceNote(["typst: yes"]),
    sourceNote(["typst: True"]),
    "text\n---\ntypst: true\n---",
    "---\ntypst: true",
  ];
  // #when
  const sources = notes.map((text) => convert(text, KIT).source);
  // #then
  assert.deepEqual(sources, [true, true, false, false, false, false, false]);
});

test("C3: Typst line count stays equal for a source with every line-break character", () => {
  // #given
  const text = sourceNote(["typst: true"], ["first\u000bsecond\fthird\u0085fourth\u2028fifth\u2029sixth\rlast"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(typstLineCount(conversion.typ), text.split("\n").length);
});

test("C4–C5: frontmatter becomes the preamble and typed template arguments", () => {
  // #given
  const text = sourceNote(
    [
      "typst: true",
      "typst-template: reference",
      'typst-title: "Pilot"',
      "typst-pages: 2",
      "typst-ratio: 1.5",
      "typst-draft: false",
      "typst-tags: [alpha, 2, true]",
      "typst-empty-list: []",
      "typst-bare: alpha",
      "typst-single: 'beta'",
      'typst-path: "C:\\notes"',
      "ignored: value",
    ],
    ["Body"],
  );
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(outputLines(conversion.typ), [
    `${BUILT_INS}#import \"/_typst/md/reference.typ\": *; #show: template.with(`,
    "",
    "",
    'title: "Pilot",',
    "pages: 2,",
    "ratio: 1.5,",
    "draft: false,",
    'tags: ("alpha", 2, true,),',
    "empty-list: (),",
    'bare: "alpha",',
    'single: "beta",',
    'path: "C:\\\\notes",',
    "",
    ")",
    "Body",
  ]);
});

test("C4–C6: the configured default template supplies the import", () => {
  // #given
  const text = sourceNote(["typst: true"], ["Body"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(
    outputLines(conversion.typ)[0],
    `${BUILT_INS}#import \"/_typst/md/reference.typ\": *; #show: template.with(`,
  );
});

test("C5: unusable property values leave their lines empty and report non-fatal problems", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-empty:", "typst-block:", "  continued: value"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) },
    {
      lines: [`${BUILT_INS}#import \"/_typst/md/reference.typ\": *; #show: template.with(`, "", "", "", "", ")"],
      problems: [
        { line: 2, fatal: false },
        { line: 3, fatal: false },
      ],
    },
  );
});

test("C6–C7: template and property errors name their original lines and severity", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-template: missing", "typst-9bad: value"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    conversion.problems.map(({ line, fatal }) => ({ line, fatal })),
    [
      { line: 2, fatal: true },
      { line: 3, fatal: false },
    ],
  );
});

test("C6: a null kit and an unknown default template make template selection fatal", () => {
  // #given
  const explicit = sourceNote(["typst: true", "typst-template: reference"]);
  const defaulted = sourceNote(["typst: true"]);
  // #when
  const problems = [
    convert(explicit, null).problems.map(({ line, fatal }) => ({ line, fatal })),
    convert(defaulted, { templates: {}, defaultTemplate: "reference" }).problems.map(({ line, fatal }) => ({ line, fatal })),
  ];
  // #then
  assert.deepEqual(problems, [[{ line: 2, fatal: true }], [{ line: 0, fatal: true }]]);
});

test("C8–C9: /typst lines and typ fences pass only their content through unchanged", () => {
  // #given
  const text = sourceNote(["typst: true"], ["/typst#v(3mm)", "```typ", "#let x = [raw]", "```", "```js", "#not-code", "```"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [
    `${BUILT_INS}#show: template.with(`,
    "",
    ")",
    "#v(3mm)",
    "",
    "#let x = [raw]",
    "",
    "```js",
    "#not-code",
    "```",
  ]);
});

test("C9: an unclosed typ fence passes its remaining content through", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```typ", "#let value = [raw]"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [`${BUILT_INS}#show: template.with(`, "", ")", "", "#let value = [raw]"]);
});

test("C10–C11: native Markdown structure remains markup and prose syntax is escaped", () => {
  // #given
  const text = sourceNote(
    ["typst: true"],
    [
      "# Heading",
      "- one",
      "  * two",
      "+ three",
      "4. four",
      "**bold** __strong__ *italic* _emphasis_ `#code`",
      "a # $ @ < ~ [ ] \\ ` * _ snake_case // /* https://example.com/x",
      "= starts with equals",
      "/ starts a prose line",
      "\\* markdown escape",
    ],
  );
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), [
    "= Heading",
    "- one",
    "  - two",
    "- three",
    "4. four",
    "*bold* *strong* _italic_ _emphasis_ `#code`",
    "a \\# \\$ \\@ \\< \\~ \\[ \\] \\\\ \\` \\* \\_ snake\\_case \\/\\/ \\/\\* #std.link(\"https://example.com/x\");",
    "\\= starts with equals",
    "\\/ starts a prose line",
    "\\* markdown escape",
  ]);
});

test("C12: forbidden Typst line breaks become spaces and flag verbatim code", () => {
  // #given
  const text = sourceNote([
    "typst: true",
  ], [
    "prose\u000btext",
    "/typst#box[a\u000b\f\u0085\u2028\u2029\rb]",
    "```typ",
    "#let x = a\u000b\f\u0085\u2028\u2029\rb",
    "```",
  ]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) },
    {
      lines: [
        `${BUILT_INS}#show: template.with(`,
        "",
        ")",
        "prose text",
        "#box[a      b]",
        "",
        "#let x = a      b",
        "",
      ],
      problems: [
        { line: 4, fatal: true },
        { line: 6, fatal: true },
      ],
    },
  );
});

test("C13: column maps account for removed markup and /typst prefixes", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**жирный** текст", "/typst#v(3mm)"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    [conversion.toMd(3, 9), conversion.toTyp(3, 11), conversion.toMd(4, 0), conversion.toTyp(4, 6)],
    [11, 9, 6, 0],
  );
});

test("C10: source notes stay total for hostile bodies, a 300,000-character line, and deeply nested arrays", () => {
  // #given
  const nestedArray = `${"[".repeat(5_000)}true${"]".repeat(5_000)}`;
  const text = sourceNote(
    ["typst: true", `typst-x: ${nestedArray}`],
    ["", "---", "---\ntypst: true", "\0\u000b\u2029", "x".repeat(300_000), "```typ", "#x"],
  );
  // #when
  let conversion: ReturnType<typeof convert> | undefined;
  // #then
  assert.doesNotThrow(() => {
    conversion = convert(text, KIT);
  });
  assert.deepEqual(conversion?.problems.map(({ line, fatal }) => ({ line, fatal })), [{ line: 2, fatal: false }]);
});

test("C11: prose slashes cannot form a Typst comment beside emphasis", () => {
  // #given
  const text = sourceNote(["typst: true"], ["///", "////", "a/**b**", "**b**/c", "**/b**", "**b/**"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["\\/\\/\\/", "\\/\\/\\/\\/", "a\\/*b*", "*b*\\/c", "*\\/b*", "*b\\/*"]);
});

test("C12: multi-backtick code spans are raw text rather than Typst markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["before ``#let value = [markup]`` after", "`` a`b ``", "x `a```#strong[RUN]```b` y", "x `a``b` y"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), [
    'before #std.raw("#let value = [markup]"); after',
    '#std.raw("a`b");',
    'x #std.raw("a```#strong[RUN]```b"); y',
    'x #std.raw("a``b"); y',
  ]);
});

test("C13: CommonMark fences use a delimiter longer than their content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["  ```js details", 'const ticks = "```";', "   ```"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["  ````js", 'const ticks = "```";', "  ````"]);
});

test("C14: Typst line-start markers are escaped after indentation and structure markers", () => {
  // #given
  const text = sourceNote(["typst: true"], ["  = prose", "  / prose", "- = item", "# / heading"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["  \\= prose", "  \\/ prose", "- \\= item", "= \\/ heading"]);
});

test("C15: a bare URL keeps its full target and leaves following prose unchanged", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**https://example.com/a_b**. Next sentence."]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.equal(outputLines(conversion.typ)[3], '*#std.link("https://example.com/a_b");*. Next sentence.');
});

test("C16: emphasis between CJK characters remains emphasis", () => {
  // #given
  const text = sourceNote(["typst: true"], ["中文**粗体**中文"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.equal(outputLines(conversion.typ)[3], "中文*粗体*中文");
});

test("C17: Typst keywords and _ are rejected as template argument names", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-none: value", "typst-_: value", "typst-title: kept"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) },
    {
      lines: [`${BUILT_INS}#show: template.with(`, "", "", "", 'title: "kept",', ")"],
      problems: [
        { line: 2, fatal: false },
        { line: 3, fatal: false },
      ],
    },
  );
});

test("C18: Typst-only line breaks do not prevent heading, list, or property parsing", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-title: a\u2028b"], ["# a\u2028b", "- item\u2028next"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [
    `${BUILT_INS}#show: template.with(`,
    "",
    'title: "a b",',
    ")",
    "= a b",
    "- item next",
  ]);
});

test("C19: block scalar and indented typst properties are skipped with their continuation lines", () => {
  // #given
  const text = sourceNote([
    "typst: true",
    "typst-literal: |-2",
    "typst-literal-with-indent: |2-",
    "typst-folded: >2",
    "typst-indented: value",
    "  continued",
    "\tcontinued again",
    "typst-title: kept",
  ]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) },
    {
      lines: [`${BUILT_INS}#show: template.with(`, "", "", "", "", "", "", "", 'title: "kept",', ")"],
      problems: [
        { line: 2, fatal: false },
        { line: 3, fatal: false },
        { line: 4, fatal: false },
        { line: 5, fatal: false },
      ],
    },
  );
});

test("C20: quoted template ids resolve to the same template", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-template: "reference"']);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    { firstLine: outputLines(conversion.typ)[0], problems: conversion.problems },
    { firstLine: `${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`, problems: [] },
  );
});

test("C21: column maps preserve every common character around heading, emphasis, and an escape", () => {
  // #given
  const text = sourceNote(["typst: true"], ["# *a* $"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    {
      typ: outputLines(conversion.typ)[3],
      toTyp: [0, 1, 2, 3, 4, 5, 6].map((column) => conversion.toTyp(3, column)),
      toMd: [0, 1, 2, 3, 4, 5, 7].map((column) => conversion.toMd(3, column)),
    },
    { typ: "= _a_ \\$", toTyp: [0, 1, 2, 3, 4, 5, 7], toMd: [0, 1, 2, 3, 4, 5, 6] },
  );
});

test("C22: a null kit without typst-template uses the built-in template without a problem", () => {
  // #given
  const text = sourceNote(["typst: true"], ["Body"]);
  // #when
  const conversion = convert(text, null);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    { lines: [`${BUILT_INS}#show: template.with(`, "", ")", "Body"], problems: [] },
  );
});

test("C22: each forbidden line-break character is fatal alone in each verbatim code context", () => {
  // #given
  const forbidden = ["\r", "\u000b", "\f", "\u0085", "\u2028", "\u2029"];
  const notes = forbidden.flatMap((character) => [
    sourceNote(["typst: true"], [`/typst#v(a${character}b)`]),
    sourceNote(["typst: true"], ["```typ", `#let x = a${character}b`, "```"]),
  ]);
  // #when
  const results = notes.map((text) => {
    const conversion = convert(text, { templates: {}, defaultTemplate: "" });
    return {
      lines: outputLines(conversion.typ).slice(3),
      problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })),
    };
  });
  // #then
  assert.deepEqual(
    results,
    forbidden.flatMap(() => [
      { lines: ["#v(a b)"], problems: [{ line: 3, fatal: true }] },
      { lines: ["", "#let x = a b", ""], problems: [{ line: 4, fatal: true }] },
    ]),
  );
});

test("C24: every prose slash is escaped outside opaque and verbatim ranges", () => {
  // #given
  const text = sourceNote(["typst: true"], ["///", "////", "a/b", "a/**b**", "**b**/c", "**/b**", "**b/**", "/* x */", "/", "  /", "- /", "/\tx", "  / prose", "# / heading"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["\\/\\/\\/", "\\/\\/\\/\\/", "a\\/b", "a\\/*b*", "*b*\\/c", "*\\/b*", "*b\\/*", "\\/\\* x \\*\\/", "\\/", "  \\/", "- \\/", "\\/\tx", "  \\/ prose", "= \\/ heading"]);
});

test("C25: shorthand-sensitive prose characters remain literal", () => {
  // #given
  const text = sourceNote(["typst: true"], ["really-? a -? b", "+", "- + x", "+ item"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["really\\-? a \\-? b", "\\+", "- \\+ x", "- item"]);
});

test("C26: URLs are opaque to emphasis and stop before a code span", () => {
  // #given
  const text = sourceNote(["typst: true"], ["https://x.com/foo_/bar and _italic_", "_see https://en.wikipedia.org/wiki/Foo_(bar)_", "*a https://e.com/*x y", "https://x.com/`a` b"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ['#std.link("https://x.com/foo_/bar"); and _italic_', '_see #std.link("https://en.wikipedia.org/wiki/Foo_(bar)");_', '\\*a #std.link("https://e.com/*x"); y', '#std.link("https://x.com/");`a` b']);
});

test("C27: non-typ fences preserve a four-backtick fence and separate an unclosed trailing backtick", () => {
  // #given
  const tail = sourceNote(["typst: true"], ["```js", "const a = `x`"]);
  const fourTicks = sourceNote(["typst: true"], ["````md", "```", "x", "```", "````"]);
  // #when
  const converted = [convert(tail, { templates: {}, defaultTemplate: "" }), convert(fourTicks, { templates: {}, defaultTemplate: "" })];
  // #then
  assert.deepEqual(converted.map((conversion) => outputLines(conversion.typ).slice(3)), [["```js", "const a = `x` ```"], ["````md", "```", "x", "```", "````"]]);
});

test("C28: multiline typst-template falls back to the default template once", () => {
  // #given
  const kit = { templates: { reference: "/reference.typ", default: "/default.typ" }, defaultTemplate: "default" };
  const notes = [sourceNote(["typst: true", "typst-template: reference", "  more"]), sourceNote(["typst: true", "typst-template: |", "  reference"])];
  // #when
  const conversions = notes.map((text) => convert(text, kit));
  // #then
  assert.deepEqual(conversions.map((conversion) => ({ firstLine: outputLines(conversion.typ)[0], problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) })), [
    { firstLine: `${BUILT_INS}#import "/default.typ": *; #show: template.with(`, problems: [{ line: 2, fatal: false }] },
    { firstLine: `${BUILT_INS}#import "/default.typ": *; #show: template.with(`, problems: [{ line: 2, fatal: false }] },
  ]);
});

test("C29: columns inside a converted multi-backtick code span map to their matching characters", () => {
  // #given
  const text = sourceNote(["typst: true"], ["x ``abc`` y"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual({ typ: outputLines(conversion.typ)[3], toTyp: [conversion.toTyp(3, 0), conversion.toTyp(3, 1), conversion.toTyp(3, 2), conversion.toTyp(3, 3), conversion.toTyp(3, 4), conversion.toTyp(3, 5), conversion.toTyp(3, 6), conversion.toTyp(3, 7), conversion.toTyp(3, 8), conversion.toTyp(3, 9), conversion.toTyp(3, 10)], toMd: [conversion.toMd(3, 0), conversion.toMd(3, 1), conversion.toMd(3, 2), conversion.toMd(3, 3), conversion.toMd(3, 4), conversion.toMd(3, 5), conversion.toMd(3, 6), conversion.toMd(3, 7), conversion.toMd(3, 8), conversion.toMd(3, 9), conversion.toMd(3, 10), conversion.toMd(3, 11), conversion.toMd(3, 12), conversion.toMd(3, 13), conversion.toMd(3, 14), conversion.toMd(3, 15), conversion.toMd(3, 16), conversion.toMd(3, 17), conversion.toMd(3, 18), conversion.toMd(3, 19)] }, { typ: 'x #std.raw("abc"); y', toTyp: [0, 1, 2, 2, 12, 13, 14, 15, 15, 18, 19], toMd: [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 5, 6, 7, 7, 7, 9, 10] });
});

test("C29: columns inside a bare URL map to their matching characters", () => {
  // #given
  const text = sourceNote(["typst: true"], ["x https://a.b y"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual({ typ: outputLines(conversion.typ)[3], toTyp: [conversion.toTyp(3, 0), conversion.toTyp(3, 1), conversion.toTyp(3, 2), conversion.toTyp(3, 3), conversion.toTyp(3, 4), conversion.toTyp(3, 5), conversion.toTyp(3, 6), conversion.toTyp(3, 7), conversion.toTyp(3, 8), conversion.toTyp(3, 9), conversion.toTyp(3, 10), conversion.toTyp(3, 11), conversion.toTyp(3, 12), conversion.toTyp(3, 13), conversion.toTyp(3, 14), conversion.toTyp(3, 15)], toMd: [conversion.toMd(3, 0), conversion.toMd(3, 1), conversion.toMd(3, 2), conversion.toMd(3, 3), conversion.toMd(3, 4), conversion.toMd(3, 5), conversion.toMd(3, 6), conversion.toMd(3, 7), conversion.toMd(3, 8), conversion.toMd(3, 9), conversion.toMd(3, 10), conversion.toMd(3, 11), conversion.toMd(3, 12), conversion.toMd(3, 13), conversion.toMd(3, 14), conversion.toMd(3, 15), conversion.toMd(3, 16), conversion.toMd(3, 17), conversion.toMd(3, 18), conversion.toMd(3, 19), conversion.toMd(3, 20), conversion.toMd(3, 21), conversion.toMd(3, 22), conversion.toMd(3, 23), conversion.toMd(3, 24), conversion.toMd(3, 25), conversion.toMd(3, 26), conversion.toMd(3, 27), conversion.toMd(3, 28), conversion.toMd(3, 29)] }, { typ: 'x #std.link("https://a.b"); y', toTyp: [0, 1, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 27, 28, 29], toMd: [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 13, 13, 14, 15] });
});

test("C29: a prose backslash maps its escaped character column", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a\\b"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual({ typ: outputLines(conversion.typ)[3], toTyp: [conversion.toTyp(3, 0), conversion.toTyp(3, 1), conversion.toTyp(3, 2), conversion.toTyp(3, 3)], toMd: [conversion.toMd(3, 0), conversion.toMd(3, 1), conversion.toMd(3, 2), conversion.toMd(3, 3), conversion.toMd(3, 4)] }, { typ: "a\\\\b", toTyp: [0, 2, 3, 4], toMd: [0, 1, 1, 2, 3] });
});

function performanceResult(body: string): { error: string | undefined; status: number | null; withinLimit: boolean } {
  const source = `---\ntypst: true\n---\n${body}`;
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-performance-"));
  try {
    const { buildSync } = createRequire(__filename)("esbuild") as typeof import("esbuild");
    const output = join(directory, "convert.cjs");
    buildSync({ entryPoints: ["src/markdown/convert.ts"], bundle: true, format: "cjs", platform: "node", outfile: output });
    const runner = `
      const { convert } = require(process.env.output);
      const started = performance.now();
      convert(${JSON.stringify(source)}, null);
      process.stdout.write(JSON.stringify({ elapsed: performance.now() - started }));
    `;
    const result = spawnSync(process.execPath, ["-e", runner], { cwd: process.cwd(), encoding: "utf8", timeout: 5_500, env: { ...process.env, output } });
    const elapsed = result.stdout === "" ? Number.POSITIVE_INFINITY : JSON.parse(result.stdout).elapsed as number;
    return { error: result.error?.code, status: result.status, withinLimit: elapsed < 5_000 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("C30: one-backtick spans on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "`a` ".repeat(75_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true });
});

test("C30: emphasis markers on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "*x ".repeat(100_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true });
});

test("C30: URLs on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "https://a.b ".repeat(25_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true });
});

test("C30: prose backslashes on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "\\ ".repeat(150_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true });
});

test("C31: only Typst number literals stay numbers in template arguments", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-x: 1.e5", "typst-y: 1.", "typst-z: [1.e5, 2]", "typst-valid: .5"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [`${BUILT_INS}#show: template.with(`, "", 'x: "1.e5",', 'y: "1.",', 'z: ("1.e5", 2,),', "valid: .5,", ")"]);
});

test("C32: apostrophes inside bare flow-array items stay ordinary characters", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-a: [O'Brien, Smith]", "typst-b: [O'Brien, D'Arcy]", "typst-c: ['a, b', c]"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [`${BUILT_INS}#show: template.with(`, "", 'a: ("O\'Brien", "Smith",),', 'b: ("O\'Brien", "D\'Arcy",),', 'c: ("a, b", "c",),', ")"]);
});

test("C33: Typst-only line breaks count as indentation before line-start markers", () => {
  // #given
  const text = sourceNote(["typst: true"], ["\u000b= x", "\u2028+"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), [" \\= x", " \\+"]);
});

test("C34: Devanagari combining marks follow Typst's intraword emphasis rule", () => {
  // #given
  const text = sourceNote(["typst: true"], ["हि**ब**", "**ब**ी"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["हि\\*\\*ब\\*\\*", "\\*\\*ब\\*\\*ी"]);
});
