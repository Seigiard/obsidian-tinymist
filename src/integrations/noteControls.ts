import { MarkdownView, type TFile, type WorkspaceLeaf } from "obsidian";
import type TinymistPlugin from "../main";

/** Installs the source-aware preview action on Markdown note views. */
export function registerNoteControls(plugin: TinymistPlugin): void {
  const actions = new WeakMap<MarkdownView, HTMLElement>();

  const refresh = (view: MarkdownView | null): void => {
    if (!view) return;
    const existing = actions.get(view);
    const path = view.file?.path ?? null;
    if (!path || !plugin.sources.mayBeSource(path)) {
      existing?.remove();
      actions.delete(view);
      return;
    }
    if (existing) return;
    const action = view.addAction("eye", "Open preview", () => {
      const currentPath = view.file?.path;
      if (currentPath) void plugin.openPreview(currentPath).catch(() => {});
    });
    actions.set(view, action);
  };

  const refreshPath = (path: string | null): void => {
    if (!path) return;
    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) refresh(view);
    }
  };

  plugin.registerEvent(plugin.app.workspace.on("file-open", (file: TFile | null) => {
    refreshPath(file?.path ?? null);
  }));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
    refresh(leaf?.view instanceof MarkdownView ? leaf.view : null);
  }));
  const metadataCache = (plugin.app as unknown as {
    metadataCache?: { on(name: string, callback: (file: TFile) => void): { detach(): void } };
  }).metadataCache;
  if (metadataCache) {
    plugin.registerEvent(metadataCache.on("changed", (file) => {
      refreshPath(file.path);
    }));
  }

  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    refresh(leaf.view instanceof MarkdownView ? leaf.view : null);
  }
}
