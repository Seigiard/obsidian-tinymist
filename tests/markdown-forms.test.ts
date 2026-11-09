import assert from "node:assert/strict";
import { test } from "node:test";
import { convert } from "../src/markdown/convert";
import { sourceNote } from "./fixtures/markdown/notes";

const KIT = { templates: {}, defaultTemplate: "" };

test("E2: a width-three delimiter becomes nested strong and emphasis markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["***both***"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "*_both_*");
});

test("E2: a width-three underscore delimiter becomes nested strong and emphasis markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["___x___"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "*_x_*");
});

test("R36: an unclosed width-three underscore delimiter stays literal", () => {
  // #given
  const text = sourceNote(["typst: true"], ["___x"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "\\_\\_\\_x");
});

test("E1: same-kind nested emphasis flattens while different kinds stay markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**a **b** c**", "_a _b_ c_", "***a *b* c***", "**a *b* c**"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["*a b c*", "_a b c_", "*_a b c_*", "*a _b_ c*"]);
});

test("E3: intraword stars use function forms for Latin and Cyrillic words while underscores remain prose", () => {
  // #given
  const text = sourceNote(["typst: true"], ["un*frig*believable", "не**вер**оятно", "snake_case_name", "a*b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["un#std.emph[frig];believable", "не#std.strong[вер];оятно", "snake\\_case\\_name", "a\\*b"]);
});

test("E3: intraword stars apply to digits while CJK neighbours keep markup", () => {
  // #given
  const text = sourceNote(["typst: true"], ["1*2*3", "中文**粗体**中文"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["1#std.emph[2];3", "中文*粗体*中文"]);
});

test("E1: fully flattened neighbours make an inner emphasis range use the function form", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**foo__*bar*__ baz**", "*foo_**bar**_ baz*", "*x _a_**c** y*", "**a x__*b*__y c**", "**foo__*bar*__**"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["*foo#std.emph[bar]; baz*", "_foo#std.strong[bar]; baz_", "_x a#std.strong[c]; y_", "*a x#std.emph[b];y c*", "*foo#std.emph[bar];*"]);
});

test("E4: tilde fences preserve typ code, normalize other fences, and ignore backtick closers", () => {
  // #given
  const text = sourceNote(
    ["typst: true"],
    [
      "~~~typ",
      "#let tilde = 1",
      "~~~",
      "~~~js `detail`",
      "const normal = 1;",
      "~~~",
      "~~~js",
      'const ticks = "```";',
      "```",
      "~~~",
      "~~~js",
      "const tail = `x`",
    ],
  );
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["", "#let tilde = 1", "", "```js", "const normal = 1;", "```", "````js", 'const ticks = "```";', "```", "````", "```js", "const tail = `x` ```"]);
});

test("E5: eligible indented lines become raw blocks after headings or a blank body start", () => {
  // #given
  const text = sourceNote(
    ["typst: true"],
    [
      "",
      "    blank-start",
      "body",
      "# spaces",
      "    alpha",
      "    beta",
      "# inner",
      "    left",
      "",
      "    right",
      "after",
      "# tab",
      "\ttabbed",
      "# literal",
      '    backtick ` and "quote"',
    ],
  );
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["", '#std.raw(block: true, "blank-start");', "body", "= spaces", '#std.raw(block: true, "alpha\\nbeta");', "", "= inner", '#std.raw(block: true, "left\\n\\nright");', "", "", "after", "= tab", '#std.raw(block: true, "tabbed");', "= literal", '#std.raw(block: true, "backtick ` and \\"quote\\"");']);
});

test("E5: indented code follows the rewritten opening rule", () => {
  // #given
  const text = sourceNote(["typst: true"], ["paragraph", "", "    code", "# heading", "", "    heading-code", "- item", "", "    list-continued", "paragraph", "    continued", "- item", "    continued", "", "    after-indented"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["paragraph", "", '#std.raw(block: true, "code");', "= heading", "", '#std.raw(block: true, "heading-code");', "- item", "", "    list-continued", "paragraph", "    continued", "- item", "    continued", "", "    after-indented"]);
});

test("E5: a list continuation before a blank line keeps following indented text as prose", () => {
  // #given
  const text = sourceNote(["typst: true"], ["- item", "  lazy", "", "    x"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[6], "    x");
});

test("E5: an indented ordered-list continuation before a blank line keeps following indented text as prose", () => {
  // #given
  const text = sourceNote(["typst: true"], ["1. a", "", "   b", "", "    c"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[7], "    c");
});

test("E5: a parenthesized ordered list before a blank line keeps following indented text as prose", () => {
  // #given
  const text = sourceNote(["typst: true"], ["1) item", "", "    x"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[5], "    x");
});

test("E6/E8: converted forms preserve their hand-written column maps", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a**x**b", "a*x*b", "***x***", "a***x***b", "# code", "    x"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    {
      lines: conversion.typ.split("\n").slice(3),
      strong: {
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7].map((column) => conversion.toTyp(3, column)),
        toMd: Array.from({ length: 18 }, (_, column) => conversion.toMd(3, column)),
      },
      emphasis: {
        toTyp: [0, 1, 2, 3, 4, 5].map((column) => conversion.toTyp(4, column)),
        toMd: Array.from({ length: 16 }, (_, column) => conversion.toMd(4, column)),
      },
      triple: {
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7].map((column) => conversion.toTyp(5, column)),
        toMd: [0, 1, 2, 3, 4, 5].map((column) => conversion.toMd(5, column)),
      },
      tripleFunction: {
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((column) => conversion.toTyp(6, column)),
        toMd: Array.from({ length: 29 }, (_, column) => conversion.toMd(6, column)),
      },
      raw: {
        toTyp: [0, 1, 2, 3, 4, 5].map((column) => conversion.toTyp(8, column)),
        toMd: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map((column) => conversion.toMd(8, column)),
      },
    },
    {
      lines: ["a#std.strong[x];b", "a#std.emph[x];b", "*_x_*", "a#std.strong[#std.emph[x]];b", "= code", '#std.raw(block: true, "x");'],
      strong: { toTyp: [0, 1, 1, 13, 14, 14, 16, 17], toMd: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 4, 4, 6, 7] },
      emphasis: { toTyp: [0, 1, 11, 12, 14, 15], toMd: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 4, 5] },
      triple: { toTyp: [0, 0, 1, 2, 3, 4, 4, 5], toMd: [0, 2, 3, 4, 5, 7] },
      tripleFunction: { toTyp: [0, 1, 1, 1, 23, 24, 24, 24, 27, 28], toMd: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 5, 5, 5, 8, 9] },
      raw: { toTyp: [0, 0, 0, 0, 23, 27], toMd: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5] },
    },
  );
});

test("E9: function-form content escapes line-start markers", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a**- x**b", "a**= x**b", "a**+ x**b", "a**1. x**b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["a#std.strong[\\- x];b", "a#std.strong[\\= x];b", "a#std.strong[\\+ x];b", "a#std.strong[1\\. x];b"]);
});

test("E11: rewritten tabs and quotes in the first indented-code line preserve their maps", () => {
  // #given
  const text = sourceNote(["typst: true"], ["\ta\tb", "# quote", '    a"b']);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    {
      lines: conversion.typ.split("\n").slice(3),
      tab: {
        toTyp: [0, 1, 2, 3, 4].map((column) => conversion.toTyp(3, column)),
        toMd: Array.from({ length: 31 }, (_, column) => conversion.toMd(3, column)),
      },
      quote: {
        toTyp: [0, 1, 2, 3, 4, 5, 6, 7].map((column) => conversion.toTyp(5, column)),
        toMd: Array.from({ length: 31 }, (_, column) => conversion.toMd(5, column)),
      },
    },
    {
      lines: ['#std.raw(block: true, "a\\tb");', "= quote", '#std.raw(block: true, "a\\"b");'],
      tab: { toTyp: [0, 23, 25, 26, 30], toMd: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 4, 4, 4] },
      quote: { toTyp: [0, 0, 0, 0, 23, 25, 26, 30], toMd: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 6, 7, 7, 7, 7] },
    },
  );
});

test("E12: links, wikilinks, and images are opaque to surrounding emphasis", () => {
  // #given
  const text = sourceNote(["typst: true"], ["[a*b](https://x.y) c*d", "[[Note*x]] y* z", "[a](foo*bar.md) baz* q", "*see [foo*](https://x.y) z", "*a [b](c.md) d*", "![alt*](image.png) z*", "![[pic*.png]] z*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ['#std.link("https://x.y")[a\\*b]; c\\*d', "#[Note\\*x]; y\\* z", "#[a]; baz\\* q", '\\*see #std.link("https://x.y")[foo\\*]; z', "_a #[b]; d_", '#std.image("image.png"); z\\*', '#std.image("pic*.png"); z\\*']);
});

test("E13: crossing emphasis ranges discard the later openers", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*a **b* c**", "**a *b** c*", "*a _b* c_", "*a **b* _c_ d**"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["_a \\*\\*b_ c\\*\\*", "*a \\*b* c\\*", "_a \\_b_ c\\_", "_a \\*\\*b_ _c_ d\\*\\*"]);
});

test("E14: width-three emphasis drops each enclosed kind independently", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**a ***b*** c**", "*a ***b*** c*", "*a b***x***c d*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["*a _b_ c*", "_a *b* c_", "_a b#std.strong[x];c d_"]);
});

test("E16: dropped nested and width-three runs map every source column to the next output character", () => {
  // #given
  const text = sourceNote(["typst: true"], ["**a **b** c**", "**a ***b*** c**", "***a ***b*** c***"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(
    {
      lines: conversion.typ.split("\n").slice(3),
      nested: {
        toTyp: Array.from({ length: 14 }, (_, column) => conversion.toTyp(3, column)),
        toMd: Array.from({ length: 8 }, (_, column) => conversion.toMd(3, column)),
      },
      oneHalfDropped: {
        toTyp: Array.from({ length: 16 }, (_, column) => conversion.toTyp(4, column)),
        toMd: Array.from({ length: 10 }, (_, column) => conversion.toMd(4, column)),
      },
      bothHalvesDropped: {
        toTyp: Array.from({ length: 18 }, (_, column) => conversion.toTyp(5, column)),
        toMd: Array.from({ length: 10 }, (_, column) => conversion.toMd(5, column)),
      },
    },
    {
      lines: ["*a b c*", "*a _b_ c*", "*_a b c_*"],
      nested: { toTyp: [0, 0, 1, 2, 3, 3, 3, 4, 4, 4, 5, 6, 6, 7], toMd: [0, 2, 3, 6, 9, 10, 11, 13] },
      oneHalfDropped: { toTyp: [0, 0, 1, 2, 3, 3, 3, 4, 5, 5, 5, 6, 7, 8, 8, 9], toMd: [0, 2, 3, 4, 7, 8, 11, 12, 13, 15] },
      bothHalvesDropped: { toTyp: [0, 0, 1, 2, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 7, 8, 8, 9], toMd: [0, 2, 3, 4, 8, 12, 13, 14, 15, 17] },
    },
  );
});

test("E17: labels inherit enclosing emphasis kinds and flatten their same-kind ranges", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*x ![y *b*](https://x.y) z*", "*x [y *b*](https://x.y) z*", "*x [y *b*](note.md) z*", "*x [[n|y *b*]] z*", "a*[x *b*](note.md)*c"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ['_x #std.link("https://x.y")[y b]; z_', '_x #std.link("https://x.y")[y b]; z_', "_x #[y b]; z_", "_x #[y b]; z_", "a#std.emph[#[x b];];c"]);
});

test("E9: flattened ranges preserve line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a*_- x_*b", "a**__= x__**b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["a#std.emph[\\- x];b", "a#std.strong[\\= x];b"]);
});

test("E9: flattened ranges at link-label starts preserve line-start escaping", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*[*- x*](note.md)*", "*[*= x*](note.md)*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["_#[\\- x];_", "_#[\\= x];_"]);
});

test("E9: a dropped range after a hyphen preserves line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a*_-_ x*b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "a#std.emph[\\- x];b");
});

test("E9: a dropped range after a plus preserves line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a*_+_ x*b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "a#std.emph[\\+ x];b");
});

test("E9: dropped ranges after an equals marker preserve line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a**__=__ x**b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "a#std.strong[\\= x];b");
});

test("E9: dropped ranges after an ordered-list dot preserve line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a**__1.__ x**b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "a#std.strong[1\\. x];b");
});

test("E9: dropped ranges between an ordered-list digit and dot preserve line-start escaping in function-form content", () => {
  // #given
  const text = sourceNote(["typst: true"], ["a**__1__. x**b"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "a#std.strong[1\\. x];b");
});

test("E9: a dropped range after a hyphen preserves line-start escaping at a link-label start", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*[*-* x](note.md)*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "_#[\\- x];_");
});

test("E9: a dropped range after an equals marker preserves line-start escaping at a link-label start", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*[*=* x](note.md)*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "_#[\\= x];_");
});

test("R14: a hyphen before a question mark remains escaped across dropped emphasis", () => {
  // #given
  const text = sourceNote(["typst: true"], ["*a _-_? b*"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "_a \\-? b_");
});

test("E18: indented quote bodies remain prose", () => {
  // #given
  const text = sourceNote(["typst: true"], [">     code"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.equal(conversion.typ.split("\n")[3], "#std.quote(block: true)[    code]");
});

test("E5: indented code starts after a closing fence delimiter or a /typst line", () => {
  // #given
  const text = sourceNote(["typst: true"], ["```js", "code", "```", "    after-fence", "/typst#let x = 1", "    after-typst"]);
  // #when
  const conversion = convert(text, KIT);
  // #then
  assert.deepEqual(conversion.typ.split("\n").slice(3), ["```js", "code", "```", '#std.raw(block: true, "after-fence");', "#let x = 1", '#std.raw(block: true, "after-typst");']);
});

test("E10: 300,000 flat unmatched star openers convert within five seconds", () => {
  // #given
  const body = "*a ".repeat(100_000);
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 8), bodyEnd: conversion.typ.split("\n")[3].slice(-8) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 400_000, bodyStart: "\\*a \\*a ", bodyEnd: "\\*a \\*a " },
  );
});

test("E10: 600,000 alternating star ranges convert within five seconds", () => {
  // #given
  const body = "*a*b* ".repeat(100_000);
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 17), bodyEnd: conversion.typ.split("\n")[3].slice(-17) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 1_700_000, bodyStart: "#std.emph[a];b\\* ", bodyEnd: "#std.emph[a];b\\* " },
  );
});

test("E10: 300,000 flattened underscore ranges convert within five seconds", () => {
  // #given
  const body = "_a _b_ c_ ".repeat(30_000);
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 16), bodyEnd: conversion.typ.split("\n")[3].slice(-16) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 240_000, bodyStart: "_a b c_ _a b c_ ", bodyEnd: "_a b c_ _a b c_ " },
  );
});

test("E10: deeply nested strong delimiters convert within five seconds", () => {
  // #given
  const body = `${"**a ".repeat(100_000)}x${" b**".repeat(100_000)}`;
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 9), bodyEnd: conversion.typ.split("\n")[3].slice(-9) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 400_003, bodyStart: "*a a a a ", bodyEnd: " b b b b*" },
  );
});

test("E10: 20,000 nested dropped emphasis runs convert within five seconds", () => {
  // #given
  const count = 20_000;
  const body = `${"*a _b ".repeat(count)}x${"_*".repeat(count)}`;
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 9), bodyEnd: conversion.typ.split("\n")[3].slice(-6) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 80_003, bodyStart: "_a b a b ", bodyEnd: "a b x_" },
  );
});

test("E15: links inside deep emphasis convert within five seconds", { timeout: 30_000 }, () => {
  // #given
  const count = 100_000;
  const body = `${"*a ".repeat(count)}${"[x](u) ".repeat(count)}${"a* ".repeat(count)}`;
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 11), bodyEnd: conversion.typ.split("\n")[3].slice(-9), linkCalls: conversion.typ.split("\n")[3].split("#[x];").length - 1 },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 1_000_002, bodyStart: "_a a a a a ", bodyEnd: "a a a a_ ", linkCalls: 100_000 },
  );
});

test("E15: crossing emphasis ranges convert within five seconds", { timeout: 30_000 }, () => {
  // #given
  const count = 100_000;
  const body = `${"*x ".repeat(count)}${"**y ".repeat(count)}${"x* ".repeat(count)}${"y** ".repeat(count)}`;
  // #when
  const started = performance.now();
  const conversion = convert(sourceNote(["typst: true"], [body]), KIT);
  const elapsed = performance.now() - started;
  // #then
  assert.deepEqual(
    { underFiveSeconds: elapsed < 5000, source: conversion.source, lineCount: conversion.typ.split("\n").length, bodyLength: conversion.typ.split("\n")[3].length, bodyStart: conversion.typ.split("\n")[3].slice(0, 11), bodyEnd: conversion.typ.split("\n")[3].slice(-9) },
    { underFiveSeconds: true, source: true, lineCount: 4, bodyLength: 1_600_002, bodyStart: "_x x x x x ", bodyEnd: "\\* y\\*\\* ", },
  );
});
