import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Kit, type KitStateView } from "../src/kit/kit";
import { parseManifest, type ParsedManifest } from "../src/kit/manifest";
import TinymistPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { TFile, testApp } from "./support/obsidian";

async function afterDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("kit settings default to empty values and survive loading and saving", async () => {
  // #given
  const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin & {
    loadData(): Promise<unknown>;
    saveData(value: unknown): Promise<void>;
  };
  const writes: unknown[] = [];
  plugin.loadData = async () => ({ fontPaths: ["fonts"] });
  plugin.saveData = async (value) => { writes.push(value); };

  // #when
  await plugin.loadSettings();
  await plugin.saveSettings();

  // #then
  assert.deepEqual(
    {
      defaults: {
        kitManifest: (DEFAULT_SETTINGS as typeof DEFAULT_SETTINGS & { kitManifest?: unknown }).kitManifest,
        defaultTemplate: (DEFAULT_SETTINGS as typeof DEFAULT_SETTINGS & { defaultTemplate?: unknown }).defaultTemplate,
      },
      loaded: {
        kitManifest: (plugin.settings as typeof plugin.settings & { kitManifest?: unknown }).kitManifest,
        defaultTemplate: (plugin.settings as typeof plugin.settings & { defaultTemplate?: unknown }).defaultTemplate,
      },
      saved: writes.map((value) => ({
        kitManifest: (value as { kitManifest?: unknown }).kitManifest,
        defaultTemplate: (value as { defaultTemplate?: unknown }).defaultTemplate,
      })),
    },
    {
      defaults: { kitManifest: "", defaultTemplate: "" },
      loaded: { kitManifest: "", defaultTemplate: "" },
      saved: [{ kitManifest: "", defaultTemplate: "" }],
    },
  );
});

test("the normative manifest makes root Typst template paths and absolute font paths", async () => {
  // #given
  const manifest = {
    version: 1,
    templates: [{ id: "reference", path: "reference.typ" }],
    "font-paths": ["../fonts/files"],
  };

  // #when
  const parsed = parseManifest(manifest, "kit/md", "/vault");

  // #then
  assert.deepEqual(parsed, {
    templates: { reference: "/kit/md/reference.typ" },
    fontPaths: ["/vault/kit/fonts/files"],
  });
});

test("a kit moves from none through loading to ready or failed and exposes its current view", async () => {
  // #given
  let settings = { kitManifest: "", defaultTemplate: "reference" };
  const reads: string[] = [];
  let next: ParsedManifest | Error = { templates: { reference: "/kit/md/reference.typ" }, fontPaths: ["/vault/kit/fonts"] };
  const kit = new Kit({
    vaultBase: "/vault",
    bin: () => "/bin/tinymist",
    settings: () => settings,
    readManifest: async (_bin, _vault, manifest) => {
      reads.push(manifest);
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const initial = kit.view();
  const views: KitStateView[] = [];
  kit.onChange(() => views.push(kit.view()));

  // #when
  await kit.reload();
  settings = { kitManifest: "kit/md/manifest.typ", defaultTemplate: "reference" };
  await kit.reload();
  settings = { kitManifest: "kit/md/manifest.typ", defaultTemplate: "alternate" };
  await kit.reload();
  next = new Error("manifest is invalid");
  settings = { kitManifest: "kit/md/broken.typ", defaultTemplate: "alternate" };
  await kit.reload();

  // #then
  try {
    assert.deepEqual(
      { initial: initial.ready ? initial.kit : initial.reason, reads, states: views.map((view) => view.ready ? view.kit : view.reason), final: kit.state.kind },
      {
        initial: { templates: {}, defaultTemplate: "reference" },
        reads: ["/vault/kit/md/manifest.typ", "/vault/kit/md/broken.typ"],
        states: [
          "Typst kit is loading",
          { templates: { reference: "/kit/md/reference.typ" }, defaultTemplate: "reference" },
          { templates: { reference: "/kit/md/reference.typ" }, defaultTemplate: "alternate" },
          "Typst kit is loading",
          "Typst kit failed: manifest is invalid",
        ],
        final: "failed",
      },
    );
  } finally {
    kit.dispose();
  }
});

test("the Markdown host forwards kit state and kit-change notifications", () => {
  // #given
  const listeners = new Set<() => void>();
  const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin & {
    kit: { view(): KitStateView; onChange(listener: () => void): () => void };
  };
  const state = { ready: true, kit: { templates: { reference: "/kit/md/reference.typ" }, defaultTemplate: "reference" } };
  plugin.kit = {
    view: () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const host = (plugin as unknown as {
    markdownSourceHost(): { kit(): unknown; onKitChange(listener: () => void): () => void };
  }).markdownSourceHost();
  let changes = 0;

  // #when
  const unsubscribe = host.onKitChange(() => { changes += 1; });
  for (const listener of listeners) listener();
  unsubscribe();

  // #then
  assert.deepEqual(
    { view: host.kit(), changes, unsubscribed: listeners.size },
    { view: state, changes: 1, unsubscribed: 0 },
  );
});

test("a setting change during a manifest read discards it and loads the later setting", async () => {
  // #given
  let settings = { kitManifest: "kit/md/letter.typ", defaultTemplate: "" };
  let finishReference: ((manifest: ParsedManifest) => void) | null = null;
  const reads: string[] = [];
  let letterReads = 0;
  const kit = new Kit({
    vaultBase: "/vault",
    bin: () => "/bin/tinymist",
    settings: () => settings,
    readManifest: async (_bin, _vault, path) => {
      reads.push(path);
      if (path.endsWith("reference.typ")) {
        return await new Promise<ParsedManifest>((resolve) => { finishReference = resolve; });
      }
      letterReads += 1;
      return {
        templates: { letter: letterReads === 1 ? "/kit/md/initial-letter.typ" : "/kit/md/reloaded-letter.typ" },
        fontPaths: [],
      };
    },
  });

  // #when
  await kit.reload();
  settings = { kitManifest: "kit/md/reference.typ", defaultTemplate: "" };
  const first = kit.reload();
  settings = { kitManifest: "kit/md/letter.typ", defaultTemplate: "" };
  const second = kit.reload();
  finishReference?.({ templates: { reference: "/kit/md/reference.typ" }, fontPaths: [] });
  await Promise.all([first, second]);

  // #then
  try {
    assert.deepEqual(
      { reads, state: kit.state, loadingPath: Reflect.get(kit, "loadedManifestPath") },
      {
        reads: ["/vault/kit/md/letter.typ", "/vault/kit/md/reference.typ", "/vault/kit/md/letter.typ"],
        state: { kind: "ready", manifest: { templates: { letter: "/kit/md/reloaded-letter.typ" }, fontPaths: [] } },
        loadingPath: "kit/md/letter.typ",
      },
    );
  } finally {
    kit.dispose();
  }
});

test("a missing manifest supersedes an in-flight read and keeps its failure", async () => {
  // #given
  const settings = { kitManifest: "kit/md/manifest.typ", defaultTemplate: "" };
  let finishRead: ((manifest: ParsedManifest) => void) | null = null;
  const kit = new Kit({
    vaultBase: "/vault",
    bin: () => "/bin/tinymist",
    settings: () => settings,
    readManifest: async () => await new Promise<ParsedManifest>((resolve) => { finishRead = resolve; }),
  });

  // #when
  const reload = kit.reload();
  const loadingPath = Reflect.get(kit, "loadedManifestPath");
  kit.markManifestMissing("kit/md/manifest.typ");
  finishRead?.({ templates: { reference: "/kit/md/reference.typ" }, fontPaths: [] });
  await reload;

  // #then
  try {
    assert.deepEqual(
      { loadingPath, state: kit.state },
      {
        loadingPath: null,
        state: { kind: "failed", reason: "Manifest file not found: kit/md/manifest.typ" },
      },
    );
  } finally {
    kit.dispose();
  }
});

test("plugin reload triggers read only for the configured manifest and preserves missing states", async () => {
  // #given
  const app = testApp();
  app.pluginData = { ...DEFAULT_SETTINGS, kitManifest: "kit/md/manifest.typ" };
  const plugin = new TinymistPlugin(app as never, {} as never);
  const reads: string[] = [];
  let failReads = false;
  plugin.kit = new Kit({
    vaultBase: "/vault",
    bin: () => "/bin/tinymist",
    settings: () => ({
      kitManifest: plugin.settings.kitManifest,
      defaultTemplate: plugin.settings.defaultTemplate,
    }),
    readManifest: async (_bin, _vault, path) => {
      reads.push(path);
      if (failReads) throw new Error("manifest is invalid");
      return { templates: { reference: "/kit/md/reference.typ" }, fontPaths: [] };
    },
  });
  plugin.startLsp = async () => {};
  let defaultTemplateNotifications = 0;

  // #when
  try {
    await plugin.onload();
    await app.workspace.runLayoutReady();
    await plugin.kit.reload();
    plugin.kit.onChange(() => { defaultTemplateNotifications += 1; });

    plugin.settings.kitManifest = "kit/md/next.typ";
    await plugin.saveSettings();
    await afterDelay(550);
    await plugin.kit.reload();
    const afterKitSetting = reads.length;
    const beforeDefaultTemplateNotifications = defaultTemplateNotifications;

    plugin.settings.defaultTemplate = "reference";
    await plugin.saveSettings();
    await afterDelay(0);
    await plugin.kit.reload();
    const afterDefaultTemplate = reads.length;
    const afterDefaultTemplateNotifications = defaultTemplateNotifications - beforeDefaultTemplateNotifications;

    await app.vault.emit("modify", new TFile("kit/md/next.typ"));
    await plugin.kit.reload();
    const afterManifestModify = reads.length;

    await app.vault.emit("modify", new TFile("other.typ"));
    await afterDelay(0);
    const afterOtherModify = reads.length;

    plugin.kit.markManifestMissing("kit/md/next.typ");
    failReads = true;
    await app.vault.emit("create", new TFile("kit/md/next.typ"));
    await plugin.kit.reload();
    const afterManifestCreate = reads.length;
    const createState = plugin.kit.state;

    await app.vault.emit("rename", new TFile("elsewhere.typ"), "kit/md/next.typ");
    const renameState = plugin.kit.state;
    await app.vault.emit("delete", new TFile("kit/md/next.typ"));
    const deleteState = plugin.kit.state;

    failReads = false;
    const restart = (plugin.commands as Array<{ id?: string; callback?: () => void }>).find(
      (command) => command.id === "restart-language-server",
    );
    if (!restart?.callback) throw new Error("restart-language-server command is not registered");
    restart.callback();
    await afterDelay(0);
    await plugin.kit.reload();

    // #then
    assert.deepEqual(
      {
        reads,
        afterKitSetting,
        afterDefaultTemplate,
        afterManifestModify,
        afterOtherModify,
        afterManifestCreate,
        afterDefaultTemplateNotifications,
        createKind: createState.kind,
        renameState,
        deleteState,
      },
      {
        reads: [
          "/vault/kit/md/manifest.typ",
          "/vault/kit/md/next.typ",
          "/vault/kit/md/next.typ",
          "/vault/kit/md/next.typ",
          "/vault/kit/md/next.typ",
        ],
        afterKitSetting: 2,
        afterDefaultTemplate: 2,
        afterManifestModify: 3,
        afterOtherModify: 3,
        afterManifestCreate: 4,
        afterDefaultTemplateNotifications: 1,
        createKind: "failed",
        renameState: { kind: "failed", reason: "Manifest file not found: kit/md/next.typ" },
        deleteState: { kind: "failed", reason: "Manifest file not found: kit/md/next.typ" },
      },
    );
  } finally {
    plugin.kit.dispose();
    plugin.unload();
  }
});
