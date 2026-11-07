import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { TypstSource } from "../src/sources";
import TinymistPlugin from "../src/main";
import { MarkdownView, TFile, testApp } from "./support/obsidian";

function source(
  document: string,
  calls: Array<{ kind: string; position?: { line: number; character: number } }>,
): TypstSource {
  return {
    file: "notes/chapter.typ",
    entry: document,
    document,
    inputs: undefined,
    pinnable: true,
    pdf: "notes/chapter.pdf",
    open: () => ({ close: () => {} }),
    toSource: (position) => ({ line: position.line + 10, character: position.character + 20 }),
    toEntry: (position) => position,
    reveal: async (position) => {
      calls.push({ kind: "reveal", position });
    },
    describe: String,
    on: () => () => {},
    release: () => {
      calls.push({ kind: "release" });
    },
  };
}

class JumpPlugin extends TinymistPlugin {
  readonly opened: Array<{ document: string; line: number; character: number }> = [];

  async openAndPlaceCursor(document: string, line: number, character: number): Promise<void> {
    this.opened.push({ document, line, character });
  }
}

test("preview jumps use held and transient sources, then fall back to opening the file", async () => {
  // #given
  const app = testApp("/vault");
  const calls: Array<{ kind: string; position?: { line: number; character: number } }> = [];
  const held = source("/vault/notes/held.typ", calls);
  const transient = source("/vault/notes/transient.typ", calls);
  const plugin = new JumpPlugin(app as never, {});
  plugin.sources = {
    byDocument: (document: string) => (document === held.document ? held : null),
    hold: async (file: string) => (file === "notes/transient.typ" ? transient : null),
  } as never;

  // #when
  plugin.jumpToSource({ filepath: held.document, start: [1, 2], end: null });
  plugin.jumpToSource({ filepath: transient.document, start: [3, 4], end: null });
  plugin.jumpToSource({ filepath: "/vault/notes/fallback.typ", start: [5, 6], end: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  assert.deepEqual(
    { calls, opened: plugin.opened },
    {
      calls: [
        { kind: "reveal", position: { line: 11, character: 22 } },
        { kind: "reveal", position: { line: 13, character: 24 } },
        { kind: "release" },
      ],
      opened: [{ document: "/vault/notes/fallback.typ", line: 5, character: 6 }],
    },
  );
});

test("preview clicks on a typ file reveal through the real source registry", async () => {
  // #given
  const app = testApp("/vault");
  const plugin = new JumpPlugin(app as never, {});
  const realHold = plugin.sources.hold.bind(plugin.sources);
  const holds: Array<{ file: string; source: TypstSource | null }> = [];
  plugin.sources.hold = async (file) => {
    const source = await realHold(file);
    holds.push({ file, source });
    return source;
  };

  // #when
  plugin.jumpToSource({ filepath: "/vault/notes/a.typ", start: [7, 8], end: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  assert.deepEqual(
    {
      holds: holds.map(({ file, source }) => ({ file, resolved: source !== null })),
      opened: plugin.opened,
    },
    {
      holds: [{ file: "notes/a.typ", resolved: true }],
      opened: [{ document: join("/vault", "notes", "a.typ"), line: 7, character: 8 }],
    },
  );
});

test("placing a Markdown source cursor reuses its leaf or opens it before revealing", async () => {
  // #given
  const app = testApp("/vault");
  app.vault.files.set("Notes/A.md", "text");
  app.vault.files.set("Notes/B.md", "text");
  const existingView = new MarkdownView(new TFile("Notes/A.md"));
  const existingLeaf = { view: existingView };
  const activeLeaves: unknown[] = [];
  let leaves: unknown[] = [existingLeaf];
  let requestedLeafArgument: unknown = null;
  const openedView = new MarkdownView();
  const openedLeaf = {
    view: openedView,
    openFile: async (file: TFile) => {
      openedView.file = file;
    },
  };
  Object.assign(app.workspace, {
    getLeavesOfType: () => leaves,
    setActiveLeaf: (leaf: unknown) => activeLeaves.push(leaf),
    getLeaf: (argument: unknown) => {
      requestedLeafArgument = argument;
      return openedLeaf;
    },
  });
  const plugin = new TinymistPlugin(app as never, {});

  // #when
  await plugin.openAndPlaceCursor("/vault/Notes/A.md", 2, 7);
  leaves = [];
  await plugin.openAndPlaceCursor("/vault/Notes/B.md", 4, 9);

  // #then
  assert.deepEqual(
    {
      existingCursor: existingView.cursorCalls,
      existingScrolls: existingView.scrollCalls.length,
      activeLeaves,
      requestedLeafArgument,
      openedFile: openedView.file?.path,
      openedCursor: openedView.cursorCalls,
      openedScrolls: openedView.scrollCalls.length,
    },
    {
      existingCursor: [{ line: 2, ch: 7 }],
      existingScrolls: 1,
      activeLeaves: [existingLeaf],
      requestedLeafArgument: false,
      openedFile: "Notes/B.md",
      openedCursor: [{ line: 4, ch: 9 }],
      openedScrolls: 1,
    },
  );
});
