import assert from "node:assert/strict";
import { test } from "node:test";
import TinymistPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { loadKitModule } from "./support/kit-module";

interface ParsedManifest {
  templates: Record<string, string>;
  fontPaths: string[];
}

interface ManifestModule {
  parseManifest(value: unknown, manifestVaultDir: string, vaultBase: string): ParsedManifest | { error: string };
}

interface KitStateView {
  ready: boolean;
  kit?: { templates: Record<string, string>; defaultTemplate: string } | null;
  reason?: string;
}

interface KitModule {
  Kit: new (options: {
    vaultBase: string;
    bin(): string | null;
    settings(): { kitManifest: string; defaultTemplate: string };
    readManifest(binPath: string, vaultBase: string, manifestAbsPath: string): Promise<ParsedManifest>;
  }) => {
    state: { kind: string };
    reload(): Promise<void>;
    view(): KitStateView;
    onChange(listener: () => void): () => void;
    dispose(): void;
  };
}

function manifestModule(): ManifestModule {
  return loadKitModule<ManifestModule>("src/kit/manifest.ts");
}

function kitModule(): KitModule {
  return loadKitModule<KitModule>("src/kit/kit.ts");
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
  const parsed = manifestModule().parseManifest(manifest, "kit/md", "/vault");

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
  const kit = new (kitModule().Kit)({
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
    markdownSourceHost(): { kit(): unknown; onKitChange?: (listener: () => void) => () => void };
  }).markdownSourceHost();
  let changes = 0;

  // #when
  const unsubscribe = host.onKitChange?.(() => { changes += 1; });
  for (const listener of listeners) listener();
  unsubscribe?.();

  // #then
  assert.deepEqual(
    { view: host.kit(), changes, unsubscribed: listeners.size },
    { view: state, changes: 1, unsubscribed: 0 },
  );
});
