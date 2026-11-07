import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SourceRegistry,
  pdfDestination,
  typAdapter,
  type Position,
  type SourceAdapter,
  type TypstSource,
} from "../src/sources";

function source(path: string, release: () => void): TypstSource {
  return {
    file: path,
    entry: `/vault/${path}`,
    document: `/vault/${path}`,
    inputs: undefined,
    pinnable: true,
    exportable: true,
    pdf: `${path}.pdf`,
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release,
  } as TypstSource & { exportable: boolean };
}

test("pdfDestination replaces only the final extension of the final path segment", () => {
  // #given
  const vaultPaths = ["a/b.typ", "a/Note.md", "a/b.md.typ", "a.dir/noext", "A.TYP"];

  // #when
  const destinations = vaultPaths.map((vaultPath) => pdfDestination(vaultPath));

  // #then
  assert.deepEqual(destinations, ["a/b.pdf", "a/Note.pdf", "a/b.md.pdf", "a.dir/noext.pdf", "A.pdf"]);
});

test("SourceRegistry shares a pending source until every holder releases it", async () => {
  // #given
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

test("SourceRegistry disposes a shared source once after its final holder releases", async () => {
  // #given
  const lifecycle: string[] = [];
  const adapter: SourceAdapter = {
    mayBe: () => true,
    create: async (path, release) => {
      const created = source(path, release) as TypstSource & { dispose?: () => void };
      created.dispose = () => lifecycle.push("dispose");
      return created;
    },
  };
  const registry = new SourceRegistry([adapter]);
  const first = await registry.hold("notes/chapter.typ");
  const second = await registry.hold("notes/chapter.typ");
  assert.ok(first && second, "expected two holders of one source");

  // #when
  first.release();
  const afterFirst = [...lifecycle];
  second.release();
  const afterSecond = [...lifecycle];
  first.release();

  // #then
  assert.deepEqual(
    { afterFirst, afterSecond, afterRepeatedRelease: lifecycle },
    { afterFirst: [], afterSecond: ["dispose"], afterRepeatedRelease: ["dispose"] },
  );
});

test("SourceRegistry queries adapters in order and mayBeSource does not create a source", async () => {
  // #given
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

test("SourceRegistry asks a false-mayBe adapter and shares its held source", async () => {
  // #given
  let creates = 0;
  const adapter: SourceAdapter = {
    mayBe: () => false,
    create: async (path, release) => {
      creates++;
      return source(path, release);
    },
  };
  const registry = new SourceRegistry([adapter]);

  // #when
  const first = await registry.hold("notes/chapter.md");
  const second = await registry.hold("notes/chapter.md");
  if (!first || !second) throw new Error("expected a source from the adapter verdict");
  first.release();
  second.release();

  // #then
  assert.deepEqual({ sameObject: first === second, creates }, { sameObject: true, creates: 1 });
});

test("SourceRegistry ignores a release after the held source is evicted", async () => {
  // #given
  let creates = 0;
  const adapter: SourceAdapter = {
    mayBe: () => true,
    create: async (path, release) => {
      creates++;
      return source(path, release);
    },
  };
  const registry = new SourceRegistry([adapter]);
  const first = await registry.hold("notes/chapter.typ");
  if (!first) throw new Error("expected the adapter to create a source");
  first.release();

  // #when
  assert.doesNotThrow(() => first.release());
  const second = await registry.hold("notes/chapter.typ");
  if (!second) throw new Error("expected the adapter to recreate a source");

  // #then
  try {
    assert.equal(creates, 2);
  } finally {
    second.release();
  }
});

test("the typ adapter follows a wrapper created after the source is held", async () => {
  // #given
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
  const wrongExtension = await adapter.create("notes/chapter.md", () => {});

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
        exportable: (held as TypstSource & { exportable?: boolean }).exportable,
        toSource: held.toSource(position),
        toEntry: held.toEntry(position),
        description: held.describe(new Error("broken")),
        reveals,
        listenerCalls,
        releases,
        unavailable,
        wrongExtension,
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
        exportable: true,
        toSource: { line: 4, character: 7 },
        toEntry: { line: 4, character: 7 },
        description: "Error: broken",
        reveals: [{ document: join(root, "notes", "chapter.typ"), position: { line: 4, character: 7 } }],
        listenerCalls: 0,
        releases: 1,
        unavailable: null,
        wrongExtension: null,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the typ adapter recognizes upper-case Typst extensions", async () => {
  // #given
  const adapter = typAdapter({ root: () => "/vault", reveal: async () => {} });

  // #when
  const upperCaseSource = await adapter.create("notes/a.TYP", () => {});

  // #then
  assert.deepEqual(
    { mayBe: adapter.mayBe("Chapter.TYP"), created: upperCaseSource !== null },
    { mayBe: true, created: true },
  );
});
