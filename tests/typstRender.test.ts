// The Typst render hover (src/editor/typstRender.ts) on the real editor stack with a fake
// fragment backend that answers in the shape of tinymist's SVG export: the section above
// tinymist's hover, the SVG on the baseline in currentColor, errors, and the render cache
// with its invalidation. The fixture book (tests/fixtures/book) supplies the preamble; the
// real renderer process is covered by tests/fragmentRenderer.test.ts.
import "./support/dom";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { EditorState, Extension, Text } from "@codemirror/state";
import { EditorView, closeHoverTooltips, hoverTooltip } from "@codemirror/view";
import { typstEditorExtensions } from "../src/editor/typstEditor";
import { typstMathAt } from "../src/editor/typstFragment";
import { FileEvent, FragmentBackend, TypstLiveRenderer, TypstRender, typstCursorPreview, typstPaperAt, typstRenderHover } from "../src/editor/typstRender";
import { typstLiveLanguage } from "../src/editor/typstLive";
import { livePreview } from "../src/editor/shared/livePreview";
import { FragmentError } from "../src/lsp/fragmentRenderer";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ROOT = resolve("tests/fixtures");
const CH1 = join(ROOT, "book", "chapters", "ch1.typ");
const CH1_TEXT = readFileSync(CH1, "utf8").replace(/\r\n/g, "\n");

/**
 * A page like tinymist's for `source`: 1pt wide per character of the formula, the
 * baseline marker for inline math, the ink colour on a glyph and a rule.
 */
function page(source: string): string {
  // A paper render: the page's fixed width, black ink on white.
  if (source.includes("#set page(width: 400pt")) {
    return [
      '<svg viewBox="0 0 400 120" width="400pt" height="120pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<path d="M 0 0v 120h 400v -120Z " fill="#ffffff"/><g><use xlink:href="#g1" fill="#000000"/></g>',
      '<defs><symbol id="g1" overflow="visible"><path d="M 0 0"/></symbol></defs></svg>',
    ].join("");
  }
  const body = source.slice(source.lastIndexOf("$", source.length - 3)).trimEnd().length;
  const inline = source.includes('fill: rgb("#010203")');
  return [
    `<svg viewBox="0 0 ${body} 24" width="${body}pt" height="24pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
    inline ? '<g transform="translate(0 16)"><path fill="#010203" fill-rule="nonzero" d="M 0 0v 0.1h 0.1v -0.1Z "/></g>' : "",
    '<g transform="matrix(1 0 0 -1 0 16)"><use xlink:href="#g1" fill="#0a0b0c"/></g><path stroke="#0a0b0c" d="M 0 5 L 9 5"/>',
    '<defs><symbol id="g1" overflow="visible"><path d="M 0 0"/></symbol></defs></svg>',
  ].join("");
}

function fakeBackend(fail?: (source: string) => Error | null) {
  const calls: { dir: string; source: string }[] = [];
  const backend: FragmentBackend = {
    async render(dir, source) {
      calls.push({ dir, source });
      const err = fail?.(source);
      if (err) throw err;
      return page(source);
    },
  };
  return { backend, calls };
}

/** tinymist's text hover (a signature) at any position, answered after a round trip. */
const tinymistHover: Extension = hoverTooltip(
  async (_view, pos) => {
    await sleep(15);
    return {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "tym-hover";
        dom.textContent = "let EE = op";
        return { dom };
      },
    };
  },
  { hoverTime: 10 },
);

/**
 * An editor on `text` (the file `path`) with the render hover above tinymist's (paper renders
 * inverted as `inverted` says) and the cursor preview while `preview` says so.
 */
function editor(
  render: TypstRender,
  enabled: () => boolean,
  text = CH1_TEXT,
  path = CH1,
  more: { inverted?: () => boolean; preview?: () => boolean; live?: Extension } = {},
) {
  const host = { renderer: () => render, path: () => path, enabled, inverted: more.inverted };
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: typstEditorExtensions(
        {
          completion: { triggerCharacters: () => [], request: async () => null },
          hover: [
            typstRenderHover(host),
            typstCursorPreview({ ...host, enabled: more.preview ?? (() => false) }),
            tinymistHover,
          ],
          live: more.live,
        },
        text,
      ),
    }),
    parent: document.body,
  });
  /**
   * The pointer comes to rest on `needle`, through CodeMirror's mousemove path (jsdom has
   * no layout: the coordinate mapping is pinned), so a hover that another section's
   * arrival discards is asked again, as with a resting pointer.
   */
  const hoverAt = async (needle: string) => {
    view.dispatch({ effects: closeHoverTooltips });
    const pos = text.indexOf(needle) + 1;
    Object.assign(view, {
      posAtCoords: () => pos,
      coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }),
    });
    const line = view.contentDOM.querySelector(".cm-line")!;
    line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
    await sleep(380);
    const host = view.dom.querySelector(".cm-tooltip-hover");
    return host ? [...host.children] : [];
  };
  return { view, hoverAt };
}

const kind = (el: Element) =>
  el.classList.contains("lsp-render-hover") ? "render" : el.classList.contains("tym-hover") ? "tinymist" : el.className;

test("render hover: the formula's SVG above tinymist's hover, on the baseline, in currentColor", async () => {
  const { backend, calls } = fakeBackend();
  const render = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(render, () => true);
  try {
    const sections = await hoverAt("EE[X] = integral");
    assert.deepEqual(sections.map(kind), ["render", "tinymist"]);
    const box = sections[0].querySelector(":scope > span.tym-fragment")!;
    const svg = box.querySelector("svg")!;
    const body = "$EE[X] = integral_Omega X dif PP$";
    assert.equal(svg.getAttribute("width"), null, "sized by style, in em");
    assert.equal(svg.style.width, `${body.length / 16}em`);
    assert.equal(svg.style.height, `${24 / 16}em`);
    assert.equal(svg.style.verticalAlign, `${-(24 - 16) / 16}em`, "the depth below the baseline");
    assert.ok(!svg.innerHTML.includes("#010203"), "marker stripped");
    assert.equal(svg.querySelectorAll('[fill="currentColor"], [stroke="currentColor"]').length, 2);
    assert.match(svg.querySelector("use")!.getAttribute("xlink:href")!, /^#f\w+-g1$/);

    // The chapter's folder, the book main's lines, the chapter's import, the frame.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dir, dirname(CH1));
    assert.ok(
      calls[0].source.startsWith(
        '#import "/book/template.typ": *\n#let meta = yaml("/book/meta.yaml")\n#set math.equation(numbering: "(1.1)")\n#import "../template.typ": *\n#set page(',
      ),
    );
    assert.ok(calls[0].source.endsWith(`fill: rgb("#010203"))))${body}\n`));

    const display = await hoverAt("Var(X) = EE");
    const block = display[0].querySelector(":scope > div.tym-fragment.is-display svg") as SVGSVGElement;
    assert.ok(block, "display math is a block");
    assert.equal(block.style.verticalAlign, "");

    assert.deepEqual((await hoverAt("期望写作")).map(kind), ["tinymist"], "outside math");
    assert.deepEqual((await hoverAt("`$x$`")).map(kind), ["tinymist"], "raw text");
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("render hover: Typst's error with the formula, and nothing while the setting is off", async () => {
  let on = true;
  const { backend } = fakeBackend((s) =>
    s.includes("EE[abs(X)]") ? new FragmentError("unknown variable: abs") : s.includes("sum_(i=1)") ? new Error("tinymist binary not found") : null,
  );
  const render = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(render, () => on);
  try {
    const [error] = await hoverAt("EE[abs(X)]");
    assert.equal(error.querySelector(".lsp-render-hover-message")?.textContent, "unknown variable: abs");
    assert.equal(error.querySelector(".lsp-render-hover-source")?.textContent, "$EE[abs(X)] < infinity$");
    const [missing] = await hoverAt("sum_(i=1)");
    assert.equal(missing.querySelector(".lsp-render-hover-message")?.textContent, "tinymist binary not found");
    on = false;
    assert.deepEqual((await hoverAt("EE[X] = integral")).map(kind), ["tinymist"]);
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("paper hover: a call with a content body, #figure or #image, on a page 400pt wide in a paper frame", async () => {
  const text = [
    CH1_TEXT.trimEnd(),
    "#let note = [注]",
    "#figure(rect(width: 1cm), caption: [盒子]) <fig:box>",
    "#h(1em) #image(\"fig.png\", width: 2cm) #link(\"https://typst.app\")[Typst]",
    `#box[${"长".repeat(4100)}]`,
    "$#box[x]$ and #strong[bad",
    "",
  ].join("\n");
  const { backend, calls } = fakeBackend((src) => (src.includes("#strong[oops]") ? new FragmentError("unexpected end of block") : null));
  const render = new TypstRender(backend, ROOT);
  let inverted = false;
  const { view, hoverAt } = editor(render, () => true, text, CH1, { inverted: () => inverted });
  try {
    const sections = await hoverAt("#theorem(title");
    assert.deepEqual(sections.map(kind), ["render", "tinymist"]);
    const paper = sections[0].querySelector<HTMLElement>(":scope > div.tym-fragment.is-paper.lsp-lp-paper")!;
    assert.ok(paper && !paper.classList.contains("is-inverted"));
    const svg = paper.querySelector("svg")!;
    assert.equal(svg.style.width, `${400 / 12}em`, "a 400pt page at 12pt per em (a PDF at 100%)");
    assert.ok(svg.innerHTML.includes('fill="#000000"') && !svg.innerHTML.includes("currentColor"), "the page's own ink");
    // The book main's lines (its document template rule too: the book's look) and the
    // chapter's statements above the call, the page (marked), the call.
    const source = calls.at(-1)!.source;
    const call = text.slice(text.indexOf("#theorem(title"), text.indexOf("]\n\n- 第一项") + 1);
    assert.ok(
      source.startsWith('#import "/book/template.typ": *\n#let meta = yaml("/book/meta.yaml")\n#show: book.with(title: meta.title)\n'),
      source,
    );
    assert.ok(source.includes('#import "../template.typ": *\n#set page(width: 400pt, height: auto, margin: 6pt, fill: white'));
    assert.ok(source.includes('foreground: place(rect(width: 0.1pt, height: 0.1pt, fill: rgb("#010203")))'), "the page's mark");
    assert.match(source, /\n#show ref: it => if it\.element == none .*\n#show cite: .*\n/, "references outside the call show as keys");
    assert.ok(source.endsWith(`]]\n${call}\n`), source);
    assert.ok(!source.includes("#let note"), "statements below the call are not in its preamble");

    // On the name only: its content is markup (its formulas hover as math).
    assert.deepEqual((await hoverAt("若 $EE")).map(kind), ["tinymist"]);
    assert.deepEqual((await hoverAt("abs(X)] <")).map(kind), ["render", "tinymist"]);
    assert.ok((await hoverAt("abs(X)] <"))[0].querySelector("span.tym-fragment"), "math, not paper");
    // #figure and #image render as pages; #link has a content body; #h does not.
    assert.ok((await hoverAt("#figure("))[0].querySelector(".lsp-lp-paper"));
    assert.ok((await hoverAt("#image("))[0].querySelector(".lsp-lp-paper"));
    assert.ok((await hoverAt("#link("))[0].querySelector(".lsp-lp-paper"));
    assert.deepEqual((await hoverAt("#h(1em)")).map(kind), ["tinymist"]);
    assert.deepEqual((await hoverAt("#box[长")).map(kind), ["tinymist"], "past 4,000 characters");
    assert.deepEqual((await hoverAt("#let note")).map(kind), ["tinymist"], "a statement");
    // In math it is math; an unclosed call is no call.
    assert.ok((await hoverAt("box[x]$"))[0].querySelector("span.tym-fragment"));
    assert.deepEqual((await hoverAt("#strong[bad")).map(kind), ["tinymist"]);
    assert.equal(typstPaperAt(view.state.doc, text.indexOf("#theorem") + 8)?.body, call, "its name's end counts");

    // Inverted as the preview is (the setting "auto" in a dark theme).
    inverted = true;
    assert.ok((await hoverAt("#figure("))[0].querySelector(".lsp-lp-paper.is-inverted"));
  } finally {
    view.destroy();
    render.dispose();
  }

  // A failing call: Typst's error with the call's first line.
  const bad = "#strong[oops]\n#theorem[\n  x\n  #strong[oops]\n]\n";
  const r2 = new TypstRender(backend, ROOT);
  const e = editor(r2, () => true, bad, join(ROOT, "book", "notes", "bad.typ"));
  try {
    const [error] = await e.hoverAt("#theorem[");
    assert.equal(error.querySelector(".lsp-render-hover-message")?.textContent, "unexpected end of block");
    assert.equal(error.querySelector(".lsp-render-hover-source")?.textContent, "#theorem[");
  } finally {
    e.view.destroy();
    r2.dispose();
  }
});

test("TypstRender: a paper render is not kept (an image it shows may change on disk); formulas are", async () => {
  // The backend answers with the image as it is on disk at each render.
  let image = "old.png";
  const calls: string[] = [];
  const backend: FragmentBackend = {
    async render(_dir, source) {
      calls.push(source);
      return page(source).replace("</svg>", `<image href="${image}"/></svg>`);
    },
  };
  const render = new TypstRender(backend, ROOT);
  const text = `${CH1_TEXT.trimEnd()}\n#figure(image("fig.png"), caption: [图])\n`;
  const doc = Text.of(text.split("\n"));
  const call = typstPaperAt(doc, text.indexOf("#figure(") + 2)!;
  const m = typstMathAt(doc, text.indexOf("a_1") + 1)!;
  try {
    const first = await render.paper(CH1, doc, call);
    image = "new.png";
    const second = await render.paper(CH1, doc, call);
    assert.ok(first.ok && first.svg.includes("old.png") && second.ok && second.svg.includes("new.png"));
    assert.equal(calls.length, 2, "the same call renders again");
    await render.math(CH1, doc, m);
    await render.math(CH1, doc, m);
    assert.equal(calls.length, 3, "formulas stay cached");
    // A page the renderer itself failed is not tried again: nothing keeps it (a formula's
    // failure bumps the file's epoch when the renderer next answers).
    const timeout: FragmentBackend = {
      async render(_dir, source) {
        if (source.includes("#figure(")) throw new Error("rendering took longer than 5 s");
        return page(source);
      },
    };
    const failing = new TypstRender(timeout, ROOT);
    try {
      assert.ok(!(await failing.paper(CH1, doc, call)).ok);
      assert.ok((await failing.math(CH1, doc, m)).ok);
      assert.equal(failing.epoch(CH1), 0, "no retry for the page");
    } finally {
      failing.dispose();
    }
  } finally {
    render.dispose();
  }
});

test("TypstRender: a paper render keeps the document template rules; without them when Typst fails with them", async () => {
  // A template holding its body in a container: Typst allows the page no set rule there.
  const container = "page configuration is not allowed inside of containers";
  const { backend, calls } = fakeBackend((src) =>
    src.includes("#show: book") && src.includes("#set page(width: 400pt")
      ? new FragmentError(container, 3)
      : src.includes("#strong[oops]")
        ? new FragmentError("unexpected end of block")
        : null,
  );
  const render = new TypstRender(backend, ROOT);
  const text = `${CH1_TEXT.trimEnd()}\n#show: rest => rest\n#figure(rect(), caption: [盒])\n#box[#strong[oops]]\n`;
  const doc = Text.of(text.split("\n"));
  const figure = typstPaperAt(doc, text.indexOf("#figure(") + 2)!;
  try {
    const r = await render.paper(CH1, doc, figure);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(calls.length, 2, "with the template rules, then without");
    assert.ok(calls[0].source.includes("#show: book.with(title: meta.title)\n") && calls[0].source.includes("#show: rest => rest\n"));
    assert.ok(!calls[1].source.includes("#show: book") && !calls[1].source.includes("#show: rest"));
    // A call's own error: Typst's message from the render without them.
    const bad = await render.paper(CH1, doc, typstPaperAt(doc, text.indexOf("#box[#strong") + 2)!);
    assert.ok(!bad.ok && bad.message === "unexpected end of block", JSON.stringify(bad));
    assert.equal(calls.length, 4);
    // Formulas never keep them.
    await render.math(CH1, doc, typstMathAt(doc, text.indexOf("a_1") + 1)!);
    assert.ok(!calls[4].source.includes("#show: book") && !calls[4].source.includes("#show: rest"));
  } finally {
    render.dispose();
  }
});

test("TypstRender: a call naming more than 10 MB of images gets no paper render", async () => {
  const book = tempBook();
  const { backend, calls } = fakeBackend();
  const render = new TypstRender(backend, book.root);
  mkdirSync(book.path("figures"));
  // Sparse files: the size without the bytes.
  writeFileSync(book.path("figures/small.png"), "");
  truncateSync(book.path("figures/small.png"), 6 * 2 ** 20);
  writeFileSync(book.path("figures/large.png"), "");
  truncateSync(book.path("figures/large.png"), 6 * 2 ** 20);
  const text = [
    '#figure(image("../figures/small.png"), caption: [a])',
    '#figure(grid(image("../figures/small.png"), image("/book/figures/large.png")), caption: [b])',
    '#figure(image("../figures/missing.png"), caption: [c])',
    "",
  ].join("\n");
  const doc = Text.of(text.split("\n"));
  const at = (needle: string) => typstPaperAt(doc, text.indexOf(needle) + 2)!;
  try {
    assert.ok((await render.paper(book.path("chapters/ch1.typ"), doc, at("#figure(image(\"../figures/small"))).ok);
    const big = await render.paper(book.path("chapters/ch1.typ"), doc, at("#figure(grid"));
    assert.ok(!big.ok && big.message === "not rendered on hover: its images take 12.0 MB (at most 10.0 MB)", JSON.stringify(big));
    assert.equal(calls.length, 1, "the renderer is not asked");
    assert.ok((await render.paper(book.path("chapters/ch1.typ"), doc, at("#figure(image(\"../figures/missing"))).ok, "Typst's to report");
  } finally {
    render.dispose();
    book.close();
  }
});

test("cursor preview: the formula at the cursor below it while typed (setting-gated); in live preview not over a block it decorates", async () => {
  const { backend, calls } = fakeBackend();
  const render = new TypstRender(backend, ROOT);
  let on = false;
  const text = "Inline $a + b$ here.\n$ x^2 $\ntext $ y $ inline display\n";
  const { view } = editor(render, () => true, text, CH1, { preview: () => on });
  const shown = () => view.dom.querySelector(".cm-tooltip.lsp-cursor-preview:not(.is-empty) svg");
  try {
    view.focus();
    await sleep(40);
    view.dispatch({ selection: { anchor: text.indexOf("a +") } });
    await sleep(20);
    assert.equal(view.dom.querySelector(".lsp-cursor-preview"), null, "off by default");
    on = true;
    view.dispatch({ selection: { anchor: text.indexOf("a +") + 1 } });
    await sleep(20);
    assert.ok(shown(), "rendered below the formula");
    assert.equal(calls.at(-1)!.source.trimEnd().split("\n").at(-1)!.endsWith("$a + b$"), true);
    // Typing inside re-renders from the buffer.
    view.dispatch({ changes: { from: text.indexOf(" b$") + 2, insert: "c" }, userEvent: "input.type" });
    await sleep(20);
    assert.ok(calls.at(-1)!.source.trimEnd().endsWith("$a + bc$"));
    assert.ok(shown());
    // Source mode: display math too.
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("x^2") } });
    await sleep(20);
    assert.ok(view.dom.querySelector(".lsp-cursor-preview div.tym-fragment.is-display"));
  } finally {
    view.destroy();
  }

  // Live preview: a display block keeps its own rendering below it; a display inside a line
  // and inline math get the preview.
  const live = new TypstLiveRenderer(render, CH1, () => document);
  const l = editor(render, () => true, text, CH1, {
    preview: () => true,
    live: livePreview({ language: typstLiveLanguage(), renderer: live }),
  });
  const preview = () => l.view.dom.querySelector(".lsp-cursor-preview");
  try {
    l.view.focus();
    await sleep(40);
    l.view.dispatch({ selection: { anchor: text.indexOf("x^2") } });
    await sleep(20);
    assert.equal(preview(), null, "a block: none");
    l.view.dispatch({ selection: { anchor: text.indexOf("y $") } });
    await sleep(20);
    assert.ok(preview(), "a display inside a line");
    l.view.dispatch({ selection: { anchor: text.indexOf("a +") } });
    await sleep(20);
    assert.ok(preview(), "inline math");
  } finally {
    l.view.destroy();
  }

  // Live preview that does not decorate (a document grown past maxLines): no rendering below
  // the block, so the cursor preview shows it.
  const long = editor(render, () => true, text, CH1, {
    preview: () => true,
    live: livePreview({ language: typstLiveLanguage(), renderer: live, maxLines: 1 }),
  });
  try {
    long.view.focus();
    await sleep(40);
    long.view.dispatch({ selection: { anchor: text.indexOf("x^2") } });
    await sleep(20);
    assert.ok(long.view.dom.querySelector(".lsp-cursor-preview div.tym-fragment.is-display"), "the block, live preview inactive");
  } finally {
    long.view.destroy();
    render.dispose();
  }
});

test("TypstRender cache: one render per formula and preamble; a change of a file it reads drops it", async () => {
  let broken = false;
  const { backend, calls } = fakeBackend((s) =>
    s.includes("frac(1, $") ? new FragmentError("unclosed delimiter") : broken ? new Error("timed out") : null,
  );
  const render = new TypstRender(backend, ROOT);
  const doc = Text.of(CH1_TEXT.split("\n"));
  const at = (d: Text, needle: string) => typstMathAt(d, d.toString().indexOf(needle))!;
  const math = (needle: string, d = doc) => render.math(CH1, d, at(d, needle));
  try {
    await math("EE[X] = integral");
    await math("EE[X] = integral");
    assert.equal(calls.length, 1, "a hit");
    // An edit elsewhere in the buffer leaves the key alone; a new statement above changes it.
    await math("EE[X] = integral", Text.of((CH1_TEXT + "\nmore text").split("\n")));
    assert.equal(calls.length, 1);
    await math("EE[X] = integral", Text.of(("#let extra = 1\n" + CH1_TEXT).split("\n")));
    assert.equal(calls.length, 2, "the chapter part is in the key");

    // Saving the chapter itself keeps its renders and its epoch (an autosave at every
    // typing pause), and those of its sibling, which does not read it. A template change
    // drops them all.
    const CH2 = join(ROOT, "book", "chapters", "ch2.typ");
    const ch2 = Text.of(readFileSync(CH2, "utf8").split("\n"));
    const inCh2 = () => render.math(CH2, ch2, at(ch2, "norm(x)$"));
    await inCh2();
    calls.pop(); // counted apart
    const [epoch1, epoch2] = [render.epoch(CH1), render.epoch(CH2)];
    render.fileChanged(CH1, "modify");
    await sleep(350);
    await math("EE[X] = integral");
    await inCh2();
    assert.equal(calls.length, 2);
    assert.deepEqual([render.epoch(CH1), render.epoch(CH2)], [epoch1, epoch2]);
    render.fileChanged(join(ROOT, "book", "template.typ"), "modify");
    await sleep(350);
    assert.deepEqual([render.epoch(CH1), render.epoch(CH2)], [epoch1 + 1, epoch2 + 1]);
    await math("EE[X] = integral");
    assert.equal(calls.length, 3);
    // Two files in one batch: the chapter's own renders go too.
    render.fileChanged(CH1, "modify");
    render.fileChanged(join(ROOT, "book", "template.typ"), "modify");
    await sleep(350);
    assert.equal(render.epoch(CH1), epoch1 + 2);
    await math("EE[X] = integral");
    assert.equal(calls.length, 4);
    calls.pop();

    // Typst errors are cached; failures of the renderer itself are not.
    const bad = Text.of([CH1_TEXT, "$frac(1, $"].join("\n").split("\n"));
    assert.deepEqual(await math("frac(1, $", bad), { ok: false, message: "unclosed delimiter" });
    await math("frac(1, $", bad);
    assert.equal(calls.length, 4);
    broken = true;
    const other = Text.of([CH1_TEXT, "$y + z$"].join("\n").split("\n"));
    assert.deepEqual(await math("y + z", other), { ok: false, message: "timed out", transient: true });
    broken = false;
    assert.ok((await math("y + z", other)).ok);
    assert.equal(calls.length, 6);

    // The same text in another folder is another render: relative imports resolve there.
    const twin = Text.of(['#import "defs.typ": *', "$x + y$"]);
    const inFolder = (dir: string) => render.math(join(ROOT, dir, "a.typ"), twin, at(twin, "x + y"));
    const n = calls.length;
    await inFolder("one");
    await inFolder("two");
    await inFolder("one");
    assert.deepEqual(calls.slice(n).map((c) => c.dir), [join(ROOT, "one"), join(ROOT, "two")]);

    // A render that finishes after a change (debounced 300 ms) is not cached.
    let delay = 400;
    let slowCalls = 0;
    const slow = new TypstRender({ render: async (_d, s) => (slowCalls++, await sleep(delay), page(s)) }, ROOT);
    const pending = slow.math(CH1, doc, at(doc, "EE[X] = integral"));
    slow.fileChanged(join(ROOT, "book", "template.typ"), "modify");
    await pending;
    delay = 0;
    await slow.math(CH1, doc, at(doc, "EE[X] = integral"));
    assert.equal(slowCalls, 2, "rendered again");
    slow.dispose();

    // Least recently used out after 2000.
    const many = Text.of([CH1_TEXT, ...Array.from({ length: 2001 }, (_, i) => `$x_${i}$`)].join("\n").split("\n"));
    const before = calls.length;
    for (let i = 0; i < 2001; i++) await math(`x_${i}$`, many);
    await math("x_2000$", many);
    assert.equal(calls.length, before + 2001);
    await math("x_0$", many);
    assert.equal(calls.length, before + 2002, "the oldest was dropped");
  } finally {
    render.dispose();
  }
});

test("TypstRender: renders are dropped 300 ms after the last .typ change, not the first", async () => {
  const render = new TypstRender({ render: async (_d, s) => page(s) }, ROOT);
  const TEMPLATE = join(ROOT, "book", "template.typ");
  try {
    const doc = Text.of(CH1_TEXT.split("\n"));
    await render.math(CH1, doc, typstMathAt(doc, CH1_TEXT.indexOf("EE[X] = integral"))!);
    const epoch = render.epoch(CH1);
    render.fileChanged(join(ROOT, "book", "chapters", "ch2.typ"), "create");
    await sleep(250);
    // A template write late in the window: tinymist may not have seen it at 300 ms.
    render.fileChanged(TEMPLATE, "modify");
    await sleep(100);
    assert.equal(render.epoch(CH1), epoch, "a later change postpones the drop");
    await sleep(250);
    assert.equal(render.epoch(CH1), epoch + 1, "one drop, 300 ms after the last change");
  } finally {
    render.dispose();
  }
});

test("render hover: math that needs its loop's or closure's variables shows no section; typos keep the error", async () => {
  const text = [
    '#let rates = (("a", 1), ("b", 2))',
    "#table(columns: 2, [$k$], ..rates.map(((k, r)) => ([#k], [$#r$])))",
    "#for i in range(3) [ $x_#i$ ]",
    "#strong[see $alpah$]",
    "",
  ].join("\n");
  // What Typst says of these formulas compiled alone, at the formula's line.
  const errors: Record<string, string> = {
    "$#r$": "unknown variable: r",
    "$x_#i$": "unknown variable: i",
    "$alpah$": "unknown variable: alpah",
  };
  const { backend } = fakeBackend((s) => {
    const lines = s.trimEnd().split("\n");
    const body = Object.keys(errors).find((b) => lines.at(-1)!.endsWith(b));
    return body ? new FragmentError(errors[body], lines.length) : null;
  });
  const render = new TypstRender(backend, ROOT);
  const file = join(ROOT, "book", "notes", "rates.typ");
  const { view, hoverAt } = editor(render, () => true, text, file);
  try {
    assert.deepEqual((await hoverAt("#r$")).map(kind), ["tinymist"], "a closure parameter");
    assert.deepEqual((await hoverAt("x_#i")).map(kind), ["tinymist"], "a loop variable");
    assert.deepEqual((await hoverAt("$k$")).map(kind), ["render", "tinymist"]);
    const [typo] = await hoverAt("alpah");
    assert.equal(typo.querySelector(".lsp-render-hover-message")?.textContent, "unknown variable: alpah");
    assert.equal(typo.querySelector(".lsp-render-hover-source")?.textContent, "$alpah$");
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("TypstRender: an error in a preamble statement is located there, not blamed on the formula", async () => {
  // The fake backend fails on a statement of the source as Typst would: at its line.
  const failAt = (needle: string, message: string) => (s: string) => {
    const line = s.split("\n").findIndex((l) => l.includes(needle));
    return line < 0 ? null : new FragmentError(message, line + 1);
  };
  const doc = (lines: string[]) => Text.of(lines);
  const at = (d: Text, needle: string) => typstMathAt(d, d.toString().indexOf(needle))!;
  let fail: (s: string) => Error | null = failAt("#let f(x) = x +", "expected expression");
  const backend: FragmentBackend = {
    async render(_dir, source) {
      const err = fail(source);
      if (err) throw err;
      return page(source);
    },
  };
  const render = new TypstRender(backend, ROOT);
  try {
    const typed = doc(["#import \"../template.typ\": *", "", "#let f(x) = x +", "The sum $a + b$ is fine."]);
    assert.deepEqual(await render.math(CH1, typed, at(typed, "a + b")), {
      ok: false,
      message: "expected expression",
      at: "book/chapters/ch1.typ:3: #let f(x) = x +",
    });
    // The cached error follows the statement when lines move above it.
    const moved = doc(["#import \"../template.typ\": *", "", "", "", "#let f(x) = x +", "The sum $a + b$ is fine."]);
    assert.equal((await render.math(CH1, moved, at(moved, "a + b")) as { at?: string }).at, "book/chapters/ch1.typ:5: #let f(x) = x +");

    // A statement of the book main, at its own line there.
    fail = failAt("#set math.equation", "expected string, found integer");
    const ch1 = Text.of(CH1_TEXT.split("\n"));
    const main = readFileSync(join(ROOT, "book", "main.typ"), "utf8").split("\n");
    const mainLine = main.findIndex((l) => l.startsWith("#set math.equation")) + 1;
    assert.deepEqual(await render.math(CH1, ch1, at(ch1, "EE[X] = integral")), {
      ok: false,
      message: "expected string, found integer",
      at: `book/main.typ:${mainLine}: #set math.equation(numbering: "(1.1)")`,
    });

    // The formula's own error: no location, the hover shows the formula.
    fail = failAt("$y + z$", "unknown variable: z");
    const own = doc(["$y + z$"]);
    assert.deepEqual(await render.math(CH1, own, at(own, "y + z")), { ok: false, message: "unknown variable: z" });
  } finally {
    render.dispose();
  }

  // In the hover: the statement in place of the formula.
  fail = failAt("#let f(x) = x +", "expected expression");
  const text = "#let f(x) = x +\nThe sum $a + b$ is fine.\n";
  const hovered = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(hovered, () => true, text);
  try {
    const [error] = await hoverAt("a + b");
    assert.equal(error.querySelector(".lsp-render-hover-message")?.textContent, "expected expression");
    assert.equal(error.querySelector(".lsp-render-hover-source")?.textContent, "book/chapters/ch1.typ:1: #let f(x) = x +");
  } finally {
    view.destroy();
    hovered.dispose();
  }
});

/** A vault with a book: main imports the template, which imports alias.typ; two chapters and a loose note. */
function tempBook() {
  const root = mkdtempSync(join(tmpdir(), "tinymist-deps-"));
  const book = join(root, "book");
  mkdirSync(join(book, "chapters"), { recursive: true });
  mkdirSync(join(book, "notes"));
  const write = (rel: string, text: string) => writeFileSync(join(book, rel), text);
  write("main.typ", '#import "template.typ": *\n#include "chapters/ch1.typ"\n#include "chapters/ch2.typ"\n');
  write("template.typ", '#import "alias.typ": *\n#let EE = $bb(E)$\n');
  write("alias.typ", "#let RR = $bb(R)$\n");
  write("chapters/ch1.typ", "$x$\n");
  write("chapters/ch2.typ", "$y$\n");
  write("notes/loose.typ", "$z$\n");
  write("notes/other.typ", "#let w = 1\n");
  const path = (rel: string) => join(book, rel);
  return { root, path, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("TypstRender: a modified file drops the renders of the files whose preambles read it, through imports", async () => {
  const book = tempBook();
  const { backend, calls } = fakeBackend();
  const render = new TypstRender(backend, book.root);
  const [ch1, ch2, loose] = ["chapters/ch1.typ", "chapters/ch2.typ", "notes/loose.typ"].map(book.path);
  let ch2Text = Text.of(["$y$"]);
  const texts = new Map([
    [ch1, Text.of(['#import "../template.typ": *', "$x$"])],
    [loose, Text.of(['#import "other.typ": w', "$z$"])],
  ]);
  const renderAll = async () => {
    for (const file of [ch1, ch2, loose]) {
      const doc = file === ch2 ? ch2Text : texts.get(file)!;
      await render.math(file, doc, typstMathAt(doc, doc.toString().lastIndexOf("$") - 1)!);
    }
  };
  const epochs = () => [ch1, ch2, loose].map((f) => render.epoch(f));
  /** The epochs a batch bumped, and how many formulas rendered again. */
  const change = async (...changes: [string, FileEvent][]) => {
    const before = epochs();
    for (const [rel, event] of changes) render.fileChanged(book.path(rel), event);
    await sleep(350);
    const n = calls.length;
    await renderAll();
    return { bumped: epochs().map((e, i) => e - before[i]), rendered: calls.length - n };
  };
  try {
    await renderAll();
    assert.equal(calls.length, 3);
    // A chapter's autosave: nobody reads it.
    assert.deepEqual(await change(["chapters/ch1.typ", "modify"]), { bumped: [0, 0, 0], rendered: 0 });
    // The template and the file it imports: both chapters (the book main imports the template),
    // not the loose note, which main does not include.
    assert.deepEqual(await change(["template.typ", "modify"]), { bumped: [1, 1, 0], rendered: 2 });
    assert.deepEqual(await change(["alias.typ", "modify"]), { bumped: [1, 1, 0], rendered: 2 });
    // The note's own import.
    assert.deepEqual(await change(["notes/other.typ", "modify"]), { bumped: [0, 0, 1], rendered: 1 });
    // The book main: it may start including any file below it.
    assert.deepEqual(await change(["main.typ", "modify"]), { bumped: [1, 1, 1], rendered: 3 });
    // A chapter that imports its sibling reads it.
    ch2Text = Text.of(['#import "ch1.typ": x', "$y$"]);
    await renderAll();
    assert.deepEqual(await change(["chapters/ch1.typ", "modify"]), { bumped: [0, 1, 0], rendered: 1 });
    // A template that starts importing another file: its own change counts, then the new one.
    writeFileSync(book.path("template.typ"), '#import "alias.typ": *\n#import "more.typ": *\n');
    assert.deepEqual(await change(["template.typ", "modify"]), { bumped: [1, 1, 0], rendered: 2 });
    assert.deepEqual(await change(["more.typ", "create"]), { bumped: [1, 1, 1], rendered: 3 });
    assert.deepEqual(await change(["more.typ", "modify"]), { bumped: [1, 1, 0], rendered: 2 });
    // A file created, deleted or renamed: every other file's renders go.
    assert.deepEqual(await change(["notes/new.typ", "create"]), { bumped: [1, 1, 1], rendered: 3 });
    assert.deepEqual(await change(["chapters/ch1.typ", "delete"]), { bumped: [0, 1, 1], rendered: 2 });
    assert.deepEqual(await change(["notes", "rename"]), { bumped: [1, 1, 1], rendered: 3 });
  } finally {
    render.dispose();
    book.close();
  }
});

test("TypstRender: a failure of the renderer itself is tried again once, when the renderer next answers", async () => {
  // A cold start past the render timeout fails the first render; the start goes on.
  let cold = true;
  const { backend, calls } = fakeBackend((s) => {
    if (s.endsWith("$slow$\n")) return new Error("rendering took longer than 5 s");
    if (!cold) return null;
    cold = false;
    return new Error("rendering took longer than 5 s");
  });
  const render = new TypstRender(backend, ROOT);
  const NOTE = join(ROOT, "book", "notes", "scratch.typ");
  const doc = Text.of(["$a$ $b$ $c$ $slow$ $d$ $e$"]);
  const math = (file: string, body: string) => render.math(file, doc, typstMathAt(doc, doc.toString().indexOf(body))!);
  let notified = 0;
  render.onChange(() => notified++);
  try {
    assert.deepEqual(await math(CH1, "$a$"), { ok: false, message: "rendering took longer than 5 s", transient: true });
    const [e1, e2] = [render.epoch(CH1), render.epoch(NOTE)];
    // The renderer answers another render: the failed file gets a new epoch (live views
    // render it again), other files keep theirs.
    assert.ok((await math(CH1, "$b$")).ok);
    assert.deepEqual([render.epoch(CH1), render.epoch(NOTE), notified], [e1 + 1, e2, 1]);
    assert.ok((await math(CH1, "$a$")).ok);
    assert.ok((await math(CH1, "$c$")).ok);
    assert.equal(notified, 1, "nothing left to retry");
    // A formula whose own compile passes the timeout is tried again once, not on every answer.
    assert.equal((await math(NOTE, "$slow$")).ok, false);
    assert.ok((await math(NOTE, "$d$")).ok);
    assert.deepEqual([render.epoch(NOTE), notified], [e2 + 1, 2]);
    assert.equal((await math(NOTE, "$slow$")).ok, false);
    assert.ok((await math(NOTE, "$e$")).ok);
    assert.deepEqual([render.epoch(NOTE), notified], [e2 + 1, 2]);
    // A settings save retries it, and only the files with failures.
    render.retryFailed();
    assert.deepEqual([render.epoch(CH1), render.epoch(NOTE), notified], [e1 + 1, e2 + 2, 3]);
    render.retryFailed();
    assert.equal(notified, 3, "nothing failed since");
    assert.equal(calls.filter((c) => c.source.endsWith("$slow$\n")).length, 2);
  } finally {
    render.dispose();
  }
});

test("TypstRender: an error in a template the preamble imports is located at the import, with the last rendering", async () => {
  // As Typst reports a broken template: at its own line, then "while importing" at the
  // fragment's line 1 (the book main's import), which typstExportError gives as the line.
  let broken = false;
  const backend: FragmentBackend = {
    async render(_dir, source) {
      if (broken) throw new FragmentError("unclosed delimiter (book/template.typ:9)", 1);
      return page(source);
    },
  };
  const render = new TypstRender(backend, ROOT);
  const doc = Text.of(CH1_TEXT.split("\n"));
  const at = (needle: string) => typstMathAt(doc, CH1_TEXT.indexOf(needle))!;
  try {
    const good = await render.math(CH1, doc, at("EE[X] = integral"));
    assert.ok(good.ok);
    broken = true;
    render.fileChanged(join(ROOT, "book", "template.typ"), "modify");
    await sleep(350);
    const r = await render.math(CH1, doc, at("EE[X] = integral"));
    assert.equal(r.ok, false);
    assert.deepEqual(
      { ...r, last: r.ok ? null : r.last === good },
      {
        ok: false,
        message: "unclosed delimiter (book/template.typ:9)",
        at: 'book/main.typ:2: #import "/book/template.typ": *',
        last: true,
      },
    );
    // A formula never rendered before has no last rendering.
    assert.equal(((await render.math(CH1, doc, at("X: Omega"))) as { last?: unknown }).last, undefined);
    // A statement of the file's own changes the formula: no last rendering either.
    const edited = Text.of(["#let extra = 1", ...CH1_TEXT.split("\n")]);
    const own = await render.math(CH1, edited, typstMathAt(edited, edited.toString().indexOf("EE[X] = integral"))!);
    assert.equal((own as { last?: unknown }).last, undefined);
  } finally {
    render.dispose();
  }
});
