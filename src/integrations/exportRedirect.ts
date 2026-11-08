import { MarkdownView } from "obsidian";
import type TinymistPlugin from "../main";

/** Replaces a function-valued property and restores it if no later patch replaced it. */
export function patchMethod<T extends object>(
  target: T,
  key: keyof T & string,
  replace: (original: Function, isActive: () => boolean) => Function,
): { restore(): void } | null {
  const member = (target as Record<string, unknown>)[key];
  if (typeof member !== "function") return null;

  const original = member;
  let active = true;
  const replacement = replace(original, () => active);
  (target as Record<string, unknown>)[key] = replacement;

  return {
    restore(): void {
      active = false;
      if ((target as Record<string, unknown>)[key] === replacement) {
        (target as Record<string, unknown>)[key] = original;
      }
    },
  };
}

/** Redirects Obsidian's Markdown export action to the plugin's PDF rebuild. */
export function installExportRedirect(plugin: TinymistPlugin): (() => void) | null {
  const patch = patchMethod(
    MarkdownView.prototype as unknown as Record<string, unknown>,
    "printToPdf",
    (original, isActive) =>
      async function (this: MarkdownView, ...args: unknown[]): Promise<unknown> {
        if (!isActive()) return original.apply(this, args);
        const path = this.file?.path;
        if (path && plugin.sources.mayBeSource(path)) {
          await plugin.rebuildPdf(path);
          return undefined;
        }
        return original.apply(this, args);
      },
  );
  return patch ? () => patch.restore() : null;
}
