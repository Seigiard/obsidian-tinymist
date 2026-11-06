import { join } from "path";
import type { LspClient } from "../lsp/client";
import { bookMain, previewEntry } from "../preview/previewEntry";

export interface Position {
  line: number;
  character: number;
}

export interface TypstSource {
  readonly file: string;
  readonly entry: string;
  readonly document: string;
  readonly inputs: string | undefined;
  readonly pinnable: boolean;
  readonly pdf: string;
  open(client: LspClient): { close(): void };
  toSource(position: Position): Position;
  toEntry(position: Position): Position;
  reveal(position: Position): Promise<void>;
  describe(error: unknown): string;
  on(
    event: "moved" | "ended" | "problems",
    listener: () => void,
  ): () => void;
  release(): void;
}

export interface SourceAdapter {
  mayBe(vaultPath: string): boolean;
  create(vaultPath: string, release: () => void): Promise<TypstSource | null>;
}

export interface SourceRegistryOptions {
  adapters: SourceAdapter[];
}

interface HeldSource {
  source: TypstSource;
  holders: number;
}

interface PendingSource {
  holders: number;
  promise: Promise<TypstSource | null>;
}

/** Keeps one source object alive while one or more consumers hold a vault path. */
export class SourceRegistry {
  private readonly held = new Map<string, HeldSource>();
  private readonly pending = new Map<string, PendingSource>();

  constructor(private readonly adapters: SourceAdapter[]) {}

  async hold(vaultPath: string): Promise<TypstSource | null> {
    const held = this.held.get(vaultPath);
    if (held) {
      held.holders++;
      return held.source;
    }

    const pending = this.pending.get(vaultPath);
    if (pending) {
      pending.holders++;
      return await pending.promise;
    }

    const state: PendingSource = {
      holders: 1,
      promise: Promise.resolve(null),
    };
    const release = (): void => this.release(vaultPath, state);
    state.promise = this.create(vaultPath, release).then((source) => {
      this.pending.delete(vaultPath);
      if (!source) return null;
      this.held.set(vaultPath, { source, holders: state.holders });
      return source;
    }, (error: unknown) => {
      this.pending.delete(vaultPath);
      throw error;
    });
    this.pending.set(vaultPath, state);
    return await state.promise;
  }

  byDocument(address: string): TypstSource | null {
    for (const { source } of this.held.values()) {
      if (source.document === address) return source;
    }
    return null;
  }

  mayBeSource(vaultPath: string): boolean {
    return this.adapters.some((adapter) => adapter.mayBe(vaultPath));
  }

  private async create(
    vaultPath: string,
    release: () => void,
  ): Promise<TypstSource | null> {
    for (const adapter of this.adapters) {
      const source = await adapter.create(vaultPath, release);
      if (source) return source;
    }
    return null;
  }

  private release(vaultPath: string, state: PendingSource): void {
    const held = this.held.get(vaultPath);
    if (!held) {
      if (this.pending.get(vaultPath) === state) state.holders--;
      return;
    }
    if (held.holders > 0) held.holders--;
    if (held.holders === 0) this.held.delete(vaultPath);
  }
}

/** Replaces the final extension of the final vault path segment with `.pdf`. */
export function pdfDestination(vaultPath: string): string {
  const slash = vaultPath.lastIndexOf("/");
  const prefix = vaultPath.slice(0, slash + 1);
  const name = vaultPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${prefix}${dot > 0 ? name.slice(0, dot) : name}.pdf`;
}

export interface TypAdapterOptions {
  root(): string | null;
  reveal(document: string, position: Position): Promise<void>;
}

/** Adapts a saved `.typ` file without opening a second LSP document. */
export function typAdapter(options: TypAdapterOptions): SourceAdapter {
  const mayBe = (vaultPath: string): boolean => vaultPath.endsWith(".typ");
  return {
    mayBe,
    create: async (vaultPath, release) => {
      if (!mayBe(vaultPath)) return null;
      const root = options.root();
      if (!root) return null;
      const document = join(root, vaultPath);
      return {
        file: vaultPath,
        get entry(): string {
          return previewEntry(document, root).filePath;
        },
        get document(): string {
          return document;
        },
        get inputs(): string | undefined {
          return previewEntry(document, root).sourceInput;
        },
        pinnable: true,
        pdf: pdfDestination(vaultPath),
        open: () => ({ close: () => {} }),
        toSource: (position) => position,
        toEntry: (position) => position,
        reveal: (position) => options.reveal(document, position),
        describe: (error) => String(error),
        on: () => () => {},
        release,
      };
    },
  };
}

/** Reads book-main metadata for the `.typ` adapter's existing editor path. */
export function typBookMain(filePath: string, root: string): string | null {
  return bookMain(filePath, root);
}
