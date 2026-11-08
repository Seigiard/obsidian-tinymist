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
  kit(): KitView | null;
  reveal(vaultPath: string, position: Position): Promise<void>;
  onEditorChange(listener: (vaultPath: string, text: string) => void): () => void;
  onRename(listener: (oldPath: string, newPath: string) => void): () => void;
  onDelete(listener: (vaultPath: string) => void): () => void;
}

interface HostFixture {
  host: MarkdownSourceHost;
  readFiles: string[];
  reveals: Array<{ file: string; position: Position }>;
  emitEditorChange(path: string, text: string): void;
  emitRename(oldPath: string, newPath: string): void;
  emitDelete(path: string): void;
  restartSubscriptions(): number;
}

interface HostOptions {
  root?: string | null;
  frontmatter?: Record<string, unknown> | null;
  editorText?: string | null;
  fileText?: string;
  existing?: string[];
  kit?: KitView | null;
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
  const restartListeners = new Set<() => void>();
  const readFiles: string[] = [];
  const reveals: Array<{ file: string; position: Position }> = [];
  const existing = new Set(options.existing ?? []);
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
      return options.fileText ?? SOURCE_TEXT;
    },
    exists: (path) => existing.has(path),
    kit: () => options.kit ?? null,
    reveal: async (file, position) => {
      reveals.push({ file, position });
    },
    onEditorChange: (listener) => subscribe(editorListeners, listener),
    onRename: (listener) => subscribe(renameListeners, listener),
    onDelete: (listener) => subscribe(deleteListeners, listener),
  };
  Object.defineProperty(host, "onServerRestart", {
    configurable: true,
    value: (listener: () => void) => subscribe(restartListeners, listener),
  });
  return {
    host,
    readFiles,
    reveals,
    emitEditorChange: (path, text) => {
      for (const listener of editorListeners) listener(path, text);
    },
    emitRename: (oldPath, newPath) => {
      for (const listener of renameListeners) listener(oldPath, newPath);
    },
    emitDelete: (path) => {
      for (const listener of deleteListeners) listener(path);
    },
    restartSubscriptions: () => restartListeners.size,
  };
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

test("source creation rejects ordinary notes and notes shadowed by a sibling Typst file", async () => {
  // #given
  const ordinary = fakeHost({ editorText: "ordinary note" });
  const shadowed = fakeHost({ existing: ["Notes/A.md.typ"] });

  // #when
  const ordinarySource = await (await markdownAdapter(ordinary.host)).create("Notes/A.md", () => {});
  const shadowedSource = await (await markdownAdapter(shadowed.host)).create("Notes/A.md", () => {});

  // #then
  assert.deepEqual({ ordinarySource, shadowedSource }, { ordinarySource: null, shadowedSource: null });
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

test("renaming a Markdown source onto an occupied virtual address ends its open document", async () => {
  // #given
  const fixture = fakeHost({ existing: ["Notes/B.md.typ"] });
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

test("a full Markdown preview start and edit send no md address to Tinymist", async () => {
  // #given
  const fixture = fakeHost({ editorText: SOURCE_TEXT });
  const adapter = await markdownAdapter(fixture.host);
  const requests: unknown[] = [];
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
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  requests.forEach(collect);

  // #then
  try {
    assert.deepEqual(strings.filter((value) => value.endsWith(".md")), []);
  } finally {
    manager.dispose();
  }
});
