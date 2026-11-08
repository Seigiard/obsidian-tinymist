import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomaticPdfReceipt } from "../src/automatic-pdf";
import TinymistPlugin from "../src/main";
import { MarkdownView, TFile, testApp } from "./support/obsidian";

type PatchMethod = <T extends object>(
  target: T,
  key: keyof T & string,
  replace: (original: Function, isActive: () => boolean) => Function,
) => { restore(): void } | null;

async function patchMethod(): Promise<PatchMethod> {
  const module = await import("../src/integrations/exportRedirect");
  return module.patchMethod as PatchMethod;
}

class Printer {
  readonly calls: Array<{ prefix: string; copies: number }> = [];

  print(prefix: string, copies: number): string {
    this.calls.push({ prefix, copies });
    return `${prefix}:${copies}`;
  }
}

test("patchMethod replaces a plain class method and preserves its receiver and arguments", async () => {
  // #given
  const patch = await patchMethod();
  const printer = new Printer();
  let observed: { receiver: unknown; args: unknown[] } | null = null;
  const original = printer.print;
  const installed = patch(printer, "print", (method) => function (this: Printer, ...args: unknown[]): unknown {
    observed = { receiver: this, args };
    return method.apply(this, args);
  });

  // #when
  const result = printer.print("chapter", 2);

  // #then
  assert.deepEqual(
    { installed: installed !== null, observed, result, calls: printer.calls, replaced: printer.print !== original },
    {
      installed: true,
      observed: { receiver: printer, args: ["chapter", 2] },
      result: "chapter:2",
      calls: [{ prefix: "chapter", copies: 2 }],
      replaced: true,
    },
  );
});

test("patchMethod leaves a plain class unchanged when its method is missing", async () => {
  // #given
  const patch = await patchMethod();
  const printer = new Printer() as Printer & { preview?: unknown };
  const before = Object.keys(printer);

  // #when
  const installed = patch(printer, "preview", () => () => undefined);

  // #then
  assert.deepEqual({ installed, keys: Object.keys(printer) }, { installed: null, keys: before });
});

test("patchMethod leaves a plain class unchanged when its member is not a function", async () => {
  // #given
  const patch = await patchMethod();
  const printer = Object.assign(new Printer(), { print: "not a function" }) as Printer & { print: unknown };
  const before = Object.keys(printer);

  // #when
  const installed = patch(printer, "print", () => () => undefined);

  // #then
  assert.deepEqual(
    { installed, keys: Object.keys(printer), print: printer.print },
    { installed: null, keys: before, print: "not a function" },
  );
});

test("patchMethod restore returns a plain class method to its original function", async () => {
  // #given
  const patch = await patchMethod();
  const printer = new Printer();
  const original = printer.print;
  const installed = patch(printer, "print", () => () => "replacement");

  // #when
  installed?.restore();

  // #then
  assert.equal(printer.print, original);
});

test("patchMethod restore leaves a later plain-class patch in place", async () => {
  // #given
  const patch = await patchMethod();
  const printer = new Printer();
  const installed = patch(printer, "print", () => () => "plugin replacement");
  const later = () => "third-party replacement";
  printer.print = later;

  // #when
  installed?.restore();

  // #then
  assert.equal(printer.print, later);
});

test("patchMethod makes its replacement inert behind a later plain-class wrapper after restore", async () => {
  // #given
  const patch = await patchMethod();
  const printer = new Printer();
  let redirectBranchCalls = 0;
  const installed = patch(printer, "print", (original, isActive) =>
    function (this: Printer, ...args: unknown[]): unknown {
      if (isActive?.() === false) return original.apply(this, args);
      redirectBranchCalls += 1;
      return original.apply(this, args);
    },
  );
  const ours = printer.print;
  printer.print = function (this: Printer, ...args: unknown[]): string {
    return ours.apply(this, args as [string, number]);
  };
  installed?.restore();

  // #when
  const result = printer.print("chapter", 2);

  // #then
  assert.deepEqual(
    { redirectBranchCalls, result, calls: printer.calls },
    { redirectBranchCalls: 0, result: "chapter:2", calls: [{ prefix: "chapter", copies: 2 }] },
  );
});

class ExportRedirectPlugin extends TinymistPlugin {
  readonly rebuilt: string[] = [];

  async startLsp(_restart: boolean): Promise<void> {}

  async rebuildPdf(path: string): Promise<AutomaticPdfReceipt> {
    this.rebuilt.push(path);
    return { outcome: "cancelled", generation: 0, pdfPath: "Notes/A.pdf", status: "missing" };
  }
}

interface ExportHarness {
  plugin: ExportRedirectPlugin;
  view: MarkdownView;
}

async function exportHarness(typst: boolean): Promise<ExportHarness> {
  const app = testApp("/vault");
  const file = new TFile("Notes/A.md");
  app.metadataCache.setFrontmatter(file.path, typst ? { typst: true } : {});
  const plugin = new ExportRedirectPlugin(app as never, {});
  await plugin.onload();
  return { plugin, view: new MarkdownView(file) };
}

type PrintToPdf = (this: MarkdownView, ...args: unknown[]) => unknown;

function printPrototype(): { printToPdf?: PrintToPdf } {
  return MarkdownView.prototype as unknown as { printToPdf?: PrintToPdf };
}

function unload(plugin: ExportRedirectPlugin): void {
  plugin.onunload();
  plugin.unload();
}

test("Export to PDF rebuilds a typst Markdown note instead of calling Obsidian print", async () => {
  // #given
  const prototype = printPrototype();
  const originals: Array<{ receiver: unknown; args: unknown[] }> = [];
  const original: PrintToPdf = function (...args) {
    originals.push({ receiver: this, args });
    return "Obsidian PDF";
  };
  prototype.printToPdf = original;
  const h = await exportHarness(true);

  // #when
  const result = await prototype.printToPdf.call(h.view, "export", { landscape: true });

  // #then
  try {
    assert.deepEqual(
      { rebuilt: h.plugin.rebuilt, originals, result },
      { rebuilt: ["Notes/A.md"], originals: [], result: undefined },
    );
  } finally {
    unload(h.plugin);
    delete prototype.printToPdf;
  }
});

test("Export to PDF delegates a plain Markdown note with its receiver and arguments", async () => {
  // #given
  const prototype = printPrototype();
  const originals: Array<{ receiver: unknown; args: unknown[] }> = [];
  const original: PrintToPdf = function (...args) {
    originals.push({ receiver: this, args });
    return "Obsidian PDF";
  };
  prototype.printToPdf = original;
  const h = await exportHarness(false);

  // #when
  const result = await prototype.printToPdf.call(h.view, "export", { landscape: false });

  // #then
  try {
    assert.deepEqual(
      { rebuilt: h.plugin.rebuilt, originals, result },
      {
        rebuilt: [],
        originals: [{ receiver: h.view, args: ["export", { landscape: false }] }],
        result: "Obsidian PDF",
      },
    );
  } finally {
    unload(h.plugin);
    delete prototype.printToPdf;
  }
});

test("plugin load leaves a MarkdownView without printToPdf unchanged", async () => {
  // #given
  const prototype = printPrototype();
  delete prototype.printToPdf;

  // #when
  const h = await exportHarness(true);

  // #then
  try {
    assert.equal("printToPdf" in prototype, false);
  } finally {
    unload(h.plugin);
    delete prototype.printToPdf;
  }
});

test("plugin unload restores the original MarkdownView printToPdf method", async () => {
  // #given
  const prototype = printPrototype();
  const original: PrintToPdf = () => "Obsidian PDF";
  prototype.printToPdf = original;
  const h = await exportHarness(true);

  // #when
  unload(h.plugin);

  // #then
  try {
    assert.equal(prototype.printToPdf, original);
  } finally {
    delete prototype.printToPdf;
  }
});

test("plugin unload leaves a third-party MarkdownView printToPdf patch in place", async () => {
  // #given
  const prototype = printPrototype();
  const original: PrintToPdf = () => "Obsidian PDF";
  const thirdParty: PrintToPdf = () => "third-party PDF";
  prototype.printToPdf = original;
  const h = await exportHarness(true);

  // #when
  prototype.printToPdf = thirdParty;
  unload(h.plugin);

  // #then
  try {
    assert.equal(prototype.printToPdf, thirdParty);
  } finally {
    delete prototype.printToPdf;
  }
});

test("plugin unload makes its redirect inert behind a later MarkdownView wrapper", async () => {
  // #given
  const prototype = printPrototype();
  const originals: Array<{ receiver: unknown; args: unknown[] }> = [];
  const original: PrintToPdf = function (...args) {
    originals.push({ receiver: this, args });
    return "Obsidian PDF";
  };
  prototype.printToPdf = original;
  const h = await exportHarness(true);
  const ours = prototype.printToPdf;
  prototype.printToPdf = function (this: MarkdownView, ...args: unknown[]): unknown {
    return ours?.apply(this, args);
  };
  unload(h.plugin);

  // #when
  const result = await prototype.printToPdf.call(h.view, "export", { landscape: true });

  // #then
  try {
    assert.deepEqual(
      { rebuilt: h.plugin.rebuilt, originals, result },
      {
        rebuilt: [],
        originals: [{ receiver: h.view, args: ["export", { landscape: true }] }],
        result: "Obsidian PDF",
      },
    );
  } finally {
    delete prototype.printToPdf;
  }
});
