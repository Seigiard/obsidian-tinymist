// TypstView on the test stand-in for Obsidian's TextFileView (tests/support/obsidian.ts).
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize } from "node:path";
import { undoDepth } from "@codemirror/commands";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorSelection } from "@codemirror/state";
import { EditorView, closeHoverTooltips } from "@codemirror/view";
import { HistoryCache } from "../src/editor/shared/editorKit";
import { isLive } from "../src/editor/shared/livePreview";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { TypstRender } from "../src/editor/typstRender";
import { TypstView } from "../src/editor/typstView";
import { LspDiagnostic, pathToUri } from "../src/lsp/client";
import type TinymistPlugin from "../src/main";
import { Notice, TFile, TextFileView, WorkspaceLeaf, testApp } from "./support/obsidian";
import { sleep } from "./support/keyMatrix";

/** `plugin` overrides fields of the stand-in plugin. */
function typstView(saveDebounceMs: number, plugin: Record<string, unknown> = {}) {
  const app = testApp();
  const didSave: (string | undefined)[] = [];
  // publishDiagnostics as LspClient and the plugin deliver it: store by URI, then notify.
  const diagnostics = new Map<string, LspDiagnostic[]>();
  const diagListeners = new Set<(uri: string) => void>();
  const publish = (path: string, diags: LspDiagnostic[]) => {
    const uri = pathToUri(`/vault/${path}`);
    diagnostics.set(uri, diags);
    for (const cb of diagListeners) cb(uri);
  };
  const stub = {
    app,
    lsp: {
      status: "stopped",
      completionTriggerCharacters: () => [],
      didSave: () => didSave.push(app.vault.files.get("a.typ")),
      diagnostics: (uri: string) => diagnostics.get(uri) ?? [],
    },
    settings: { saveDebounceMs },
    history: new HistoryCache(),
    yolo: new YoloBridge(app as never, { name: "test", enabled: () => false }),
    onDiagnostics: (cb: (uri: string) => void) => {
      diagListeners.add(cb);
      return () => diagListeners.delete(cb);
    },
    openPreview: async () => {},
    togglePreview: async () => {},
    syncPinnedMain: () => {},
    vaultBasePath: () => "/vault",
    preview: { cursorMoved: () => {} },
    typstRender: null,
    ...plugin,
  };
  const view = new TypstView(new WorkspaceLeaf(app) as never, stub as unknown as TinymistPlugin);
  return { view, vault: app.vault, app, didSave, publish };
}

function insert(cm: EditorView, from: number, to: number, text: string, compose: boolean) {
  cm.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: compose ? "input.type.compose" : "input.type",
  });
}

/** Real DOM composition events: CodeMirror's own observers track the composition. */
const composition = (cm: EditorView, type: "compositionstart" | "compositionend") =>
  cm.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "" }));

test("uncommitted IME text (Pinyin) is never written; the committed text is saved after compositionend", async () => {
  const requestSaveMs = TextFileView.requestSaveMs;
  // [the plugin's save debounce, Obsidian's requestSave debounce, the committed text]
  const cases: [number, number, string | null][] = [
    [50, 100000, "你好"], // the plugin's debounce fires mid-composition
    [100000, 50, "你好"], // Obsidian's own requestSave fires mid-composition
    [50, 100000, null], // a composition that changes nothing: the earlier edit is still saved
  ];
  try {
    for (const [saveDebounceMs, obsidianMs, committed] of cases) {
      TextFileView.requestSaveMs = obsidianMs;
      const { view, vault, didSave } = typstView(saveDebounceMs);
      vault.files.set("a.typ", "Hello ");
      await view.loadFile(new TFile("a.typ") as never);
      const cm = view.cm!;
      const label = JSON.stringify({ saveDebounceMs, obsidianMs, committed });
      try {
        insert(cm, 6, 6, "world, ", false); // a committed edit starts both debounces
        await sleep(10);
        composition(cm, "compositionstart");
        assert.equal(cm.compositionStarted, true);
        if (committed) insert(cm, 13, 13, "ni'hao", true); // the marked text is in the document
        await sleep(150);
        assert.deepEqual(vault.writes, [], label);
        assert.deepEqual(didSave, [], label);
        if (committed) insert(cm, 13, 19, committed, true); // picking a candidate replaces it
        composition(cm, "compositionend");
        await sleep(150);
        const saved = `Hello world, ${committed ?? ""}`;
        assert.deepEqual(vault.writes.map((w) => w.data), [saved], label);
        if (saveDebounceMs < 1000) assert.deepEqual(didSave, [saved], label);
      } finally {
        await view.onClose();
      }
    }
  } finally {
    TextFileView.requestSaveMs = requestSaveMs;
  }
});

test("a CRLF file stays CRLF: opening it and switching away never rewrites it; saves keep CRLF", async () => {
  const { view, vault } = typstView(50);
  const crlf = "= Title\r\n\r\n$ x $\r\n";
  vault.files.set("a.typ", crlf);
  vault.files.set("b.typ", "b\n");
  try {
    await view.loadFile(new TFile("a.typ") as never);
    assert.equal(view.cm!.state.doc.toString(), "= Title\n\n$ x $\n"); // CodeMirror holds LF
    assert.equal(view.getViewData(), crlf);
    await view.loadFile(new TFile("b.typ") as never); // switch away
    await view.loadFile(new TFile("a.typ") as never); // and back (the cached undo history)
    await sleep(100);
    assert.deepEqual(vault.writes, []);
    // An edit is saved with the file's CRLF line breaks; an LF file stays LF.
    let cm = view.cm!;
    insert(cm, cm.state.doc.length, cm.state.doc.length, "more\n", false);
    await sleep(150);
    assert.deepEqual(vault.writes.map((w) => w.data), [`${crlf}more\r\n`]);
    await view.loadFile(new TFile("b.typ") as never);
    cm = view.cm!;
    insert(cm, 1, 1, "\nc", false);
    await sleep(150);
    assert.deepEqual(vault.writes.map((w) => w.data).slice(1), ["b\nc\n"]);
    // A change from outside follows the new text's line breaks.
    view.setViewData("b\r\nc\r\nd\r\n", false);
    assert.equal(view.cm!.state.doc.toString(), "b\nc\nd\n");
    assert.equal(view.getViewData(), "b\r\nc\r\nd\r\n");
  } finally {
    await view.onClose();
  }
});

// ---- diagnostics while typing -----------------------------------------------------------------

/** An LSP error on 0-based `line`, characters `from`..`to`. */
const lspError = (line: number, from: number, to: number, message: string): LspDiagnostic => ({
  range: { start: { line, character: from }, end: { line, character: to } },
  severity: 1,
  message,
  source: "typst",
});

/** The editor's lint layer as "line: message", sorted. */
function shown(cm: EditorView): string[] {
  const out: string[] = [];
  forEachDiagnostic(cm.state, (d, from) => out.push(`${cm.state.doc.lineAt(from).number}: ${d.message}`));
  return out.sort();
}

/** Type `text` at the cursor one character at a time, as a keystroke would. */
function typeAtCursor(cm: EditorView, text: string) {
  for (const ch of text) {
    const at = cm.state.selection.main.head;
    insert(cm, at, at, ch, false);
  }
}

test("tinymist diagnostics: a new one on the line being typed waits for a ~1.5 s pause; other lines show at once", async () => {
  const { view, vault, publish } = typstView(100000);
  vault.files.set("a.typ", "= Title\n#let x = y\n\n");
  await view.loadFile(new TFile("a.typ") as never);
  const cm = view.cm!;
  const other = lspError(1, 9, 10, "unknown variable: y");
  try {
    publish("a.typ", [other]);
    assert.deepEqual(shown(cm), ["2: unknown variable: y"], "nothing typed: shown at once");

    // tinymist publishes after every keystroke on line 3.
    cm.dispatch({ selection: { anchor: cm.state.doc.line(3).from } });
    typeAtCursor(cm, "#f");
    publish("a.typ", [other, lspError(2, 1, 2, "unknown variable: f")]);
    assert.deepEqual(shown(cm), ["2: unknown variable: y"], "line 3 held, line 2 still shown");
    await sleep(300);
    typeAtCursor(cm, "o");
    publish("a.typ", [other, lspError(2, 1, 3, "unknown variable: fo")]);
    assert.deepEqual(shown(cm), ["2: unknown variable: y"]);

    // A diagnostic on another line appears and goes at once while line 3 is being typed.
    publish("a.typ", [lspError(0, 2, 7, "a warning elsewhere"), other, lspError(2, 1, 3, "unknown variable: fo")]);
    assert.deepEqual(shown(cm), ["1: a warning elsewhere", "2: unknown variable: y"]);
    publish("a.typ", [lspError(2, 1, 3, "unknown variable: fo")]);
    assert.deepEqual(shown(cm), [], "fixed elsewhere: removed at once");
    await sleep(1000);
    assert.deepEqual(shown(cm), [], "still inside the pause");
    await sleep(700);
    assert.deepEqual(shown(cm), ["3: unknown variable: fo"], "the pause reveals it");

    // Typing on: the stale error goes at once, the new one waits again.
    typeAtCursor(cm, "o");
    publish("a.typ", [lspError(2, 1, 4, "unknown variable: foo")]);
    assert.deepEqual(shown(cm), []);
    // The error on the cursor line disappears (fixed): removed at once, nothing comes back.
    typeAtCursor(cm, "t");
    publish("a.typ", []);
    await sleep(1700);
    assert.deepEqual(shown(cm), []);
  } finally {
    await view.onClose();
  }
});

test("tinymist diagnostics: leaving the typed line (a click, Enter) shows its held ones at once", async () => {
  const { view, vault, publish } = typstView(100000);
  vault.files.set("a.typ", "= Title\n\n");
  await view.loadFile(new TFile("a.typ") as never);
  const cm = view.cm!;
  const bar = lspError(1, 1, 4, "unknown variable: bar");
  try {
    // A change from outside (another pane's save) on the cursor line is not typing.
    cm.dispatch({ selection: { anchor: cm.state.doc.line(2).from } });
    view.setViewData("= Title\n#bar\n", false);
    publish("a.typ", [bar]);
    assert.deepEqual(shown(cm), ["2: unknown variable: bar"]);

    cm.dispatch({ selection: { anchor: cm.state.doc.line(3).from } });
    typeAtCursor(cm, "#fo");
    publish("a.typ", [bar, lspError(2, 1, 3, "unknown variable: fo")]);
    assert.deepEqual(shown(cm), ["2: unknown variable: bar"]);
    cm.dispatch({ selection: { anchor: 2 } }); // a click on line 1
    await Promise.resolve();
    assert.deepEqual(shown(cm), ["2: unknown variable: bar", "3: unknown variable: fo"]);

    // Back on line 3, typing again; Enter moves the cursor off the line.
    cm.dispatch({ selection: { anchor: cm.state.doc.line(3).to } });
    typeAtCursor(cm, "o");
    publish("a.typ", [bar, lspError(2, 1, 4, "unknown variable: foo")]);
    assert.deepEqual(shown(cm), ["2: unknown variable: bar"], "the stale error went at once");
    const end = cm.state.doc.line(3).to;
    cm.dispatch({ changes: { from: end, insert: "\n" }, selection: { anchor: end + 1 }, userEvent: "input" });
    await Promise.resolve();
    assert.deepEqual(shown(cm), ["2: unknown variable: bar", "3: unknown variable: foo"]);
  } finally {
    await view.onClose();
  }
});

test("render hover: the formula under the pointer through the plugin's TypstRender, gated by the setting", async () => {
  const calls: { dir: string; source: string }[] = [];
  const typstRender = new TypstRender(
    {
      async render(dir, source) {
        calls.push({ dir, source });
        return '<svg viewBox="0 0 10 12" width="10pt" height="12pt" xmlns="http://www.w3.org/2000/svg"><path fill="#0a0b0c" d="M 0 0"/></svg>';
      },
    },
    "/vault",
  );
  const settings = { saveDebounceMs: 100000, hoverRender: true };
  const { view, vault } = typstView(100000, { settings, typstRender });
  vault.files.set("a.typ", "Intro $x^2$ here\n");
  await view.loadFile(new TFile("a.typ") as never);
  const cm = view.cm!;
  // A resting pointer through CodeMirror's mousemove path (jsdom has no layout).
  const hoverAt = async (pos: number) => {
    cm.dispatch({ effects: closeHoverTooltips });
    Object.assign(cm, { posAtCoords: () => pos, coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }) });
    cm.contentDOM.querySelector(".cm-line")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
    await sleep(380);
    return cm.dom.querySelector(".cm-tooltip-hover .lsp-render-hover .tym-fragment svg");
  };
  try {
    const svg = await hoverAt(8);
    assert.ok(svg, "rendered");
    assert.equal(svg.querySelector("path")!.getAttribute("fill"), "currentColor");
    assert.deepEqual(calls.map((c) => c.dir), [normalize("/vault")]);
    assert.ok(calls[0].source.endsWith("$x^2$\n"));
    settings.hoverRender = false;
    assert.equal(await hoverAt(8), null, "setting off");
  } finally {
    await view.onClose();
    typstRender.dispose();
  }
});

test("cursor preview and paper hover through the view: the settings, and the invert setting in a dark theme", async () => {
  const typstRender = new TypstRender(
    {
      async render(_dir, source) {
        const w = source.includes("#set page(width: 400pt") ? 400 : 10;
        return `<svg viewBox="0 0 ${w} 12" width="${w}pt" height="12pt" xmlns="http://www.w3.org/2000/svg"><path fill="#0a0b0c" d="M 0 0"/></svg>`;
      },
    },
    "/vault",
  );
  const settings = { saveDebounceMs: 100000, hoverRender: true, cursorPreview: false, invertPreviewColors: "never" };
  const { view, vault } = typstView(100000, { settings, typstRender });
  vault.files.set("a.typ", "Intro $x^2$ here\n#block[boxed]\n");
  await view.loadFile(new TFile("a.typ") as never);
  const cm = view.cm!;
  const preview = () => cm.dom.querySelector(".cm-tooltip.lsp-cursor-preview:not(.is-empty) .tym-fragment svg");
  const hoverAt = async (pos: number) => {
    cm.dispatch({ effects: closeHoverTooltips });
    Object.assign(cm, { posAtCoords: () => pos, coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }) });
    cm.contentDOM.querySelector(".cm-line")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
    await sleep(380);
    return cm.dom.querySelector<HTMLElement>(".cm-tooltip-hover .lsp-render-hover .lsp-lp-paper");
  };
  try {
    cm.focus();
    await sleep(40);
    cm.dispatch({ selection: { anchor: 8 } });
    await sleep(10);
    assert.equal(preview(), null, "off by default");
    settings.cursorPreview = true;
    cm.dispatch({ selection: { anchor: 9 } });
    await sleep(10);
    assert.ok(preview(), "on: the formula at the cursor");

    const block = "Intro $x^2$ here\n".length + 2;
    const paper = await hoverAt(block);
    assert.ok(paper && !paper.classList.contains("is-inverted"), "a page, not inverted");
    settings.invertPreviewColors = "auto";
    assert.ok(!(await hoverAt(block))!.classList.contains("is-inverted"), "auto, light theme");
    document.body.classList.add("theme-dark");
    assert.ok((await hoverAt(block))!.classList.contains("is-inverted"), "auto, dark theme");
  } finally {
    document.body.classList.remove("theme-dark");
    await view.onClose();
    typstRender.dispose();
  }
});

test("tinymist's hover: closed by typing; in a rendered formula, not a symbol's sampled values", async () => {
  const typstRender = new TypstRender(
    {
      async render() {
        return '<svg viewBox="0 0 10 12" width="10pt" height="12pt" xmlns="http://www.w3.org/2000/svg"><path fill="#0a0b0c" d="M 0 0"/></svg>';
      },
    },
    "/vault",
  );
  const text = "Sum $integral x + EE$ and #sym.integral here\n";
  // tinymist's answers: a symbol's sampled values, an alias's signature.
  const hover = async (_path: string, pos: { line: number; character: number }) => {
    const at = pos.character;
    const word = (/[\w.]*$/.exec(text.slice(0, at))?.[0] ?? "") + (/^[\w.]*/.exec(text.slice(at))?.[0] ?? "");
    const value = word.endsWith("EE")
      ? "```typc\nlet EE = op;\n```"
      : word.endsWith("integral")
        ? '### Sampled Values\n```typc\nsymbol("∫")\n```'
        : "";
    return value && { contents: { kind: "markdown", value } };
  };
  const lsp = {
    status: "running",
    serverCapabilities: null,
    completionTriggerCharacters: () => [],
    diagnostics: () => [],
    didOpen: () => {},
    didChange: () => {},
    didChangeRanges: () => {},
    didClose: () => {},
    didSave: () => {},
    hover,
  };
  const settings = { saveDebounceMs: 100000, hoverRender: true };
  const { view, vault } = typstView(100000, { settings, typstRender, lsp });
  vault.files.set("a.typ", text);
  await view.loadFile(new TFile("a.typ") as never);
  const cm = view.cm!;
  const sections = () =>
    [...(cm.dom.querySelector(".cm-tooltip-hover")?.children ?? [])].map((el) =>
      el.classList.contains("lsp-render-hover") ? "render" : el.classList.contains("tym-hover") ? "tinymist" : el.className,
    );
  const hoverAt = async (needle: string) => {
    cm.dispatch({ effects: closeHoverTooltips });
    const pos = text.indexOf(needle) + 1;
    Object.assign(cm, { posAtCoords: () => pos, coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }) });
    cm.contentDOM.querySelector(".cm-line")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
    await sleep(380);
    return sections();
  };
  try {
    assert.deepEqual(await hoverAt("integral x"), ["render"], "the render shows the symbol");
    assert.deepEqual(await hoverAt("EE$"), ["render", "tinymist"], "an alias's signature stays");
    assert.deepEqual(await hoverAt("integral here"), ["tinymist"], "outside math");
    // Typing closes tinymist's section as it closes the render's.
    cm.dispatch({ changes: { from: text.length - 1, insert: "!" }, userEvent: "input.type" });
    await sleep(50);
    assert.deepEqual(sections(), []);
    settings.hoverRender = false;
    assert.deepEqual(await hoverAt("integral x"), ["tinymist"], "no render: tinymist's answer is all there is");
  } finally {
    await view.onClose();
    typstRender.dispose();
  }
});

// ---- live preview: the editing mode -----------------------------------------------------------

/** A TypstRender whose backend answers every fragment with a small page, counting calls. */
function fakeTypstRender() {
  const calls: string[] = [];
  const dirs: string[] = [];
  const typstRender = new TypstRender(
    {
      async render(dir, source) {
        calls.push(source);
        dirs.push(dir);
        return '<svg viewBox="0 0 10 12" width="10pt" height="12pt" xmlns="http://www.w3.org/2000/svg"><path fill="#0a0b0c" d="M 0 0"/></svg>';
      },
    },
    "/vault",
  );
  return { typstRender, calls, dirs };
}

const liveWidgets = (cm: EditorView) => cm.contentDOM.querySelectorAll(".lsp-lp-render:not(.is-below)").length;

async function waitUntil(pred: () => boolean, what: string, timeout = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("editing mode: the setting's default, the view state, the header action and the toggle keep the editor's state", async () => {
  const { typstRender, dirs } = fakeTypstRender();
  const settings = { saveDebounceMs: 100000, hoverRender: true, editingMode: "source" };
  const { view, vault, app } = typstView(100000, { settings, typstRender });
  vault.files.set("a.typ", "Intro $x^2$ here\n$ y $\n");
  vault.files.set("b.typ", "Other $z$\n");
  await view.loadFile(new TFile("a.typ") as never);
  try {
    let cm = view.cm!;
    const [action] = view.actions;
    assert.equal(view.editingMode, "source", "the default");
    assert.deepEqual(view.getState(), { file: "a.typ", mode: "source" });
    assert.deepEqual([action.dataset.icon, action.getAttribute("aria-label")], ["book-open", "Switch to live preview"]);
    assert.equal(isLive(cm.state), false);

    // An edit and a selection, then the header action: live, with the same state.
    cm.dispatch({ changes: { from: 0, insert: "An " }, userEvent: "input.type" });
    cm.dispatch({ selection: EditorSelection.single(1, 3) });
    const doc = cm.state.doc;
    action.click();
    assert.equal(view.editingMode, "live");
    assert.equal(isLive(cm.state), true);
    assert.equal(cm.state.doc, doc);
    assert.deepEqual([cm.state.selection.main.anchor, cm.state.selection.main.head], [1, 3]);
    assert.equal(undoDepth(cm.state), 1);
    assert.deepEqual([action.dataset.icon, action.getAttribute("aria-label")], ["code", "Switch to source mode"]);
    assert.ok(view.contentEl.classList.contains("is-live-preview"));
    assert.equal(app.workspace.layoutSaves, 1, "the layout (and the mode) is saved");
    assert.deepEqual(view.getState(), { file: "a.typ", mode: "live" });
    await waitUntil(() => liveWidgets(cm) === 2, "widgets");
    assert.match(view.renderStatistics()!, /^2 renders/);

    // The command's toggle, and back.
    view.toggleMode();
    assert.equal(isLive(cm.state), false);
    assert.equal(liveWidgets(cm), 0);
    assert.equal(view.renderStatistics(), null);
    assert.ok(!view.contentEl.classList.contains("is-live-preview"));
    view.toggleMode();
    assert.equal(liveWidgets(cm), 2, "its renders are kept across the switch");

    // Obsidian restores a leaf with its state: the mode comes with it; a state without one
    // (another file opened in the leaf) keeps the leaf's mode, as in Markdown views.
    await view.setState({ file: "a.typ", mode: "source" }, { history: false });
    assert.equal(isLive(cm.state), false, "the same file, not reloaded");
    await view.setState({ file: "a.typ", mode: "live" }, { history: false });
    assert.equal(isLive(cm.state), true);
    await view.setState({ file: "b.typ" }, { history: false });
    cm = view.cm!;
    assert.equal(view.editingMode, "live");
    assert.equal(isLive(cm.state), true);
    await waitUntil(() => liveWidgets(cm) === 1, "b.typ's widget");
    await view.setState({ file: "a.typ", mode: "source" }, { history: false });
    assert.equal(isLive(view.cm!.state), false);

    // Renamed (moved) in live mode: renders start afresh from the new folder.
    await view.setState({ file: "a.typ", mode: "live" }, { history: false });
    await waitUntil(() => liveWidgets(view.cm!) === 2, "widgets before the move");
    const n = dirs.length;
    view.file = new TFile("sub/a.typ");
    await view.onRename(view.file as never);
    await waitUntil(() => dirs.length === n + 2 && liveWidgets(view.cm!) === 2, "widgets after the move");
    assert.deepEqual(dirs.slice(n), [normalize("/vault/sub"), normalize("/vault/sub")]);
  } finally {
    await view.onClose();
    typstRender.dispose();
  }
});

test("editing mode: a reopened file's cached history comes back in the view's mode", async () => {
  const { typstRender } = fakeTypstRender();
  const settings = { saveDebounceMs: 100000, hoverRender: true, editingMode: "live" };
  const { view, vault } = typstView(100000, { settings, typstRender });
  vault.files.set("a.typ", "Intro $x$\n");
  vault.files.set("b.typ", "Other\n");
  try {
    await view.loadFile(new TFile("a.typ") as never);
    assert.equal(view.editingMode, "live", "the setting's default");
    let cm = view.cm!;
    await waitUntil(() => liveWidgets(cm) === 1, "widget");
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: "more\n" }, userEvent: "input.type" });
    await view.setState({ file: "b.typ", mode: "source" }, { history: false });
    await view.setState({ file: "a.typ", mode: "live" }, { history: false });
    cm = view.cm!;
    assert.equal(undoDepth(cm.state), 1, "the cached history");
    assert.equal(isLive(cm.state), true, "restored with the live compartment");
    await waitUntil(() => liveWidgets(cm) === 1, "widget again");
  } finally {
    await view.onClose();
    typstRender.dispose();
  }
});

test("editing mode: live preview refuses files over 10,000 lines", async () => {
  const { typstRender, calls } = fakeTypstRender();
  const settings = { saveDebounceMs: 100000, hoverRender: true, editingMode: "source" };
  const { view, vault } = typstView(100000, { settings, typstRender });
  const long = Array.from({ length: 10001 }, (_, i) => `line ${i} $x_${i}$`).join("\n");
  vault.files.set("long.typ", long);
  vault.files.set("short.typ", "$x$\n");
  Notice.shown.length = 0;
  try {
    await view.loadFile(new TFile("long.typ") as never);
    assert.equal(view.setMode("live"), false);
    assert.equal(view.editingMode, "source");
    assert.equal(isLive(view.cm!.state), false);
    assert.deepEqual(Notice.shown, ["Tinymist: live preview is limited to 10,000 lines (this file has 10,001)."]);
    // Opened in live mode (a restored leaf, the default setting): source.
    await view.setState({ file: "short.typ", mode: "live" }, { history: false });
    assert.equal(isLive(view.cm!.state), true);
    await view.setState({ file: "long.typ", mode: "live" }, { history: false });
    assert.equal(view.editingMode, "source");
    assert.equal(isLive(view.cm!.state), false);
    await sleep(50);
    assert.ok(!calls.some((c) => c.includes("$x_1$")), "nothing rendered");
  } finally {
    await view.onClose();
    typstRender.dispose();
  }
});
