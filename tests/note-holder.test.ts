import "./support/dom";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import TinymistPlugin from "../src/main";
import { LspClient, pathToUri, type LspDiagnostic } from "../src/lsp/client";
import { setNoteDiagnostics } from "../src/underlines/editorDiagnostics";
import type { NoteDiagnostic } from "../src/underlines/noteDiagnostics";
import { TypstView } from "../src/editor/typstView";
import { MarkdownView, TFile, setEditorInfo, testApp, type TestApp } from "./support/obsidian";
import { virtualAddress } from "./support/virtualAddress";

const NOTE_TEXT = "---\ntypst: true\n---\n/typst#let value = missing\n";
const PLAIN_TEXT = "---\ntitle: Plain\n---\nNo Typst here\n";
const PROBLEM_TEXT = "---\ntypst: true\ntypst-x: first\ntypst-x: second\n---\nBody\n";

interface HarnessOptions {
  autoStart?: boolean;
  holdBarrier?: Promise<void>;
  startBarrier?: Promise<void>;
}

interface ClientRecord {
  opens: Array<{ path: string; text: string }>;
  closes: string[];
  pins: Array<string | null>;
}

interface Harness {
  app: TestApp;
  plugin: HolderPlugin;
  leaves: Array<{ view: MarkdownView }>;
  holds: string[];
  releases: string[];
  clients: LspClient[];
  startupRmdirs: Array<{ path: string; recursive: boolean }>;
  activate(view: unknown): void;
  close(): void;
}

interface Mark {
  from: number;
  to: number;
  className: string;
  title: string;
}

const records = new WeakMap<LspClient, ClientRecord>();
const createdClients: LspClient[] = [];
const startBarriers: Promise<void>[] = [];
let originalStart: typeof LspClient.prototype.start;
let originalStop: typeof LspClient.prototype.stop;
let originalDidOpen: typeof LspClient.prototype.didOpen;
let originalDidClose: typeof LspClient.prototype.didClose;
let originalPinMain: typeof LspClient.prototype.pinMain;

before(() => {
  originalStart = LspClient.prototype.start;
  originalStop = LspClient.prototype.stop;
  originalDidOpen = LspClient.prototype.didOpen;
  originalDidClose = LspClient.prototype.didClose;
  originalPinMain = LspClient.prototype.pinMain;
  LspClient.prototype.start = async function (): Promise<void> {
    this.status = "starting";
    createdClients.push(this);
    records.set(this, { opens: [], closes: [], pins: [] });
    await startBarriers.shift();
    this.status = "running";
  };
  LspClient.prototype.stop = function (): void {
    this.status = "stopped";
  };
  LspClient.prototype.didOpen = function (path: string, text: string): void {
    records.get(this)?.opens.push({ path, text });
  };
  LspClient.prototype.didClose = function (path: string): void {
    records.get(this)?.closes.push(path);
  };
  LspClient.prototype.pinMain = function (path: string | null): void {
    this.mainFile = path;
    records.get(this)?.pins.push(path);
  };
});

after(() => {
  LspClient.prototype.start = originalStart;
  LspClient.prototype.stop = originalStop;
  LspClient.prototype.didOpen = originalDidOpen;
  LspClient.prototype.didClose = originalDidClose;
  LspClient.prototype.pinMain = originalPinMain;
});

class HolderPlugin extends TinymistPlugin {
  resolveBinary(): string {
    return "/fake/tinymist";
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness(
  notes: Array<{ path: string; typst: boolean; text?: string }>,
  options: HarnessOptions = {},
): Promise<Harness> {
  createdClients.splice(0);
  startBarriers.splice(0);
  if (options.startBarrier) startBarriers.push(options.startBarrier);
  const app = testApp("/vault");
  let activeView: unknown = null;
  const leaves = notes.map(({ path, typst, text }) => {
    const file = new TFile(path);
    const view = new MarkdownView(file);
    view.editorText = text ?? (typst ? NOTE_TEXT : PLAIN_TEXT);
    app.vault.files.set(path, view.editorText);
    app.metadataCache.setFrontmatter(path, typst ? { typst: true } : {});
    return { view };
  });
  Object.assign(app.workspace, {
    getLeavesOfType: (type: string) => type === "markdown" ? leaves : [],
    getActiveViewOfType: (viewType: new (...args: never[]) => unknown) =>
      activeView instanceof viewType ? activeView : null,
  });
  const plugin = new HolderPlugin(app as never, {});
  const holds: string[] = [];
  const releases: string[] = [];
  const originalHold = plugin.sources.hold.bind(plugin.sources);
  const wrapped = new WeakSet<object>();
  plugin.sources.hold = async (path: string) => {
    holds.push(path);
    await options.holdBarrier;
    const source = await originalHold(path);
    if (source && !wrapped.has(source)) {
      wrapped.add(source);
      const release = source.release.bind(source);
      source.release = () => {
        releases.push(path);
        release();
      };
    }
    return source;
  };
  await plugin.onload();
  const startupRmdirs = [...app.vault.adapter.rmdirs];
  if (options.autoStart !== false) {
    await plugin.startLsp(false);
    await settle();
  }
  return {
    app,
    plugin,
    leaves,
    holds,
    releases,
    clients: createdClients,
    startupRmdirs,
    activate: (view) => {
      activeView = view;
    },
    close: () => plugin.onunload(),
  };
}

test("plugin load wipes the note shadow cache once before a source opens", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);

  // #when
  const afterStart = [...h.app.vault.adapter.rmdirs];
  const opens = clientRecord(h.clients[0]).opens.map(({ path }) => path);

  // #then
  try {
    assert.deepEqual(
      { beforeStart: h.startupRmdirs, afterStart, opens },
      {
        beforeStart: [{ path: ".typst-cache/notes", recursive: true }],
        afterStart: [{ path: ".typst-cache/notes", recursive: true }],
        opens: ["/vault/.typst-cache/notes/Notes/A.md.typ"],
      },
    );
  } finally {
    h.close();
  }
});

test("a rejected note shadow cache wipe does not fail plugin load", async () => {
  // #given
  const app = testApp("/vault");
  app.vault.adapter.failNextRmdir = new Error("cache wipe failed");
  const plugin = new HolderPlugin(app as never, {});
  let error: unknown;

  // #when
  try {
    await plugin.onload();
  } catch (caught) {
    error = caught;
  }

  // #then
  try {
    assert.deepEqual(
      { error, rmdirs: app.vault.adapter.rmdirs },
      {
        error: undefined,
        rmdirs: [{ path: ".typst-cache/notes", recursive: true }],
      },
    );
  } finally {
    plugin.onunload();
  }
});

function clientRecord(client: LspClient): ClientRecord {
  return records.get(client) ?? { opens: [], closes: [], pins: [] };
}

function typstView(path: string): TypstView {
  const view = Object.create(TypstView.prototype) as TypstView;
  Object.defineProperty(view, "absolutePath", { value: () => path });
  return view;
}

function openPreview(h: Harness, path: string): Promise<string | null> {
  const client = h.clients[0];
  client.executeCommand = function<T = unknown>(command: string): Promise<T> {
    const result = command === "tinymist.doStartPreview"
      ? { staticServerPort: 4321 }
      : {};
    return Promise.resolve(result as T);
  };
  return h.plugin.preview.start(`/vault/${path}`);
}

function marks(view: EditorView): Mark[] {
  const result: Mark[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const decorations = typeof source === "function" ? source(view) : source;
    decorations.between(0, view.state.doc.length, (from, to, value: Decoration) => {
      const className = typeof value.spec.class === "string" ? value.spec.class : "";
      if (!className.startsWith("tinymist-note-diagnostic-")) return;
      const attributes = value.spec.attributes as Record<string, string> | undefined;
      result.push({ from, to, className, title: attributes?.title ?? "" });
    });
  }
  return result;
}

function mountNote(
  h: Harness,
  file: TFile,
  text: string,
  onDiagnosticDispatch?: (
    diagnosticCount: number,
    diagnostics: readonly NoteDiagnostic[],
  ) => void,
  fileAtCreation = false,
): EditorView {
  const extensions = h.plugin.editorExtensions as Extension[];
  const listener = EditorView.updateListener.of((update) => {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setNoteDiagnostics)) {
          onDiagnosticDispatch?.(effect.value.length, effect.value);
        }
      }
    }
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        fileAtCreation ? editorInfoField.init(() => ({ file })) : editorInfoField,
        ...extensions,
        listener,
      ],
    }),
    parent: document.body,
  });
  if (!fileAtCreation) view.dispatch({ effects: setEditorInfo.of({ file }) });
  return view;
}

function publish(client: LspClient, uri: string, diagnostics: LspDiagnostic[]): void {
  const boundary = client as unknown as {
    handleMessage(message: { method: string; params: unknown }): void;
  };
  boundary.handleMessage({
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

function entryDiagnostic(message = "unknown variable: value"): LspDiagnostic {
  return {
    range: {
      start: { line: 3, character: 5 },
      end: { line: 3, character: 9 },
    },
    severity: 1,
    message,
  };
}

async function switchOneOfTwoViewsToPlainNote(rename: boolean): Promise<{
  stayedMarks: Mark[];
  switchedMarks: Mark[];
  stayedDispatches: number[];
  switchedDispatches: number[];
}> {
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/C.md", typst: false },
  ]);
  const noteFile = h.leaves[0].view.file!;
  const plainFile = h.leaves[1].view.file!;
  const stayedDispatches: number[] = [];
  const switchedDispatches: number[] = [];
  const stayed = mountNote(h, noteFile, NOTE_TEXT, (count) => stayedDispatches.push(count));
  const switched = mountNote(h, noteFile, NOTE_TEXT, (count) => switchedDispatches.push(count));
  await settle();

  try {
    let diagnosticPath = "Notes/A.md";
    if (rename) {
      await h.app.fileManager.renameFile(noteFile, "Notes/B.md");
      h.app.metadataCache.setFrontmatter(noteFile.path, { typst: true });
      await h.app.vault.emit("rename", noteFile, "Notes/A.md");
      await settle();
      diagnosticPath = "Notes/B.md";
    }

    switched.dispatch({ effects: setEditorInfo.of({ file: plainFile }) });
    await settle();
    stayedDispatches.splice(0);
    switchedDispatches.splice(0);

    publish(
      h.clients[0],
      pathToUri(virtualAddress("/vault", diagnosticPath)),
      [entryDiagnostic("B failed")],
    );
    await settle();

    return {
      stayedMarks: marks(stayed),
      switchedMarks: marks(switched),
      stayedDispatches: [...stayedDispatches],
      switchedDispatches: [...switchedDispatches],
    };
  } finally {
    h.close();
    stayed.destroy();
    switched.destroy();
  }
}

test("one open Typst note holds its source and opens its virtual entry on the main client", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);

  // #when
  const record = clientRecord(h.clients[0]);

  // #then
  try {
    assert.deepEqual(
      { holds: h.holds, opens: record.opens.map(({ path }) => path) },
      { holds: ["Notes/A.md"], opens: [virtualAddress("/vault", "Notes/A.md")] },
    );
  } finally {
    h.close();
  }
});

test("a second leaf of the same Typst note does not hold or open it twice", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  h.leaves.push({ view: new MarkdownView(new TFile("Notes/A.md")) });

  // #when
  await h.app.workspace.emit("layout-change");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { holds: h.holds, opens: clientRecord(h.clients[0]).opens.map(({ path }) => path) },
      { holds: ["Notes/A.md"], opens: [virtualAddress("/vault", "Notes/A.md")] },
    );
  } finally {
    h.close();
  }
});

test("closing the last leaf closes the virtual entry and releases the source", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);

  // #when
  h.leaves.splice(0);
  await h.app.workspace.emit("layout-change");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { closes: clientRecord(h.clients[0]).closes, releases: h.releases },
      {
        closes: [virtualAddress("/vault", "Notes/A.md")],
        releases: ["Notes/A.md"],
      },
    );
  } finally {
    h.close();
  }
});

test("a note without the typst property is never held, opened, or decorated", async () => {
  // #given
  const h = await harness([{ path: "Notes/Plain.md", typst: false }]);
  const file = h.leaves[0].view.file!;
  const nonEmptyDispatches: number[] = [];
  const view = mountNote(h, file, PLAIN_TEXT, (count) => {
    if (count > 0) nonEmptyDispatches.push(count);
  });

  // #when
  await h.app.workspace.emit("layout-change");
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        holds: h.holds,
        opens: clientRecord(h.clients[0]).opens,
        marks: marks(view),
        nonEmptyDispatches,
      },
      { holds: [], opens: [], marks: [], nonEmptyDispatches: [] },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("losing the typst property releases the note and clears its attached editor", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const view = mountNote(h, file, NOTE_TEXT);
  const entry = virtualAddress("/vault", file.path);
  publish(h.clients[0], pathToUri(entry), [entryDiagnostic()]);
  await settle();
  const before = marks(view);

  // #when
  h.app.metadataCache.setFrontmatter(file.path, {});
  await h.app.metadataCache.emit("changed", file);
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        before,
        after: marks(view),
        closes: clientRecord(h.clients[0]).closes,
        releases: h.releases,
      },
      {
        before: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "unknown variable: value",
        }],
        after: [],
        closes: [entry],
        releases: ["Notes/A.md"],
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("restarting the main language server reopens every held note on the new client", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const oldClient = h.clients[0];

  // #when
  await h.plugin.startLsp(true);
  await settle();
  const newClient = createdClients[1];

  // #then
  try {
    assert.deepEqual(
      {
        oldCloses: clientRecord(oldClient).closes,
        newOpens: clientRecord(newClient).opens.map(({ path }) => path),
      },
      {
        oldCloses: [virtualAddress("/vault", "Notes/A.md")],
        newOpens: [virtualAddress("/vault", "Notes/A.md")],
      },
    );
  } finally {
    h.close();
  }
});

test("entry diagnostics reach only the matching note and an empty publication clears it", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/B.md", typst: true },
  ]);
  const aFile = h.leaves[0].view.file!;
  const bFile = h.leaves[1].view.file!;
  const aView = mountNote(h, aFile, NOTE_TEXT);
  const bView = mountNote(h, bFile, NOTE_TEXT);
  const aUri = pathToUri(virtualAddress("/vault", aFile.path));

  // #when
  publish(h.clients[0], aUri, [entryDiagnostic("A failed")]);
  await settle();
  const afterError = { a: marks(aView), b: marks(bView) };
  publish(h.clients[0], aUri, []);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { afterError, afterClear: { a: marks(aView), b: marks(bView) } },
      {
        afterError: {
          a: [{
            from: 31,
            to: 35,
            className: "tinymist-note-diagnostic-error",
            title: "A failed",
          }],
          b: [],
        },
        afterClear: { a: [], b: [] },
      },
    );
  } finally {
    aView.destroy();
    bView.destroy();
    h.close();
  }
});

test("identical diagnostic republication does not dispatch; a changed message dispatches once", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const dispatches: number[] = [];
  const view = mountNote(h, file, NOTE_TEXT, (count) => dispatches.push(count));
  await settle();
  dispatches.splice(0);
  const entry = h.plugin.noteHolder?.entryOf(file.path);
  assert.ok(entry, "expected the held note to expose its entry");
  const uri = pathToUri(entry);

  // #when
  publish(h.clients[0], uri, [entryDiagnostic("same diagnostic")]);
  await settle();
  publish(h.clients[0], uri, [entryDiagnostic("same diagnostic")]);
  await settle();
  const afterIdentical = [...dispatches];
  publish(h.clients[0], uri, [entryDiagnostic("changed diagnostic")]);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { afterIdentical, dispatches, marks: marks(view) },
      {
        afterIdentical: [1],
        dispatches: [1, 1],
        marks: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "changed diagnostic",
        }],
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("an identical diagnostic is dispatched again after an edit removes its mapped mark", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const dispatches: number[] = [];
  const view = mountNote(h, file, NOTE_TEXT, (count) => dispatches.push(count));
  await settle();
  dispatches.splice(0);
  const entry = h.plugin.noteHolder?.entryOf(file.path);
  assert.ok(entry, "expected the held note to expose its entry");
  const diagnostic = entryDiagnostic("same error");
  publish(h.clients[0], pathToUri(entry), [diagnostic]);
  await settle();
  const beforeEdit = marks(view);
  const line = view.state.doc.line(4);

  // #when
  view.dispatch({ changes: { from: line.from, to: line.to, insert: "/typst#let other = missing" } });
  const afterEdit = marks(view);
  publish(h.clients[0], pathToUri(entry), [diagnostic]);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { beforeEdit, afterEdit, afterRepublish: marks(view), dispatches },
      {
        beforeEdit: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "same error",
        }],
        afterEdit: [],
        afterRepublish: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "same error",
        }],
        dispatches: [1, 1],
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("unchanged converter problems preserve mapped LSP marks while changed problems publish", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const dispatches: number[] = [];
  const view = mountNote(h, file, NOTE_TEXT, (count) => dispatches.push(count));
  publish(
    h.clients[0],
    pathToUri(virtualAddress("/vault", file.path)),
    [entryDiagnostic("keep mapped")],
  );
  await settle();
  dispatches.splice(0);

  // #when
  view.dispatch({ changes: { from: 30, insert: "X" } });
  await h.app.workspace.emit(
    "editor-change",
    { getValue: () => view.state.doc.toString() },
    { file },
  );
  await settle();
  const afterSame = { marks: marks(view), dispatches: [...dispatches] };
  await h.app.workspace.emit(
    "editor-change",
    { getValue: () => PROBLEM_TEXT },
    { file },
  );
  await settle();

  // #then
  try {
    assert.deepEqual(
      { afterSame, dispatches },
      {
        afterSame: {
          marks: [{
            from: 32,
            to: 36,
            className: "tinymist-note-diagnostic-error",
            title: "keep mapped",
          }],
          dispatches: [],
        },
        dispatches: [2],
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("a fatal conversion publishes only its problem, then restored conversion republishes LSP diagnostics", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const dispatches: NoteDiagnostic[][] = [];
  const view = mountNote(h, file, NOTE_TEXT, (_count, diagnostics) => {
    dispatches.push([...diagnostics]);
  });
  const uri = pathToUri(virtualAddress("/vault", file.path));
  publish(h.clients[0], uri, [entryDiagnostic("cached LSP error")]);
  await settle();
  const initialMarks = marks(view);
  dispatches.splice(0);
  const insertion = "typst-template: missing\n";
  const insertAt = view.state.doc.line(3).from;

  // #when
  view.dispatch({ changes: { from: insertAt, insert: insertion } });
  await h.app.workspace.emit(
    "editor-change",
    { getValue: () => view.state.doc.toString() },
    { file },
  );
  await settle();
  const fatal = { dispatches: dispatches.splice(0), marks: marks(view) };
  view.dispatch({ changes: { from: insertAt, to: insertAt + insertion.length } });
  await h.app.workspace.emit(
    "editor-change",
    { getValue: () => view.state.doc.toString() },
    { file },
  );
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        initialMarks,
        fatal,
        restored: { dispatches, marks: marks(view) },
      },
      {
        initialMarks: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "cached LSP error",
        }],
        fatal: {
          dispatches: [[{
            from: { line: 2, character: 0 },
            to: { line: 2, character: Number.MAX_SAFE_INTEGER },
            message: "Unknown Typst template missing",
            severity: "error",
          }]],
          marks: [{
            from: 16,
            to: 39,
            className: "tinymist-note-diagnostic-error",
            title: "Unknown Typst template missing",
          }],
        },
        restored: {
          dispatches: [[{
            from: { line: 3, character: 11 },
            to: { line: 3, character: 15 },
            message: "cached LSP error",
            severity: "error",
          }]],
          marks: [{
            from: 31,
            to: 35,
            className: "tinymist-note-diagnostic-error",
            title: "cached LSP error",
          }],
        },
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("renaming a held note rekeys its source and attached editor", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const view = mountNote(h, file, NOTE_TEXT);
  const oldEntry = virtualAddress("/vault", "Notes/A.md");
  const newEntry = virtualAddress("/vault", "Notes/Renamed.md");

  // #when
  await h.app.fileManager.renameFile(file, "Notes/Renamed.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/A.md");
  view.dispatch({ selection: { anchor: 0 } });
  publish(h.clients[0], pathToUri(newEntry), [entryDiagnostic("renamed")]);
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        holds: h.holds,
        opens: clientRecord(h.clients[0]).opens.map(({ path }) => path),
        closes: clientRecord(h.clients[0]).closes,
        marks: marks(view),
      },
      {
        holds: ["Notes/A.md"],
        opens: [oldEntry, newEntry],
        closes: [oldEntry],
        marks: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "renamed",
        }],
      },
    );
  } finally {
    view.destroy();
    h.close();
  }
});

test("after rename, switching one view to a plain note removes it from the renamed diagnostic bucket", async () => {
  // #given
  const rename = true;

  // #when
  const result = await switchOneOfTwoViewsToPlainNote(rename);

  // #then
  assert.deepEqual(result, {
    stayedMarks: [{
      from: 31,
      to: 35,
      className: "tinymist-note-diagnostic-error",
      title: "B failed",
    }],
    switchedMarks: [],
    stayedDispatches: [1],
    switchedDispatches: [],
  });
});

test("after rename, destroying one view removes it from the renamed diagnostic bucket", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const survivingDispatches: number[] = [];
  let destroyedDispatches = 0;
  const surviving = mountNote(h, file, NOTE_TEXT, (count) => survivingDispatches.push(count));
  const destroyed = mountNote(h, file, NOTE_TEXT);
  await settle();

  // #when
  await h.app.fileManager.renameFile(file, "Notes/B.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/A.md");
  await settle();
  survivingDispatches.splice(0);
  destroyed.destroy();
  const destroyedDispatch = destroyed.dispatch;
  Object.defineProperty(destroyed, "dispatch", {
    value: (...specs: unknown[]) => {
      destroyedDispatches += 1;
      Reflect.apply(destroyedDispatch, destroyed, specs);
    },
  });
  publish(
    h.clients[0],
    pathToUri(virtualAddress("/vault", "Notes/B.md")),
    [entryDiagnostic("B failed")],
  );
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        survivingMarks: marks(surviving),
        survivingDispatches,
        destroyedDispatches,
      },
      {
        survivingMarks: [{
          from: 31,
          to: 35,
          className: "tinymist-note-diagnostic-error",
          title: "B failed",
        }],
        survivingDispatches: [1],
        destroyedDispatches: 0,
      },
    );
  } finally {
    surviving.destroy();
    h.close();
  }
});

test("without rename, switching one view to a plain note keeps it outside the diagnostic bucket", async () => {
  // #given
  const rename = false;

  // #when
  const result = await switchOneOfTwoViewsToPlainNote(rename);

  // #then
  assert.deepEqual(result, {
    stayedMarks: [{
      from: 31,
      to: 35,
      className: "tinymist-note-diagnostic-error",
      title: "B failed",
    }],
    switchedMarks: [],
    stayedDispatches: [1],
    switchedDispatches: [],
  });
});

test("closing a leaf while its source hold is pending releases without an unbalanced open", async () => {
  // #given
  const hold = deferred();
  const h = await harness(
    [{ path: "Notes/A.md", typst: true }],
    { autoStart: false, holdBarrier: hold.promise },
  );
  const starting = h.plugin.startLsp(false);
  await settle();

  // #when
  h.leaves.splice(0);
  await h.app.workspace.emit("layout-change");
  hold.resolve();
  await starting;
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        holds: h.holds,
        opens: clientRecord(h.clients[0]).opens,
        closes: clientRecord(h.clients[0]).closes,
        releases: h.releases,
      },
      { holds: ["Notes/A.md"], opens: [], closes: [], releases: ["Notes/A.md"] },
    );
  } finally {
    h.close();
  }
});

test("plugin unload closes and releases every held note", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/B.md", typst: true },
  ]);
  const client = h.clients[0];

  // #when
  h.close();

  // #then
  assert.deepEqual(
    {
      closes: clientRecord(client).closes,
      releases: h.releases,
    },
    {
      closes: [
        virtualAddress("/vault", "Notes/A.md"),
        virtualAddress("/vault", "Notes/B.md"),
      ],
      releases: ["Notes/A.md", "Notes/B.md"],
    },
  );
});

test("a view created after diagnostics were published receives the current list on attach", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  publish(
    h.clients[0],
    pathToUri(virtualAddress("/vault", file.path)),
    [entryDiagnostic("already published")],
  );
  await settle();

  // #when
  const view = mountNote(h, file, NOTE_TEXT, undefined, true);
  await settle();

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 31,
      to: 35,
      className: "tinymist-note-diagnostic-error",
      title: "already published",
    }]);
  } finally {
    view.destroy();
    h.close();
  }
});

test("a refresh during language-server start waits to open the held note", async () => {
  // #given
  const start = deferred();
  const h = await harness(
    [{ path: "Notes/A.md", typst: true }],
    { autoStart: false, startBarrier: start.promise },
  );
  const starting = h.plugin.startLsp(false);
  await settle();

  // #when
  await h.plugin.noteHolder!.refresh();
  const beforeStartResolved = clientRecord(h.clients[0]).opens.map(({ path }) => path);
  start.resolve();
  await starting;
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        beforeStartResolved,
        afterStartResolved: clientRecord(h.clients[0]).opens.map(({ path }) => path),
      },
      {
        beforeStartResolved: [],
        afterStartResolved: [virtualAddress("/vault", "Notes/A.md")],
      },
    );
  } finally {
    h.close();
  }
});

test("converter problems attach as whole-line warning marks", async () => {
  // #given
  const h = await harness([{ path: "Notes/Problem.md", typst: true, text: PROBLEM_TEXT }]);
  const file = h.leaves[0].view.file!;

  // #when
  const view = mountNote(h, file, PROBLEM_TEXT, undefined, true);
  await settle();

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 31,
      to: 46,
      className: "tinymist-note-diagnostic-warning",
      title: "Property x is repeated",
    }]);
  } finally {
    view.destroy();
    h.close();
  }
});

test("an active Typst note pins its virtual entry once and a Typst view clears it", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const client = h.clients[0];
  h.activate(h.leaves[0].view);

  // #when
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  h.activate(typstView("/vault/Chapter.typ"));
  await h.app.workspace.emit("active-leaf-change");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      {
        pins: [virtualAddress("/vault", "Notes/A.md"), null],
        mainFile: null,
      },
    );
  } finally {
    h.close();
  }
});

test("releasing the pinned note while a plain note is active pins main to null", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/Plain.md", typst: false },
  ]);
  const client = h.clients[0];
  const entry = virtualAddress("/vault", "Notes/A.md");
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  h.activate(h.leaves[1].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[1]);
  await settle();

  // #when
  h.app.metadataCache.setFrontmatter("Notes/A.md", {});
  await h.app.metadataCache.emit("changed", h.leaves[0].view.file!);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile, releases: h.releases },
      { pins: [entry, null], mainFile: null, releases: ["Notes/A.md"] },
    );
  } finally {
    h.close();
  }
});

test("releasing a held note while preview owns main sends no pin command", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const client = h.clients[0];
  h.plugin.preview.url = "http://127.0.0.1:4321";
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();

  // #when
  h.app.metadataCache.setFrontmatter("Notes/A.md", {});
  await h.app.metadataCache.emit("changed", h.leaves[0].view.file!);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, releases: h.releases },
      { pins: [], releases: ["Notes/A.md"] },
    );
  } finally {
    h.close();
  }
});

test("releasing the preview main for a plain active note hands null back when the preview stops", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/Plain.md", typst: false },
  ]);
  const client = h.clients[0];
  const entry = virtualAddress("/vault", "Notes/A.md");
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  await openPreview(h, "Notes/A.md");
  h.activate(h.leaves[1].view);

  // #when
  h.app.metadataCache.setFrontmatter("Notes/A.md", {});
  await h.app.metadataCache.emit("changed", h.leaves[0].view.file!);
  await settle();
  const afterRelease = {
    pins: [...clientRecord(client).pins],
    mainFile: client.mainFile,
  };
  await h.plugin.preview.stop();
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        afterRelease,
        afterStop: {
          pins: clientRecord(client).pins,
          mainFile: client.mainFile,
        },
      },
      {
        afterRelease: { pins: [entry], mainFile: null },
        afterStop: { pins: [entry, null], mainFile: null },
      },
    );
  } finally {
    h.close();
  }
});

test("releasing the preview main retargets it to another active held note", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/B.md", typst: true },
  ]);
  const client = h.clients[0];
  const aEntry = virtualAddress("/vault", "Notes/A.md");
  const bEntry = virtualAddress("/vault", "Notes/B.md");
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  await openPreview(h, "Notes/A.md");
  h.activate(h.leaves[1].view);

  // #when
  h.app.metadataCache.setFrontmatter("Notes/A.md", {});
  await h.app.metadataCache.emit("changed", h.leaves[0].view.file!);
  await settle();
  const afterRelease = {
    pins: [...clientRecord(client).pins],
    mainFile: client.mainFile,
  };
  await h.plugin.preview.stop();
  await settle();

  // #then
  try {
    assert.deepEqual(
      {
        afterRelease,
        afterStop: {
          pins: clientRecord(client).pins,
          mainFile: client.mainFile,
        },
      },
      {
        afterRelease: { pins: [aEntry], mainFile: bEntry },
        afterStop: { pins: [aEntry, bEntry], mainFile: bEntry },
      },
    );
  } finally {
    h.close();
  }
});

test("an active Typst note updates mainFile without a pin command while preview is open", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const client = h.clients[0];
  h.activate(h.leaves[0].view);
  h.plugin.preview.url = "http://127.0.0.1:4321";

  // #when
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      {
        pins: [],
        mainFile: virtualAddress("/vault", "Notes/A.md"),
      },
    );
  } finally {
    h.close();
  }
});

test("a plain active Markdown note leaves the pinned main unchanged", async () => {
  // #given
  const h = await harness([{ path: "Notes/Plain.md", typst: false }]);
  const client = h.clients[0];
  client.mainFile = "/vault/book.typ";
  h.activate(h.leaves[0].view);

  // #when
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      { pins: [], mainFile: "/vault/book.typ" },
    );
  } finally {
    h.close();
  }
});

test("an active Typst note is pinned when its pending hold resolves", async () => {
  // #given
  const hold = deferred();
  const h = await harness(
    [{ path: "Notes/A.md", typst: true }],
    { autoStart: false, holdBarrier: hold.promise },
  );
  h.activate(h.leaves[0].view);
  const starting = h.plugin.startLsp(false);
  await settle();
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();

  // #when
  hold.resolve();
  await starting;
  await settle();

  // #then
  try {
    assert.deepEqual(clientRecord(h.clients[0]).pins, [
      virtualAddress("/vault", "Notes/A.md"),
    ]);
  } finally {
    h.close();
  }
});

test("renaming an active held note pins its new virtual entry", async () => {
  // #given
  const h = await harness([{ path: "Notes/A.md", typst: true }]);
  const file = h.leaves[0].view.file!;
  const client = h.clients[0];
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();

  // #when
  await h.app.fileManager.renameFile(file, "Notes/Renamed.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/A.md");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      {
        pins: [
          virtualAddress("/vault", "Notes/A.md"),
          virtualAddress("/vault", "Notes/Renamed.md"),
        ],
        mainFile: virtualAddress("/vault", "Notes/Renamed.md"),
      },
    );
  } finally {
    h.close();
  }
});

test("renaming the pinned note retargets main while a plain note is active", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/Plain.md", typst: false },
  ]);
  const file = h.leaves[0].view.file!;
  const client = h.clients[0];
  const oldEntry = virtualAddress("/vault", "Notes/A.md");
  const newEntry = virtualAddress("/vault", "Archive/A.md");
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  h.activate(h.leaves[1].view);

  // #when
  await h.app.fileManager.renameFile(file, "Archive/A.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/A.md");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      { pins: [oldEntry, newEntry], mainFile: newEntry },
    );
  } finally {
    h.close();
  }
});

test("renaming a held note that is not main sends no pin command", async () => {
  // #given
  const h = await harness([
    { path: "Notes/A.md", typst: true },
    { path: "Notes/B.md", typst: true },
    { path: "Notes/Plain.md", typst: false },
  ]);
  const file = h.leaves[1].view.file!;
  const client = h.clients[0];
  const mainEntry = virtualAddress("/vault", "Notes/A.md");
  h.activate(h.leaves[0].view);
  await h.app.workspace.emit("active-leaf-change", h.leaves[0]);
  await settle();
  h.activate(h.leaves[2].view);

  // #when
  await h.app.fileManager.renameFile(file, "Archive/B.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/B.md");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { pins: clientRecord(client).pins, mainFile: client.mainFile },
      { pins: [mainEntry], mainFile: mainEntry },
    );
  } finally {
    h.close();
  }
});

test("renaming a held note without an open handle does not notify onOpened", async () => {
  // #given
  const h = await harness(
    [{ path: "Notes/A.md", typst: true }],
    { autoStart: false },
  );
  await h.plugin.noteHolder!.refresh();
  const file = h.leaves[0].view.file!;
  const opened: string[] = [];
  h.plugin.syncPinnedMain = () => {
    opened.push(file.path);
  };

  // #when
  await h.app.fileManager.renameFile(file, "Notes/Renamed.md");
  h.app.metadataCache.setFrontmatter(file.path, { typst: true });
  await h.app.vault.emit("rename", file, "Notes/A.md");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { holds: h.holds, clients: h.clients.length, opened },
      { holds: ["Notes/A.md"], clients: 0, opened: [] },
    );
  } finally {
    h.close();
  }
});
