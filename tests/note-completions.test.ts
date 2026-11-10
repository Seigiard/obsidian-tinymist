import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptCompletion,
  autocompletion,
  CompletionContext,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  NoteCompletionHost,
  NoteCompletionSession,
  NoteSessionHost,
  NoteSessions,
  noteCompletionExtension,
  noteCompletionSource,
} from "../src/editor/noteCompletions";
import type { LspCompletionContext, LspPosition } from "../src/lsp/client";
import { convert } from "../src/markdown/convert";
import type { TypstSource } from "../src/sources/typst";

const NOTE = "---\ntypst: true\n---\n/typst #cal // old";

interface CompletionCall {
  position: LspPosition;
  context: LspCompletionContext;
}

function sessionFor(doc: string, response: unknown | (() => Promise<unknown>)) {
  const conversion = convert(doc, null);
  const calls: CompletionCall[] = [];
  const session: NoteCompletionSession = {
    entry: "/vault/.typst-cache/notes/Note.md.typ",
    toEntry: (position) => ({ line: position.line, character: conversion.toTyp(position.line, position.character) }),
    toSource: (position) => ({ line: position.line, character: conversion.toMd(position.line, position.character) }),
    completion: async (position, context) => {
      calls.push({ position, context });
      return typeof response === "function" ? await response() : structuredClone(response);
    },
  };
  return { session, calls };
}

function hostFor(session: NoteCompletionSession | null, notePath = "Notes/Note.md"): NoteCompletionHost {
  return {
    notePath: () => notePath,
    session: async () => session,
    triggerCharacters: () => ["#"],
  };
}

function contextAt(doc: string, line: number, character: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, state.doc.line(line + 1).from + character, explicit);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function type(view: EditorView, text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  }
}

function pressEnter(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
}

function pressArrowDown(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 40, bubbles: true, cancelable: true }));
}

async function settle(view: EditorView): Promise<void> {
  await wait(130);
  await wait(90);
}

test("control: the real converter removes the /typst prefix only outside a fence", () => {
  // #given
  const regular = convert(NOTE, null);
  const fenced = convert("---\ntypst: true\n---\n```typ\n/typst #cal\n```", null);

  // #when
  const observed = {
    regularEntry: regular.toTyp(3, 8),
    regularSource: regular.toMd(3, 1),
    fencedEntry: fenced.toTyp(4, 7),
  };

  // #then
  assert.deepEqual(observed, { regularEntry: 2, regularSource: 7, fencedEntry: 7 });
});

test("a /typst # request uses the generated document position and returns its items", async () => {
  // #given
  const fixture = sessionFor(NOTE, [{ label: "callout" }]);
  const source = noteCompletionSource(hostFor(fixture.session));

  // #when
  const result = await source(contextAt(NOTE, 3, 8));

  // #then
  assert.deepEqual(
    { calls: fixture.calls, labels: result?.options.map((option) => option.label) },
    {
      calls: [{ position: { line: 3, character: 2 }, context: { triggerKind: 2, triggerCharacter: "#" } }],
      labels: ["callout"],
    },
  );
});

test("Tinymist's text edit after the hash preserves the hash on the Markdown /typst line", async () => {
  // #given
  const fixture = sessionFor(NOTE, [{
    label: "callout",
    textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, newText: "callout" },
  }]);
  const view = new EditorView({
    state: EditorState.create({
      doc: NOTE,
      selection: { anchor: NOTE.indexOf(" //") },
      extensions: [autocompletion({ override: [noteCompletionSource(hostFor(fixture.session))] })],
    }),
    parent: document.body,
  });

  // #when
  try {
    startCompletion(view);
    await settle(view);
    acceptCompletion(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #callout // old");
  } finally {
    view.destroy();
  }
});

test("the note completion extension does not conflict with another override", () => {
  // #given
  const other = async (context: CompletionContext) => ({ from: context.pos, options: [{ label: "override-item" }] });

  // #when
  const state = EditorState.create({
    doc: NOTE,
    extensions: [noteCompletionExtension(hostFor(null)), autocompletion({ override: [other] })],
  });

  // #then
  assert.ok(state.facet(EditorState.languageData));
});

test("an ordinary line keeps another language-data completion source", async () => {
  // #given
  const other = async (context: CompletionContext) => ({ from: context.pos, options: [{ label: "other-item" }] });
  const view = new EditorView({
    state: EditorState.create({
      doc: "ordinary",
      selection: { anchor: 8 },
      extensions: [
        noteCompletionExtension(hostFor(null)),
        EditorState.languageData.of(() => [{ autocomplete: other }]),
      ],
    }),
    parent: document.body,
  });

  // #when
  try {
    startCompletion(view);
    await settle(view);

    // #then
    assert.deepEqual(currentCompletions(view.state).map((item) => item.label), ["other-item"]);
  } finally {
    view.destroy();
  }
});

test("multi-line completion edits are not offered on a /typst line", async () => {
  // #given
  const fixture = sessionFor(NOTE, [
    { label: "block", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, newText: "if ${1:1 < 2} {\n\t${2:}\n}" }, insertTextFormat: 2 },
    { label: "callout", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, newText: "callout" } },
  ]);

  // #when
  const result = await noteCompletionSource(hostFor(fixture.session))(contextAt(NOTE, 3, 8));

  // #then
  assert.deepEqual(result?.options.map((item) => item.label), ["callout"]);
});

function noteCompletionView(response: unknown): EditorView {
  const doc = "---\ntypst: true\n---\n/typst ";
  const fixture = sessionFor(NOTE, response);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        noteCompletionExtension(hostFor(fixture.session)),
        keymap.of([{ key: "Enter", run: insertNewlineAndIndent }]),
      ],
    }),
    parent: document.body,
  });
}

test("Enter on an untouched trigger completion inserts a Markdown newline", async () => {
  // #given
  const view = noteCompletionView([{ label: "callout", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }, newText: "callout" } }]);

  // #when
  try {
    type(view, "#");
    await settle(view);
    pressEnter(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #\n");
  } finally {
    view.destroy();
  }
});

test("Enter accepts a trigger completion after the writer types on it", async () => {
  // #given
  const view = noteCompletionView([{ label: "callout", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }, newText: "callout" } }]);

  // #when
  try {
    type(view, "#");
    await settle(view);
    type(view, "c");
    await settle(view);
    pressEnter(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #callout");
  } finally {
    view.destroy();
  }
});

test("ArrowDown then Enter accepts the second trigger completion", async () => {
  // #given
  const view = noteCompletionView([
    { label: "first", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }, newText: "first" } },
    { label: "second", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }, newText: "second" } },
  ]);

  // #when
  try {
    type(view, "#");
    await settle(view);
    pressArrowDown(view);
    pressEnter(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #second");
  } finally {
    view.destroy();
  }
});

test("Enter falls through when the selected completion would not change the note", async () => {
  // #given
  const view = noteCompletionView([{ label: "c", textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } }, newText: "c" } }]);

  // #when
  try {
    type(view, "#");
    await settle(view);
    type(view, "c");
    await settle(view);
    pressEnter(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #c\n");
  } finally {
    view.destroy();
  }
});

test("Enter reaches downstream host newline handling on ordinary and /typst lines without a list", () => {
  // #given
  const docs = ["ordinary", "---\ntypst: true\n---\n/typst #cal"];
  const observed: string[] = [];

  // #when
  for (const doc of docs) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          noteCompletionExtension(hostFor(null)),
          keymap.of([{ key: "Enter", run: insertNewlineAndIndent }]),
        ],
      }),
      parent: document.body,
    });
    try {
      pressEnter(view);
      observed.push(view.state.doc.toString());
    } finally {
      view.destroy();
    }
  }

  // #then
  assert.deepEqual(observed, ["ordinary\n", "---\ntypst: true\n---\n/typst #cal\n"]);
});

test("ordinary, prefix, non-note, and fenced lines never request note completions", async () => {
  // #given
  const cases = [
    { doc: "---\ntypst: true\n---\n#cal", line: 3, character: 4, notePath: "Notes/Note.md" },
    { doc: NOTE, line: 3, character: 4, notePath: "Notes/Note.md" },
    { doc: NOTE, line: 3, character: 8, notePath: null },
    { doc: "---\ntypst: true\n---\n```typ\n/typst #cal\n```", line: 4, character: 11, notePath: "Notes/Note.md" },
  ];

  // #when
  const observed = [];
  for (const item of cases) {
    const fixture = sessionFor(item.doc, [{ label: "callout" }]);
    const source = noteCompletionSource(hostFor(fixture.session, item.notePath));
    const result = await source(contextAt(item.doc, item.line, item.character, true));
    observed.push({ calls: fixture.calls, result });
  }

  // #then
  assert.deepEqual(observed, [
    { calls: [], result: null },
    { calls: [], result: null },
    { calls: [], result: null },
    { calls: [], result: null },
  ]);
});

test("an unavailable session, unavailable client, or rejected request closes completion without throwing", async () => {
  // #given
  const unavailableSource = noteCompletionSource(hostFor(null));
  const rejected = sessionFor(NOTE, async () => await Promise.reject(new Error("offline")));
  const rejectedSource = noteCompletionSource(hostFor(rejected.session));
  const source = trackedSource("/vault/.typst-cache/notes/Note.md.typ").source;
  const unavailableClient = new NoteSessions({ hold: async () => source, client: () => null });

  // #when
  const observed = [
    await unavailableSource(contextAt(NOTE, 3, 8)),
    await unavailableClient.session("Notes/Note.md"),
    await rejectedSource(contextAt(NOTE, 3, 8)),
  ];

  // #then
  assert.deepEqual({ observed, rejectedCalls: rejected.calls }, {
    observed: [null, null, null],
    rejectedCalls: [{ position: { line: 3, character: 2 }, context: { triggerKind: 2, triggerCharacter: "#" } }],
  });
});

test("additional edits outside the /typst line are dropped while same-line edits are mapped", async () => {
  // #given
  const fixture = sessionFor(NOTE, [{
    label: "callout",
    textEdit: { range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, newText: "callout" },
    additionalTextEdits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "#let injected = true\n" },
      { range: { start: { line: 3, character: 9 }, end: { line: 3, character: 12 } }, newText: "new" },
    ],
  }]);
  const view = new EditorView({
    state: EditorState.create({
      doc: NOTE,
      selection: { anchor: NOTE.indexOf(" //") },
      extensions: [autocompletion({ override: [noteCompletionSource(hostFor(fixture.session))] })],
    }),
    parent: document.body,
  });

  // #when
  try {
    startCompletion(view);
    await settle(view);
    acceptCompletion(view);

    // #then
    assert.equal(view.state.doc.toString(), "---\ntypst: true\n---\n/typst #callout // new");
  } finally {
    view.destroy();
  }
});

interface TrackedSource {
  source: TypstSource;
  end(): void;
  events: string[];
}

function trackedSource(entry: string, clientName?: (client: unknown) => string): TrackedSource {
  const ended = new Set<() => void>();
  const events: string[] = [];
  return {
    source: {
      file: "Notes/Note.md",
      entry,
      document: entry,
      inputs: undefined,
      pinnable: false,
      exportable: true,
      pdf: "Notes/Note.pdf",
      open: (client) => {
        events.push(`open ${entry}${clientName ? ` ${clientName(client)}` : ""}`);
        return { close: () => events.push(`close ${entry}`) };
      },
      toEntry: (position) => position,
      toSource: (position) => position,
      reveal: async () => {},
      describe: (error) => String(error),
      on: (event, listener) => {
        if (event === "ended") ended.add(listener);
        return () => ended.delete(listener);
      },
      release: () => events.push(`release ${entry}`),
    },
    end: () => ended.forEach((listener) => listener()),
    events,
  };
}

test("client object identity decides whether a held note session is reused", async () => {
  // #given
  const oldClientCalls: CompletionCall[] = [];
  const newClientCalls: CompletionCall[] = [];
  const clientFrom = (calls: CompletionCall[]) => ({
    completion: async (_entry: string, position: LspPosition, context: LspCompletionContext) => {
      calls.push({ position, context });
      return null;
    },
  }) as never;
  const oldClient = clientFrom(oldClientCalls);
  const newClient = clientFrom(newClientCalls);
  const first = trackedSource("/vault/.typst-cache/notes/Note-old.md.typ", (client) => client === oldClient ? "old" : "new");
  const second = trackedSource("/vault/.typst-cache/notes/Note-new.md.typ", (client) => client === oldClient ? "old" : "new");
  const holds: string[] = [];
  let client = oldClient;
  const sessions = new NoteSessions({
    hold: async (path) => {
      holds.push(path);
      return holds.length === 1 ? first.source : second.source;
    },
    client: () => client,
  });

  // #when
  const oldSession = await sessions.session("Notes/Note.md");
  const repeatedSession = await sessions.session("Notes/Note.md");
  client = newClient;
  const newSession = await sessions.session("Notes/Note.md");
  await newSession!.completion({ line: 3, character: 2 }, { triggerKind: 2, triggerCharacter: "#" });
  sessions.dispose();

  // #then
  assert.deepEqual(
    { holds, reused: oldSession === repeatedSession, changed: oldSession !== newSession, first: first.events, second: second.events, oldClientCalls, newClientCalls },
    {
      holds: ["Notes/Note.md", "Notes/Note.md"],
      reused: true,
      changed: true,
      first: [
        "open /vault/.typst-cache/notes/Note-old.md.typ old",
        "close /vault/.typst-cache/notes/Note-old.md.typ",
        "release /vault/.typst-cache/notes/Note-old.md.typ",
      ],
      second: [
        "open /vault/.typst-cache/notes/Note-new.md.typ new",
        "close /vault/.typst-cache/notes/Note-new.md.typ",
        "release /vault/.typst-cache/notes/Note-new.md.typ",
      ],
      oldClientCalls: [],
      newClientCalls: [{ position: { line: 3, character: 2 }, context: { triggerKind: 2, triggerCharacter: "#" } }],
    },
  );
});

test("disposing a held note session closes and releases its source", async () => {
  // #given
  const held = trackedSource("/vault/.typst-cache/notes/Note.md.typ");
  const client = { completion: async () => null } as never;
  const sessions = new NoteSessions({
    hold: async () => held.source,
    client: () => client,
  });

  // #when
  await sessions.session("Notes/Note.md");
  sessions.dispose();

  // #then
  assert.deepEqual(held.events, [
    "open /vault/.typst-cache/notes/Note.md.typ",
    "close /vault/.typst-cache/notes/Note.md.typ",
    "release /vault/.typst-cache/notes/Note.md.typ",
  ]);
});

test("note sessions reuse a held note and close and release it when switched, ended, or disposed", async () => {
  // #given
  const first = trackedSource("/vault/.typst-cache/notes/First.md.typ");
  const second = trackedSource("/vault/.typst-cache/notes/Second.md.typ");
  const holds: string[] = [];
  const client = { completion: async () => null } as never;
  const host: NoteSessionHost = {
    hold: async (path) => {
      holds.push(path);
      return path === "Notes/First.md" ? first.source : second.source;
    },
    client: () => client,
  };
  const sessions = new NoteSessions(host);

  // #when
  const firstSession = await sessions.session("Notes/First.md");
  const repeatedSession = await sessions.session("Notes/First.md");
  await sessions.session("Notes/Second.md");
  second.end();
  sessions.dispose();

  // #then
  assert.deepEqual(
    { holds, reused: firstSession === repeatedSession, first: first.events, second: second.events },
    {
      holds: ["Notes/First.md", "Notes/Second.md"],
      reused: true,
      first: ["open /vault/.typst-cache/notes/First.md.typ", "close /vault/.typst-cache/notes/First.md.typ", "release /vault/.typst-cache/notes/First.md.typ"],
      second: ["open /vault/.typst-cache/notes/Second.md.typ", "close /vault/.typst-cache/notes/Second.md.typ", "release /vault/.typst-cache/notes/Second.md.typ"],
    },
  );
});
