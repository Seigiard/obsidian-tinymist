import { join } from "path";
import type { LspClient } from "../lsp/client";
import { bookMain, previewEntry } from "../preview/previewEntry";

export interface Position {
  line: number;
  character: number;
}

/**
 * A shared source object for one held file. Each successful hold owns one
 * release call, even when several holders receive this same object.
 */
export interface TypstSource {
  readonly file: string;
  /** Address passed to preview and PDF jobs; may be the project's `.tinymist-preview.typ` wrapper. */
  readonly entry: string;
  /** Address of the source file's text, used for cursor sync and source jumps. */
  readonly document: string;
  /** Preview-source input for an entry wrapper; like entry, adapters read it live. */
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

/**
 * Decides whether it can create the shared source for a path. `mayBe` is a
 * cheap affordance; `create` is the verdict and receives the hold's release.
 */
export interface SourceAdapter {
  mayBe(vaultPath: string): boolean;
  create(vaultPath: string, release: () => void): Promise<TypstSource | null>;
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

  /**
   * Holds one shared source object. Every non-null result needs its own
   * release call; pending holders also share the eventual created object.
   */
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

    const release = (): void => this.release(vaultPath);
    const state: PendingSource = {
      holders: 1,
      promise: this.create(vaultPath, release).then(
        (source) => {
          this.pending.delete(vaultPath);
          if (!source) return null;
          this.held.set(vaultPath, { source, holders: state.holders });
          return source;
        },
        (error: unknown) => {
          this.pending.delete(vaultPath);
          throw error;
        },
      ),
    };
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

  private release(vaultPath: string): void {
    const held = this.held.get(vaultPath);
    if (!held) return;
    held.holders--;
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

interface TypAdapterOptions {
  root(): string | null;
  reveal(document: string, position: Position): Promise<void>;
}

/** Adapts a saved `.typ` file without opening a second LSP document. */
export function typAdapter(options: TypAdapterOptions): SourceAdapter {
  const mayBe = (vaultPath: string): boolean => /\.typ$/i.test(vaultPath);
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

/** Returns the nearest `main.typ` that includes the given file. */
export function typBookMain(filePath: string, root: string): string | null {
  return bookMain(filePath, root);
}
