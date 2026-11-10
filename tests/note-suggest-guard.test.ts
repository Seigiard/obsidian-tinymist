import assert from "node:assert/strict";
import { test } from "node:test";
import { installNativeSuggestGuard } from "../src/integrations/nativeSuggestGuard";

interface FakeEditor {
  getCursor(): { line: number; ch: number };
  getLine(line: number): string;
  getValue(): string;
}

interface FakeFile {
  path: string;
}

interface TriggerCall {
  receiver: unknown;
  editor: FakeEditor;
  file: FakeFile | null;
  open: boolean;
}

interface FakeSuggest {
  close(): void;
  trigger(editor: FakeEditor, file: FakeFile | null, open: boolean): string;
}

function editorAt(line: string, ch: number): FakeEditor {
  return editorIn(line, 0, ch);
}

function editorIn(value: string, line: number, ch: number): FakeEditor {
  return {
    getCursor: () => ({ line, ch }),
    getLine: (number) => value.split("\n")[number] ?? "",
    getValue: () => value,
  };
}

function suggestHarness(): {
  app: { workspace: { editorSuggest: FakeSuggest } };
  calls: TriggerCall[];
  closes: number[];
  suggest: FakeSuggest;
} {
  const calls: TriggerCall[] = [];
  const closes: number[] = [];
  const suggest: FakeSuggest = {
    close: () => { closes.push(1); },
    trigger(this: FakeSuggest, editor, file, open): string {
      calls.push({ receiver: this, editor, file, open });
      return "native-result";
    },
  };
  return { app: { workspace: { editorSuggest: suggest } }, calls, closes, suggest };
}

test("a typst /typst line closes the native suggester without triggering it", () => {
  // #given
  const h = suggestHarness();
  const restore = installNativeSuggestGuard(h.app, (file) => file?.path === "Notes/Plan.md");
  const editor = editorAt("/typst #callout", 6);
  const file = { path: "Notes/Plan.md" };

  // #when
  const result = h.suggest.trigger(editor, file, true);

  // #then
  try {
    assert.deepEqual({ result, calls: h.calls, closes: h.closes }, { result: undefined, calls: [], closes: [1] });
  } finally {
    restore?.();
  }
});

test("ordinary, prefix, and non-typst note calls preserve native trigger arguments and receiver", () => {
  // #given
  const h = suggestHarness();
  const restore = installNativeSuggestGuard(h.app, (file) => file?.path === "Notes/Plan.md");
  const ordinary = editorAt("ordinary #tag", 13);
  const prefix = editorAt("/typst #callout", 5);
  const nonTypst = editorAt("/typst #callout", 6);
  const typstFile = { path: "Notes/Plan.md" };
  const markdownFile = { path: "Notes/Plain.md" };

  // #when
  const results = [
    h.suggest.trigger(ordinary, typstFile, true),
    h.suggest.trigger(prefix, typstFile, false),
    h.suggest.trigger(nonTypst, markdownFile, true),
  ];

  // #then
  try {
    assert.deepEqual(
      {
        results,
        calls: h.calls.map(({ receiver, editor, file, open }) => ({
          receiverIsSuggest: receiver === h.suggest,
          cursor: editor.getCursor(),
          line: editor.getLine(0),
          file: file?.path ?? null,
          open,
        })),
        closes: h.closes,
      },
      {
        results: ["native-result", "native-result", "native-result"],
        calls: [
          { receiverIsSuggest: true, cursor: { line: 0, ch: 13 }, line: "ordinary #tag", file: "Notes/Plan.md", open: true },
          { receiverIsSuggest: true, cursor: { line: 0, ch: 5 }, line: "/typst #callout", file: "Notes/Plan.md", open: false },
          { receiverIsSuggest: true, cursor: { line: 0, ch: 6 }, line: "/typst #callout", file: "Notes/Plain.md", open: true },
        ],
        closes: [],
      },
    );
  } finally {
    restore?.();
  }
});

test("a literal /typst line in a fence or comment preserves the native suggester", () => {
  // #given
  const h = suggestHarness();
  const restore = installNativeSuggestGuard(h.app, (file) => file?.path === "Notes/Plan.md");
  const file = { path: "Notes/Plan.md" };
  const editors = [
    editorIn("---\ntypst: true\n---\n```typ\n/typst #callout\n```", 4, 6),
    editorIn("---\ntypst: true\n---\n%%\n/typst #callout\n%%", 4, 6),
  ];

  // #when
  const results = editors.map((editor) => h.suggest.trigger(editor, file, true));

  // #then
  try {
    assert.deepEqual(
      {
        results,
        calls: h.calls.map((call) => ({ cursor: call.editor.getCursor(), line: call.editor.getLine(call.editor.getCursor().line) })),
        closes: h.closes,
      },
      {
        results: ["native-result", "native-result"],
        calls: [
          { cursor: { line: 4, ch: 6 }, line: "/typst #callout" },
          { cursor: { line: 4, ch: 6 }, line: "/typst #callout" },
        ],
        closes: [],
      },
    );
  } finally {
    restore?.();
  }
});

test("a bare /typst line inside a comment preserves the native suggester", () => {
  // #given
  const h = suggestHarness();
  const restore = installNativeSuggestGuard(h.app, (file) => file?.path === "Notes/Plan.md");
  const file = { path: "Notes/Plan.md" };
  const comment = editorIn("---\ntypst: true\n---\n%%\n/typst\n%%", 4, 6);
  const real = editorIn("---\ntypst: true\n---\n/typst", 3, 6);

  // #when
  const results = [
    h.suggest.trigger(comment, file, true),
    h.suggest.trigger(real, file, true),
  ];

  // #then
  try {
    assert.deepEqual(
      {
        results,
        calls: h.calls.map((call) => ({ cursor: call.editor.getCursor(), line: call.editor.getLine(call.editor.getCursor().line) })),
        closes: h.closes,
      },
      {
        results: ["native-result", undefined],
        calls: [{ cursor: { line: 4, ch: 6 }, line: "/typst" }],
        closes: [1],
      },
    );
  } finally {
    restore?.();
  }
});

test("a real /typst line after a fenced %% closes the native suggester", () => {
  // #given
  const h = suggestHarness();
  const restore = installNativeSuggestGuard(h.app, (file) => file?.path === "Notes/Plan.md");
  const editor = editorIn("---\ntypst: true\n---\n```\n%%\n```\n/typst #a", 6, 6);
  const file = { path: "Notes/Plan.md" };

  // #when
  const result = h.suggest.trigger(editor, file, true);

  // #then
  try {
    assert.deepEqual({ result, calls: h.calls, closes: h.closes }, { result: undefined, calls: [], closes: [1] });
  } finally {
    restore?.();
  }
});

test("restoring the guard returns the original trigger", () => {
  // #given
  const h = suggestHarness();
  const original = h.suggest.trigger;
  const restore = installNativeSuggestGuard(h.app, () => true);
  const editor = editorAt("/typst #callout", 6);
  const file = { path: "Notes/Plan.md" };

  // #when
  restore?.();
  const result = h.suggest.trigger(editor, file, true);

  // #then
  assert.deepEqual(
    {
      installed: restore !== null,
      restored: h.suggest.trigger === original,
      result,
      calls: h.calls.map((call) => ({ receiverIsSuggest: call.receiver === h.suggest, file: call.file?.path ?? null, open: call.open })),
      closes: h.closes,
    },
    {
      installed: true,
      restored: true,
      result: "native-result",
      calls: [{ receiverIsSuggest: true, file: "Notes/Plan.md", open: true }],
      closes: [],
    },
  );
});

test("a missing native suggester returns null", () => {
  // #given
  const app = { workspace: {} };

  // #when
  const installed = installNativeSuggestGuard(app, () => true);

  // #then
  assert.equal(installed, null);
});
