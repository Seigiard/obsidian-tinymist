import { join } from "path";
import type { LspClient } from "../lsp/client";
import { convert, type KitView, type Problem } from "../markdown/convert";
import { pdfDestination } from "./typst";
import type { Position, SourceAdapter, TypstSource } from "./typst";

export interface MarkdownSourceHost {
  root(): string | null;
  frontmatter(vaultPath: string): Record<string, unknown> | null;
  editorText(vaultPath: string): string | null;
  readFile(vaultPath: string): Promise<string>;
  exists(vaultPath: string): boolean;
  kit(): KitView | null;
  reveal(vaultPath: string, position: Position): Promise<void>;
  onEditorChange(listener: (vaultPath: string, text: string) => void): () => void;
  onRename(listener: (oldPath: string, newPath: string) => void): () => void;
  onDelete(listener: (vaultPath: string) => void): () => void;
  onServerRestart(listener: () => void): () => void;
}

interface OpenClient {
  client: LspClient;
  opened: boolean;
}

interface SourceState {
  file: string;
  entry: string;
  conversion: ReturnType<typeof convert>;
  ended: boolean;
}

/** Joins a vault-relative Markdown path to its in-memory Typst address. */
export function virtualAddress(root: string, vaultPath: string): string {
  return `${join(root, vaultPath)}.typ`;
}

/** Adapts a frontmatter-enabled Markdown note to an in-memory Typst document. */
export function mdAdapter(host: MarkdownSourceHost): SourceAdapter {
  const mayBe = (vaultPath: string): boolean => {
    if (!/\.md$/iu.test(vaultPath)) return false;
    return host.frontmatter(vaultPath)?.typst === true;
  };

  return {
    mayBe,
    create: async (vaultPath, release) => {
      if (!mayBe(vaultPath)) return null;
      if (host.exists(`${vaultPath}.typ`)) return null;
      const root = host.root();
      if (!root) return null;
      const editorText = host.editorText(vaultPath);
      const text = normalizeText(editorText ?? await host.readFile(vaultPath));
      const conversion = convert(text, host.kit());
      if (!conversion.source) return null;

      const state: SourceState = {
        file: vaultPath,
        entry: virtualAddress(root, vaultPath),
        conversion,
        ended: false,
      };
      const clients = new Set<OpenClient>();
      const listeners = new Set<() => void>();
      const eventListeners = new Set<() => void>();
      const sourceListeners = new Map<"moved" | "ended" | "problems", Set<() => void>>([
        ["moved", new Set()],
        ["ended", new Set()],
        ["problems", new Set()],
      ]);

      const emit = (event: "moved" | "ended" | "problems"): void => {
        for (const listener of sourceListeners.get(event) ?? []) listener();
      };
      const closeClient = (open: OpenClient, path = state.entry): void => {
        if (!open.opened) return;
        open.client.didClose(path);
        open.opened = false;
      };
      const fatal = (): boolean => conversionHasFatal(state.conversion.problems);
      const reopen = (open: OpenClient): void => {
        if (state.ended || fatal()) return;
        open.client.didOpen(state.entry, state.conversion.typ);
        open.opened = true;
      };
      const onEditorChange = (path: string, nextText: string): void => {
        if (state.ended || path !== state.file) return;
        state.conversion = convert(normalizeText(nextText), host.kit());
        if (!conversionHasFatal(state.conversion.problems)) {
          for (const open of clients) {
            if (open.opened) open.client.didChange(state.entry, state.conversion.typ);
            else reopen(open);
          }
        }
        emit("problems");
      };
      const onRename = (oldPath: string, newPath: string): void => {
        if (state.ended || oldPath !== state.file) return;
        const oldEntry = state.entry;
        const rootNow = host.root();
        if (!rootNow) return;
        state.file = newPath;
        state.entry = virtualAddress(rootNow, newPath);
        for (const open of clients) {
          closeClient(open, oldEntry);
          reopen(open);
        }
        emit("moved");
      };
      const onDelete = (path: string): void => {
        if (state.ended || path !== state.file) return;
        state.ended = true;
        for (const open of clients) closeClient(open);
        clients.clear();
        emit("ended");
      };
      const onServerRestart = (): void => {
        if (state.ended) return;
        for (const open of clients) reopen(open);
      };

      eventListeners.add(host.onEditorChange(onEditorChange));
      eventListeners.add(host.onRename(onRename));
      eventListeners.add(host.onDelete(onDelete));
      eventListeners.add(host.onServerRestart(onServerRestart));

      const source: TypstSource = {
        get file(): string {
          return state.file;
        },
        get entry(): string {
          return state.entry;
        },
        get document(): string {
          return state.entry;
        },
        inputs: undefined,
        pinnable: false,
        get pdf(): string {
          return pdfDestination(state.file);
        },
        get problems(): Problem[] {
          return state.conversion.problems;
        },
        open(client): { close(): void } {
          const open: OpenClient = { client, opened: false };
          clients.add(open);
          reopen(open);
          return {
            close: () => {
              if (!clients.delete(open)) return;
              closeClient(open);
            },
          };
        },
        toSource: (position) => ({
          line: position.line,
          character: state.conversion.toMd(position.line, position.character),
        }),
        toEntry: (position) => ({
          line: position.line,
          character: state.conversion.toTyp(position.line, position.character),
        }),
        reveal: (position) => host.reveal(state.file, position),
        describe: (error) => String(error).replaceAll(state.entry, state.file),
        on: (event, listener) => {
          const eventSet = sourceListeners.get(event);
          eventSet?.add(listener);
          return () => eventSet?.delete(listener);
        },
        release: () => {
          if (listeners.size === 0) return;
          for (const open of clients) closeClient(open);
          clients.clear();
          for (const unsubscribe of eventListeners) unsubscribe();
          eventListeners.clear();
          listeners.clear();
          release();
        },
      };
      listeners.add(() => {});
      return source;
    },
  };
}

function normalizeText(text: string): string {
  return text.replace(/^\ufeff/u, "").replaceAll("\r\n", "\n");
}

function conversionHasFatal(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.fatal);
}
