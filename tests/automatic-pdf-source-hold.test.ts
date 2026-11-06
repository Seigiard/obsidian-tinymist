import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomaticPdfController, type AutomaticPdfExportRequest } from "../src/automatic-pdf";
import type { TypstSource } from "../src/sources";
import { TestFileManager, TestVault } from "./support/obsidian";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface Harness {
  controller: AutomaticPdfController;
  notices: string[];
  requests: AutomaticPdfExportRequest[];
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function source(
  pdf: string,
  release: () => void,
  describe: (error: unknown) => string = String,
): TypstSource {
  return {
    file: "notes/chapter.typ",
    entry: "/vault/notes/chapter.typ",
    document: "/vault/notes/chapter.typ",
    inputs: undefined,
    pinnable: true,
    pdf,
    open: () => ({ close: () => {} }),
    toSource: (position) => position,
    toEntry: (position) => position,
    reveal: async () => {},
    describe,
    on: () => () => {},
    release,
  };
}

function harness(
  hold: () => Promise<TypstSource | null>,
  exportPdf: () => Promise<Uint8Array> = async () => new TextEncoder().encode("PDF"),
): Harness {
  const vault = new TestVault("/vault");
  vault.files.set("notes/chapter.typ", "= Chapter\n");
  const notices: string[] = [];
  const requests: AutomaticPdfExportRequest[] = [];
  const controller = new AutomaticPdfController({
    vault,
    fileManager: new TestFileManager(vault),
    sources: { mayBeSource: () => true, hold },
    root: () => "/vault",
    onLayoutReady: () => {},
    registerEvent: () => {},
    createExporter: () => ({
      exportPdf: async (request) => {
        requests.push(request);
        return await exportPdf();
      },
      stop: () => {},
    }),
    confirmReplace: async () => true,
    persist: async () => {},
    notice: (message) => notices.push(message),
    storedState: () => undefined,
  } as never);
  return {
    controller,
    notices,
    requests,
  };
}

test("a missing or rejected automatic-PDF source hold fails instead of staying building", async () => {
  // #given
  const unavailable = harness(async () => null);
  const rejected = harness(async () => {
    throw new Error("source lookup failed");
  });

  // #when
  const [unavailableReceipt, rejectedReceipt] = await Promise.all([
    unavailable.controller.rebuildPdf("notes/chapter.typ"),
    rejected.controller.rebuildPdf("notes/chapter.typ"),
  ]);

  // #then
  try {
    assert.deepEqual(
      {
        unavailable: unavailableReceipt,
        rejected: rejectedReceipt,
        unavailableStatus: unavailable.controller.automaticPdfStatus("notes/chapter.typ"),
        rejectedStatus: rejected.controller.automaticPdfStatus("notes/chapter.typ"),
      },
      {
        unavailable: {
          outcome: "failed",
          generation: 1,
          pdfPath: "notes/chapter.pdf",
          status: "error",
        },
        rejected: {
          outcome: "failed",
          generation: 1,
          pdfPath: "notes/chapter.pdf",
          status: "error",
        },
        unavailableStatus: "error",
        rejectedStatus: "error",
      },
    );
  } finally {
    unavailable.controller.dispose();
    rejected.controller.dispose();
  }
});

test("a source hold that becomes stale releases without changing the PDF entry", async () => {
  // #given
  const pending = deferred<TypstSource | null>();
  let releases = 0;
  const h = harness(async () => await pending.promise);
  const receipt = h.controller.rebuildPdf("notes/chapter.typ");
  await Promise.resolve();
  await h.controller.setAutomaticPdf("notes/chapter.typ", false);

  // #when
  pending.resolve(source("notes/custom.pdf", () => {
    releases++;
  }));
  const resolved = await receipt;

  // #then
  try {
    assert.deepEqual(
      {
        receipt: resolved,
        status: h.controller.automaticPdfStatus("notes/chapter.typ"),
        notices: h.notices,
        requests: h.requests,
        releases,
      },
      {
        receipt: {
          outcome: "cancelled",
          generation: 1,
          pdfPath: "notes/chapter.pdf",
          status: "missing",
        },
        status: "missing",
        notices: [],
        requests: [],
        releases: 1,
      },
    );
  } finally {
    h.controller.dispose();
  }
});

test("an automatic-PDF export error uses the source description in its notice", async () => {
  // #given
  let releases = 0;
  const h = harness(
    async () => source("notes/chapter.pdf", () => {
      releases++;
    }, () => "render service unavailable"),
    async () => {
      throw new Error("socket closed");
    },
  );

  // #when
  const receipt = await h.controller.rebuildPdf("notes/chapter.typ");

  // #then
  try {
    assert.deepEqual(
      { outcome: receipt.outcome, status: receipt.status, notices: h.notices, releases },
      {
        outcome: "failed",
        status: "error",
        notices: ["PDF export failed for notes/chapter.typ: render service unavailable"],
        releases: 1,
      },
    );
  } finally {
    h.controller.dispose();
  }
});
