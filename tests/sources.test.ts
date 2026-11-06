import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface Position {
  line: number;
  character: number;
}

interface TypstSource {
  file: string;
  entry: string;
  document: string;
  inputs: string | undefined;
  pinnable: boolean;
  pdf: string;
  open(client: unknown): { close(): void };
  toSource(position: Position): Position;
  toEntry(position: Position): Position;
  reveal(position: Position): Promise<void>;
  describe(error: unknown): string;
  on(event: "moved" | "ended" | "problems", listener: () => void): () => void;
  release(): void;
}

interface SourceAdapter {
  mayBe(vaultPath: string): boolean;
  create(vaultPath: string, release: () => void): Promise<TypstSource | null>;
}

interface SourceRegistry {
  hold(vaultPath: string): Promise<TypstSource | null>;
  release?(source: TypstSource): void;
  byDocument(address: string): TypstSource | null;
  mayBeSource(vaultPath: string): boolean;
}

interface SourcesModule {
  SourceRegistry: new (adapters: SourceAdapter[]) => SourceRegistry;
  pdfDestination(vaultPath: string): string;
  typAdapter(options: {
    root(): string | null;
    reveal(document: string, position: Position): Promise<void>;
  }): SourceAdapter;
}

function sources(): SourcesModule {
  try {
    return require("../src/sources") as SourcesModule;
  } catch {
    throw new Error("src/sources is not implemented");
  }
}

function source(path: string, release: () => void): TypstSource {
  return {
    file: path,
    entry: `/vault/${path}`,
    document: `/vault/${path}`,
    inputs: undefined,
    pinnable: true,
    pdf: `${path}.pdf`,
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release,
  };
}

test("pdfDestination replaces only the final extension of the final path segment", () => {
  // #given
  const { pdfDestination } = sources();
  const vaultPaths = ["a/b.typ", "a/Note.md", "a/b.md.typ", "a.dir/noext", "A.TYP"];

  // #when
  const destinations = vaultPaths.map((vaultPath) => pdfDestination(vaultPath));

  // #then
  assert.deepEqual(destinations, ["a/b.pdf", "a/Note.pdf", "a/b.md.pdf", "a.dir/noext.pdf", "A.pdf"]);
});

test("SourceRegistry shares a pending source until every holder releases it", async () => {
  // #given
  const { SourceRegistry } = sources();
  let finishCreate!: () => void;
  const creation = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  let creates = 0;
  const adapter: SourceAdapter = {
    mayBe: () => true,
    create: async (path, release) => {
      creates++;
      await creation;
      return source(path, release);
    },
  };
  const registry = new SourceRegistry([adapter]);
  const firstPending = registry.hold("notes/chapter.typ");
  const secondPending = registry.hold("notes/chapter.typ");
  finishCreate();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  if (!first || !second) throw new Error("expected the adapter to create a source");

  // #when
  const foundBeforeRelease = registry.byDocument("/vault/notes/chapter.typ") === first;
  first.release();
  const foundAfterOneRelease = registry.byDocument("/vault/notes/chapter.typ") === first;
  second.release();
  const foundAfterLastRelease = registry.byDocument("/vault/notes/chapter.typ");
  const later = await registry.hold("notes/chapter.typ");
  if (!later) throw new Error("expected the adapter to create a later source");
  later.release();

  // #then
  assert.deepEqual(
    {
      sameObject: first === second,
      foundBeforeRelease,
      foundAfterOneRelease,
      foundAfterLastRelease,
      recreated: later !== first,
      creates,
    },
    {
      sameObject: true,
      foundBeforeRelease: true,
      foundAfterOneRelease: true,
      foundAfterLastRelease: null,
      recreated: true,
      creates: 2,
    },
  );
});

test("SourceRegistry queries adapters in order and mayBeSource does not create a source", async () => {
  // #given
  const { SourceRegistry } = sources();
  const calls: string[] = [];
  const adapters: SourceAdapter[] = [
    {
      mayBe: (path) => path.endsWith(".typ"),
      create: async (path) => {
        calls.push(`first:${path}`);
        return null;
      },
    },
    {
      mayBe: () => true,
      create: async (path, release) => {
        calls.push(`second:${path}`);
        return source(path, release);
      },
    },
  ];
  const registry = new SourceRegistry(adapters);

  // #when
  const mayBeTypst = registry.mayBeSource("notes/chapter.typ");
  const mayBeText = registry.mayBeSource("notes/chapter.txt");
  const held = await registry.hold("notes/chapter.typ");
  if (!held) throw new Error("expected the second adapter to create a source");
  held.release();

  // #then
  assert.deepEqual(
    { mayBeTypst, mayBeText, calls, file: held.file },
    {
      mayBeTypst: true,
      mayBeText: true,
      calls: ["first:notes/chapter.typ", "second:notes/chapter.typ"],
      file: "notes/chapter.typ",
    },
  );
});

test("the typ adapter follows a wrapper created after the source is held", async () => {
  // #given
  const { typAdapter } = sources();
  const root = mkdtempSync(join(tmpdir(), "typst-source-"));
  const position: Position = { line: 4, character: 7 };
  const reveals: Array<{ document: string; position: Position }> = [];
  let releases = 0;
  const adapter = typAdapter({
    root: () => root,
    reveal: async (document, revealedPosition) => {
      reveals.push({ document, position: revealedPosition });
    },
  });
  const held = await adapter.create("notes/chapter.typ", () => {
    releases++;
  });
  if (!held) throw new Error("expected a source with a vault root");
  const direct = { entry: held.entry, inputs: held.inputs };
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", ".tinymist-preview.typ"), "#include sys.inputs.at(\"preview-source\")\n");
  let listenerCalls = 0;

  // #when
  const close = held.open(new Proxy({}, { get: () => { throw new Error("typ source must not open an LSP document"); } }) as never).close;
  close();
  const unsubscribe = held.on("moved", () => {
    listenerCalls++;
  });
  unsubscribe();
  await held.reveal(position);
  held.release();
  const unavailable = await typAdapter({ root: () => null, reveal: async () => {} }).create(
    "notes/chapter.typ",
    () => {},
  );

  // #then
  try {
    assert.deepEqual(
      {
        mayBe: [adapter.mayBe("notes/chapter.typ"), adapter.mayBe("notes/chapter.md")],
        direct,
        wrapped: { entry: held.entry, inputs: held.inputs },
        file: held.file,
        document: held.document,
        pdf: held.pdf,
        pinnable: held.pinnable,
        toSource: held.toSource(position),
        toEntry: held.toEntry(position),
        description: held.describe(new Error("broken")),
        reveals,
        listenerCalls,
        releases,
        unavailable,
      },
      {
        mayBe: [true, false],
        direct: { entry: join(root, "notes", "chapter.typ"), inputs: undefined },
        wrapped: {
          entry: join(root, "notes", ".tinymist-preview.typ"),
          inputs: "/notes/chapter.typ",
        },
        file: "notes/chapter.typ",
        document: join(root, "notes", "chapter.typ"),
        pdf: "notes/chapter.pdf",
        pinnable: true,
        toSource: position,
        toEntry: position,
        description: "Error: broken",
        reveals: [{ document: join(root, "notes", "chapter.typ"), position }],
        listenerCalls: 0,
        releases: 1,
        unavailable: null,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
