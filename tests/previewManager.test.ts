import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type TinymistPlugin from "../src/main";
import { PreviewManager } from "../src/preview/previewManager";
import { SourceRegistry, typAdapter, type TypstSource } from "../src/sources";

function source(path: string, release: () => void, entryOffset = 0): TypstSource {
  return {
    file: path,
    entry: `/vault/${path}`,
    document: `/vault/${path}`,
    inputs: `/input/${path}`,
    pinnable: true,
    pdf: `${path}.pdf`,
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => ({
      line: position.line + entryOffset,
      character: position.character + entryOffset,
    }),
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("starting a renamed preview launches the requested path instead of reusing the old task", async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "typst-preview-manager-"));
  const oldFolder = join(root, "old");
  const newFolder = join(root, "new");
  mkdirSync(oldFolder);
  writeFileSync(join(oldFolder, ".tinymist-preview.typ"), "#include sys.inputs.at(\"preview-source\")\n");
  writeFileSync(join(oldFolder, "chapter.typ"), "= Chapter\n");
  const previewSources: Array<string | null> = [];
  const startEntries: string[] = [];
  const lsp = {
    status: "running",
    mainFile: null,
    onNotification: () => {},
    setPreviewSource: (source?: string) => previewSources.push(source ?? null),
    pinMain: () => {},
    executeCommand: async (command: string, args: unknown[]): Promise<Record<string, number>> => {
      if (command === "tinymist.doStartPreview") {
        const commandArgs = args[0] as string[];
        startEntries.push(commandArgs.at(-1) ?? "");
        return { staticServerPort: 4321 + startEntries.length };
      }
      return {};
    },
  };
  const plugin = {
    lsp,
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => root,
    sources: new SourceRegistry([
      typAdapter({ root: () => root, reveal: async () => {} }),
    ]),
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const oldPath = join(oldFolder, "chapter.typ");
  const newPath = join(newFolder, "chapter.typ");

  // #when
  try {
    await manager.start(oldPath);
    renameSync(oldFolder, newFolder);
    manager.onVaultRename("new", "old");
    await manager.start(newPath);

    // #then
    assert.deepEqual(
      { startEntries, previewSources: previewSources.filter((source) => source !== null) },
      {
        startEntries: [
          join(oldFolder, ".tinymist-preview.typ"),
          join(newFolder, ".tinymist-preview.typ"),
        ],
        previewSources: ["/old/chapter.typ", "/new/chapter.typ"],
      },
    );
  } finally {
    await manager.stop();
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("renaming a running preview sends no language-client call", async () => {
  // #given
  const calls: string[] = [];
  const holds: TypstSource[] = [];
  const releases = new Map<string, number>();
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push(`setPreviewSource:${input ?? ""}`),
      pinMain: () => calls.push("pinMain"),
      executeCommand: async (command: string) => {
        calls.push(command);
        return command === "tinymist.doStartPreview" ? { staticServerPort: 4321 } : {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        const held = source(path, () => {
          releases.set(path, (releases.get(path) ?? 0) + 1);
        });
        holds.push(held);
        return held;
      },
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  await manager.start("/vault/old/chapter.typ");
  calls.length = 0;

  // #when
  manager.onVaultRename("new", "old");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const afterRename = {
    old: releases.get("old/chapter.typ") ?? 0,
    next: releases.get("new/chapter.typ") ?? 0,
  };
  const renameCalls = [...calls];
  const sourcePath = manager.sourcePath();
  await manager.stop();
  const afterStop = {
    old: releases.get("old/chapter.typ") ?? 0,
    next: releases.get("new/chapter.typ") ?? 0,
  };

  // #then
  try {
    assert.deepEqual(
      { calls: renameCalls, sourcePath, holds: holds.length, afterRename, afterStop },
      {
        calls: [],
        sourcePath: "new/chapter.typ",
        holds: 2,
        afterRename: { old: 1, next: 0 },
        afterStop: { old: 1, next: 1 },
      },
    );
  } finally {
    manager.dispose();
  }
});

test("overlapping preview starts release every held source after stop", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  let startCalls = 0;
  let holds = 0;
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => {},
      pinMain: () => {},
      executeCommand: async (command: string) => {
        if (command !== "tinymist.doStartPreview") return {};
        startCalls++;
        return startCalls === 1 ? await firstStart.promise : { staticServerPort: 4322 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        holds++;
        return source(path, () => {
          releases++;
        });
      },
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const first = manager.start("/vault/first.typ");
  await Promise.resolve();
  const second = manager.start("/vault/second.typ");
  await second;
  firstStart.resolve({ staticServerPort: 4321 });
  await first;

  // #when
  await manager.stop();

  // #then
  try {
    assert.deepEqual({ holds, releases, balance: holds - releases }, { holds: 2, releases: 2, balance: 0 });
  } finally {
    manager.dispose();
  }
});

test("preview lifecycle releases its held source on every terminal path", async () => {
  // #given
  const rows = [
    "stop",
    "dispose",
    "restart",
    "server-dispose",
    "start-rejects",
    "start-has-no-port",
  ] as const;
  const observed: Array<{ row: string; result: string; holds: number; releases: number }> = [];

  // #when
  for (const row of rows) {
    let holds = 0;
    let releases = 0;
    let taskId: string | null = null;
    const notifications = new Map<string, (params: unknown) => void>();
    const plugin = {
      lsp: {
        status: "running",
        mainFile: null,
        onNotification: (method: string, listener: (params: unknown) => void) => {
          notifications.set(method, listener);
        },
        setPreviewSource: () => {},
        pinMain: () => {},
        executeCommand: async (command: string, args: unknown[]) => {
          if (command !== "tinymist.doStartPreview") return {};
          taskId = (args[0] as string[])[1] ?? null;
          if (row === "start-rejects") throw new Error("preview start failed");
          return row === "start-has-no-port" ? {} : { staticServerPort: 4321 };
        },
      },
      settings: { invertPreviewColors: "never" },
      vaultBasePath: () => "/vault",
      sources: {
        hold: async (path: string) => {
          holds++;
          return source(path, () => {
            releases++;
          });
        },
        byDocument: () => null,
        mayBeSource: (path: string) => path.endsWith(".typ"),
      },
      jumpToSource: () => {},
    } as unknown as TinymistPlugin;
    const manager = new PreviewManager(plugin);
    let result = "resolved";
    try {
      await manager.start("/vault/notes/chapter.typ");
    } catch {
      result = "rejected";
    }
    if (row === "stop") await manager.stop();
    if (row === "dispose") manager.dispose();
    if (row === "restart") manager.onLspRestart();
    if (row === "server-dispose") notifications.get("tinymist/preview/dispose")?.({ taskId });
    await Promise.resolve();
    observed.push({ row, result, holds, releases });
    manager.dispose();
  }

  // #then
  assert.deepEqual(observed, [
    { row: "stop", result: "resolved", holds: 1, releases: 1 },
    { row: "dispose", result: "resolved", holds: 1, releases: 1 },
    { row: "restart", result: "resolved", holds: 1, releases: 1 },
    { row: "server-dispose", result: "resolved", holds: 1, releases: 1 },
    { row: "start-rejects", result: "rejected", holds: 1, releases: 1 },
    { row: "start-has-no-port", result: "rejected", holds: 1, releases: 1 },
  ]);
});

test("cursor sync uses the caller source mapping and falls back to caller coordinates", async () => {
  // #given
  const scrolls: unknown[] = [];
  const held = source("notes/chapter.typ", () => {}, 10);
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => {},
      pinMain: () => {},
      executeCommand: async (command: string, args: unknown[]) => {
        if (command === "tinymist.scrollPreview") scrolls.push(args[1]);
        return command === "tinymist.doStartPreview" ? { staticServerPort: 4321 } : {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async () => held,
      byDocument: (document: string) => (document === held.document ? held : null),
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  await manager.start("/vault/notes/chapter.typ");

  // #when
  manager.cursorMoved("/vault/notes/chapter.typ", 1, 2);
  manager.cursorMoved("/vault/notes/other.typ", 3, 4);
  await Promise.resolve();

  // #then
  try {
    assert.deepEqual(scrolls, [
      { event: "panelScrollTo", filepath: "/vault/notes/chapter.typ", line: 11, character: 12 },
      { event: "panelScrollTo", filepath: "/vault/notes/other.typ", line: 3, character: 4 },
    ]);
  } finally {
    await manager.stop();
    manager.dispose();
  }
});
