import assert from "node:assert/strict";
import { test } from "node:test";
import type { KitView } from "../src/markdown/convert";
import type TinymistPlugin from "../src/main";
import { PreviewManager } from "../src/preview/previewManager";
import { SourceRegistry, type Position, type SourceAdapter, type TypstSource } from "../src/sources";
import { virtualAddress } from "./support/virtualAddress";

const BUILT_INS =
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = std.block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";
const SOURCE_TEXT = "---\ntypst: true\n---\n**жирный** текст";
const SOURCE_TYP = `${BUILT_INS}#show: template.with(\n\n)\n*жирный* текст`;
const ARLIDUS_ENTRY = virtualAddress("/v", "Notes/Арлидус.md");
const A_ENTRY = virtualAddress("/v", "Notes/A.md");
const ARCHIVE_B_ENTRY = virtualAddress("/v", "Archive/B.md");

interface MarkdownSourceHost {
  root(): string | null;
  frontmatter(vaultPath: string): Record<string, unknown> | null;
  editorText(vaultPath: string): string | null;
  readFile(vaultPath: string): Promise<string>;
  exists(vaultPath: string): boolean;
  kit(): KitStateView;
  reveal(vaultPath: string, position: Position): Promise<void>;
  onKitChange(listener: () => void): () => void;
  onEditorChange(listener: (vaultPath: string, text: string) => void): () => void;
  onRename(listener: (oldPath: string, newPath: string) => void): () => void;
  onDelete(listener: (vaultPath: string) => void): () => void;
  writeShadow(vaultPath: string): Promise<void>;
  removeShadow(vaultPath: string): Promise<void>;
}

type KitStateView =
  | { ready: true; kit: KitView | null }
  | { ready: false; reason: string };

interface HostFixture {
  host: MarkdownSourceHost;
  readFiles: string[];
  reveals: Array<{ file: string; position: Position }>;
  shadowWrites: string[];
  shadowRemoves: string[];
  shadowOperations: string[];
  shadowPaths: Set<string>;
  setFileText(text: string): void;
  emitEditorChange(path: string, text: string): void;
  emitRename(oldPath: string, newPath: string): void;
  emitDelete(path: string): void;
  emitKitChange(next: KitStateView): void;
  restartSubscriptions(): number;
}

interface HostOptions {
  root?: string | null;
  frontmatter?: Record<string, unknown> | null;
  editorText?: string | null;
  fileText?: string;
  existing?: string[];
  kit?: KitStateView;
  writeShadow?: (vaultPath: string) => Promise<void>;
  removeShadow?: (vaultPath: string) => Promise<void>;
}

interface ClientCall {
  method: "didOpen" | "didChange" | "didClose";
  path: string;
  text?: string;
}

class RecordingClient {
  readonly calls: ClientCall[] = [];

  didOpen(path: string, text: string): void {
    this.calls.push({ method: "didOpen", path, text });
  }

  didChange(path: string, text: string): void {
    this.calls.push({ method: "didChange", path, text });
  }

  didClose(path: string): void {
    this.calls.push({ method: "didClose", path });
  }
}

function fakeHost(options: HostOptions = {}): HostFixture {
  const editorListeners = new Set<(path: string, text: string) => void>();
  const renameListeners = new Set<(oldPath: string, newPath: string) => void>();
  const deleteListeners = new Set<(path: string) => void>();
  const kitListeners = new Set<() => void>();
  const restartListeners = new Set<() => void>();
  const readFiles: string[] = [];
  const reveals: Array<{ file: string; position: Position }> = [];
  const shadowWrites: string[] = [];
  const shadowRemoves: string[] = [];
  const shadowOperations: string[] = [];
  const shadowPaths = new Set<string>();
  const existing = new Set(options.existing ?? []);
  let kit = options.kit ?? { ready: true, kit: null } as KitStateView;
  let fileText = options.fileText ?? SOURCE_TEXT;
  const subscribe = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const host: MarkdownSourceHost = {
    root: () => options.root === undefined ? "/v" : options.root,
    frontmatter: () => options.frontmatter === undefined ? { typst: true } : options.frontmatter,
    editorText: () => options.editorText === undefined ? SOURCE_TEXT : options.editorText,
    readFile: async (path) => {
      readFiles.push(path);
      return fileText;
    },
    exists: (path) => existing.has(path),
    kit: () => kit,
    reveal: async (file, position) => {
      reveals.push({ file, position });
    },
    onEditorChange: (listener) => subscribe(editorListeners, listener),
    onRename: (listener) => subscribe(renameListeners, listener),
    onDelete: (listener) => subscribe(deleteListeners, listener),
    onKitChange: (listener) => subscribe(kitListeners, listener),
    writeShadow: async (path) => {
      shadowWrites.push(path);
      shadowOperations.push(`write started ${path}`);
      await options.writeShadow?.(path);
      shadowPaths.add(path);
      existing.add(`.typst-cache/notes/${path}.typ`);
      shadowOperations.push(`write settled ${path}`);
    },
    removeShadow: async (path) => {
      shadowRemoves.push(path);
      shadowOperations.push(`remove started ${path}`);
      await options.removeShadow?.(path);
      shadowPaths.delete(path);
      existing.delete(`.typst-cache/notes/${path}.typ`);
      shadowOperations.push(`remove settled ${path}`);
    },
  };
  Object.defineProperty(host, "onServerRestart", {
    configurable: true,
    value: (listener: () => void) => subscribe(restartListeners, listener),
  });
  return {
    host,
    readFiles,
    reveals,
    shadowWrites,
    shadowRemoves,
    shadowOperations,
    shadowPaths,
    setFileText: (text) => {
      fileText = text;
    },
    emitEditorChange: (path, text) => {
      for (const listener of editorListeners) listener(path, text);
    },
    emitRename: (oldPath, newPath) => {
      for (const listener of renameListeners) listener(oldPath, newPath);
    },
    emitDelete: (path) => {
      for (const listener of deleteListeners) listener(path);
    },
    emitKitChange: (next) => {
      kit = next;
      for (const listener of kitListeners) listener();
    },
    restartSubscriptions: () => restartListeners.size,
  };
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

async function markdownAdapter(host: MarkdownSourceHost): Promise<SourceAdapter> {
  const module = await import("../src/sources");
  const mdAdapter = (module as unknown as {
    mdAdapter?: (candidate: MarkdownSourceHost) => SourceAdapter;
  }).mdAdapter;
  assert.equal(typeof mdAdapter, "function", "mdAdapter is exported from the sources boundary");
  return mdAdapter(host);
}

async function createSource(
  fixture: HostFixture,
  file = "Notes/Арлидус.md",
  release = (): void => {},
): Promise<TypstSource> {
  const adapter = await markdownAdapter(fixture.host);
  const source = await adapter.create(file, release);
  assert.ok(source, `expected ${file} to be a Markdown source`);
  return source;
}

test("the Markdown adapter offers only flagged Markdown notes", async () => {
  // #given
  const enabled = await markdownAdapter(fakeHost().host);
  const disabled = await markdownAdapter(fakeHost({ frontmatter: { typst: false } }).host);

  // #when
  const observed = {
    lower: enabled.mayBe("Notes/A.md"),
    upper: enabled.mayBe("Notes/A.MD"),
    typst: enabled.mayBe("Notes/A.typ"),
    suffix: enabled.mayBe("Notes/A.md.bak"),
    unflagged: disabled.mayBe("Notes/A.md"),
  };

  // #then
  assert.deepEqual(observed, {
    lower: true,
    upper: true,
    typst: false,
    suffix: false,
    unflagged: false,
  });
});

test("virtualAddress puts a Markdown entry under the vault note cache", async () => {
  // #given
  const { virtualAddress: address } = await import("../src/sources/markdown");

  // #when
  const entry = address("/vault", "Notes/Plan.md");

  // #then
  assert.equal(entry, virtualAddress("/vault", "Notes/Plan.md"));
});

test("source creation prefers normalized editor text and falls back to the vault", async () => {
  // #given
  const editor = fakeHost({ editorText: `\ufeff${SOURCE_TEXT.replaceAll("\n", "\r\n")}` });
  const vault = fakeHost({ editorText: null, fileText: SOURCE_TEXT });

  // #when
  const editorSource = await createSource(editor);
  const vaultSource = await createSource(vault);
  const firstClient = new RecordingClient();
  const secondClient = new RecordingClient();
  const firstHandle = editorSource.open(firstClient as never);
  const secondHandle = vaultSource.open(secondClient as never);

  // #then
  try {
    assert.deepEqual(
      { editorCalls: firstClient.calls, vaultCalls: secondClient.calls, editorReads: editor.readFiles, vaultReads: vault.readFiles },
      {
        editorCalls: [{ method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP }],
        vaultCalls: [{ method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP }],
        editorReads: [],
        vaultReads: ["Notes/Арлидус.md"],
      },
    );
  } finally {
    firstHandle.close();
    secondHandle.close();
  }
});

test("the Markdown source gives the converter its note path for relative images", async () => {
  // #given
  const fixture = fakeHost({ editorText: "---\ntypst: true\n---\n![[fig.png]]" });
  const source = await createSource(fixture, "Notes/Plan.md");
  const client = new RecordingClient();

  // #when
  const handle = source.open(client as never);

  // #then
  try {
    assert.equal(client.calls[0]?.text?.split("\n")[3], '#std.image("/Notes/fig.png");');
  } finally {
    handle.close();
  }
});

test("a ready kit imports a selected template or its default, while no kit leaves built-ins alone", async () => {
  // #given
  const ready = {
    ready: true,
    kit: {
      templates: { reference: "/kit/md/reference.typ", letter: "/kit/md/letter.typ" },
      defaultTemplate: "reference",
    },
  } as const;
  const selected = await createSource(fakeHost({
    kit: ready,
    editorText: "---\ntypst: true\ntypst-template: letter\n---\nBody",
  }), "Notes/Selected.md");
  const fallback = await createSource(fakeHost({
    kit: ready,
    editorText: "---\ntypst: true\n---\nBody",
  }), "Notes/Fallback.md");
  const builtIn = await createSource(fakeHost({
    kit: { ready: true, kit: null },
    editorText: "---\ntypst: true\n---\nBody",
  }), "Notes/Built-in.md");
  const selectedClient = new RecordingClient();
  const fallbackClient = new RecordingClient();
  const builtInClient = new RecordingClient();

  // #when
  const selectedHandle = selected.open(selectedClient as never);
  const fallbackHandle = fallback.open(fallbackClient as never);
  const builtInHandle = builtIn.open(builtInClient as never);

  // #then
  try {
    assert.deepEqual(
      [selectedClient.calls[0]?.text?.split("\n")[0], fallbackClient.calls[0]?.text?.split("\n")[0], builtInClient.calls[0]?.text?.split("\n")[0]],
      [
        `${BUILT_INS}#import "/kit/md/letter.typ": *; #show: template.with(`,
        `${BUILT_INS}#import "/kit/md/reference.typ": *; #show: template.with(`,
        `${BUILT_INS}#show: template.with(`,
      ],
    );
  } finally {
    selectedHandle.close();
    fallbackHandle.close();
    builtInHandle.close();
  }
});

test("an open Markdown source closes while the kit is unavailable and reopens with current text", async () => {
  // #given
  const ready = { ready: true, kit: { templates: {}, defaultTemplate: "" } } as const;
  const fixture = fakeHost({ kit: ready });
  const source = await createSource(fixture, "Notes/Kit-state.md");
  const client = new RecordingClient();
  const problems: unknown[] = [];
  source.on("problems", () => problems.push(source.problems));
  const handle = source.open(client as never);

  // #when
  fixture.emitKitChange({ ready: false, reason: "Typst kit failed: Manifest file not found: kit/md/manifest.typ" });
  fixture.emitKitChange(ready);

  // #then
  try {
    assert.deepEqual(
      { calls: client.calls, problems },
      {
        calls: [
          { method: "didOpen", path: virtualAddress("/v", "Notes/Kit-state.md"), text: SOURCE_TYP },
          { method: "didClose", path: virtualAddress("/v", "Notes/Kit-state.md") },
          { method: "didOpen", path: virtualAddress("/v", "Notes/Kit-state.md"), text: SOURCE_TYP },
        ],
        problems: [
          [{ line: 0, message: "Typst kit failed: Manifest file not found: kit/md/manifest.typ", fatal: true }],
          [],
        ],
      },
    );
  } finally {
    handle.close();
  }
});

test("a source waits for a non-ready kit and opens after the kit becomes ready", async () => {
  // #given
  const fixture = fakeHost({ kit: { ready: false, reason: "Typst kit is loading" } });
  const source = await createSource(fixture, "Notes/Waiting.md");
  const client = new RecordingClient();
  const problems: unknown[] = [];
  source.on("problems", () => problems.push(source.problems));

  // #when
  const handle = source.open(client as never);
  const initial = source.problems;
  fixture.emitKitChange({ ready: true, kit: null });

  // #then
  try {
    assert.deepEqual(
      { initial, final: source.problems, calls: client.calls, problems },
      {
        initial: [{ line: 0, message: "Typst kit is loading", fatal: true }],
        final: [],
        calls: [{ method: "didOpen", path: virtualAddress("/v", "Notes/Waiting.md"), text: SOURCE_TYP }],
        problems: [[]],
      },
    );
  } finally {
    handle.close();
  }
});

test("source creation rejects ordinary notes and notes shadowed by a cached Typst file", async () => {
  // #given
  const ordinary = fakeHost({ editorText: "ordinary note" });
  const shadowed = fakeHost({ existing: [".typst-cache/notes/Notes/A.md.typ"] });

  // #when
  const ordinarySource = await (await markdownAdapter(ordinary.host)).create("Notes/A.md", () => {});
  const shadowedSource = await (await markdownAdapter(shadowed.host)).create("Notes/A.md", () => {});

  // #then
  assert.deepEqual({ ordinarySource, shadowedSource }, { ordinarySource: null, shadowedSource: null });
});

test("first open writes one shadow; repeated handles and clients do not rewrite it; last close removes it", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture, "Notes/Plan.md");
  const firstClient = new RecordingClient();
  const secondClient = new RecordingClient();

  // #when
  const first = source.open(firstClient as never);
  const duplicate = source.open(firstClient as never);
  const second = source.open(secondClient as never);
  await settle();
  duplicate.close();
  first.close();
  await settle();
  const beforeLastClose = [...fixture.shadowRemoves];
  second.close();
  await settle();

  // #then
  assert.deepEqual(
    {
      writes: fixture.shadowWrites,
      beforeLastClose,
      removes: fixture.shadowRemoves,
    },
    {
      writes: ["Notes/Plan.md"],
      beforeLastClose: [],
      removes: ["Notes/Plan.md"],
    },
  );
});

test("last close waits for a pending shadow write before removing it", async () => {
  // #given
  const write = deferred();
  const fixture = fakeHost({ writeShadow: async () => await write.promise });
  const source = await createSource(fixture, "Notes/Plan.md");
  const client = new RecordingClient();

  // #when
  const handle = source.open(client as never);
  handle.close();
  await settle();
  const beforeWriteFinished = [...fixture.shadowRemoves];
  write.resolve();
  await settle();

  // #then
  assert.deepEqual(
    { beforeWriteFinished, writes: fixture.shadowWrites, removes: fixture.shadowRemoves },
    { beforeWriteFinished: [], writes: ["Notes/Plan.md"], removes: ["Notes/Plan.md"] },
  );
});

test("regression: a recreated note serializes its shadow write after the prior instance removes it", async () => {
  // #given
  const firstWrite = deferred();
  let writes = 0;
  const fixture = fakeHost({
    writeShadow: async () => {
      writes++;
      if (writes === 1) await firstWrite.promise;
    },
  });
  const adapter = await markdownAdapter(fixture.host);
  const firstSource = await adapter.create("Notes/Plan.md", () => {});
  if (!firstSource) throw new Error("expected the first Markdown source");
  const firstHandle = firstSource.open(new RecordingClient() as never);
  await settle();
  firstHandle.close();
  const secondSource = await adapter.create("Notes/Plan.md", () => {});
  if (!secondSource) throw new Error("expected the recreated Markdown source");
  const secondHandle = secondSource.open(new RecordingClient() as never);

  // #when
  firstWrite.resolve();
  await settle();

  // #then
  try {
    assert.deepEqual(
      { operations: fixture.shadowOperations, shadows: [...fixture.shadowPaths] },
      {
        operations: [
          "write started Notes/Plan.md",
          "write settled Notes/Plan.md",
          "remove started Notes/Plan.md",
          "remove settled Notes/Plan.md",
          "write started Notes/Plan.md",
          "write settled Notes/Plan.md",
        ],
        shadows: ["Notes/Plan.md"],
      },
      "per-instance shadow queues must not let a recreated note write before the previous instance removes it",
    );
  } finally {
    firstHandle.close();
    secondHandle.close();
    firstSource.dispose?.();
    secondSource.dispose?.();
  }
});

test("regression: one global shadow queue must not block a different note", async () => {
  // #given
  const slowWrite = deferred();
  const fixture = fakeHost({
    writeShadow: async (path) => {
      if (path === "Notes/Slow.md") await slowWrite.promise;
    },
  });
  const adapter = await markdownAdapter(fixture.host);
  const slowSource = await adapter.create("Notes/Slow.md", () => {});
  const fastSource = await adapter.create("Notes/Fast.md", () => {});
  if (!slowSource || !fastSource) throw new Error("expected both Markdown sources");
  const slowHandle = slowSource.open(new RecordingClient() as never);
  const fastHandle = fastSource.open(new RecordingClient() as never);

  // #when
  await settle();

  // #then
  try {
    assert.deepEqual(
      { operations: fixture.shadowOperations, shadows: [...fixture.shadowPaths] },
      {
        operations: [
          "write started Notes/Slow.md",
          "write started Notes/Fast.md",
          "write settled Notes/Fast.md",
        ],
        shadows: ["Notes/Fast.md"],
      },
      "one global shadow queue must not delay an unrelated note after a pending write",
    );
  } finally {
    slowWrite.resolve();
    slowHandle.close();
    fastHandle.close();
    await settle();
    slowSource.dispose?.();
    fastSource.dispose?.();
  }
});

test("disposing an open Markdown source removes its shadow", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture, "Notes/Plan.md");
  source.open(new RecordingClient() as never);
  await settle();

  // #when
  source.dispose?.();
  await settle();

  // #then
  assert.deepEqual(
    { writes: fixture.shadowWrites, removes: fixture.shadowRemoves },
    { writes: ["Notes/Plan.md"], removes: ["Notes/Plan.md"] },
  );
});

test("moving an open Markdown source removes the old shadow and writes the new one", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture, "Notes/Plan.md");
  const handle = source.open(new RecordingClient() as never);
  await settle();

  // #when
  fixture.emitRename("Notes/Plan.md", "Archive/Plan.md");
  await settle();

  // #then
  try {
    assert.deepEqual(
      { writes: fixture.shadowWrites, removes: fixture.shadowRemoves },
      {
        writes: ["Notes/Plan.md", "Archive/Plan.md"],
        removes: ["Notes/Plan.md"],
      },
    );
  } finally {
    handle.close();
  }
});

test("a never-opened Markdown source writes and removes no shadow", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture, "Notes/Plan.md");

  // #when
  source.dispose?.();
  await settle();

  // #then
  assert.deepEqual(
    { writes: fixture.shadowWrites, removes: fixture.shadowRemoves },
    { writes: [], removes: [] },
  );
});

test("a rejected shadow write does not throw from open", async () => {
  // #given
  const fixture = fakeHost({
    writeShadow: async () => {
      throw new Error("shadow write failed");
    },
  });
  const source = await createSource(fixture, "Notes/Plan.md");
  const client = new RecordingClient();
  let thrown: unknown;
  let handle: { close(): void } | null = null;

  // #when
  try {
    handle = source.open(client as never);
  } catch (error) {
    thrown = error;
  }
  await settle();

  // #then
  try {
    assert.deepEqual(
      { thrown, writes: fixture.shadowWrites },
      { thrown: undefined, writes: ["Notes/Plan.md"] },
    );
  } finally {
    handle?.close();
  }
});

test("a Markdown source exposes literal virtual addresses and PDF destination", async () => {
  // #given
  const fixture = fakeHost();

  // #when
  const source = await createSource(fixture);

  // #then
  assert.deepEqual(
    {
      file: source.file,
      entry: source.entry,
      document: source.document,
      inputs: source.inputs,
      pinnable: source.pinnable,
      exportable: (source as TypstSource & { exportable?: boolean }).exportable,
      pdf: source.pdf,
    },
    {
      file: "Notes/Арлидус.md",
      entry: ARLIDUS_ENTRY,
      document: ARLIDUS_ENTRY,
      inputs: undefined,
      pinnable: false,
      exportable: true,
      pdf: "Notes/Арлидус.pdf",
    },
  );
});

test("open clients receive independent document updates and closing one stops its updates", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture);
  const first = new RecordingClient();
  const second = new RecordingClient();
  const firstHandle = source.open(first as never);
  const secondHandle = source.open(second as never);
  const events: string[] = [];
  source.on("problems", () => events.push("problems"));

  // #when
  fixture.emitEditorChange("Other.md", "ignored");
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = 1");
  firstHandle.close();
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = 2");
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = \"bad\u2028break\"");

  // #then
  try {
    assert.deepEqual(
      { first: first.calls, second: second.calls, events },
      {
        first: [
          { method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP },
          { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 1` },
          { method: "didClose", path: ARLIDUS_ENTRY },
        ],
        second: [
          { method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP },
          { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 1` },
          { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 2` },
        ],
        events: ["problems", "problems", "problems"],
      },
    );
  } finally {
    secondHandle.close();
  }
});

test("refreshing a closed Markdown source updates open clients only when the vault text changed", async () => {
  // #given
  const fixture = fakeHost({ editorText: null, fileText: SOURCE_TEXT });
  const source = await createSource(fixture);
  const client = new RecordingClient();
  const handle = source.open(client as never);
  const events: string[] = [];
  source.on("problems", () => events.push("problems"));
  const refreshed = source as TypstSource & { refresh?: () => Promise<void> };
  assert.equal(typeof refreshed.refresh, "function", "expected Markdown sources to refresh closed vault text");
  if (!refreshed.refresh) throw new Error("Markdown refresh is unavailable");
  fixture.setFileText("---\ntypst: true\n---\n# Refreshed heading\n");

  // #when
  await refreshed.refresh();
  await refreshed.refresh();

  // #then
  try {
    assert.deepEqual(
      { calls: client.calls, events, reads: fixture.readFiles },
      {
        calls: [
          { method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP },
          {
            method: "didChange",
            path: ARLIDUS_ENTRY,
            text: `${BUILT_INS}#show: template.with(\n\n)\n= Refreshed heading\n`,
          },
        ],
        events: ["problems"],
        reads: ["Notes/Арлидус.md", "Notes/Арлидус.md", "Notes/Арлидус.md"],
      },
    );
  } finally {
    handle.close();
  }
});

test("refresh rejects when saved Markdown text no longer enables Typst", async () => {
  // #given
  const fixture = fakeHost({ editorText: null, fileText: SOURCE_TEXT });
  const source = await createSource(fixture);
  const refreshed = source as TypstSource & { refresh?: () => Promise<void> };
  assert.equal(typeof refreshed.refresh, "function", "expected Markdown sources to refresh closed vault text");
  if (!refreshed.refresh) throw new Error("Markdown refresh is unavailable");
  fixture.setFileText("---\n---\n= No longer a source\n");

  // #when
  const refresh = refreshed.refresh();

  // #then
  await assert.rejects(refresh, { message: "the note is no longer a Typst source" });
});

test("refresh rejects unchanged text after an editor change removed the Typst source", async () => {
  // #given
  const fixture = fakeHost({ editorText: null, fileText: SOURCE_TEXT });
  const source = await createSource(fixture);
  const refreshed = source as TypstSource & { refresh?: () => Promise<void> };
  assert.equal(typeof refreshed.refresh, "function", "expected Markdown sources to refresh closed vault text");
  if (!refreshed.refresh) throw new Error("Markdown refresh is unavailable");
  const noLongerSource = "---\n---\n= No longer a source\n";
  fixture.emitEditorChange("Notes/Арлидус.md", noLongerSource);
  fixture.setFileText(noLongerSource);

  // #when
  const refresh = refreshed.refresh();

  // #then
  await assert.rejects(refresh, { message: "the note is no longer a Typst source" });
});

test("repeated opens on one client share one document until the final handle closes", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture);
  const client = new RecordingClient();
  const first = source.open(client as never);
  const second = source.open(client as never);

  // #when
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = 1");
  first.close();
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = 2");
  second.close();

  // #then
  assert.deepEqual(client.calls, [
    { method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP },
    { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 1` },
    { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 2` },
    { method: "didClose", path: ARLIDUS_ENTRY },
  ]);
});

test("a shared Markdown source stays live until the registry's final holder releases it", async () => {
  // #given
  const fixture = fakeHost();
  let creates = 0;
  const adapter = await markdownAdapter(fixture.host);
  const counted: SourceAdapter = {
    mayBe: (path) => adapter.mayBe(path),
    create: async (path, release) => {
      creates++;
      return await adapter.create(path, release);
    },
  };
  const registry = new SourceRegistry([counted]);
  const first = await registry.hold("Notes/Арлидус.md");
  const second = await registry.hold("Notes/Арлидус.md");
  assert.ok(first && second, "expected both holders to share a Markdown source");
  const client = new RecordingClient();
  const handle = second.open(client as never);

  // #when
  first.release();
  fixture.emitEditorChange("Notes/Арлидус.md", "---\ntypst: true\n---\n/typst#let x = 1");
  const heldAfterOne = registry.byDocument(ARLIDUS_ENTRY) === second;
  second.release();
  const heldAfterLast = registry.byDocument(ARLIDUS_ENTRY);
  const third = await registry.hold("Notes/Арлидус.md");
  assert.ok(third, "expected a fresh source after the final release");

  // #then
  try {
    assert.deepEqual(
      { calls: client.calls, heldAfterOne, heldAfterLast, recreated: third !== first, creates },
      {
        calls: [
          { method: "didOpen", path: ARLIDUS_ENTRY, text: SOURCE_TYP },
          { method: "didChange", path: ARLIDUS_ENTRY, text: `${BUILT_INS}#show: template.with(\n\n)\n#let x = 1` },
          { method: "didClose", path: ARLIDUS_ENTRY },
        ],
        heldAfterOne: true,
        heldAfterLast: null,
        recreated: true,
        creates: 2,
      },
    );
  } finally {
    handle.close();
    third.release();
  }
});

test("position maps preserve the translated non-ASCII column in both directions", async () => {
  // #given
  const source = await createSource(fakeHost());

  // #when
  const markdown = source.toSource({ line: 3, character: 8 });
  const typst = source.toEntry({ line: 3, character: 10 });

  // #then
  assert.deepEqual({ markdown, typst }, {
    markdown: { line: 3, character: 10 },
    typst: { line: 3, character: 8 },
  });
});

test("reveal delegates the Markdown path and describe removes every virtual address", async () => {
  // #given
  const fixture = fakeHost();
  const source = await createSource(fixture, "Notes/A.md");

  // #when
  await source.reveal({ line: 2, character: 7 });
  const description = source.describe(
    new Error(`${A_ENTRY}:3:5: ${A_ENTRY} has an unknown variable`),
  );
  const stringDescription = source.describe("plain failure");

  // #then
  assert.deepEqual(
    { reveals: fixture.reveals, description, stringDescription },
    {
      reveals: [{ file: "Notes/A.md", position: { line: 2, character: 7 } }],
      description: "Notes/A.md:3:5: Notes/A.md has an unknown variable",
      stringDescription: "plain failure",
    },
  );
});

test("rename and delete move every open client without an adapter-owned restart hook", async () => {
  // #given
  const fixture = fakeHost();
  let releases = 0;
  const source = await createSource(fixture, "Notes/A.md", () => {
    releases++;
  });
  const first = new RecordingClient();
  const second = new RecordingClient();
  const firstHandle = source.open(first as never);
  const secondHandle = source.open(second as never);
  const events: string[] = [];
  source.on("moved", () => events.push("moved"));
  source.on("ended", () => events.push("ended"));
  const restartSubscriptions = fixture.restartSubscriptions();

  // #when
  fixture.emitRename("Notes/A.md", "Archive/B.md");
  fixture.emitDelete("Archive/B.md");
  source.release();

  // #then
  try {
    const lifecycleCalls: ClientCall[] = [
      { method: "didOpen", path: A_ENTRY, text: SOURCE_TYP },
      { method: "didClose", path: A_ENTRY },
      { method: "didOpen", path: ARCHIVE_B_ENTRY, text: SOURCE_TYP },
      { method: "didClose", path: ARCHIVE_B_ENTRY },
    ];
    assert.deepEqual(
      {
        first: first.calls,
        second: second.calls,
        events,
        addresses: { file: source.file, entry: source.entry, document: source.document, pdf: source.pdf },
        releases,
        restartSubscriptions,
      },
      {
        first: lifecycleCalls,
        second: lifecycleCalls,
        events: ["moved", "ended"],
        addresses: {
          file: "Archive/B.md",
          entry: ARCHIVE_B_ENTRY,
          document: ARCHIVE_B_ENTRY,
          pdf: "Archive/B.pdf",
        },
        releases: 1,
        restartSubscriptions: 0,
      },
    );
  } finally {
    firstHandle.close();
    secondHandle.close();
  }
});

test("renaming a Markdown source recomputes relative images for its new folder", async () => {
  // #given
  const fixture = fakeHost({
    editorText: "---\ntypst: true\n---\n![](fig.png)",
  });
  const source = await createSource(fixture, "Notes/A.md");
  const client = new RecordingClient();
  const handle = source.open(client as never);

  // #when
  fixture.emitRename("Notes/A.md", "Archive/A.md");
  const reopened = client.calls[2];

  // #then
  try {
    assert.deepEqual(
      {
        method: reopened?.method,
        path: reopened?.path,
        image: reopened?.text?.split("\n")[3],
      },
      {
        method: "didOpen",
        path: virtualAddress("/v", "Archive/A.md"),
        image: '#std.image("/Archive/fig.png");',
      },
    );
  } finally {
    handle.close();
  }
});

test("renaming a Markdown source onto an occupied cached address ends its open document", async () => {
  // #given
  const fixture = fakeHost({ existing: [".typst-cache/notes/Notes/B.md.typ"] });
  const source = await createSource(fixture, "Notes/A.md");
  const client = new RecordingClient();
  const handle = source.open(client as never);
  client.calls.splice(0);
  const events: string[] = [];
  source.on("moved", () => events.push("moved"));
  source.on("ended", () => events.push("ended"));

  // #when
  fixture.emitRename("Notes/A.md", "Notes/B.md");

  // #then
  try {
    assert.deepEqual(
      { calls: client.calls, events, entry: source.entry },
      {
        calls: [{ method: "didClose", path: A_ENTRY }],
        events: ["ended"],
        entry: A_ENTRY,
      },
    );
  } finally {
    handle.close();
  }
});

test("a full Markdown preview start and edit keep its path out of Tinymist document addresses", async () => {
  // #given
  const fixture = fakeHost({ editorText: SOURCE_TEXT });
  const adapter = await markdownAdapter(fixture.host);
  const requests: Array<{
    method: string;
    path?: string | null;
    input?: string;
    args?: unknown[];
  }> = [];
  const lsp = {
    status: "running",
    mainFile: null,
    onNotification: () => {},
    setPreviewSource: (input?: string) => requests.push({ method: "setPreviewSource", input }),
    pinMain: (path: string | null) => requests.push({ method: "pinMain", path }),
    executeCommand: async (command: string, args: unknown[]) => {
      requests.push({ method: command, args });
      return command === "tinymist.doStartPreview" ? { staticServerPort: 4321 } : {};
    },
    didOpen: (path: string, text: string) => requests.push({ method: "didOpen", path, text }),
    didChange: (path: string, text: string) => requests.push({ method: "didChange", path, text }),
    didClose: (path: string) => requests.push({ method: "didClose", path }),
  };
  const plugin = {
    lsp,
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => "/v",
    sources: new SourceRegistry([adapter]),
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);

  // #when
  await manager.start("/v/Notes/A.md");
  fixture.emitEditorChange("Notes/A.md", "---\ntypst: true\n---\n/typst#let x = 2");
  await manager.stop();
  const addressFields: string[] = [];
  const previewTitlesAndEntries: unknown[][] = [];
  for (const request of requests) {
    if (request.method === "didOpen" || request.method === "didChange" || request.method === "didClose") {
      if (request.path) addressFields.push(request.path);
      continue;
    }
    if (request.method === "pinMain") {
      if (request.path) addressFields.push(request.path);
      continue;
    }
    if (request.method === "setPreviewSource") {
      if (request.input) addressFields.push(request.input);
      continue;
    }
    if (request.method !== "tinymist.doStartPreview") continue;
    const previewArgs = request.args?.[0];
    if (!Array.isArray(previewArgs)) continue;
    const pageTitleIndex = previewArgs.indexOf("--page-title");
    previewArgs.forEach((argument, index) => {
      if (index !== pageTitleIndex + 1 && typeof argument === "string") addressFields.push(argument);
    });
    previewTitlesAndEntries.push(previewArgs.slice(pageTitleIndex + 1, pageTitleIndex + 3));
  }

  // #then
  try {
    assert.deepEqual(
      {
        markdownAddresses: addressFields.filter((value) => value.endsWith(".md")),
        previewTitlesAndEntries,
      },
      {
        markdownAddresses: [],
        previewTitlesAndEntries: [["A.md", virtualAddress("/v", "Notes/A.md")]],
      },
    );
  } finally {
    manager.dispose();
  }
});
