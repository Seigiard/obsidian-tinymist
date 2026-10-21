// T-T1: the pure parts of Typst fragment rendering (src/editor/typstFragment.ts, the error
// text in src/lsp/fragmentRenderer.ts) on the synthetic book in tests/fixtures/book. The
// vault root is tests/fixtures, so root-absolute paths start with /book/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import {
  buildPreamble,
  chapterPreamble,
  fragmentSource,
  needsEnclosingCode,
  preambleLine,
  projectPreamble,
  projectStatements,
  readSvg,
  topLevelStatements,
  typFilesNamed,
  typstMathAt,
} from "../src/editor/typstFragment";
import { FRAGMENT_DOC, typstExportError } from "../src/lsp/fragmentRenderer";

const ROOT = resolve("tests/fixtures");
const BOOK = join(ROOT, "book");
const file = (rel: string) => join(BOOK, rel);
const read = (rel: string) => readFileSync(file(rel), "utf8").replace(/\r\n/g, "\n");

test("topLevelStatements: multi-line statements are one, nested and quoted ones are not top level", () => {
  const tpl = topLevelStatements(read("template.typ"));
  assert.deepEqual(
    tpl.map((s) => s.kind),
    ["let", "let", "let", "let", "let", "let", "let", "let", "let"],
  );
  const theorem = tpl.find((s) => s.text.startsWith("#let theorem"))!;
  assert.match(theorem.text, /^#let theorem\(title: none, body\) = block\([\s\S]*#body\n\]$/, "the block and its body");
  const book = tpl.find((s) => s.text.startsWith("#let book"))!;
  assert.ok(book.text.endsWith("body\n}"), "a code block body up to its closing brace");

  // ch1's `#set text(fill: red)` sits inside #theorem[...]: scoped there, not a preamble line.
  assert.deepEqual(
    topLevelStatements(read("chapters/ch1.typ")).map((s) => s.text),
    ['#import "../template.typ": *'],
  );

  const text = [
    "// #let a = 1",
    "`#let b = 2` and ```typ",
    "#let c = 3",
    "```",
    "$ #let d = 4 $ /* #let e = 5 */",
    "#let f = 6 // not part of it",
    "#letter[x] #show-rule[y] #strong[#set text(red)]",
    "#let g(x) = (x,",
    "#set page(width: auto)",
    "#let h = 1; #let i = [a",
    "b]",
    // Calls and fields chain onto a parenthesized or bracketed expression, as in Typst.
    "#(a).b[#let j = 1] #[c].d[#set text(red)]",
  ].join("\n");
  assert.deepEqual(
    topLevelStatements(text).map((s) => s.text),
    [
      "#let f = 6",
      // Unclosed while typing: the statement ends at its line, later ones are still found.
      "#let g(x) = (x,",
      "#set page(width: auto)",
      "#let h = 1;",
      "#let i = [a\nb]",
    ],
  );
  const f = topLevelStatements(text)[0];
  assert.equal(text.slice(f.from, f.to), f.text);

  // The other top-level code, when asked for.
  const code: { from: number; to: number }[] = [];
  topLevelStatements("#let a = 1\n#for i in range(2) [$i$]\n#(1, 2).map(x => [$x$]).join() and $y$", code);
  assert.deepEqual(
    code.map((c) => "#let a = 1\n#for i in range(2) [$i$]\n#(1, 2).map(x => [$x$]).join() and $y$".slice(c.from, c.to)),
    ["#for i in range(2) [$i$]", "#(1, 2).map(x => [$x$]).join()"],
  );
});

test("buildPreamble: the book main's lines before this chapter's include, then the chapter's before the formula", () => {
  const ch1 = read("chapters/ch1.typ");
  const at1 = ch1.indexOf("$ Var(X)");
  assert.equal(
    buildPreamble(file("chapters/ch1.typ"), ch1, at1, ROOT),
    [
      // main.typ: its relative import and data path made root-absolute, no
      // `#show: book.with`, no include, nothing from between or after the includes.
      '#import "/book/template.typ": *',
      '#let meta = yaml("/book/meta.yaml")',
      '#set math.equation(numbering: "(1.1)")',
      // ch1.typ: relative paths stay (the fragment sits in the chapter's folder).
      '#import "../template.typ": *',
    ].join("\n"),
  );
  assert.equal(buildPreamble(file("chapters/ch1.typ"), ch1, 0, ROOT), projectPreamble(file("chapters/ch1.typ"), ROOT));

  const ch2 = read("chapters/ch2.typ");
  const before = buildPreamble(file("chapters/ch2.typ"), ch2, ch2.indexOf("在定义之前"), ROOT);
  const after = buildPreamble(file("chapters/ch2.typ"), ch2, ch2.indexOf("在定义之后"), ROOT);
  assert.ok(before.includes('#set math.vec(delim: "[")'), "main's line between the includes, for ch2");
  assert.ok(!before.includes("after-chapters"));
  assert.ok(before.includes("#let ip(a, b)"));
  assert.ok(!before.includes("#let Lip"), "a later definition is not in the preamble");
  assert.ok(after.includes("#let Lip = $L$\n#let grad = math.nabla"));
  // The buffer decides, not the file on disk: an unsaved alias is in the preamble.
  const edited = ch2.replace("#let grad", "#let unsaved = 1\n#let grad");
  assert.ok(buildPreamble(file("chapters/ch2.typ"), edited, edited.length, ROOT).includes("#let unsaved = 1"));
});

test("projectStatements: a book main's relative file paths become root-absolute; each keeps its line", () => {
  const vault = mkdtempSync(join(tmpdir(), "tinymist-preamble-"));
  try {
    mkdirSync(join(vault, "book", "chapters"), { recursive: true });
    const main = [
      '#import "tpl.typ": *',
      '#let meta = yaml("meta.yaml")',
      '#let logo = image( "figures/logo.svg", width: 1cm)',
      '#set page(background: image("figures/logo.svg"))',
      '#let v = read("../VERSION") + read("../../outside.txt")',
      '#let data = (json("/abs.json"), csv(bytes("a,b")), my-image("keep.png"), cfg.read("keep.txt"))',
      '#import "@preview/cetz:0.4.2": canvas',
      '#let f() = {',
      '  image("lazy.png")',
      "}",
      '#include "chapters/ch.typ"',
    ].join("\n");
    writeFileSync(join(vault, "book", "main.typ"), main);
    const stmts = projectStatements(join(vault, "book", "chapters", "ch.typ"), vault);
    assert.deepEqual(
      stmts.map((s) => s.text),
      [
        '#import "/book/tpl.typ": *',
        '#let meta = yaml("/book/meta.yaml")',
        '#let logo = image( "/book/figures/logo.svg", width: 1cm)',
        '#set page(background: image("/book/figures/logo.svg"))',
        // Inside the vault root, and outside it (left alone).
        '#let v = read("/VERSION") + read("../../outside.txt")',
        // Absolute, not a literal, user functions and methods: left alone.
        '#let data = (json("/abs.json"), csv(bytes("a,b")), my-image("keep.png"), cfg.read("keep.txt"))',
        '#import "@preview/cetz:0.4.2": canvas',
        '#let f() = {\n  image("/book/lazy.png")\n}',
      ],
    );
    assert.deepEqual(
      stmts.map((s) => s.line),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.ok(stmts.every((s) => s.file === join(vault, "book", "main.typ")));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("preambleLine: a fragment document's line back to the statement line it came from", () => {
  const stmts = [
    { text: "#let a = 1", file: "/v/main.typ", line: 4 },
    { text: "#let b = {\n  1 +\n}", file: "/v/ch.typ", line: 10 },
  ];
  assert.deepEqual(preambleLine(stmts, 1), { file: "/v/main.typ", line: 4, text: "#let a = 1" });
  assert.deepEqual(preambleLine(stmts, 3), { file: "/v/ch.typ", line: 11, text: "1 +" });
  assert.equal(preambleLine(stmts, 5), null, "the frame");
  assert.equal(preambleLine([], 1), null);
});

test("buildPreamble: .tinymist-fragment.typ replaces the book main's part", () => {
  const notes = read("notes/scratch.typ");
  assert.equal(
    buildPreamble(file("notes/scratch.typ"), notes, notes.length, ROOT),
    [
      '#import "/book/template.typ": RR, EE',
      "#let note = $N$",
      "#show math.equation: set text(size: 1.2em)",
    ].join("\n"),
  );
  // A file no main.typ includes and no override covers: nothing but its own lines.
  assert.equal(projectPreamble(file("template.typ"), ROOT), "");
  assert.equal(chapterPreamble(topLevelStatements("#show: t.with(a: 1)\n#include \"x.typ\"\n#let a = 1\n"), 100), "#let a = 1");
});

test("typstMathAt: formulas with their delimiters; never raw, escaped, commented or statement math", () => {
  const doc = Text.of(read("chapters/ch1.typ").split("\n"));
  const text = doc.toString();
  const inline = text.indexOf("$EE[X] = integral");
  const m = typstMathAt(doc, inline + 3)!;
  assert.deepEqual(m, {
    from: inline,
    to: text.indexOf("$", inline + 1) + 1,
    body: "$EE[X] = integral_Omega X dif PP$",
    display: false,
  });
  assert.equal(typstMathAt(doc, m.from)?.from, m.from, "on the opening $");
  assert.equal(typstMathAt(doc, m.to)?.from, m.from, "right after the closing $");

  const display = typstMathAt(doc, text.indexOf("Var(X) ="))!;
  assert.equal(display.body, "$ Var(X) = EE[(X - EE[X])^2] $", "the trailing <label> is not part of it");
  assert.equal(display.display, true);
  // Inside #theorem[...] content: a formula like any other.
  assert.equal(typstMathAt(doc, text.indexOf("EE[abs(X)]"))?.body, "$EE[abs(X)] < infinity$");

  for (const needle of ["\\$5", "`$x$`", "$alpha$", "价格"]) {
    assert.equal(typstMathAt(doc, text.indexOf(needle) + 2), null, needle);
  }
  const ch2 = Text.of(read("chapters/ch2.typ").split("\n"));
  assert.equal(typstMathAt(ch2, ch2.toString().indexOf("chevron.l")), null, "math inside #let ip(a, b)");
  assert.equal(typstMathAt(Text.of(["a $x + "]), 4), null, "unclosed");
  assert.equal(typstMathAt(Text.of(["a $ $ b"]), 3), null, "empty");
});

test("needsEnclosingCode: a loop's, closure's or block's variable, or a context; never a typo", () => {
  const doc = Text.of([
    '#let rates = (("a", 1), ("b", 2))',
    "#table(columns: 2, [$k$], ..rates.map(((k, r)) => ([#k], [$#r$])))",
    "#for i in range(3) [ $x_#i$ ]",
    "#(1, 2).map(x => [$#x$]).join()",
    "#[",
    "  #let ab = 5",
    "  Value $#ab + 1$.",
    "]",
    "#context [ $#counter(page).get().first()$ ]",
    "#strong[see $alpah$]",
    "Top $alpah$ and $#i$.",
    "#for n in (1, 2) [ $#j$ ]",
  ]);
  const text = doc.toString();
  const at = (needle: string, from = 0) => typstMathAt(doc, text.indexOf(needle, from) + 1)!;
  const needs = (needle: string, message: string, from?: number) => needsEnclosingCode(doc, at(needle, from), message);
  assert.equal(needs("#r$", "unknown variable: r"), true, "a closure parameter");
  assert.equal(needs("x_#i", "unknown variable: i"), true, "a loop variable");
  assert.equal(needs("#x$", "unknown variable: x"), true, "a closure in a chain on (…)");
  assert.equal(needs("#ab + 1", "unknown variable: ab"), true, "a let in a content block");
  assert.equal(
    needs("#counter", "can only be used when context is known\nhint: try wrapping this in a `context` expression"),
    true,
  );
  assert.equal(needs("$k$", "unknown variable: k"), false, "k comes after the formula");
  assert.equal(needs("alpah", "unknown variable: alpah"), false, "a typo in a call's content");
  assert.equal(needs("alpah", "unknown variable: alpah", text.indexOf("Top")), false, "a typo in markup");
  assert.equal(needs("#i$", "unknown variable: i", text.indexOf("Top")), false, "no code around it");
  assert.equal(needs("#j$", "unknown variable: j"), false, "not bound before the formula");
  assert.equal(needs("x_#i", "unclosed delimiter"), false, "another error");
});

test("fragmentSource: preamble, frame, then the formula (inline after the baseline marker)", () => {
  const inline = fragmentSource("#let a = 1", { body: "$a$", display: false }).split("\n");
  assert.equal(inline[0], "#let a = 1");
  assert.match(inline[1], /^#set page\(width: auto, height: auto, margin: 0pt, fill: none,/);
  assert.equal(inline[2], '#set text(fill: rgb("#0a0b0c"), size: 16pt, top-edge: "bounds", bottom-edge: "bounds")');
  assert.equal(inline[3], "#set math.equation(numbering: none)");
  assert.match(inline[4], /^#box\(width: 0pt, height: 0pt, place\(rect\(.*fill: rgb\("#010203"\)\)\)\)\$a\$$/);
  const display = fragmentSource("", { body: "$ a $", display: true }).split("\n");
  assert.match(display[0], /^#set page/, "no empty preamble line");
  assert.equal(display[3], "$ a $");
});

// Synthetic pages in the shape tinymist's SVG export has.
const PAGE = [
  '<svg viewBox="0 0 30 20" width="30pt" height="20.5pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
  '<g transform="translate(0 14.25)"><path fill="#010203" fill-rule="nonzero" d="M 0 0v 0.1h 0.1v -0.1Z "/></g>',
  '<g transform="matrix(1 0 0 -1 0 14.25)"><use xlink:href="#gA1" x="0" y="0" fill="#0a0b0c" fill-rule="nonzero"/></g>',
  '<path stroke="#0a0b0c" d="M 0 5 L 30 5"/><path fill="#ff4136" d="M 1 1"/>',
  '<g clip-path="url(#c2)"><use href="#gA1"/></g>',
  '<defs><symbol id="gA1" overflow="visible"><path d="M 0 0"/></symbol><clipPath id="c2"><rect/></clipPath></defs>',
  "</svg>",
].join("");

test("readSvg: size, baseline, marker stripped, theme ink and prefixed ids", () => {
  const r = readSvg(PAGE, "fx-")!;
  assert.equal(r.width, 30);
  assert.equal(r.height, 20.5);
  assert.equal(r.baseline, 14.25);
  assert.ok(!r.svg.includes("#010203"), "marker stripped");
  assert.ok(!r.svg.includes("#0a0b0c"));
  assert.equal(r.svg.match(/currentColor/g)?.length, 2, "fill and stroke of the ink");
  assert.ok(r.svg.includes('fill="#ff4136"'), "explicit colours stay");
  assert.deepEqual(
    [...r.svg.matchAll(/(?:id="|href="#|url\(#)([^")]+)/g)].map((m) => m[1]),
    ["fx-gA1", "fx-c2", "fx-gA1", "fx-gA1", "fx-c2"],
  );
  const display = readSvg(PAGE.replace(/<g transform="translate[^]*?<\/g>/, ""), "fy-")!;
  assert.equal(display.baseline, null);
  assert.equal(readSvg("<html></html>", "f-"), null);
});

test("typFilesNamed: quoted .typ paths, relative to the file or root-absolute; never packages", () => {
  const text = [
    '#import "../template.typ": *',
    '#import "/book/alias.typ"',
    '#import "@preview/cetz:0.5.2"',
    '#let data = read("notes.typ") + yaml("meta.yaml")',
    '#include "ch2.typ"',
  ].join("\n");
  assert.deepEqual(typFilesNamed(text, file("chapters"), ROOT), [
    file("template.typ"),
    file("alias.typ"),
    file("chapters/notes.typ"),
    file("chapters/ch2.typ"),
  ]);
});

test("typstExportError: Typst's messages and hints from a failed export, located outside the fragment", () => {
  const frag = join(BOOK, "chapters", FRAGMENT_DOC);
  // The shape tinymist 0.15 answers with (a Rust debug string inside the JSON-RPC error).
  const failed = (diag: string) =>
    `crates/tinymist/src/task/export.rs:606:17: ExportTask(0): document is not available for export: ${JSON.stringify(diag)}`;
  const error = (diag: string) => {
    const e = typstExportError(failed(diag), ROOT);
    return e && { message: e.message, line: e.line };
  };
  assert.deepEqual(error(`error: unclosed delimiter\n  ┌─ ${frag}:6:98\n  │\n6 │ $frac(1, $\n  │ ^\n\n`), {
    message: "unclosed delimiter",
    line: 6,
  });
  assert.deepEqual(
    error(`error: unknown variable: bX\n  ┌─ ${frag}:6:94\n  │\n  = hint: try adding spaces between each letter: \`b X\`\n\n`),
    { message: "unknown variable: bX\nhint: try adding spaces between each letter: `b X`", line: 6 },
  );
  // The fragment line is the first error's, only when that one lies in the fragment.
  assert.deepEqual(
    error(`error: expected expression\n  ┌─ ${join(BOOK, "template.typ")}:3:10\n\nerror: unclosed delimiter\n  ┌─ ${frag}:2:1\n`),
    { message: "expected expression (book/template.typ:3)\nunclosed delimiter", line: null },
  );
  // A broken template: located there, and at the fragment's import of it through the trace
  // (the book main's import on line 1). The same error through two imports shows once.
  const tpl = join(BOOK, "template.typ");
  const importing = (col: number) =>
    `error: unclosed delimiter\n    ┌─ ${tpl}:9:${col}\n    │\n9 │ #let VV = $bb(V\n    │           ^\n\n` +
    `help: while importing \`/book/template.typ\`\n  ┌─ ${frag}:1:1\n  │\n1 │ #import "/book/template.typ": *\n  │  ^^^^\n\n`;
  assert.deepEqual(error(importing(10) + importing(13)), { message: "unclosed delimiter (book/template.typ:9)", line: 1 });
  // A template function the formula calls fails: the trace points at the formula's line.
  assert.deepEqual(
    error(
      `error: cannot add string and integer\n    ┌─ ${tpl}:12:14\n    │\n12 │ #let bad(x) = x + 1\n    │               ^^^^^\n\n` +
        `help: while calling \`bad\`\n  ┌─ ${frag}:6:94\n  │\n6 │ $bad("s")$\n  │ ^^^^^^^^\n\n`,
    ),
    { message: "cannot add string and integer (book/template.typ:12)", line: 6 },
  );
  assert.equal(typstExportError("ExportTask(0): document is not available for export: file not found", ROOT), null);
  assert.equal(typstExportError("workspace/executeCommand timed out after 5000ms", ROOT), null);
});
