import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomaticPdfController, type AutomaticPdfExportRequest } from "../src/automatic-pdf";
import { TestFileManager, TestVault } from "./support/obsidian";

interface SourceStub {
  file: string;
  entry: string;
  inputs: string | undefined;
  pdf: string;
  release(): void;
}

interface GuardHarness {
  controller: AutomaticPdfController;
  exporterRequests: AutomaticPdfExportRequest[];
  holds(): number;
  releases(): number;
  vault: TestVault;
}

function guardHarness(pdf: string): GuardHarness {
  const vault = new TestVault("/vault");
  const sourcePath = "notes/chapter.md";
  vault.files.set(sourcePath, "source bytes must remain unchanged");
  const exporterRequests: AutomaticPdfExportRequest[] = [];
  let holds = 0;
  let releaseCount = 0;
  const source: SourceStub = {
    file: sourcePath,
    entry: "/vault/notes/chapter.typ",
    document: "/vault/notes/chapter.md",
    inputs: undefined,
    pdf,
    release: () => {
      releaseCount++;
    },
  };
  const controller = new AutomaticPdfController({
    vault,
    fileManager: new TestFileManager(vault),
    root: () => "/vault",
    onLayoutReady: () => {},
    registerEvent: () => {},
    createExporter: () => ({
      exportPdf: async (request) => {
        exporterRequests.push(request);
        return new TextEncoder().encode("PDF bytes");
      },
      stop: () => {},
    }),
    confirmReplace: async () => true,
    persist: async () => {},
    notice: () => {},
    storedState: () => undefined,
    sources: {
      hold: async () => {
        holds++;
        return source;
      },
      mayBeSource: () => true,
    },
  } as never);
  return {
    controller,
    exporterRequests,
    holds: () => holds,
    releases: () => releaseCount,
    vault,
  };
}

test("AutomaticPdfController refuses a destination that is the source file", async () => {
  // #given
  const h = guardHarness("notes/chapter.md");
  try {
    // #when
    const receipt = await h.controller.rebuildPdf("notes/chapter.md");

    // #then
    assert.deepEqual(
      {
        outcome: receipt.outcome,
        pdfPath: receipt.pdfPath,
        sourceBytes: h.vault.files.get("notes/chapter.md"),
        destinationBytes: h.vault.binaryFiles.get("notes/chapter.md") ?? null,
        destinationReads: h.vault.binaryReadStarted,
        exporterRequests: h.exporterRequests,
        heldAtLeastOnce: h.holds() > 0,
        holdReleaseBalance: h.holds() - h.releases(),
      },
      {
        outcome: "failed",
        pdfPath: "notes/chapter.md",
        sourceBytes: "source bytes must remain unchanged",
        destinationBytes: null,
        destinationReads: [],
        exporterRequests: [],
        heldAtLeastOnce: true,
        holdReleaseBalance: 0,
      },
    );
  } finally {
    h.controller.dispose();
  }
});

test("AutomaticPdfController refuses a destination without a PDF suffix", async () => {
  // #given
  const h = guardHarness("notes/chapter.txt");
  try {
    // #when
    const receipt = await h.controller.rebuildPdf("notes/chapter.md");

    // #then
    assert.deepEqual(
      {
        outcome: receipt.outcome,
        pdfPath: receipt.pdfPath,
        sourceBytes: h.vault.files.get("notes/chapter.md"),
        destinationBytes: h.vault.binaryFiles.get("notes/chapter.txt") ?? null,
        destinationReads: h.vault.binaryReadStarted,
        exporterRequests: h.exporterRequests,
        heldAtLeastOnce: h.holds() > 0,
        holdReleaseBalance: h.holds() - h.releases(),
      },
      {
        outcome: "failed",
        pdfPath: "notes/chapter.txt",
        sourceBytes: "source bytes must remain unchanged",
        destinationBytes: null,
        destinationReads: [],
        exporterRequests: [],
        heldAtLeastOnce: true,
        holdReleaseBalance: 0,
      },
    );
  } finally {
    h.controller.dispose();
  }
});
