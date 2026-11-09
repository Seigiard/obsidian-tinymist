import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { TFile, editorInfoField } from "obsidian";
import { setEditorInfo } from "./support/obsidian";

interface Mark {
  from: number;
  to: number;
  className: string;
  title: string;
}

interface Diagnostic {
  from: { line: number; character: number };
  to: { line: number; character: number };
  message: string;
  severity: "error" | "warning" | "info";
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

function makeView(doc: string, extension: Extension): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [editorInfoField, extension] }),
    parent: document.body,
  });
}

test("diagnostics create exact error marks whose title carries the message", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "zero\none\ntwo\n0123456789 end",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );
  const diagnostics: Diagnostic[] = [{
    from: { line: 3, character: 5 },
    to: { line: 3, character: 9 },
    message: "unknown variable: name",
    severity: "error",
  }];

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 18,
      to: 22,
      className: "tinymist-note-diagnostic-error",
      title: "unknown variable: name",
    }]);
  } finally {
    view.destroy();
  }
});

test("a column past line end clamps and an empty range widens to the left", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView("abc\nxy", editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }));
  const diagnostics: Diagnostic[] = [{
    from: { line: 1, character: 99 },
    to: { line: 1, character: 99 },
    message: "line end",
    severity: "warning",
  }];

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 5,
      to: 6,
      className: "tinymist-note-diagnostic-warning",
      title: "line end",
    }]);
  } finally {
    view.destroy();
  }
});

test("an empty range inside a non-empty line widens one character to the right", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView("abcd", editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }));
  const diagnostics: Diagnostic[] = [{
    from: { line: 0, character: 2 },
    to: { line: 0, character: 2 },
    message: "point error",
    severity: "info",
  }];

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 2,
      to: 3,
      className: "tinymist-note-diagnostic-info",
      title: "point error",
    }]);
  } finally {
    view.destroy();
  }
});

test("a diagnostic line beyond the document is dropped", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView("only one line", editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }));
  const diagnostics: Diagnostic[] = [{
    from: { line: 7, character: 0 },
    to: { line: 7, character: 4 },
    message: "wrong document",
    severity: "error",
  }];

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #then
  try {
    assert.deepEqual(marks(view), []);
  } finally {
    view.destroy();
  }
});

test("an edit before a diagnostic maps its existing mark forward", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView("abc\ndef", editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }));
  const diagnostics: Diagnostic[] = [{
    from: { line: 1, character: 0 },
    to: { line: 1, character: 3 },
    message: "mapped",
    severity: "error",
  }];
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #when
  view.dispatch({ changes: { from: 0, insert: "XX" } });

  // #then
  try {
    assert.deepEqual(marks(view), [{
      from: 6,
      to: 9,
      className: "tinymist-note-diagnostic-error",
      title: "mapped",
    }]);
  } finally {
    view.destroy();
  }
});

test("an empty diagnostics publication clears every mark", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView("abcd", editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }));
  const diagnostics: Diagnostic[] = [{
    from: { line: 0, character: 0 },
    to: { line: 0, character: 4 },
    message: "fixed later",
    severity: "error",
  }];
  view.dispatch({ effects: setNoteDiagnostics.of(diagnostics) });

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([]) });

  // #then
  try {
    assert.deepEqual(marks(view), []);
  } finally {
    view.destroy();
  }
});

test("the view plugin reattaches on a file change and detaches on destroy", async () => {
  // #given
  const { editorDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const events: string[] = [];
  const holder = {
    attach: (path: string) => events.push(`attach:${path}`),
    detach: (path: string) => events.push(`detach:${path}`),
  };
  const view = makeView("text", editorDiagnostics(
    (candidate) => candidate.state.field(editorInfoField, false)?.file?.path ?? null,
    holder,
  ));

  // #when
  view.dispatch({ effects: setEditorInfo.of({ file: new TFile("Notes/A.md") }) });
  view.dispatch({ effects: setEditorInfo.of({ file: new TFile("Notes/B.md") }) });
  view.destroy();

  // #then
  assert.deepEqual(events, [
    "attach:Notes/A.md",
    "detach:Notes/A.md",
    "attach:Notes/B.md",
    "detach:Notes/B.md",
  ]);
});

test("the view plugin attaches when editor info is present in the initial state", async () => {
  // #given
  const { editorDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const events: string[] = [];
  const holder = {
    attach: (path: string) => events.push(`attach:${path}`),
    detach: (path: string) => events.push(`detach:${path}`),
  };
  const file = new TFile("Notes/Initial.md");

  // #when
  const view = new EditorView({
    state: EditorState.create({
      doc: "text",
      extensions: [
        editorInfoField.init(() => ({ file })),
        editorDiagnostics(
          (candidate) => candidate.state.field(editorInfoField, false)?.file?.path ?? null,
          holder,
        ),
      ],
    }),
    parent: document.body,
  });
  view.destroy();

  // #then
  assert.deepEqual(events, [
    "attach:Notes/Initial.md",
    "detach:Notes/Initial.md",
  ]);
});
