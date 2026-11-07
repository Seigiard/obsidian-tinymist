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
}

interface OpenClient {
  client: LspClient;
  handles: number;
  opened: boolean;
}

interface SourceState {
  file: string;
  entry: string;
  conversion: ReturnType<typeof convert>;
  ended: boolean;
  disposed: boolean;
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
        disposed: false,
      };
      const clients = new Map<LspClient, OpenClient>();
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
          for (const open of clients.values()) {
            if (open.opened) open.client.didChange(state.entry, state.conversion.typ);
            else reopen(open);
          }
        }
        emit("problems");
      };
      const onRename = (oldPath: string, newPath: string): void => {
        if (state.ended || oldPath !== state.file) return;
        if (host.exists(`${newPath}.typ`)) {
          state.ended = true;
          for (const open of clients.values()) closeClient(open);
          clients.clear();
          emit("ended");
          return;
        }
        const oldEntry = state.entry;
        const rootNow = host.root();
        if (!rootNow) return;
        state.file = newPath;
        state.entry = virtualAddress(rootNow, newPath);
        for (const open of clients.values()) {
          closeClient(open, oldEntry);
          reopen(open);
        }
        emit("moved");
      };
      const onDelete = (path: string): void => {
        if (state.ended || path !== state.file) return;
        state.ended = true;
        for (const open of clients.values()) closeClient(open);
        clients.clear();
        emit("ended");
      };

      eventListeners.add(host.onEditorChange(onEditorChange));
      eventListeners.add(host.onRename(onRename));
      eventListeners.add(host.onDelete(onDelete));

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
        exportable: false,
        get pdf(): string {
          return pdfDestination(state.file);
        },
        get problems(): Problem[] {
          return state.conversion.problems;
        },
        open(client): { close(): void } {
          let open = clients.get(client);
          if (open) {
            open.handles++;
          } else {
            open = { client, handles: 1, opened: false };
            clients.set(client, open);
            reopen(open);
          }
          let active = true;
          return {
            close: () => {
              if (!active) return;
              active = false;
              open.handles--;
              if (open.handles === 0) {
                clients.delete(client);
                closeClient(open);
              }
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
        describe: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.replaceAll(state.entry, state.file);
        },
        on: (event, listener) => {
          const eventSet = sourceListeners.get(event);
          eventSet?.add(listener);
          return () => eventSet?.delete(listener);
        },
        release: () => {
          release();
        },
        dispose: () => {
          if (state.disposed) return;
          state.disposed = true;
          state.ended = true;
          for (const open of clients.values()) closeClient(open);
          clients.clear();
          for (const unsubscribe of eventListeners) unsubscribe();
          eventListeners.clear();
          sourceListeners.forEach((listeners) => listeners.clear());
        },
      };
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
