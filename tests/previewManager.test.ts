import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type TinymistPlugin from "../src/main";
import { PreviewManager } from "../src/preview/previewManager";

test("starting a renamed preview launches the requested path instead of reusing the old task", async () => {
  // #given
  const root = mkdtempSync(join(tmpdir(), "typst-preview-manager-"));
  const oldFolder = join(root, "old");
  const newFolder = join(root, "new");
  mkdirSync(oldFolder);
  writeFileSync(join(oldFolder, ".tinymist-preview.typ"), "#include sys.inputs.at(\"preview-source\")\n");
  writeFileSync(join(oldFolder, "chapter.typ"), "= Chapter\n");
  const previewSources: Array<string | null> = [];
  const startEntries: string[] = [];
  const lsp = {
    status: "running",
    mainFile: null,
    onNotification: () => {},
    setPreviewSource: (source?: string) => previewSources.push(source ?? null),
    pinMain: () => {},
    executeCommand: async (command: string, args: unknown[]): Promise<Record<string, number>> => {
      if (command === "tinymist.doStartPreview") {
        const commandArgs = args[0] as string[];
        startEntries.push(commandArgs.at(-1) ?? "");
        return { staticServerPort: 4321 + startEntries.length };
      }
      return {};
    },
  };
  const plugin = {
    lsp,
    settings: { invertPreviewColors: "never" },
    vaultBasePath: () => root,
    jumpToSource: () => {},
  } as unknown as TinymistPlugin;
  const manager = new PreviewManager(plugin);
  const oldPath = join(oldFolder, "chapter.typ");
  const newPath = join(newFolder, "chapter.typ");

  // #when
  try {
    await manager.start(oldPath);
    renameSync(oldFolder, newFolder);
    manager.onVaultRename("new", "old");
    await manager.start(newPath);

    // #then
    assert.deepEqual(
      { startEntries, previewSources: previewSources.filter((source) => source !== null) },
      {
        startEntries: [
          join(oldFolder, ".tinymist-preview.typ"),
          join(newFolder, ".tinymist-preview.typ"),
        ],
        previewSources: ["/old/chapter.typ", "/new/chapter.typ"],
      },
    );
  } finally {
    await manager.stop();
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
