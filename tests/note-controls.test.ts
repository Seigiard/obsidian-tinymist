import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Notice } from "obsidian";
import TinymistPlugin from "../src/main";
import { MarkdownView, TFile, testApp, type TestApp } from "./support/obsidian";
import { virtualAddress } from "./support/virtualAddress";

interface CommandRecord {
  id: string;
  checkCallback?(checking: boolean): boolean;
}

interface MetadataCacheFake {
  getCache(path: string): { frontmatter: Record<string, unknown> } | null;
  on(name: string, callback: (...args: unknown[]) => unknown): { detach(): void };
  emit(name: string, ...args: unknown[]): Promise<void>;
  setFrontmatter(path: string, frontmatter: Record<string, unknown>): void;
}

function metadataCache(initial: Record<string, Record<string, unknown>>): MetadataCacheFake {
  const values = new Map(Object.entries(initial));
  const events = new Map<string, Set<(...args: unknown[]) => unknown>>();
  return {
    getCache: (path) => {
      const frontmatter = values.get(path);
      return frontmatter ? { frontmatter } : null;
    },
    on: (name, callback) => {
      let callbacks = events.get(name);
      if (!callbacks) events.set(name, (callbacks = new Set()));
      callbacks.add(callback);
      return { detach: () => callbacks?.delete(callback) };
    },
    emit: async (name, ...args) => {
      await Promise.all([...(events.get(name) ?? [])].map((callback) => callback(...args)));
    },
    setFrontmatter: (path, frontmatter) => values.set(path, frontmatter),
  };
}

class NoteControlPlugin extends TinymistPlugin {
  readonly commands: CommandRecord[] = [];
  readonly opened: string[] = [];

  addCommand(command: unknown): void {
    this.commands.push(command as CommandRecord);
  }

  async startLsp(_restart: boolean): Promise<void> {}

  async openPreview(path: string): Promise<void> {
    this.opened.push(path);
  }
}

interface NoteHarness {
  app: TestApp;
  plugin: NoteControlPlugin;
  metadata: MetadataCacheFake;
  file: TFile;
  view: MarkdownView;
  leaf: { view: MarkdownView };
}

async function noteHarness(): Promise<NoteHarness> {
  const app = testApp("/vault");
  const metadata = metadataCache({ "Notes/A.md": { typst: true } });
  const file = new TFile("Notes/A.md");
  const view = new MarkdownView(file);
  const leaf = { view };
  Object.assign(app, { metadataCache: metadata });
  Object.assign(app.workspace, {
    getActiveFile: () => file,
    getActiveViewOfType: (type: new (...args: never[]) => unknown) =>
      view instanceof type ? view : null,
    getLeavesOfType: () => [leaf],
  });
  const plugin = new NoteControlPlugin(app as never, {});
  await plugin.onload();
  return { app, plugin, metadata, file, view, leaf };
}

test("a flagged Markdown view owns one removable Open preview header action", async () => {
  // #given
  const h = await noteHarness();

  // #when
  await h.app.workspace.emit("file-open", h.file);
  await h.app.workspace.emit("active-leaf-change", h.leaf);
  await h.metadata.emit("changed", h.file);
  const live = h.view.actions.filter((action) => !action.removed);
  await live[0]?.callback();
  h.metadata.setFrontmatter("Notes/A.md", { typst: false });
  await h.metadata.emit("changed", h.file);

  // #then
  try {
    assert.deepEqual(
      {
        actions: h.view.actions.map(({ icon, title, removed }) => ({ icon, title, removed })),
        liveBeforeRemoval: live.length,
        opened: h.plugin.opened,
      },
      {
        actions: [{ icon: "eye", title: "Open preview", removed: true }],
        liveBeforeRemoval: 1,
        opened: ["Notes/A.md"],
      },
    );
  } finally {
    h.plugin.onunload();
  }
});

test("an existing header action opens the file shown by its view at click time", async () => {
  // #given
  const h = await noteHarness();
  await h.app.workspace.emit("file-open", h.file);
  const action = h.view.actions.find(({ removed }) => !removed);
  assert.ok(action, "expected the flagged view action");
  const second = new TFile("Notes/B.md");
  h.metadata.setFrontmatter(second.path, { typst: true });

  // #when
  h.view.file = second;
  await h.app.workspace.emit("file-open", second);
  await action.callback();
  second.path = "Archive/C.md";
  h.metadata.setFrontmatter(second.path, { typst: true });
  await h.app.workspace.emit("file-open", second);
  await action.callback();

  // #then
  try {
    assert.deepEqual(h.plugin.opened, ["Notes/B.md", "Archive/C.md"]);
  } finally {
    h.plugin.onunload();
  }
});

test("the Open preview command accepts a flagged Markdown file and starts its vault path", async () => {
  // #given
  const h = await noteHarness();
  const command = h.plugin.commands.find(({ id }) => id === "open-preview");

  // #when
  const available = command?.checkCallback?.(true) ?? false;
  const executed = command?.checkCallback?.(false) ?? false;
  await Promise.resolve();

  // #then
  try {
    assert.deepEqual(
      { available, executed, opened: h.plugin.opened },
      { available: true, executed: true, opened: ["Notes/A.md"] },
    );
  } finally {
    h.plugin.onunload();
  }
});

test("a Markdown preview start failure notice uses the described note path", async () => {
  // #given
  const app = testApp("/vault");
  const metadata = metadataCache({ "Notes/A.md": { typst: true } });
  const file = new TFile("Notes/A.md");
  const view = new MarkdownView(file);
  Object.assign(view.editor, { getValue: () => "---\ntypst: true\n---\nText" });
  app.vault.files.set(file.path, "---\ntypst: true\n---\nText");
  Object.assign(app, { metadataCache: metadata });
  Object.assign(app.workspace, {
    getActiveFile: () => file,
    getActiveViewOfType: (type: new (...args: never[]) => unknown) =>
      view instanceof type ? view : null,
    getLeavesOfType: () => [{ view }],
  });
  const commands: CommandRecord[] = [];
  class ErrorPlugin extends TinymistPlugin {
    addCommand(command: unknown): void {
      commands.push(command as CommandRecord);
    }
    async startLsp(_restart: boolean): Promise<void> {}
  }
  const plugin = new ErrorPlugin(app as never, {});
  Notice.shown.length = 0;
  await plugin.onload();
  plugin.lsp = {
    status: "running",
    mainFile: null,
    onNotification: () => {},
    setPreviewSource: () => {},
    pinMain: () => {},
    didOpen: () => {},
    didChange: () => {},
    didClose: () => {},
    executeCommand: async () => {
      throw new Error(`${virtualAddress("/vault", "Notes/A.md")}:3:5: unknown variable`);
    },
    stop: () => {},
  } as never;
  const command = commands.find(({ id }) => id === "open-preview");

  // #when
  const accepted = command?.checkCallback?.(false) ?? false;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // #then
  try {
    assert.deepEqual(
      { accepted, notices: Notice.shown },
      {
        accepted: true,
        notices: ["Tinymist preview failed: Notes/A.md:3:5: unknown variable"],
      },
    );
  } finally {
    plugin.onunload();
  }
});
