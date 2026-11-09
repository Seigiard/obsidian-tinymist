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

function diagnostic(
  message: string,
  line: number,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return {
    from: { line, character: 0 },
    to: { line, character: Number.MAX_SAFE_INTEGER },
    message,
    severity,
  };
}

function frontmatterBanner(view: EditorView): HTMLElement | null {
  return view.contentDOM.querySelector<HTMLElement>(".tinymist-note-frontmatter-problems");
}

function bannerRows(banner: HTMLElement | null): string[] {
  return banner === null ? [] : [...banner.children].map((row) => row.textContent ?? "");
}

test("a fatal frontmatter problem renders directly before the first body line in source mode", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---\nFirst body line\nSecond body line",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });

  // #then
  try {
    const banner = frontmatterBanner(view);
    assert.deepEqual({
      rows: bannerRows(banner),
      previousLine: banner?.previousElementSibling?.textContent ?? null,
      nextLine: banner?.nextElementSibling?.textContent ?? null,
    }, {
      rows: ["Unknown Typst template missing"],
      previousLine: "---",
      nextLine: "First body line",
    });
  } finally {
    view.destroy();
  }
});

test("distinct fatal frontmatter problems render one row each in first-seen order", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\ntypst-count: [1,,2]\n---\nBody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([
    diagnostic("Property count has a malformed list", 2),
    diagnostic("Unknown Typst template missing", 1),
  ]) });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), [
      "Property count has a malformed list",
      "Unknown Typst template missing",
    ]);
  } finally {
    view.destroy();
  }
});

test("equal fatal frontmatter problem messages collapse to their first row", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\ntypst-layout: missing\n---\nBody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([
    diagnostic("Unknown Typst template missing", 1),
    diagnostic("Unknown Typst template missing", 2),
  ]) });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), ["Unknown Typst template missing"]);
  } finally {
    view.destroy();
  }
});

test("a frontmatter problem after a final closing delimiter renders at document end", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Closing frontmatter problem", 2)]) });

  // #then
  try {
    const banner = frontmatterBanner(view);
    assert.deepEqual({
      rows: bannerRows(banner),
      previousLine: banner?.previousElementSibling?.textContent ?? null,
      nextElement: banner?.nextElementSibling?.textContent ?? null,
    }, {
      rows: ["Closing frontmatter problem"],
      previousLine: "---",
      nextElement: null,
    });
  } finally {
    view.destroy();
  }
});

test("a final-delimiter banner stays above text inserted after it", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });

  // #when
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nHello" } });

  // #then
  try {
    const banner = frontmatterBanner(view);
    assert.deepEqual({
      rows: bannerRows(banner),
      previousLine: banner?.previousElementSibling?.textContent ?? null,
      nextLine: banner?.nextElementSibling?.textContent ?? null,
    }, {
      rows: ["Unknown Typst template missing"],
      previousLine: "---",
      nextLine: "Hello",
    });
  } finally {
    view.destroy();
  }
});

test("a frontmatter banner stays above the body after its blank line is deleted", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---\n\nbody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });

  // #when
  view.dispatch({ changes: { from: view.state.doc.line(3).to, to: view.state.doc.line(4).to } });

  // #then
  try {
    const banner = frontmatterBanner(view);
    assert.deepEqual({
      rows: bannerRows(banner),
      previousLine: banner?.previousElementSibling?.textContent ?? null,
      nextLine: banner?.nextElementSibling?.textContent ?? null,
    }, {
      rows: ["Unknown Typst template missing"],
      previousLine: "---",
      nextLine: "body",
    });
  } finally {
    view.destroy();
  }
});

test("a frontmatter banner disappears when its opening delimiter is deleted", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---\n\nbody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });

  // #when
  view.dispatch({ changes: { from: 0, to: view.state.doc.line(2).from } });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), []);
  } finally {
    view.destroy();
  }
});

test("an empty diagnostics publication removes an existing frontmatter problem widget", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---\nBody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });
  const before = bannerRows(frontmatterBanner(view));

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([]) });

  // #then
  try {
    assert.deepEqual({ before, after: bannerRows(frontmatterBanner(view)) }, {
      before: ["Unknown Typst template missing"],
      after: [],
    });
  } finally {
    view.destroy();
  }
});

test("frontmatter warnings and infos do not render a problem widget", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\ntypst-count: maybe\n---\nBody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([
    diagnostic("Template selection warning", 1, "warning"),
    diagnostic("Property count information", 2, "info"),
  ]) });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), []);
  } finally {
    view.destroy();
  }
});

test("a body-line error does not render a frontmatter problem widget", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: article\n---\nBroken body",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Body cannot compile", 3)]) });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), []);
  } finally {
    view.destroy();
  }
});

test("an error in a document without frontmatter does not render a frontmatter problem widget", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "Broken body",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Body cannot compile", 0)]) });

  // #then
  try {
    assert.deepEqual(bannerRows(frontmatterBanner(view)), []);
  } finally {
    view.destroy();
  }
});

test("the frontmatter line keeps its exact error mark when the problem widget renders", async () => {
  // #given
  const { editorDiagnostics, setNoteDiagnostics } = await import("../src/underlines/editorDiagnostics");
  const view = makeView(
    "---\ntypst-template: missing\n---\nBody",
    editorDiagnostics(() => null, { attach: () => {}, detach: () => {} }),
  );

  // #when
  view.dispatch({ effects: setNoteDiagnostics.of([diagnostic("Unknown Typst template missing", 1)]) });

  // #then
  try {
    assert.deepEqual({
      rows: bannerRows(frontmatterBanner(view)),
      marks: marks(view),
    }, {
      rows: ["Unknown Typst template missing"],
      marks: [{
        from: 4,
        to: 27,
        className: "tinymist-note-diagnostic-error",
        title: "Unknown Typst template missing",
      }],
    });
  } finally {
    view.destroy();
  }
});

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
