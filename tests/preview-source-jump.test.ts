import assert from "node:assert/strict";
import { test } from "node:test";
import type { TypstSource } from "../src/sources";
import TinymistPlugin from "../src/main";
import { testApp } from "./support/obsidian";

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

  // #when
  plugin.jumpToSource({ filepath: "/vault/notes/a.typ", start: [7, 8], end: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  assert.deepEqual(plugin.opened, [
    { document: "/vault/notes/a.typ", line: 7, character: 8 },
  ]);
});
