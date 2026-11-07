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
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = std.block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";

/** Counts lines the way Typst does, splitting on every character it treats as a line break. */
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
    sourceNote(["typst:true"]),
    sourceNote(["typst: true", "  continued"]),
    sourceNote(["typst: true # on"]),
    "text\n---\ntypst: true\n---",
    "---\ntypst: true",
  ];
  // #when
  const sources = notes.map((text) => convert(text, KIT).source);
  // #then
  assert.deepEqual(sources, [true, true, false, false, false, false, false, true, false, false]);
});

test("C66: typst true in a note body does not select a source", () => {
  // #given
  const text = sourceNote(["title: Ordinary note"], ["typst: true"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.source, false);
});

test("C67: only the bare typst key selects a source and typst-typst remains an argument", () => {
  // #given
  const propertyOnly = sourceNote(["typst-typst: true"]);
  const sourceWithProperty = sourceNote(["typst: true", "typst-typst: true"]);
  // #when
  const conversions = [convert(propertyOnly, KIT), convert(sourceWithProperty, KIT)];
  // #then
  assert.deepEqual(
    { propertyOnly: conversions[0].source, propertyLine: outputLines(conversions[1].typ)[2] },
    { propertyOnly: false, propertyLine: "typst: true," },
  );
});

test("C68–C76: blank frontmatter lines do not create a continuation", () => {
  // #given
  const propertyContinuation = sourceNote(["typst: true", "typst-title: first", "", "  second"]);
  const flagContinuation = sourceNote(["typst: true", "", "  continued"]);
  const ordinaryBlankLines = sourceNote(["typst: true", "", "typst-title: kept", "", "other: value"]);
  // #when
  const conversions = [convert(propertyContinuation, KIT), convert(flagContinuation, KIT), convert(ordinaryBlankLines, KIT)];
  // #then
  assert.deepEqual(
    {
      property: {
        lines: outputLines(conversions[0].typ),
        problems: conversions[0].problems,
      },
      flagSource: conversions[1].source,
      ordinary: {
        source: conversions[2].source,
        lines: outputLines(conversions[2].typ),
        problems: conversions[2].problems,
      },
    },
    {
      property: {
        lines: [`${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`, "", "", "", "", ")"],
        problems: [{ line: 2, message: "Property title has a multi-line value", fatal: false }],
      },
      flagSource: false,
      ordinary: {
        source: true,
        lines: [`${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`, "", "", 'title: "kept",', "", "", ")"],
        problems: [],
      },
    },
  );
});

test("C69: a repeated property is skipped after its first value", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-x: first", "typst-x: second"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [`${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`, "", 'x: "first",', "", ")"],
      problems: [{ line: 3, message: "Property x is repeated", fatal: false }],
    },
  );
});

test("C73: indented frontmatter comments leave flags, properties, and template selection unchanged", () => {
  // #given
  const flag = sourceNote(["typst: true", "", "  # note"]);
  const property = sourceNote(["typst: true", "typst-title: T", "", "  # note"]);
  const template = sourceNote(["typst: true", "typst-template: a", "", "  # note"]);
  const templateKit = { templates: { a: "/a.typ", b: "/b.typ" }, defaultTemplate: "b" };
  // #when
  const conversions = [convert(flag, KIT), convert(property, KIT), convert(template, templateKit)];
  // #then
  assert.deepEqual(
    {
      flag: { source: conversions[0].source, problems: conversions[0].problems },
      property: { line: outputLines(conversions[1].typ)[2], problems: conversions[1].problems },
      template: { line: outputLines(conversions[2].typ)[0], problems: conversions[2].problems },
    },
    {
      flag: { source: true, problems: [] },
      property: { line: 'title: "T",', problems: [] },
      template: { line: `${BUILT_INS}#import "/a.typ": *; #show: template.with(`, problems: [] },
    },
  );
});

test("C74: every later frontmatter name is repeated even after an invalid first value", () => {
  // #given
  const template = sourceNote(["typst: true", "typst-template: a", "typst-template: b"]);
  const empty = sourceNote(["typst: true", "typst-x:", "typst-x: second"]);
  const malformed = sourceNote(["typst: true", "typst-x: [a", "typst-x: 1"]);
  const flag = sourceNote(["typst: true", "typst: false"]);
  const templateKit = { templates: { a: "/a.typ", b: "/b.typ" }, defaultTemplate: "b" };
  // #when
  const conversions = [convert(template, templateKit), convert(empty, { templates: {}, defaultTemplate: "" }), convert(malformed, { templates: {}, defaultTemplate: "" }), convert(flag, { templates: {}, defaultTemplate: "" })];
  // #then
  assert.deepEqual(
    conversions.map((conversion) => ({ source: conversion.source, lines: outputLines(conversion.typ), problems: conversion.problems })),
    [
      {
        source: true,
        lines: [`${BUILT_INS}#import "/a.typ": *; #show: template.with(`, "", "", "", ")"],
        problems: [{ line: 3, message: "Property template is repeated", fatal: false }],
      },
      {
        source: true,
        lines: [`${BUILT_INS}#show: template.with(`, "", "", "", ")"],
        problems: [
          { line: 2, message: "Property x has no value", fatal: false },
          { line: 3, message: "Property x is repeated", fatal: false },
        ],
      },
      {
        source: true,
        lines: [`${BUILT_INS}#show: template.with(`, "", "", "", ")"],
        problems: [
          { line: 2, message: "Property x has a malformed list", fatal: false },
          { line: 3, message: "Property x is repeated", fatal: false },
        ],
      },
      {
        source: true,
        lines: [`${BUILT_INS}#show: template.with(`, "", "", ")"],
        problems: [{ line: 2, message: "Property typst is repeated", fatal: false }],
      },
    ],
  );
});

test("C80: the first false source flag keeps a note outside conversion", () => {
  // #given
  const text = sourceNote(["typst: false", "typst: true"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual({ source: conversion.source, typ: conversion.typ, problems: conversion.problems }, { source: false, typ: "", problems: [] });
});

test("C81: an empty first template keeps the distinct default after a repeated template", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-template:", "typst-template: b"]);
  const templateKit = { templates: { b: "/b.typ", d: "/d.typ" }, defaultTemplate: "d" };
  // #when
  const conversion = convert(text, templateKit);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [`${BUILT_INS}#import "/d.typ": *; #show: template.with(`, "", "", "", ")"],
      problems: [
        { line: 2, message: "Property template has no value", fatal: false },
        { line: 3, message: "Property template is repeated", fatal: false },
      ],
    },
  );
});

test("C81: a multi-line first template keeps the distinct default after a repeated template", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-template: |", "  x", "typst-template: b"]);
  const templateKit = { templates: { b: "/b.typ", d: "/d.typ" }, defaultTemplate: "d" };
  // #when
  const conversion = convert(text, templateKit);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [`${BUILT_INS}#import "/d.typ": *; #show: template.with(`, "", "", "", "", ")"],
      problems: [
        { line: 2, message: "Property template has a multi-line value", fatal: false },
        { line: 4, message: "Property template is repeated", fatal: false },
      ],
    },
  );
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
      'typst-path: "C:\\\\notes"',
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

test("C82: bare URLs stop before punctuation, format characters, and the 8 KB limit", () => {
  // #given
  const urlAtLimit = "https://x.y/" + "a".repeat(7_988);
  const urlOverLimit = "https://x.y/" + "a".repeat(7_989);
  const text = sourceNote(
    ["typst: true"],
    ["<https://x.y>", "[https://x.y]", "«https://x.y»", "请看https://x.y。下一句", "https://x.y/­", urlAtLimit, urlOverLimit],
  );
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), [
    "\\<#std.link(\"https://x.y\");\\>",
    "\\[#std.link(\"https://x.y\");\\]",
    '«#std.link("https://x.y");»',
    '请看#std.link("https://x.y");。下一句',
    '#std.link("https://x.y/");­',
    '#std.link("https://x.y/' + "a".repeat(7_988) + '");',
    "https:\\/\\/x.y\\/" + "a".repeat(7_989),
  ]);
});

test("C78: a bare URL has one call form and converts stripped punctuation as prose", () => {
  // #given
  const text = sourceNote(
    ["typst: true"],
    [
      "(see https://example.com/a(b))",
      "(https://en.wikipedia.org/wiki/Foo_(bar)) next",
      "https://x.y/a(b)*)",
      "https://x.y/a(b)~) tail",
    ],
  );
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), [
    '(see #std.link("https://example.com/a(b)");)',
    '(#std.link("https://en.wikipedia.org/wiki/Foo_(bar)");) next',
    '#std.link("https://x.y/a(b)");\\*)',
    '#std.link("https://x.y/a(b)");\\~) tail',
  ]);
});

test("C79: column-zero YAML sequences make an empty property multi-line", () => {
  // #given
  const tags = sourceNote(["typst: true", "typst-tags:", "- a", "- b"]);
  const template = sourceNote(["typst: true", "typst-template:", "- a"]);
  const templateKit = { templates: { a: "/a.typ", b: "/b.typ" }, defaultTemplate: "b" };
  // #when
  const conversions = [convert(tags, { templates: {}, defaultTemplate: "" }), convert(template, templateKit)];
  // #then
  assert.deepEqual(
    conversions.map((conversion) => ({ lines: outputLines(conversion.typ), problems: conversion.problems })),
    [
      {
        lines: [`${BUILT_INS}#show: template.with(`, "", "", "", "", ")"],
        problems: [{ line: 2, message: "Property tags has a multi-line value", fatal: false }],
      },
      {
        lines: [`${BUILT_INS}#import "/b.typ": *; #show: template.with(`, "", "", "", ")"],
        problems: [{ line: 2, message: "Property template has a multi-line value", fatal: false }],
      },
    ],
  );
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

test("C20/C86: quoted template ids, including single quotes, resolve to the explicit template", () => {
  // #given
  const notes = [sourceNote(["typst: true", 'typst-template: "reference"']), sourceNote(["typst: true", "typst-template: 'reference'"])];
  const templateKit = { templates: { reference: "/reference.typ", default: "/default.typ" }, defaultTemplate: "default" };
  // #when
  const conversions = notes.map((text) => convert(text, templateKit));
  // #then
  assert.deepEqual(
    conversions.map((conversion) => ({ firstLine: outputLines(conversion.typ)[0], problems: conversion.problems })),
    [
      { firstLine: `${BUILT_INS}#import "/reference.typ": *; #show: template.with(`, problems: [] },
      { firstLine: `${BUILT_INS}#import "/reference.typ": *; #show: template.with(`, problems: [] },
    ],
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
  const text = sourceNote(["typst: true"], ["https://x.com/foo_/bar and _italic_", "_see https://en.wikipedia.org/wiki/Foo_(bar)_", "*a https://e.com/*x y", "https://x.com/`a` b", "(see https://x.y)"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ['#std.link("https://x.com/foo_/bar"); and _italic_', '_see #std.link("https://en.wikipedia.org/wiki/Foo_(bar)");_', '\\*a #std.link("https://e.com/*x"); y', '#std.link("https://x.com/");`a` b', '(see #std.link("https://x.y");)']);
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

test("C83: source-note maps return an invalid input column unchanged without throwing", () => {
  // #given
  const text = sourceNote(["typst: true"], ["Body"]);
  const invalid = [Number.NaN, 1.5, undefined, Number.POSITIVE_INFINITY] as const;
  // #when
  const maps = invalid.flatMap((value) => {
    try {
      const conversion = convert(text, { templates: {}, defaultTemplate: "" });
      return [conversion.toMd(value as number, 7), conversion.toTyp(value as number, 7), conversion.toMd(3, value as number), conversion.toTyp(3, value as number)];
    } catch (error) {
      return [error instanceof Error ? error.name : String(error)];
    }
  });
  // #then
  assert.deepEqual(maps, [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
});

test("C84: blank template values report a problem, while a comment-only value uses the default", () => {
  // #given
  const notes = [sourceNote(["typst: true", "typst-template: "]), sourceNote(["typst: true", "typst-template: # none"])];
  const templateKit = { templates: { d: "/d.typ" }, defaultTemplate: "d" };
  // #when
  const conversions = notes.map((text) => convert(text, templateKit));
  // #then
  assert.deepEqual(
    conversions.map((conversion) => ({ firstLine: outputLines(conversion.typ)[0], problems: conversion.problems })),
    [
      { firstLine: `${BUILT_INS}#import "/d.typ": *; #show: template.with(`, problems: [{ line: 2, message: "Property template has no value", fatal: false }] },
      { firstLine: `${BUILT_INS}#import "/d.typ": *; #show: template.with(`, problems: [] },
    ],
  );
});

test("C29: a prose backslash maps its escaped character column", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a\\b"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    {
      typ: outputLines(conversion.typ)[3],
      toTyp: [0, 1, 2, 3].map((column) => conversion.toTyp(3, column)),
      toMd: [0, 1, 2, 3, 4].map((column) => conversion.toMd(3, column)),
    },
    { typ: "a\\\\b", toTyp: [0, 2, 3, 4], toMd: [0, 1, 1, 2, 3] },
  );
});

test("C48: generated string literals escape hostile quotes and preserve their columns", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-x: a",);#panic();//'], ['``");#panic();//``', 'https://x.y/a"b']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    {
      lines: outputLines(conversion.typ),
      toTyp: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((column) => conversion.toTyp(4, column)),
    },
    {
      lines: [
        `${BUILT_INS}#show: template.with(`,
        "",
        'x: "a\\",);#panic();//",',
        ")",
        '#std.raw("\\");#panic();//");',
        '#std.link("https://x.y/a\\"b");',
      ],
      toTyp: [0, 0, 11, 12, 13, 14, 15, 16, 17, 18],
    },
  );
});

test("C48: stripped code-span spaces map to the raw literal content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["`` a`b ``"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((column) => conversion.toTyp(3, column)),
    [0, 0, 0, 10, 11, 12, 13, 13, 13, 16],
  );
});

test("C48: a Typst-only line break in a non-typ fence is a space without a problem", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```js", "const value = a\u000bb", "```"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ).slice(3), problems: conversion.problems },
    { lines: ["```js", "const value = a b", "```"], problems: [] },
  );
});

function performanceResult(body: string): { error: string | undefined; status: number | null; withinLimit: boolean; source: boolean; lineCount: boolean; bodyLength: number; startCodes: number[]; endCodes: number[]; linkCalls: number } {
  const source = `---\ntypst: true\n---\n${body}`;
  const directory = mkdtempSync(join(tmpdir(), "tinymist-markdown-performance-"));
  try {
    const { buildSync } = createRequire(__filename)("esbuild") as typeof import("esbuild");
    const output = join(directory, "convert.cjs");
    buildSync({ entryPoints: ["src/markdown/convert.ts"], bundle: true, format: "cjs", platform: "node", outfile: output });
    const runner = `
      const { readFileSync } = require("node:fs");
      const { convert } = require(process.env.output);
      const source = readFileSync(0, "utf8");
      const started = performance.now();
      const conversion = convert(source, null);
      process.stdout.write(JSON.stringify({
        elapsed: performance.now() - started,
        source: conversion.source,
        lineCount: conversion.typ.split("\\n").length === source.split("\\n").length,
        bodyLength: conversion.typ.split("\\n")[3].length,
        startCodes: [...conversion.typ.split("\\n")[3].slice(0, 8)].map((character) => character.charCodeAt(0)),
        endCodes: [...conversion.typ.split("\\n")[3].slice(-8)].map((character) => character.charCodeAt(0)),
        linkCalls: conversion.typ.split("\\n")[3].split("#std.link(").length - 1,
      }));
    `;
    const result = spawnSync(process.execPath, ["-e", runner], { cwd: process.cwd(), encoding: "utf8", input: source, timeout: 5_500, env: { ...process.env, output } });
    const elapsed = typeof result.stdout === "string" && result.stdout !== "" ? JSON.parse(result.stdout).elapsed as number : Number.POSITIVE_INFINITY;
    return {
      error: result.error?.code,
      status: result.status,
      withinLimit: elapsed < 5_000,
      source: result.status === 0 && JSON.parse(result.stdout).source === true,
      lineCount: result.status === 0 && JSON.parse(result.stdout).lineCount === true,
      bodyLength: result.status === 0 ? JSON.parse(result.stdout).bodyLength : -1,
      startCodes: result.status === 0 ? JSON.parse(result.stdout).startCodes : [],
      endCodes: result.status === 0 ? JSON.parse(result.stdout).endCodes : [],
      linkCalls: result.status === 0 ? JSON.parse(result.stdout).linkCalls : -1,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("C30/C80/C86: one-backtick spans on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "`a` ".repeat(75_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true, source: true, lineCount: true, bodyLength: 300_000, startCodes: [96, 97, 96, 32, 96, 97, 96, 32], endCodes: [96, 97, 96, 32, 96, 97, 96, 32], linkCalls: 0 });
});

test("C30/C80/C86: emphasis markers on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "*x ".repeat(100_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true, source: true, lineCount: true, bodyLength: 400_000, startCodes: [92, 42, 120, 32, 92, 42, 120, 32], endCodes: [92, 42, 120, 32, 92, 42, 120, 32], linkCalls: 0 });
});

test("C30/C80/C86: URLs on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "https://a.b ".repeat(25_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true, source: true, lineCount: true, bodyLength: 650_000, startCodes: [35, 115, 116, 100, 46, 108, 105, 110], endCodes: [47, 97, 46, 98, 34, 41, 59, 32], linkCalls: 25_000 });
});

test("C30/C80/C86: prose backslashes on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "\\ ".repeat(150_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true, source: true, lineCount: true, bodyLength: 450_000, startCodes: [92, 92, 32, 92, 92, 32, 92, 92], endCodes: [92, 32, 92, 92, 32, 92, 92, 32], linkCalls: 0 });
});

test("C38/C80/C86: unmatched backtick runs on a 300,000-character line convert within five seconds", { timeout: 7_000 }, () => {
  // #given
  const body = "\\``a".repeat(75_000);
  // #when
  const result = performanceResult(body);
  // #then
  assert.deepEqual(result, { error: undefined, status: 0, withinLimit: true, source: true, lineCount: true, bodyLength: 375_000, startCodes: [92, 96, 92, 96, 97, 92, 96, 92], endCodes: [92, 96, 97, 92, 96, 92, 96, 97], linkCalls: 0 });
});

test("C39: non-Identifier fence words are dropped from raw blocks", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```c++", "int x;", "```", "```c#", "int x;", "```", "```.net", "int x;", "```", "```1c", "int x;", "```"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["```", "int x;", "```", "```", "int x;", "```", "```", "int x;", "```", "```", "int x;", "```"]);
});

test("C41: YAML quotes decode before Typst string escaping", () => {
  // #given
  const text = sourceNote([
    "typst: true",
    "typst-quote: ''",
    "typst-path: 'C:\\'",
    "typst-paths: ['a\\', 'b']",
    "typst-possessive: 'it''s'",
    'typst-title: "He said: \\"hi\\""',
    'typst-backslash: "\\\\"',
    'typst-apostrophe: "\\\'"',
    'typst-slash: "\\/"',
    'typst-newline: "\\n"',
    'typst-tab: "\\t"',
    'typst-carriage: "\\r"',
    'typst-nul: "\\0"',
    'typst-space: "\\ "',
    'typst-hex: "\\x41"',
    'typst-unicode: "\\u03bb"',
    'typst-codepoint: "\\U0001f642"',
  ]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [
        `${BUILT_INS}#show: template.with(`,
        "",
        'quote: "",',
        'path: "C:\\\\",',
        'paths: ("a\\\\", "b",),',
        'possessive: "it\'s",',
        'title: "He said: \\"hi\\"",',
        'backslash: "\\\\",',
        'apostrophe: "\'",',
        'slash: "/",',
        'newline: "\\n",',
        'tab: "\\t",',
        'carriage: "\\r",',
        'nul: "\\u{0}",',
        'space: " ",',
        'hex: "A",',
        'unicode: "λ",',
        'codepoint: "🙂",',
        ")",
      ],
      problems: [],
    },
  );
});

test("C42: flow arrays reject text after a closing quote", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-a: ['a' junk]", 'typst-b: ["b"junk]', 'typst-c: [a, "b" trailing]']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })) },
    {
      lines: [`${BUILT_INS}#show: template.with(`, "", "", "", "", ")"],
      problems: [{ line: 2, fatal: false }, { line: 3, fatal: false }, { line: 4, fatal: false }],
    },
  );
});

test("C43: YAML comments end unquoted values without changing quoted hashes", () => {
  // #given
  const text = sourceNote(["typst: true # on", "typst-template: reference # default", "typst-pages: 5 # two sheets", "typst-a: [1, 2] # c", 'typst-title: "a # b"', "typst-id: a#b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    { source: conversion.source, lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      source: true,
      lines: [`${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`, "", "", "pages: 5,", "a: (1, 2,),", 'title: "a # b",', 'id: "a#b",', ")"],
      problems: [],
    },
  );
});

test("C44: a NEL is sanitized before structure and inline conversion", () => {
  // #given
  const text = sourceNote(["typst: true"], ["- +\u0085x", "https://a.b\u0085c d", "*a\u0085*"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["- \\+ x", '#std.link("https://a.b"); c d', "\\*a \\*"]);
});

test("C45: each rejected value names its failure kind", () => {
  // #given
  const deeplyNested = `${"[".repeat(33)}x${"]".repeat(33)}`;
  const text = sourceNote(["typst: true", "typst-empty:", "typst-multiline: |", "  continued", "typst-malformed: [x,,y]", `typst-deep: ${deeplyNested}`, 'typst-escape: "\\q"']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    conversion.problems,
    [
      { line: 2, message: "Property empty has no value", fatal: false },
      { line: 3, message: "Property multiline has a multi-line value", fatal: false },
      { line: 5, message: "Property malformed has a malformed list", fatal: false },
      { line: 6, message: "Property deep nests lists deeper than 32 levels", fatal: false },
      { line: 7, message: "Property escape has an unknown escape \\q", fatal: false },
    ],
  );
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

test("C37: malformed bracketed flow arrays leave their properties empty and report non-fatal problems", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-a: [x,,y]", "typst-b: [a, [b]", "typst-c: [ok, 1]"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    {
      lines: outputLines(conversion.typ),
      problems: conversion.problems.map(({ line, fatal }) => ({ line, fatal })),
    },
    {
      lines: [`${BUILT_INS}#show: template.with(`, "", "", "", 'c: ("ok", 1,),', ")"],
      problems: [
        { line: 2, fatal: false },
        { line: 3, fatal: false },
      ],
    },
  );
});

test("C49: decoded YAML line-break escapes become Typst string escapes", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-line: "a\\u2028b"', 'typst-nul: "a\\0b"', 'typst-nel: "a\\x85b"', 'typst-list: ["a\\x0bb"]']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [
    `${BUILT_INS}#show: template.with(`,
    "",
    'line: "a\\u{2028}b",',
    'nul: "a\\u{0}b",',
    'nel: "a\\u{85}b",',
    'list: ("a\\u{b}b",),',
    ")",
  ]);
});

test("C49: decoded YAML escapes preserve the Markdown line count", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-line: "a\\u2028b"', 'typst-nel: "a\\x85b"']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.equal(typstLineCount(conversion.typ), text.split("\n").length);
});

test("C50: nested flow arrays preserve quoted items", () => {
  // #given
  const text = sourceNote([
    "typst: true",
    'typst-a: [["a", "b"], ["c"]]',
    'typst-b: ["a", ["b", "c"]]',
    "typst-c: [['a', 'b'], c]",
    "typst-d: [[a, ']'], d]",
    'typst-e: [[a, "b]", c], d]',
  ]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [
    `${BUILT_INS}#show: template.with(`,
    "",
    'a: (("a", "b",), ("c",),),',
    'b: ("a", ("b", "c",),),',
    'c: (("a", "b",), "c",),',
    'd: (("a", "]",), "d",),',
    'e: (("a", "b]", "c",), "d",),',
    ")",
  ]);
});

test("C51: hashes in flow arrays remain data while comment-only values are empty", () => {
  // #given
  const text = sourceNote([
    "typst: true",
    "typst-template: # none",
    "typst-tags: [issue #1, issue #2]",
    "typst-a: [a, #b]",
    "typst-b: [a #b, c]",
    "typst-x: # comment",
    "typst-pages: # use default",
    "typst-color: #ff0000",
    'typst-title: "a # b"',
    "typst-id: a#b",
  ]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [
        `${BUILT_INS}#import "/_typst/md/reference.typ": *; #show: template.with(`,
        "",
        "",
        'tags: ("issue #1", "issue #2",),',
        'a: ("a", "#b",),',
        'b: ("a #b", "c",),',
        "",
        "",
        "",
        'title: "a # b",',
        'id: "a#b",',
        ")",
      ],
      problems: [
        { line: 6, message: "Property x has no value", fatal: false },
        { line: 7, message: "Property pages has no value", fatal: false },
        { line: 8, message: "Property color has no value", fatal: false },
      ],
    },
  );
});

test("C52: delimiter runs wider than strong or emphasis stay literal", () => {
  // #given
  const text = sourceNote(["typst: true"], ["Name: ____ Date: ____", "Name: ______", "a ****** b", "***x***", "**a** *b*"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["Name: \\_\\_\\_\\_ Date: \\_\\_\\_\\_", "Name: \\_\\_\\_\\_\\_\\_", "a \\*\\*\\*\\*\\*\\* b", "\\*\\*\\*x\\*\\*\\*", "*a* _b_"]);
});

test("C53: nested list item text receives prose line-start escaping", () => {
  // #given
  const text = sourceNote(["typst: true"], ["- - = x", "- - + x", "- 1. = x", "- # h", "- - x"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["- - \\= x", "- - \\+ x", "- 1. \\= x", "- \\# h", "- - x"]);
});

test("C54: malformed top-level quoted scalars are skipped with their own message", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-a: "', "typst-b: '", 'typst-c: "a" junk "b"', "typst-d: 'a' b"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ), problems: conversion.problems },
    {
      lines: [`${BUILT_INS}#show: template.with(`, "", "", "", "", "", ")"],
      problems: [
        { line: 2, message: "Property a has a malformed value", fatal: false },
        { line: 3, message: "Property b has a malformed value", fatal: false },
        { line: 4, message: "Property c has a malformed value", fatal: false },
        { line: 5, message: "Property d has a malformed value", fatal: false },
      ],
    },
  );
});

test("C56: an unclosed fence on its opening line appends a separated closing delimiter", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```js"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ), [`${BUILT_INS}#show: template.with(`, "", ")", "```js ```"]);
});

test("C57: incomplete and trailing flow arrays are skipped as malformed lists", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-a: [a, b", 'typst-b: ["a", "b"', "typst-c: [a, b] c", "typst-d: [[a] junk, b]"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ).slice(2), problems: conversion.problems },
    {
      lines: ["", "", "", "", ")"],
      problems: [
        { line: 2, message: "Property a has a malformed list", fatal: false },
        { line: 3, message: "Property b has a malformed list", fatal: false },
        { line: 4, message: "Property c has a malformed list", fatal: false },
        { line: 5, message: "Property d has a malformed list", fatal: false },
      ],
    },
  );
});

test("C58: list markers before non-ASCII whitespace stay escaped prose", () => {
  // #given
  const text = sourceNote(["typst: true"], ["-\u00a0x", "*\u3000x", "+\u00a0x", "1.\u3000x", "- -\u00a0x"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(outputLines(conversion.typ).slice(3), ["\\-\u00a0x", "\\*\u3000x", "\\+\u00a0x", "1\\.\u3000x", "- \\-\u00a0x"]);
});

test("C59: a comment in a bare scalar with brackets is removed", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-title: Part [1 # see note"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ).slice(2), problems: conversion.problems },
    { lines: ['title: "Part [1",', ")"], problems: [] },
  );
});

test("C60: surrogate and out-of-range YAML escapes are rejected without throwing", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-surrogate: "\\uD800"', 'typst-large: "\\U00110000"']);
  let conversion: ReturnType<typeof convert> | undefined;
  // #when
  assert.doesNotThrow(() => {
    conversion = convert(text, { templates: {}, defaultTemplate: "" });
  });
  // #then
  assert.deepEqual(
    { source: conversion?.source, lines: outputLines(conversion?.typ ?? "").slice(2), problems: conversion?.problems },
    {
      source: true,
      lines: ["", "", ")"],
      problems: [
        { line: 2, message: "Property surrogate has an unknown escape \\uD800", fatal: false },
        { line: 3, message: "Property large has an unknown escape \\U00110000", fatal: false },
      ],
    },
  );
});

test("C62: appended delimiters on an unclosed fence map to the final source column", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```js", "abc"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { toMd: [3, 4, 5, 6].map((column) => conversion.toMd(4, column)), toTyp: conversion.toTyp(4, 3) },
    { toMd: [3, 3, 3, 3], toTyp: 3 },
  );
});

test("C63: template paths retain Typst line-break characters through string escaping", () => {
  // #given
  const text = sourceNote(["typst: true"]);
  const kit = { templates: { reference: "/x\u2028y.typ" }, defaultTemplate: "reference" };
  // #when
  const conversion = convert(text, kit);
  const imported = outputLines(conversion.typ)[0].match(/#import [^;]+: \*;/u)?.[0];
  // #then
  assert.equal(imported, '#import "/x\\u{2028}y.typ": *;');
});

test("C64: built-in callout uses the standard-library block function", () => {
  // #given
  const text = sourceNote(["typst: true"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.equal(
    outputLines(conversion.typ)[0],
    "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = std.block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; #show: template.with(",
  );
});

test("C71: nested list columns map through width-changing strong markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["- - **x** y", "- 1. **x**"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    {
      first: {
        typ: outputLines(conversion.typ)[3],
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((column) => conversion.toTyp(3, column)),
        toMd: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((column) => conversion.toMd(3, column)),
      },
      ordered: {
        typ: outputLines(conversion.typ)[4],
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((column) => conversion.toTyp(4, column)),
        toMd: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((column) => conversion.toMd(4, column)),
      },
    },
    {
      first: {
        typ: "- - *x* y",
        toTyp: [0, 1, 2, 3, 4, 4, 5, 6, 6, 7, 8, 9],
        toMd: [0, 1, 2, 3, 4, 6, 7, 9, 10, 11],
      },
      ordered: {
        typ: "- 1. *x*",
        toTyp: [0, 1, 2, 3, 4, 5, 5, 6, 7, 7, 8],
        toMd: [0, 1, 2, 3, 4, 5, 7, 8, 10],
      },
    },
  );
});

test("C71: source-note maps preserve generated, outside, and past-end positions", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-title: Pilot"], ["Body"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    {
      outsideMd: [conversion.toMd(-1, 8), conversion.toMd(5, 8)],
      outsideTyp: [conversion.toTyp(-1, 8), conversion.toTyp(5, 8)],
      pastEnd: [conversion.toMd(4, 5), conversion.toTyp(4, 5)],
      generated: [conversion.toMd(0, 10), conversion.toTyp(0, 3), conversion.toMd(2, 4), conversion.toTyp(2, 4), conversion.toMd(3, 0), conversion.toTyp(3, 0), conversion.toMd(3, 1), conversion.toTyp(3, 1)],
    },
    {
      outsideMd: [8, 8],
      outsideTyp: [8, 8],
      pastEnd: [5, 5],
      generated: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  );
});

test("C76: non-typ fence delimiter columns are generated", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```js", "const value = 1", "```"]);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    [conversion.toMd(3, 1), conversion.toTyp(3, 1), conversion.toMd(5, 1), conversion.toTyp(5, 1)],
    [0, 0, 0, 0],
  );
});

test("C71: problems stay sorted by source line", () => {
  // #given
  const text = sourceNote(["typst: true", "typst-9bad: x", "typst-template: missing"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    conversion.problems.map(({ line, fatal }) => ({ line, fatal })),
    [
      { line: 2, fatal: false },
      { line: 3, fatal: true },
    ],
  );
});

test("C66: decoded form-feed and paragraph-separator escapes preserve Typst line identity", () => {
  // #given
  const text = sourceNote(["typst: true", 'typst-ff: "a\\x0cb"', 'typst-ps: "a\\u2029b"']);
  // #when
  const conversion = convert(text, { templates: {}, defaultTemplate: "" });
  // #then
  assert.deepEqual(
    { lines: outputLines(conversion.typ).slice(2), lineCount: typstLineCount(conversion.typ) },
    { lines: ['ff: "a\\u{c}b",', 'ps: "a\\u{2029}b",', ")"], lineCount: text.split("\n").length },
  );
});
