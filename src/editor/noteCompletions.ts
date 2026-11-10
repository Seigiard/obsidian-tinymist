import {
  autocompletion,
  closeCompletion,
  selectedCompletionIndex,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import {
  lspCompletionSource,
  lspQueryEmpty,
  type LspCompletionBackend,
  type LspInsertReplaceEdit,
  type LspPosition as SharedLspPosition,
  type LspRange,
  type LspTextEdit,
} from "./shared/lspCompletion";
import { acceptWouldChange } from "./shared/keyArbiter";
import type { LspClient, LspCompletionContext, LspPosition } from "../lsp/client";
import type { Position, TypstSource } from "../sources/typst";

export interface NoteCompletionSession {
  toEntry(position: Position): Position;
  toSource(position: Position): Position;
  refresh?(): Promise<void>;
  completion(position: LspPosition, context: LspCompletionContext): Promise<unknown>;
}

export interface NoteCompletionHost {
  notePath(state: EditorState): string | null;
  session(vaultPath: string): Promise<NoteCompletionSession | null>;
  triggerCharacters(): readonly string[];
}

export function noteCompletionSource(host: NoteCompletionHost): CompletionSource {
  const backend: LspCompletionBackend = {
    triggerCharacters: () => host.triggerCharacters(),
    request: async (position, context, state) => {
      const vaultPath = host.notePath(state);
      if (!vaultPath) return null;
      const session = await host.session(vaultPath);
      if (!session) return null;
      await session.refresh?.();
      const entryPosition = session.toEntry(position);
      const result = await session.completion(entryPosition, context);
      return mapCompletionResult(result, session, entryPosition.line);
    },
  };
  const source = lspCompletionSource(backend, {
    augment: (_item, _option, edit) => !/[\r\n]/.test(edit.text),
  });

  return async (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const character = context.pos - line.from;
    if (!line.text.startsWith("/typst") || character < 6) return null;
    const vaultPath = host.notePath(context.state);
    if (!vaultPath) return null;
    try {
      const session = await host.session(vaultPath);
      if (!session) return null;
      const entryStart = session.toEntry({ line: line.number - 1, character: 6 });
      if (entryStart.line !== line.number - 1 || entryStart.character !== 0) return null;
      return await source(context);
    } catch {
      return null;
    }
  };
}

export function noteCompletionExtension(host: NoteCompletionHost): Extension {
  const source = noteCompletionSource(host);
  return [
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    Prec.highest(keymap.of([{ key: "Enter", run: (view) => noteCompletionEnter(view, host) }])),
    autocompletion(),
  ];
}

function noteCompletionEnter(view: EditorView, host: NoteCompletionHost): boolean {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!line.text.startsWith("/typst") || state.selection.main.head - line.from < 6 || !host.notePath(state)) {
    return false;
  }
  if (selectedCompletionIndex(state) === null) return false;
  if ((lspQueryEmpty(state) && selectedCompletionIndex(state) === 0) || !acceptWouldChange(state)) {
    closeCompletion(view);
  }
  return false;
}

export interface NoteSessionHost {
  hold(vaultPath: string): Promise<TypstSource | null>;
  client(): LspClient | null;
}

export class NoteSessions {
  private active: ActiveSession | null = null;
  private disposed = false;
  private retainedPath: string | null | undefined;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly host: NoteSessionHost) {}

  async session(vaultPath: string): Promise<NoteCompletionSession | null> {
    let finish!: () => void;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await previous;
    try {
      if (this.disposed) return null;
      if (this.retainedPath !== undefined && this.retainedPath !== vaultPath) return null;
      const client = this.host.client();
      if (this.active?.vaultPath === vaultPath && this.active.client === client) {
        return this.active.session;
      }

      let source: TypstSource | null = null;
      let sourceHeld = false;
      if (this.active?.vaultPath === vaultPath && client) {
        try {
          source = await this.host.hold(vaultPath);
          sourceHeld = true;
        } catch {
          return null;
        }
      }
      this.closeActive();

      if (!client) return null;
      if (!source && !sourceHeld) {
        try {
          source = await this.host.hold(vaultPath);
        } catch {
          return null;
        }
      }
      if (!source || this.disposed) {
        source?.release();
        return null;
      }

      let opened: { close(): void };
      try {
        opened = source.open(client);
      } catch {
        source.release();
        return null;
      }
      const session: NoteCompletionSession = {
        toEntry: (position) => source!.toEntry(position),
        toSource: (position) => source!.toSource(position),
        refresh: source.refresh ? () => source!.refresh!() : undefined,
        completion: (position, context) => client.completion(source!.entry, position, context),
      };
      const active: ActiveSession = {
        vaultPath,
        client,
        source,
        opened,
        session,
        removeEnded: () => {},
      };
      active.removeEnded = source.on("ended", () => {
        if (this.active === active) this.closeActive();
      });
      this.active = active;
      return session;
    } finally {
      finish();
    }
  }

  async retain(vaultPath: string | null): Promise<void> {
    let finish!: () => void;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await previous;
    try {
      this.retainedPath = vaultPath;
      if (this.disposed) return;
      if (!vaultPath || this.active?.vaultPath !== vaultPath) this.closeActive();
    } finally {
      finish();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeActive();
  }

  private closeActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.removeEnded();
    active.opened.close();
    active.source.release();
  }
}

interface ActiveSession {
  vaultPath: string;
  client: LspClient;
  source: TypstSource;
  opened: { close(): void };
  session: NoteCompletionSession;
  removeEnded: () => void;
}

function mapCompletionResult(
  result: unknown,
  session: NoteCompletionSession,
  requestLine: number,
): unknown {
  if (Array.isArray(result)) return result.map((item) => mapCompletionItem(item, session, requestLine));
  const record = asRecord(result);
  if (!record || !Array.isArray(record.items)) return result;
  const mapped: Record<string, unknown> = {
    ...record,
    items: record.items.map((item) => mapCompletionItem(item, session, requestLine)),
  };
  const defaults = asRecord(record.itemDefaults);
  if (defaults && defaults.editRange !== undefined) {
    mapped.itemDefaults = {
      ...defaults,
      editRange: mapEditRange(defaults.editRange, session),
    };
  }
  return mapped;
}

function mapCompletionItem(item: unknown, session: NoteCompletionSession, requestLine: number): unknown {
  const record = asRecord(item);
  if (!record) return item;
  const mapped: Record<string, unknown> = { ...record };
  if (record.textEdit !== undefined) mapped.textEdit = mapTextEdit(record.textEdit, session);
  if (Array.isArray(record.additionalTextEdits)) {
    mapped.additionalTextEdits = record.additionalTextEdits
      .filter((edit) => isSameLineEdit(edit, requestLine))
      .map((edit) => mapTextEdit(edit, session));
  }
  return mapped;
}

function mapTextEdit(edit: unknown, session: NoteCompletionSession): unknown {
  const record = asRecord(edit);
  if (!record) return edit;
  if (isRange(record.range)) {
    return { ...record, range: mapRange(record.range, session) } as LspTextEdit;
  }
  if (isRange(record.insert) && isRange(record.replace)) {
    return {
      ...record,
      insert: mapRange(record.insert, session),
      replace: mapRange(record.replace, session),
    } as LspInsertReplaceEdit;
  }
  return edit;
}

function mapEditRange(editRange: unknown, session: NoteCompletionSession): unknown {
  if (isRange(editRange)) return mapRange(editRange, session);
  const record = asRecord(editRange);
  if (record && isRange(record.insert) && isRange(record.replace)) {
    return {
      ...record,
      insert: mapRange(record.insert, session),
      replace: mapRange(record.replace, session),
    };
  }
  return editRange;
}

function mapRange(range: LspRange, session: NoteCompletionSession): LspRange {
  return {
    start: session.toSource(range.start),
    end: session.toSource(range.end),
  };
}

function isSameLineEdit(edit: unknown, line: number): edit is LspTextEdit {
  const record = asRecord(edit);
  return isRange(record?.range) && record.range.start.line === line && record.range.end.line === line;
}

function isRange(value: unknown): value is LspRange {
  const record = asRecord(value);
  return isPosition(record?.start) && isPosition(record?.end);
}

function isPosition(value: unknown): value is SharedLspPosition {
  const record = asRecord(value);
  return typeof record?.line === "number" && typeof record.character === "number";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
