import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client";
import TinymistPlugin from "../src/main";
import { PreviewManager } from "../src/preview/previewManager";
import { DEFAULT_SETTINGS } from "../src/settings";
import { SourceRegistry, typAdapter, type TypstSource } from "../src/sources";
import { virtualAddress } from "./support/virtualAddress";

function source(path: string, release: () => void, entryOffset = 0): TypstSource {
  return {
    file: path,
    entry: `/vault/${path}`,
    document: `/vault/${path}`,
    inputs: `/input/${path}`,
    pinnable: true,
    exportable: true,
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
  } as TypstSource & { exportable: boolean };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(promise: Promise<T>, event: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function pendingStartHarness(): {
  manager: PreviewManager;
  sourceHeld: ReturnType<typeof deferred<TypstSource>>;
  holdReached: ReturnType<typeof deferred<void>>;
  calls: string[];
  counts(): { holds: number; releases: number };
  resolveSource(): void;
} {
  const sourceHeld = deferred<TypstSource>();
  const holdReached = deferred<void>();
  let holds = 0;
  let releases = 0;
  const calls: string[] = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => calls.push("setPreviewSource"),
      pinMain: () => calls.push("pinMain"),
      executeCommand: async (command: string) => {
        calls.push(command);
        return { staticServerPort: 4321 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async () => {
        holds++;
        holdReached.resolve();
        return await sourceHeld.promise;
      },
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  return {
    manager: new PreviewManager(plugin),
    sourceHeld,
    holdReached,
    calls,
    counts: () => ({ holds, releases }),
    resolveSource: () => sourceHeld.resolve(source("chapter.typ", () => {
      releases++;
    })),
  };
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

test("renaming a running preview to a non-source releases its old source without killing the task", async () => {
  // #given
  const calls: Array<Record<string, string | undefined>> = [];
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        return { staticServerPort: 4321 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) =>
        path.endsWith(".typ")
          ? source(path, () => {
              releases++;
            })
          : null,
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);

  try {
    await manager.start("/vault/a.typ");
    calls.length = 0;

    // #when
    manager.onVaultRename("a.txt", "a.typ");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // #then
    assert.deepEqual(
      { releases, filePath: manager.filePath, sourcePath: manager.sourcePath(), calls },
      { releases: 1, filePath: normalize(join("/vault", "a.txt")), sourcePath: null, calls: [] },
    );
  } finally {
    await manager.stop();
    manager.dispose();
  }
});

test("a rebind that becomes stale releases its deferred source", async () => {
  // #given
  const rebindHold = deferred<TypstSource>();
  const rebindReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let holds = 0;
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        return { staticServerPort: 4321 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        holds++;
        if (path === "b.typ") {
          rebindReached.resolve();
          return await rebindHold.promise;
        }
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
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    await manager.start("/vault/a.typ");
    calls.length = 0;
    manager.onVaultRename("b.typ", "a.typ");
    await waitFor(rebindReached.promise, "the rename source hold");

    // #when
    await manager.stop();
    rebindHold.resolve(
      source("b.typ", () => {
        releases++;
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // #then
    assert.deepEqual(
      { holds, releases, calls },
      {
        holds: 2,
        releases: 2,
        calls: [
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("stopping a start after its preview command resets the client after killing its task", async () => {
  // #given
  const secondStart = deferred<{ staticServerPort: number }>();
  const secondCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let starts = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          starts++;
          if (starts === 2) {
            secondCommandReached.resolve();
            return await secondStart.promise;
          }
          return { staticServerPort: 4321 };
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  Math.random = () => (starts === 0 ? 0.123456789 : 0.234567891);

  try {
    await manager.start("/vault/a.typ");
    const second = manager.start("/vault/b.typ");
    await waitFor(secondCommandReached.promise, "the second preview command");
    calls.length = 0;

    // #when
    await manager.stop();
    secondStart.resolve({ staticServerPort: 4322 });
    const result = await second;

    // #then
    assert.deepEqual(
      { result, calls },
      {
        result: null,
        calls: [
          { command: "tinymist.doKillPreview", taskId: "8fzzzdp" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("stopping two pending starts resets the client after the started task is killed", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const secondHold = deferred<TypstSource>();
  const secondHoldReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          firstCommandReached.resolve();
          return await firstStart.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        if (path === "second.typ") {
          secondHoldReached.resolve();
          return await secondHold.promise;
        }
        return source(path, () => {});
      },
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    const first = manager.start("/vault/first.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const second = manager.start("/vault/second.typ");
    await waitFor(secondHoldReached.promise, "the second source hold");

    // #when
    await manager.stop();
    secondHold.resolve(source("second.typ", () => {}));
    firstStart.resolve({ staticServerPort: 4321 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // #then
    assert.deepEqual(
      { firstResult, secondResult, calls },
      {
        firstResult: null,
        secondResult: null,
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a rejected start superseded by stop clears its preview source", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          firstCommandReached.resolve();
          return await firstStart.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    const start = manager.start("/vault/first.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");

    // #when
    await manager.stop();
    firstStart.reject(new Error("preview start failed"));
    const result = await start;

    // #then
    assert.deepEqual(
      { result, calls },
      {
        result: null,
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("overlapping preview starts release every held source after stop", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  let startCalls = 0;
  let holds = 0;
  let releases = 0;
  const calls: Array<Record<string, string | undefined>> = [];
  const liveTaskIds = new Set<string>();
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        const recordedTaskId = typeof taskId === "string" ? taskId : undefined;
        calls.push({ command, taskId: recordedTaskId });
        if (command === "tinymist.doKillPreview" && recordedTaskId) liveTaskIds.delete(recordedTaskId);
        if (command !== "tinymist.doStartPreview") return {};
        if (recordedTaskId) liveTaskIds.add(recordedTaskId);
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
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/first.typ");
    await Promise.resolve();
    const second = manager.start("/vault/second.typ");
    const secondResult = await second;
    firstStart.resolve({ staticServerPort: 4321 });
    const firstResult = await first;
    const liveAfterSupersededStart = [...liveTaskIds];

    // #when
    await manager.stop();

    // #then
    assert.deepEqual(
      {
        firstResult,
        secondResult,
        holds,
        releases,
        balance: holds - releases,
        calls,
        liveAfterSupersededStart,
        liveAfterStop: [...liveTaskIds],
      },
      {
        firstResult: null,
        secondResult: "http://127.0.0.1:4322",
        holds: 2,
        releases: 2,
        balance: 0,
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/second.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "8fzzzdp" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
        liveAfterSupersededStart: ["8fzzzdp"],
        liveAfterStop: [],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a rejected superseded start leaves the newer preview source set", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let starts = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          starts++;
          if (starts === 1) {
            firstCommandReached.resolve();
            return await firstStart.promise;
          }
          return { staticServerPort: 4322 };
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/first.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const secondResult = await manager.start("/vault/second.typ");

    // #when
    firstStart.reject(new Error("preview start failed"));
    const firstResult = await first;

    // #then
    assert.deepEqual(
      { firstResult, secondResult, calls },
      {
        firstResult: null,
        secondResult: "http://127.0.0.1:4322",
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/second.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    await manager.stop();
    manager.dispose();
  }
});

test("stopping while a preview source is held prevents the preview from starting", async () => {
  // #given
  const sourceHeld = deferred<TypstSource>();
  const holdReached = deferred<void>();
  let holds = 0;
  let releases = 0;
  const commands: string[] = [];
  const previewSources: Array<string | undefined> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: (input?: string) => previewSources.push(input),
      pinMain: () => {},
      executeCommand: async (command: string) => {
        commands.push(command);
        return { staticServerPort: 4321 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async () => {
        holds++;
        holdReached.resolve();
        return await sourceHeld.promise;
      },
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const start = manager.start("/vault/chapter.typ");
  await waitFor(holdReached.promise, "the preview source hold");

  // #when
  await manager.stop();
  sourceHeld.resolve(source("chapter.typ", () => {
    releases++;
  }));
  const result = await start;

  // #then
  try {
    assert.deepEqual(
      {
        result,
        starts: commands.filter((command) => command === "tinymist.doStartPreview").length,
        previewSources: previewSources.length,
        holds,
        releases,
      },
      { result: null, starts: 0, previewSources: 0, holds: 1, releases: 1 },
    );
  } finally {
    manager.dispose();
  }
});

test("disposing a pending start releases its source without calling the language client", async () => {
  // #given
  const h = pendingStartHarness();

  try {
    const start = h.manager.start("/vault/chapter.typ");
    await waitFor(h.holdReached.promise, "the pending preview source hold");

    // #when
    h.manager.dispose();
    h.resolveSource();
    const result = await start;

    // #then
    assert.deepEqual(
      { result, ...h.counts(), calls: h.calls },
      { result: null, holds: 1, releases: 1, calls: [] },
    );
  } finally {
    h.manager.dispose();
  }
});

test("restarting the language server supersedes a pending start and releases its source", async () => {
  // #given
  const h = pendingStartHarness();

  try {
    const start = h.manager.start("/vault/chapter.typ");
    await waitFor(h.holdReached.promise, "the pending preview source hold");

    // #when
    h.manager.onLspRestart();
    h.resolveSource();
    const result = await start;

    // #then
    assert.deepEqual(
      { result, ...h.counts(), calls: h.calls },
      { result: null, holds: 1, releases: 1, calls: [] },
    );
  } finally {
    h.manager.dispose();
  }
});

test("a server dispose notification supersedes the start that created its task", async () => {
  // #given
  const notifications = new Map<string, (params: unknown) => void>();
  const commandReached = deferred<void>();
  const commandResult = deferred<{ staticServerPort: number }>();
  let holds = 0;
  let releases = 0;
  let startTaskId = "";
  const calls: Array<Record<string, string | undefined>> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: (method: string, listener: (params: unknown) => void) => {
        notifications.set(method, listener);
      },
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: () => calls.push({ method: "pinMain" }),
      executeCommand: async (command: string, args: unknown[]) => {
        const commandTaskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof commandTaskId === "string" ? commandTaskId : undefined });
        if (command === "tinymist.doStartPreview") {
          startTaskId = commandTaskId as string;
          commandReached.resolve();
          return await commandResult.promise;
        }
        return {};
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
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    // #when
    const start = manager.start("/vault/chapter.typ");
    await waitFor(commandReached.promise, "the pending preview command");
    notifications.get("tinymist/preview/dispose")?.({ taskId: startTaskId });
    commandResult.resolve({ staticServerPort: 4321 });
    const result = await start;

    // #then
    assert.deepEqual(
      { result, holds, releases, calls },
      {
        result: null,
        holds: 1,
        releases: 1,
        calls: [
          { method: "setPreviewSource", input: "/input/chapter.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a dispose for a replacement task already killed leaves the pending preview alone", async () => {
  // #given
  const notifications = new Map<string, (params: unknown) => void>();
  const firstCommand = deferred<{ staticServerPort: number }>();
  const secondCommand = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const secondCommandReached = deferred<void>();
  const taskIds: string[] = [];
  const calls: Array<Record<string, string | undefined>> = [];
  let holds = 0;
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: (method: string, listener: (params: unknown) => void) => {
        notifications.set(method, listener);
      },
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command !== "tinymist.doStartPreview") return {};
        taskIds.push(taskId as string);
        if (taskIds.length === 1) {
          firstCommandReached.resolve();
          return await firstCommand.promise;
        }
        secondCommandReached.resolve();
        return await secondCommand.promise;
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
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/first.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const second = manager.start("/vault/second.typ");
    await waitFor(secondCommandReached.promise, "the second preview command");
    firstCommand.resolve({ staticServerPort: 4321 });
    const firstResult = await first;
    const beforeDispose = [...calls];

    // #when
    notifications.get("tinymist/preview/dispose")?.({ taskId: taskIds[0] });
    secondCommand.resolve({ staticServerPort: 4322 });
    const secondResult = await second;
    const opened = secondResult ? [secondResult] : [];

    // #then
    assert.deepEqual(
      { firstResult, secondResult, opened, holds, releases, beforeDispose, calls },
      {
        firstResult: null,
        secondResult: "http://127.0.0.1:4322",
        opened: ["http://127.0.0.1:4322"],
        holds: 2,
        releases: 1,
        beforeDispose: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/second.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
        ],
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/second.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    await manager.stop();
    manager.dispose();
  }
});

test("a newer pending task stays disposable after an older start answers late", async () => {
  // #given
  const notifications = new Map<string, (params: unknown) => void>();
  const firstCommand = deferred<{ staticServerPort: number }>();
  const secondCommand = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const secondCommandReached = deferred<void>();
  const taskIds: string[] = [];
  const calls: Array<Record<string, string | undefined>> = [];
  let holds = 0;
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: (method: string, listener: (params: unknown) => void) => {
        notifications.set(method, listener);
      },
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command !== "tinymist.doStartPreview") return {};
        taskIds.push(taskId as string);
        if (taskIds.length === 1) {
          firstCommandReached.resolve();
          return await firstCommand.promise;
        }
        secondCommandReached.resolve();
        return await secondCommand.promise;
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
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/first.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const second = manager.start("/vault/second.typ");
    await waitFor(secondCommandReached.promise, "the second preview command");
    firstCommand.resolve({ staticServerPort: 4321 });
    const firstResult = await first;

    // #when
    notifications.get("tinymist/preview/dispose")?.({ taskId: taskIds[1] });
    secondCommand.resolve({ staticServerPort: 4322 });
    const secondResult = await second;

    // #then
    assert.deepEqual(
      { firstResult, secondResult, holds, releases, calls },
      {
        firstResult: null,
        secondResult: null,
        holds: 2,
        releases: 2,
        calls: [
          { method: "setPreviewSource", input: "/input/first.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/second.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "8fzzzdp" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("disposing a deferred rename rebind releases both sources", async () => {
  // #given
  const rebindHold = deferred<TypstSource>();
  const rebindReached = deferred<void>();
  let holds = 0;
  let releases = 0;
  const calls: string[] = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => calls.push("setPreviewSource"),
      pinMain: () => calls.push("pinMain"),
      executeCommand: async (command: string) => {
        calls.push(command);
        return { staticServerPort: 4321 };
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        holds++;
        if (path === "b.typ") {
          rebindReached.resolve();
          return await rebindHold.promise;
        }
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

  try {
    await manager.start("/vault/a.typ");
    calls.length = 0;
    manager.onVaultRename("b.typ", "a.typ");
    await waitFor(rebindReached.promise, "the rename source hold");

    // #when
    manager.dispose();
    rebindHold.resolve(
      source("b.typ", () => {
        releases++;
      }),
    );
    await waitFor(
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
      "the deferred rename source settlement",
    );

    // #then
    assert.deepEqual(
      { holds, releases, calls },
      { holds: 2, releases: 2, calls: [] },
    );
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

test("a failed newer start resets the client after a superseded task is killed", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          firstCommandReached.resolve();
          return await firstStart.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => (path === "b.typ" ? null : source(path, () => {})),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    const first = manager.start("/vault/a.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");

    // #when
    const second = manager.start("/vault/b.typ");
    firstStart.resolve({ staticServerPort: 4321 });
    const [firstResult, secondResult] = await Promise.all([
      first,
      second.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
    ]);

    // #then
    assert.deepEqual(
      { firstResult, secondResult, calls },
      {
        firstResult: null,
        secondResult: "preview source is unavailable",
        calls: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a rejecting newer hold resets the client after a superseded task is killed", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let holds = 0;
  let releases = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          firstCommandReached.resolve();
          return await firstStart.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => {
        if (path === "b.typ") throw new Error("source lookup failed");
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
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    const first = manager.start("/vault/a.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");

    // #when
    const second = manager.start("/vault/b.typ").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    firstStart.resolve({ staticServerPort: 4321 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // #then
    assert.deepEqual(
      { firstResult, secondResult, holds, releases, calls },
      {
        firstResult: null,
        secondResult: "source lookup failed",
        holds: 1,
        releases: 1,
        calls: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("stopping a newer preview waits for every superseded kill before resetting the client", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const firstKillReached = deferred<void>();
  const firstKill = deferred<Record<string, never>>();
  const secondKillReached = deferred<void>();
  const secondKill = deferred<Record<string, never>>();
  const calls: Array<Record<string, string | undefined>> = [];
  let starts = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        const recordedTaskId = typeof taskId === "string" ? taskId : undefined;
        calls.push({ command, taskId: recordedTaskId });
        if (command === "tinymist.doStartPreview") {
          starts++;
          if (starts === 1) {
            firstCommandReached.resolve();
            return await firstStart.promise;
          }
          return { staticServerPort: 4322 };
        }
        if (recordedTaskId === "4fzzzxj") {
          firstKillReached.resolve();
          return await firstKill.promise;
        }
        secondKillReached.resolve();
        return await secondKill.promise;
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/a.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const secondResult = await manager.start("/vault/b.typ");
    const stopped = manager.stop();
    await waitFor(secondKillReached.promise, "the newer preview kill");
    firstStart.resolve({ staticServerPort: 4321 });
    await waitFor(firstKillReached.promise, "the superseded preview kill");

    // #when
    secondKill.resolve({});
    await stopped;
    const callsAfterSecondKill = [...calls];
    firstKill.resolve({});
    const firstResult = await first;

    // #then
    assert.deepEqual(
      { firstResult, secondResult, callsAfterSecondKill, calls },
      {
        firstResult: null,
        secondResult: "http://127.0.0.1:4322",
        callsAfterSecondKill: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/b.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
        ],
        calls: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/b.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("preview start, source rebind, and stop close each Markdown document before release", async () => {
  // #given
  const lifecycle: string[] = [];
  const makeSource = (path: string): TypstSource => ({
    file: path,
    entry: `/vault/${path}.typ`,
    document: `/vault/${path}.typ`,
    inputs: undefined,
    pinnable: false,
    exportable: false,
    pdf: path.replace(/\.md$/i, ".pdf"),
    open: () => {
      lifecycle.push(`open:${path}`);
      return { close: () => lifecycle.push(`close:${path}`) };
    },
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release: () => lifecycle.push(`release:${path}`),
  } as TypstSource & { exportable: boolean });
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => {},
      pinMain: () => {},
      executeCommand: async (command: string) =>
        command === "tinymist.doStartPreview" ? { staticServerPort: 4321 } : {},
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => makeSource(path),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".md"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);

  // #when
  await manager.start("/vault/Notes/A.md");
  manager.onVaultRename("Notes/B.md", "Notes/A.md");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await manager.stop();

  // #then
  try {
    assert.deepEqual(lifecycle, [
      "open:Notes/A.md",
      "close:Notes/A.md",
      "release:Notes/A.md",
      "open:Notes/B.md",
      "close:Notes/B.md",
      "release:Notes/B.md",
    ]);
  } finally {
    manager.dispose();
  }
});

test("Markdown moved and ended events restart then stop the same held preview source", async () => {
  // #given
  const listeners = new Map<"moved" | "ended" | "problems", Set<() => void>>([
    ["moved", new Set()],
    ["ended", new Set()],
    ["problems", new Set()],
  ]);
  let file = "Notes/A.md";
  let entry = virtualAddress("/vault", "Notes/A.md");
  let holds = 0;
  let releases = 0;
  let port = 4320;
  const calls: Array<{ command: string; entry?: string }> = [];
  const held = {
    get file(): string { return file; },
    get entry(): string { return entry; },
    get document(): string { return entry; },
    inputs: undefined,
    pinnable: false,
    exportable: false,
    get pdf(): string { return file.replace(/\.md$/iu, ".pdf"); },
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe: String,
    on: (event, listener) => {
      listeners.get(event)?.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    release: () => { releases++; },
  } as TypstSource & { exportable: boolean };
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => {},
      pinMain: () => {},
      executeCommand: async (command: string, args: unknown[]) => {
        const commandArgs = command === "tinymist.doStartPreview" ? args[0] as string[] : null;
        calls.push({ command, ...(commandArgs ? { entry: commandArgs.at(-1) } : {}) });
        return command === "tinymist.doStartPreview" ? { staticServerPort: ++port } : {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async () => {
        holds++;
        return held;
      },
      byDocument: () => null,
      mayBeSource: () => false,
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  await manager.start("/vault/Notes/A.md");

  // #when
  file = "Notes/B.md";
  entry = virtualAddress("/vault", "Notes/B.md");
  for (const listener of listeners.get("moved") ?? []) listener();
  manager.onVaultRename("Notes/B.md", "Notes/A.md");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const afterMove = { filePath: manager.filePath, url: manager.url };
  for (const listener of listeners.get("ended") ?? []) listener();
  manager.onVaultDelete("Notes/B.md");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  try {
    assert.deepEqual(
      { holds, releases, calls, afterMove, afterEnd: { filePath: manager.filePath, url: manager.url } },
      {
        holds: 1,
        releases: 1,
        calls: [
          { command: "tinymist.doStartPreview", entry: virtualAddress("/vault", "Notes/A.md") },
          { command: "tinymist.doKillPreview" },
          { command: "tinymist.doStartPreview", entry: virtualAddress("/vault", "Notes/B.md") },
          { command: "tinymist.doKillPreview" },
        ],
        afterMove: { filePath: "/vault/Notes/B.md", url: "http://127.0.0.1:4322" },
        afterEnd: { filePath: null, url: null },
      },
    );
  } finally {
    manager.dispose();
  }
});

test("startLsp restart reopens an active Markdown preview on the new client", async () => {
  // #given
  const clientIds = new WeakMap<LspClient, number>();
  const documents: Array<{ client: number; method: "didOpen" | "didClose"; path: string }> = [];
  const previewStarts: Array<{ client: number; entry: string }> = [];
  let nextClientId = 1;
  let creates = 0;
  const mutablePrototype = LspClient.prototype as unknown as Record<string, unknown>;
  const original = {
    start: mutablePrototype.start,
    stop: mutablePrototype.stop,
    didOpen: mutablePrototype.didOpen,
    didClose: mutablePrototype.didClose,
    executeCommand: mutablePrototype.executeCommand,
    setPreviewSource: mutablePrototype.setPreviewSource,
    pinMain: mutablePrototype.pinMain,
  };
  mutablePrototype.start = async function (this: LspClient): Promise<void> {
    clientIds.set(this, ++nextClientId);
    this.status = "running";
  };
  mutablePrototype.stop = function (this: LspClient): void {
    this.status = "stopped";
  };
  mutablePrototype.didOpen = function (this: LspClient, path: string): void {
    documents.push({ client: clientIds.get(this) ?? -1, method: "didOpen", path });
  };
  mutablePrototype.didClose = function (this: LspClient, path: string): void {
    documents.push({ client: clientIds.get(this) ?? -1, method: "didClose", path });
  };
  mutablePrototype.executeCommand = async function (this: LspClient, command: string, args: unknown[]): Promise<unknown> {
    if (command === "tinymist.doStartPreview") {
      previewStarts.push({
        client: clientIds.get(this) ?? -1,
        entry: (args[0] as string[]).at(-1) ?? "",
      });
      return { staticServerPort: 4320 + previewStarts.length };
    }
    return {};
  };
  mutablePrototype.setPreviewSource = (): void => {};
  mutablePrototype.pinMain = (): void => {};

  const adapter = {
    mayBe: (path: string) => path.endsWith(".md"),
    create: async (path: string, release: () => void) => {
      creates++;
      const entry = virtualAddress("/vault", path);
      return {
        file: path,
        entry,
        document: entry,
        inputs: undefined,
        pinnable: false,
        exportable: false,
        pdf: path.replace(/\.md$/iu, ".pdf"),
        open: (client: LspClient) => {
          client.didOpen(entry, "converted");
          let open = true;
          return { close: () => {
            if (!open) return;
            open = false;
            client.didClose(entry);
          } };
        },
        toSource: (position: { line: number; character: number }) => position,
        toEntry: (position: { line: number; character: number }) => position,
        reveal: async () => {},
        describe: String,
        on: () => () => {},
        release,
      } as TypstSource & { exportable: boolean };
    },
  };
  const oldClient = new LspClient("old", "/vault", () => {});
  oldClient.status = "running";
  clientIds.set(oldClient, 1);
  const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin;
  Object.assign(plugin, {
    settings: { ...DEFAULT_SETTINGS, binaryPath: "/fake/tinymist" },
    lsp: oldClient,
    app: {
      vault: { adapter: { getBasePath: () => "/vault" } },
      workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null },
    },
    sources: new SourceRegistry([adapter]),
    resolveBinary: () => "/fake/tinymist",
    vaultBasePath: () => "/vault",
  });
  const manager = new PreviewManager(plugin);
  plugin.preview = manager;

  try {
    await manager.start("/vault/Notes/A.md");

    // #when
    await plugin.startLsp(true);

    // #then
    assert.deepEqual(
      { documents, previewStarts, creates, active: { filePath: manager.filePath, url: manager.url } },
      {
        documents: [
          { client: 1, method: "didOpen", path: virtualAddress("/vault", "Notes/A.md") },
          { client: 1, method: "didClose", path: virtualAddress("/vault", "Notes/A.md") },
          { client: 2, method: "didOpen", path: virtualAddress("/vault", "Notes/A.md") },
        ],
        previewStarts: [
          { client: 1, entry: virtualAddress("/vault", "Notes/A.md") },
          { client: 2, entry: virtualAddress("/vault", "Notes/A.md") },
        ],
        creates: 2,
        active: { filePath: "/vault/Notes/A.md", url: "http://127.0.0.1:4322" },
      },
    );
  } finally {
    manager.dispose();
    plugin.lsp?.stop();
    Object.assign(mutablePrototype, original);
  }
});

test("a preview start failure is described by its held source", async () => {
  // #given
  const held = source("Notes/A.md", () => {});
  held.describe = () => "Notes/A.md:3:5: unknown variable";
  const plugin = {
    lsp: {
      status: "running",
      mainFile: null,
      onNotification: () => {},
      setPreviewSource: () => {},
      pinMain: () => {},
      executeCommand: async () => {
        throw new Error(`${virtualAddress("/vault", "Notes/A.md")}:3:5: unknown variable`);
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async () => held,
      byDocument: () => null,
      mayBeSource: () => true,
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);

  // #when
  const start = manager.start("/vault/Notes/A.md");

  // #then
  try {
    await assert.rejects(start, {
      name: "Error",
      message: "Notes/A.md:3:5: unknown variable",
    });
  } finally {
    manager.dispose();
  }
});

test("a second stop preserves the pin due after a pending preview start fails", async () => {
  // #given
  const firstStart = deferred<{ staticServerPort: number }>();
  const secondStart = deferred<{ staticServerPort: number }>();
  const firstCommandReached = deferred<void>();
  const secondCommandReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let starts = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        if (command === "tinymist.doStartPreview") {
          starts++;
          if (starts === 1) {
            firstCommandReached.resolve();
            return await firstStart.promise;
          }
          secondCommandReached.resolve();
          return await secondStart.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    const first = manager.start("/vault/a.typ");
    await waitFor(firstCommandReached.promise, "the first preview command");
    const second = manager.start("/vault/b.typ");
    await waitFor(secondCommandReached.promise, "the second preview command");
    await manager.stop();
    firstStart.resolve({ staticServerPort: 4321 });
    const firstResult = await first;
    await manager.stop();

    // #when
    secondStart.reject(new Error("preview start failed"));
    const secondResult = await second;

    // #then
    assert.deepEqual(
      { firstResult, secondResult, calls },
      {
        firstResult: null,
        secondResult: null,
        calls: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/b.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a preview command without a port kills its task before resetting the client", async () => {
  // #given
  const calls: Array<Record<string, string | undefined>> = [];
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        calls.push({ command, taskId: typeof taskId === "string" ? taskId : undefined });
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  Math.random = () => 0.123456789;

  try {
    // #when
    const result = await manager.start("/vault/a.typ").then(
      () => "resolved",
      (error: Error) => error.message,
    );

    // #then
    assert.deepEqual(
      { result, calls },
      {
        result: "preview did not report a server port",
        calls: [
          { method: "setPreviewSource", input: "/input/a.typ" },
          { command: "tinymist.doStartPreview", taskId: "4fzzzxj" },
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: undefined },
          { method: "pinMain", main: "/vault/main.typ" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    manager.dispose();
  }
});

test("a late kill reply does not reset a newer preview client input", async () => {
  // #given
  const firstKill = deferred<Record<string, never>>();
  const firstKillReached = deferred<void>();
  const calls: Array<Record<string, string | undefined>> = [];
  let starts = 0;
  const plugin = {
    lsp: {
      status: "running",
      mainFile: "/vault/main.typ",
      onNotification: () => {},
      setPreviewSource: (input?: string) => calls.push({ method: "setPreviewSource", input }),
      pinMain: (main: string | null) => calls.push({ method: "pinMain", main: main ?? undefined }),
      executeCommand: async (command: string, args: unknown[]) => {
        const taskId = command === "tinymist.doStartPreview" ? (args[0] as string[])[1] : args[0];
        const recordedTaskId = typeof taskId === "string" ? taskId : undefined;
        calls.push({ command, taskId: recordedTaskId });
        if (command === "tinymist.doStartPreview") {
          starts++;
          return { staticServerPort: 4320 + starts };
        }
        if (recordedTaskId === "4fzzzxj") {
          firstKillReached.resolve();
          return await firstKill.promise;
        }
        return {};
      },
    },
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/vault",
    sources: {
      hold: async (path: string) => source(path, () => {}),
      byDocument: () => null,
      mayBeSource: (path: string) => path.endsWith(".typ"),
    },
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const originalRandom = Math.random;
  const taskRandoms = [0.123456789, 0.234567891];
  Math.random = () => taskRandoms.shift() ?? originalRandom();

  try {
    await manager.start("/vault/a.typ");
    calls.length = 0;
    const second = manager.start("/vault/b.typ");
    await waitFor(firstKillReached.promise, "the first preview kill");

    // #when
    const thirdResult = await manager.start("/vault/c.typ");
    firstKill.resolve({});
    const secondResult = await second;

    // #then
    assert.deepEqual(
      { secondResult, thirdResult, calls },
      {
        secondResult: null,
        thirdResult: "http://127.0.0.1:4322",
        calls: [
          { command: "tinymist.doKillPreview", taskId: "4fzzzxj" },
          { method: "setPreviewSource", input: "/input/c.typ" },
          { command: "tinymist.doStartPreview", taskId: "8fzzzdp" },
        ],
      },
    );
  } finally {
    Math.random = originalRandom;
    await manager.stop();
    manager.dispose();
  }
});

test("openPreview creates no leaf when PreviewManager cancels the request", async () => {
  // #given
  let leavesCreated = 0;
  const plugin = {
    app: {
      workspace: {
        getLeavesOfType: () => [],
        getLeaf: () => {
          leavesCreated++;
          return { setViewState: async () => {}, view: null };
        },
        revealLeaf: async () => {},
      },
    },
    preview: {
      start: async () => null,
    },
  } as unknown as TinymistPlugin;
  const view = { absolutePath: () => "/vault/chapter.typ" };

  // #when
  await TinymistPlugin.prototype.openPreview.call(plugin, view as never);

  // #then
  assert.deepEqual({ leavesCreated }, { leavesCreated: 0 });
});
