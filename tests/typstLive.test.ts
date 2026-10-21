// The Typst editor's real extension stack (typstEditorExtensions) against a real
// tinymist in jsdom: completion, smart Enter, snippets, postfix edits, labels, the
// incremental document sync, the book-main pin (also across a preview configuration
// change), the key arbiter with a fake YOLO, and TypstView's diagnostics while typing.
// Skipped when no tinymist binary is found (TINYMIST_BIN overrides the lookup).
import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { HistoryCache } from "../src/editor/shared/editorKit";
import { YoloBridge, YoloEditorShim } from "../src/editor/shared/yoloBridge";
import {
  LspDocument,
  tinymistBackend,
  typstEditorExtensions,
} from "../src/editor/typstEditor";
import { TypstView } from "../src/editor/typstView";
import { LspClient, pathToUri } from "../src/lsp/client";
import type TinymistPlugin from "../src/main";
import { bookMain } from "../src/preview/previewEntry";
import { fakeYolo } from "./support/fakeYolo";
import { press, quietSettings, sleep, waitFor } from "./support/keyMatrix";
import { TFile, WorkspaceLeaf, testApp } from "./support/obsidian";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

const BASE = [
  "#let theorem(title: none, body) = block[*Theorem* #title: #body]",
  "= Basics <basics>",
  "$ theta + sigma = sum_(i = 1)^n x_i $ <eq-sum>",
  "",
].join("\n");

interface Harness {
  view: EditorView;
  bridge: YoloBridge;
  yolo: ReturnType<typeof fakeYolo>;
  close(): void;
}

test("the Typst editor stack against a real tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-live-"));
  const file = join(root, "main.typ");
  writeFileSync(file, BASE);
  const debug = console.debug;
  console.debug = () => {}; // the client forwards tinymist's stderr log here
  // publishDiagnostics reaches TypstView through the plugin's listeners (main.ts).
  const diagListeners = new Set<(uri: string) => void>();
  const lsp = new LspClient(BIN!, root, (uri) => diagListeners.forEach((cb) => cb(uri)));
  let full = 0;
  let ranges = 0;
  const didChange = lsp.didChange.bind(lsp);
  const didChangeRanges = lsp.didChangeRanges.bind(lsp);
  lsp.didChange = (p, text) => (full++, didChange(p, text));
  lsp.didChangeRanges = (p, changes) => (ranges++, didChangeRanges(p, changes));
  await lsp.start();

  /** An editor on `path` whose text is `docWithCursor` (`|` = cursor), opened on the server. */
  async function open(docWithCursor: string, path = file, client = lsp): Promise<Harness> {
    const lsp = client;
    const cursor = docWithCursor.indexOf("|");
    const doc = docWithCursor.replace("|", "");
    const yolo = fakeYolo({ settings: quietSettings() });
    const app = { plugins: { plugins: { yolo: yolo.plugin } } } as unknown as App;
    const bridge = new YoloBridge(app, { name: "test", enabled: () => true });
    const lspFile = new LspDocument(() => lsp);
    const view: EditorView = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: typstEditorExtensions(
          {
            completion: tinymistBackend(() => lsp, () => path, (state) => lspFile.sync(state.doc)),
            inline: () => bridge.inline,
            yolo: bridge.extension(() => "main.typ"),
            onEdit: (_v, changes, startDoc) => lspFile.sync(view.state.doc, { changes, startDoc }),
          },
          doc,
        ),
      }),
      parent: document.body,
    });
    view.focus();
    lspFile.open(path, view.state.doc);
    await sleep(1000); // first compile (labels come from the compiled document)
    return {
      view,
      bridge,
      yolo,
      close() {
        view.destroy();
        bridge.destroy();
        lspFile.close();
      },
    };
  }

  /** Type through the input handlers, pausing like a person (past the 100 ms delay). */
  async function type(view: EditorView, text: string, gap = 150) {
    for (const ch of text) {
      const { from, to } = view.state.selection.main;
      const insert = () =>
        view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
      await sleep(gap);
    }
  }
  const usable = async (view: EditorView) => {
    await waitFor(() => selectedCompletionIndex(view.state) !== null, 5000);
    await sleep(90); // interactionDelay
  };
  const labels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);
  const line = (view: EditorView) => {
    const head = view.state.selection.main.head;
    const l = view.state.doc.lineAt(head);
    return l.text.slice(0, head - l.from) + "|" + l.text.slice(head - l.from);
  };

  try {
    await t.test("$ x = the + Tab gives theta (a symbol the document uses)", async () => {
      const h = await open(BASE + "$ x = |$\n");
      try {
        await type(h.view, "the");
        await usable(h.view);
        assert.equal(labels(h.view)[0], "theta");
        assert.equal(press(h.view, "Tab").handled, true);
        assert.equal(line(h.view), "$ x = theta|$");
      } finally {
        h.close();
      }
    });

    await t.test("theta typed with 150 ms gaps, then Enter: a newline, still lowercase", async () => {
      const h = await open(BASE + "$ x = |$\n");
      try {
        await type(h.view, "theta");
        await usable(h.view);
        press(h.view, "Enter");
        await sleep(0);
        assert.match(h.view.state.doc.toString(), /\$ x = theta\n\$\n$/);
        assert.equal(completionStatus(h.view.state), null);
      } finally {
        h.close();
      }
    });

    await t.test("#fi, pick figure.paren, Tab: the cursor lands inside the parentheses", async () => {
      const h = await open(BASE + "|\n");
      try {
        await type(h.view, "#fi");
        await usable(h.view);
        const at = labels(h.view).indexOf("figure.paren");
        assert.ok(at > 0, labels(h.view).slice(0, 8).join(", "));
        for (let i = 0; i < at; i++) press(h.view, "ArrowDown");
        press(h.view, "Tab");
        assert.equal(line(h.view), "#figure(|)");
      } finally {
        h.close();
      }
    });

    await t.test("postfix: $arrow. then bb + Tab rewrites to bb(arrow)", async () => {
      const h = await open(BASE + "$arrow|$\n");
      try {
        await type(h.view, ".bb");
        await usable(h.view);
        assert.equal(labels(h.view)[0], "bb");
        press(h.view, "Tab");
        assert.equal(line(h.view), "$bb(arrow)|$");
      } finally {
        h.close();
      }
    });

    await t.test("$ a arrow. keeps tinymist's order: modifiers before postfix rewrites", async () => {
      const h = await open(BASE + "$ a arrow|$\n");
      try {
        await type(h.view, ".", 250);
        await usable(h.view);
        assert.deepEqual(labels(h.view).slice(0, 2), ["b", "bar"]);
        press(h.view, "Tab");
        assert.equal(line(h.view), "$ a arrow.b|$");
      } finally {
        h.close();
      }
    });

    await t.test("a list `.` opened is not accepted by Enter until the user types or navigates", async () => {
      // TS-1: Enter used to take tinymist's first member or postfix item and rewrite the text.
      for (const [doc, after] of [
        ["as proved in #cite(<basics>)|\n", "as proved in #cite(<basics>).\n|"],
        ["$\n  forall x in A|\n$\n", "  forall x in A.\n  |"],
        ["We have #calc|\n", "We have #calc.\n|"],
        ["$ a arrow|$\n", "$ a arrow.\n|"], // not rewritten by a modifier or postfix item
      ]) {
        const h = await open(BASE + doc);
        try {
          await type(h.view, ".", 250);
          await usable(h.view);
          press(h.view, "Enter");
          const d = h.view.state.doc.toString();
          const head = h.view.state.selection.main.head;
          const around = d.slice(d.lastIndexOf("\n", d.lastIndexOf("\n", head - 1) - 1) + 1, head) + "|";
          assert.equal(around, after, doc);
          assert.equal(completionStatus(h.view.state), null);
        } finally {
          h.close();
        }
      }
      // Typed on, or navigated: Enter accepts.
      const h = await open(BASE + "#calc|\n");
      try {
        await type(h.view, ".ab", 250);
        await usable(h.view);
        press(h.view, "Enter");
        assert.equal(line(h.view), "#calc.abs(|)");
        const l4 = h.view.state.doc.line(4);
        h.view.dispatch({ changes: { from: l4.from, to: l4.to, insert: "#calc" }, selection: { anchor: l4.from + 5 } });
        await type(h.view, ".", 250);
        await usable(h.view);
        const second = labels(h.view)[1];
        press(h.view, "ArrowDown");
        press(h.view, "Enter");
        assert.ok(line(h.view).startsWith(`#calc.${second}`), `${second}: ${line(h.view)}`);
      } finally {
        h.close();
      }
      // In math too. (A fresh file: with the erroring `#calc.pow()` above in the document,
      // tinymist 0.15.2 answers nothing after `$ a arrow.`)
      const m = await open(BASE + "$ a arrow|$\n");
      try {
        await type(m.view, ".ba", 250);
        await usable(m.view);
        press(m.view, "Enter");
        assert.equal(line(m.view), "$ a arrow.bar|$");
      } finally {
        m.close();
      }
    });

    await t.test('string values: "us-le filters one list, Enter inserts the whole value', async () => {
      const h = await open(BASE + "#set page(paper: |)\n");
      try {
        await type(h.view, '"us-le');
        await usable(h.view);
        assert.ok(labels(h.view).slice(0, 3).every((l) => l.startsWith('"us-le')), labels(h.view).slice(0, 5).join(", "));
        press(h.view, "Enter");
        assert.match(line(h.view), /^#set page\(paper: "us-le[a-z]+\|"\)$/);
      } finally {
        h.close();
      }
    });

    await t.test("@ completes the document's labels", async () => {
      const h = await open(BASE + "See |\n");
      try {
        await type(h.view, "@");
        await usable(h.view);
        assert.ok(labels(h.view).includes("eq-sum"), labels(h.view).join(", "));
        await type(h.view, "ba");
        await usable(h.view);
        press(h.view, "Tab");
        assert.equal(line(h.view), "See @basics|");
      } finally {
        h.close();
      }
    });

    await t.test("@ label rows describe figures as 'Figure · A box', not ': A boxFigure'", async () => {
      const h = await open(
        BASE +
          "#figure(rect(width: 2cm), caption: [A box]) <fig:box>\n" +
          "= Measure theory <sec:measure>\n" +
          "See |\n",
      );
      try {
        await type(h.view, "@");
        await usable(h.view);
        const detail = (label: string) => currentCompletions(h.view.state).find((c) => c.label === label)?.detail;
        assert.equal(detail("fig:box"), "Figure · A box");
        assert.equal(detail("sec:measure"), "Measure theory");
        // The rendered popup rows: the label, then the description; no glyph for labels.
        await waitFor(() => !!h.view.dom.querySelector(".cm-tooltip-autocomplete li"), 2000);
        const rows = [...h.view.dom.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) =>
          [".cm-completionLabel", ".cm-completionDetail"].map((c) => li.querySelector(c)?.textContent ?? ""),
        );
        assert.deepEqual(rows.find(([l]) => l === "fig:box"), ["fig:box", "Figure · A box"], JSON.stringify(rows));
        assert.deepEqual(rows.find(([l]) => l === "sec:measure"), ["sec:measure", "Measure theory"]);
        assert.ok(!h.view.dom.querySelector(".cm-tooltip-autocomplete")!.textContent!.includes(": A box"));
      } finally {
        h.close();
      }
    });

    await t.test("@ label rows cut caption and supplement only where that is certain", async () => {
      // A chapter the document includes, and a bibliography with a title that starts like a caption.
      writeFileSync(
        join(root, "chap.typ"),
        "#figure(rect(), caption: [Chapter box]) <c:box>\n" +
          "#figure(rect(), caption: [Performance of JavaScript], supplement: none) <c:js>\n",
      );
      writeFileSync(
        join(root, "refs.bib"),
        "@book{knuth84, title = {Literate Programming}, author = {Knuth, Donald}, year = {1984}}\n" +
          "@manual{colon, title = {: A Document Preparation SystemManual}, author = {Lamport, Leslie}, year = {1994}}\n",
      );
      const h = await open(
        BASE +
          '#include "chap.typ"\n' +
          "#figure(rect(), caption: [Performance of JavaScript], supplement: none) <fig:js>\n" +
          "#figure(rect(), caption: [A box], supplement: [Supplementary Figure]) <fig:multi>\n" +
          "#block[: starts with colon] <blk:colon>\n" +
          '#bibliography("refs.bib")\n' +
          "See |\n",
      );
      try {
        await type(h.view, "@");
        await usable(h.view);
        const detail = (label: string) => currentCompletions(h.view.state).find((c) => c.label === label)?.detail;
        assert.equal(detail("c:box"), "Figure · Chapter box");
        assert.equal(detail("c:js"), "Performance of JavaScript");
        assert.equal(detail("fig:js"), "Performance of JavaScript");
        assert.equal(detail("fig:multi"), "Supplementary Figure · A box");
        assert.equal(detail("blk:colon"), ": starts with colon");
        assert.equal(detail("knuth84"), "Literate Programming");
        assert.equal(detail("colon"), ": A Document Preparation SystemManual");
      } finally {
        h.close();
      }
    });

    await t.test("edits reach the server incrementally", () => {
      assert.ok(ranges > 10, `incremental: ${ranges}`);
      assert.equal(full, 0);
    });

    await t.test("a chapter pinned through its book main completes other chapters' labels", async () => {
      const book = join(root, "book");
      mkdirSync(join(book, "chapters"), { recursive: true });
      const main = join(book, "main.typ");
      writeFileSync(main, '#include "chapters/a.typ"\n#include "chapters/b.typ"\n');
      const a = join(book, "chapters", "a.typ");
      writeFileSync(a, "= Chapter A <ch-a>\n");
      writeFileSync(join(book, "chapters", "b.typ"), "= Chapter B <ch-b>\n");
      assert.equal(bookMain(a, root), main);
      // This independent book scenario owns its compiler; the pin/configuration
      // transitions below still exercise the same live server throughout.
      const lsp = new LspClient(BIN!, root, () => {});
      await lsp.start();
      const h = await open("= Chapter A <ch-a>\nSee |\n", a, lsp);
      try {
        lsp.pinMain(main);
        await sleep(1000);
        // A preview configuration change resets tinymist's entry; the client re-pins.
        lsp.setPreviewSource("/book/chapters/a.typ");
        await sleep(300);
        await type(h.view, "@");
        await usable(h.view);
        assert.deepEqual(labels(h.view).sort(), ["ch-a", "ch-b"]);
      } finally {
        lsp.setPreviewSource();
        await lsp.executeCommand("tinymist.pinMain", [null]);
        h.close();
        lsp.stop();
      }
    });

    await t.test("key arbiter with a (fake) YOLO: raw accept, popup wins, Enter never accepts AI", async () => {
      const h = await open(BASE + "Intro |\n");
      const ghost = async (text: string) => {
        assert.ok(h.bridge.triggerNow(h.view));
        h.yolo.respond(text);
        await sleep(0);
      };
      try {
        await ghost("<intro>");
        assert.equal(h.view.contentDOM.querySelector(".yolo-ghost-text")?.textContent, "<intro>");
        press(h.view, "Tab");
        assert.equal(line(h.view), "Intro <intro>|"); // not YOLO's Markdown-escaped \<intro\>
        await ghost("more");
        press(h.view, "Enter");
        await sleep(0);
        assert.equal(line(h.view), "|");
        assert.ok(!h.view.state.doc.toString().includes("more"));
        // The completion popup wins over a ghost that arrives while it is open.
        await type(h.view, "#fi");
        await usable(h.view);
        void h.yolo.tab.run(new YoloEditorShim(h.view), h.view.state.selection.main.head);
        h.yolo.respond("gure(x)");
        await sleep(10);
        assert.equal(h.view.contentDOM.querySelector(".yolo-ghost-text"), null);
        press(h.view, "Tab");
        assert.equal(line(h.view), "#figure|");
        assert.deepEqual(h.yolo.hijacked, []); // YOLO's own keymap is never mounted
      } finally {
        h.close();
      }
    });

    await t.test("TypstView: tinymist's per-keystroke errors on the typed line wait for a pause", async () => {
      // Isolate diagnostic behavior from prior document-close jobs: Tinymist's
      // asynchronous VFS snapshots may still be settling after another scenario.
      // This remains a real server with the same per-keystroke UI assertions.
      const diagListeners = new Set<(uri: string) => void>();
      const lsp = new LspClient(BIN!, root, (uri) => diagListeners.forEach((cb) => cb(uri)));
      await lsp.start();
      const name = "diag.typ";
      const text = "= Diagnostics\n\n#nosuchname\n";
      writeFileSync(join(root, name), text);
      const app = testApp();
      app.vault.files.set(name, text);
      const yolo = new YoloBridge(app as never, { name: "test", enabled: () => false });
      const plugin = {
        app,
        lsp,
        settings: { saveDebounceMs: 100000 },
        history: new HistoryCache(),
        yolo,
        onDiagnostics: (cb: (uri: string) => void) => {
          diagListeners.add(cb);
          return () => diagListeners.delete(cb);
        },
        openPreview: async () => {},
        togglePreview: async () => {},
        syncPinnedMain: () => {},
        vaultBasePath: () => root,
        preview: { cursorMoved: () => {} },
      };
      const view = new TypstView(new WorkspaceLeaf(app) as never, plugin as unknown as TinymistPlugin);
      const uri = pathToUri(join(root, name));
      /** What tinymist last published and what the editor's lint layer shows, as "line: message" (no hints). */
      const first = (message: string) => message.split("\n")[0];
      const published = () =>
        lsp.diagnostics(uri).map((d) => `${d.range.start.line + 1}: ${first(d.message)}`).sort();
      const shown = () => {
        const out: string[] = [];
        const cm = view.cm!;
        forEachDiagnostic(cm.state, (d, from) => out.push(`${cm.state.doc.lineAt(from).number}: ${first(d.message)}`));
        return out.sort();
      };
      // Typing happens on line 2; line 3 holds an error from the start.
      const typed = (list: string[]) => list.filter((d) => d.startsWith("2: "));
      const elsewhere = (list: string[]) => list.filter((d) => !d.startsWith("2: "));
      const other = "3: unknown variable: nosuchname";
      try {
        await view.loadFile(new TFile(name) as never);
        const cm = view.cm!;
        await waitFor(() => shown().includes(other), 10000);
        cm.focus();
        cm.dispatch({ selection: { anchor: cm.state.doc.line(2).from } });

        // `#fo` typed with 150 ms gaps: tinymist reports each half-typed name at once.
        let held = 0;
        let lastKey = 0;
        for (const ch of "#fo") {
          await type(cm, ch, 0);
          lastKey = Date.now();
          for (let i = 0; i < 6; i++) {
            await sleep(25);
            if (typed(published()).length) held++;
            assert.deepEqual(typed(shown()), [], `while typing: ${published().join("; ")}`);
            // Other lines follow tinymist at once (it drops line 3's error while line 2 fails).
            assert.deepEqual(elsewhere(shown()), elsewhere(published()));
          }
        }
        // Native file watching/compiler scheduling may publish after the last
        // 150 ms typing interval. Observe that event before testing the hold.
        if (held === 0) {
          await waitFor(() => typed(published()).length > 0, 1000);
          assert.deepEqual(typed(shown()), [], "a newly published typing diagnostic is still held");
        }
        await waitFor(() => typed(shown()).length > 0, 5000);
        const paused = Date.now() - lastKey;
        assert.ok(paused >= 1400, `shown after a ${paused} ms pause`);
        assert.deepEqual(typed(shown()), ["2: unknown variable: fo"]);

        // Typing on: the stale error goes with tinymist's next publish, the new one waits.
        await type(cm, "o", 0);
        await waitFor(() => published().includes("2: unknown variable: foo"), 5000);
        assert.deepEqual(typed(shown()), []);
        assert.deepEqual(elsewhere(shown()), elsewhere(published()));
        cm.dispatch({ selection: { anchor: 2 } }); // a click on line 1
        await Promise.resolve();
        assert.deepEqual(typed(shown()), ["2: unknown variable: foo"], "leaving the line shows it");

        // Fixing the line while typing on it: its error goes as soon as tinymist drops it,
        // and line 3's error, back in the same publish, shows at once.
        const l2 = cm.state.doc.line(2);
        cm.dispatch({
          changes: { from: l2.from, to: l2.to, insert: "#let foo = 1" },
          selection: { anchor: l2.from + 12 },
          userEvent: "input.type",
        });
        await waitFor(() => typed(published()).length === 0 && published().includes(other), 5000);
        assert.deepEqual(shown(), [other]);
      } finally {
        await view.onClose();
        yolo.destroy();
        lsp.stop();
      }
    });
  } finally {
    lsp.stop();
    await sleep(600); // stop() kills the process after its shutdown grace period
    console.debug = debug;
    rmSync(root, { recursive: true, force: true });
  }
});
