import { join } from "path";
import type { KitStateView } from "../kit/kit";
import type { LspClient } from "../lsp/client";
import { convert, type Problem } from "../markdown/convert";
import { pdfDestination } from "./typst";
import type { Position, SourceAdapter, TypstSource } from "./typst";

export interface MarkdownSourceHost {
  root(): string | null;
  frontmatter(vaultPath: string): Record<string, unknown> | null;
  editorText(vaultPath: string): string | null;
  readFile(vaultPath: string): Promise<string>;
  exists(vaultPath: string): boolean;
  kit(): KitStateView;
  reveal(vaultPath: string, position: Position): Promise<void>;
  onKitChange(listener: () => void): () => void;
  onEditorChange(listener: (vaultPath: string, text: string) => void): () => void;
  onRename(listener: (oldPath: string, newPath: string) => void): () => void;
  onDelete(listener: (vaultPath: string) => void): () => void;
  writeShadow(vaultPath: string): Promise<void>;
  removeShadow(vaultPath: string): Promise<void>;
}

interface OpenClient {
  client: LspClient;
  handles: number;
  opened: boolean;
}

interface SourceState {
  file: string;
  entry: string;
  text: string;
  conversion: ReturnType<typeof convert>;
  ended: boolean;
  disposed: boolean;
}

/** Joins a vault-relative Markdown path to its in-memory Typst address. */
export function virtualAddress(root: string, vaultPath: string): string {
  return join(root, shadowPath(vaultPath));
}

/** Adapts a frontmatter-enabled Markdown note to an in-memory Typst document. */
export function mdAdapter(host: MarkdownSourceHost): SourceAdapter {
  const mayBe = (vaultPath: string): boolean => {
    if (!/\.md$/iu.test(vaultPath)) return false;
    return host.frontmatter(vaultPath)?.typst === true;
  };
  const shadowQueues = new Map<string, Promise<void>>();
  const queueShadowOperation = (
    vaultPath: string,
    operation: () => Promise<void>,
    action: "write" | "remove",
  ): void => {
    const previous = shadowQueues.get(vaultPath) ?? Promise.resolve();
    const next = previous.then(operation, operation).catch((error: unknown) => {
      console.warn(`[tinymist] Markdown shadow ${action} failed for ${vaultPath}:`, error);
    });
    shadowQueues.set(vaultPath, next);
    void next.then(() => {
      if (shadowQueues.get(vaultPath) === next) shadowQueues.delete(vaultPath);
    });
  };

  return {
    mayBe,
    create: async (vaultPath, release) => {
      if (!mayBe(vaultPath)) return null;
      const root = host.root();
      if (!root) return null;
      if (host.exists(shadowPath(vaultPath))) return null;
      const editorText = host.editorText(vaultPath);
      const text = normalizeText(editorText ?? await host.readFile(vaultPath));
      const conversion = convertForKit(text, host.kit(), vaultPath);
      if (!conversion.source) return null;

      const state: SourceState = {
        file: vaultPath,
        entry: virtualAddress(root, vaultPath),
        text,
        conversion,
        ended: false,
        disposed: false,
      };
      const clients = new Map<LspClient, OpenClient>();
      const eventListeners = new Set<() => void>();
      let openHandles = 0;
      let activeShadowPath: string | null = null;
      const sourceListeners = new Map<"moved" | "ended" | "problems", Set<() => void>>([
        ["moved", new Set()],
        ["ended", new Set()],
        ["problems", new Set()],
      ]);

      const emit = (event: "moved" | "ended" | "problems"): void => {
        for (const listener of sourceListeners.get(event) ?? []) listener();
      };
      const writeShadow = (path: string): void => {
        queueShadowOperation(path, () => host.writeShadow(path), "write");
      };
      const removeShadow = (path: string): void => {
        queueShadowOperation(path, () => host.removeShadow(path), "remove");
      };
      const removeActiveShadow = (): void => {
        const path = activeShadowPath;
        activeShadowPath = null;
        if (path) removeShadow(path);
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
        state.text = normalizeText(nextText);
        applyConversion(convertForKit(state.text, host.kit(), state.file), false);
      };
      const onKitChange = (): void => {
        if (state.ended) return;
        applyConversion(convertForKit(state.text, host.kit(), state.file), true);
      };
      const applyConversion = (next: SourceState["conversion"], closeOnFatal: boolean): void => {
        state.conversion = next;
        if (closeOnFatal && conversionHasFatal(state.conversion.problems)) {
          for (const open of clients.values()) closeClient(open);
        } else if (!conversionHasFatal(state.conversion.problems)) {
          for (const open of clients.values()) {
            if (open.opened) open.client.didChange(state.entry, state.conversion.typ);
            else reopen(open);
          }
        }
        emit("problems");
      };
      const refresh = async (): Promise<void> => {
        if (state.ended) return;
        const editorText = host.editorText(state.file);
        const nextText = normalizeText(editorText ?? await host.readFile(state.file));
        if (nextText === state.text) {
          if (!state.conversion.source) {
            throw new Error("the note is no longer a Typst source");
          }
          return;
        }
        onEditorChange(state.file, nextText);
        if (!state.conversion.source) {
          throw new Error("the note is no longer a Typst source");
        }
      };
      const onRename = (oldPath: string, newPath: string): void => {
        if (state.ended || oldPath !== state.file) return;
        if (host.exists(shadowPath(newPath))) {
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
        state.conversion = convertForKit(state.text, host.kit(), state.file);
        if (openHandles > 0 && activeShadowPath === oldPath) {
          activeShadowPath = newPath;
          removeShadow(oldPath);
          writeShadow(newPath);
        }
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
      eventListeners.add(host.onKitChange(onKitChange));
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
        exportable: true,
        get pdf(): string {
          return pdfDestination(state.file);
        },
        get problems(): Problem[] {
          return state.conversion.problems;
        },
        refresh,
        open(client): { close(): void } {
          let open = clients.get(client);
          if (open) {
            open.handles++;
          } else {
            open = { client, handles: 1, opened: false };
            clients.set(client, open);
            reopen(open);
          }
          if (openHandles === 0) {
            activeShadowPath = state.file;
            writeShadow(state.file);
          }
          openHandles++;
          let active = true;
          return {
            close: () => {
              if (!active) return;
              active = false;
              openHandles--;
              open.handles--;
              if (open.handles === 0) {
                clients.delete(client);
                closeClient(open);
              }
              if (openHandles === 0) removeActiveShadow();
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
          removeActiveShadow();
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

function shadowPath(vaultPath: string): string {
  return `.typst-cache/notes/${vaultPath}.typ`;
}

function convertForKit(text: string, kit: KitStateView, vaultPath: string): ReturnType<typeof convert> {
  if (!kit.ready) {
    return {
      source: true,
      typ: "",
      toMd: (_line, column) => column,
      toTyp: (_line, column) => column,
      problems: [{ line: 0, message: kit.reason, fatal: true }],
    };
  }
  return convert(text, kit.kit, { vaultPath });
}

function conversionHasFatal(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.fatal);
}
