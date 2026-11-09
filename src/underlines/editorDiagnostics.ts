import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { NoteDiagnostic } from "./noteDiagnostics";

export const setNoteDiagnostics = StateEffect.define<readonly NoteDiagnostic[]>();

function offset(
  doc: Text,
  position: { line: number; character: number },
): { lineFrom: number; lineTo: number; offset: number } | null {
  if (position.line < 0 || position.line >= doc.lines) return null;
  const line = doc.line(position.line + 1);
  const character = Math.max(0, Math.min(position.character, line.length));
  return {
    lineFrom: line.from,
    lineTo: line.to,
    offset: line.from + character,
  };
}

function decorations(doc: Text, diagnostics: readonly NoteDiagnostic[]): DecorationSet {
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];
  for (const diagnostic of diagnostics) {
    const from = offset(doc, diagnostic.from);
    const to = offset(doc, diagnostic.to);
    if (!from || !to) continue;

    let start = from.offset;
    let end = to.offset;
    if (end <= start) {
      if (from.lineTo > from.lineFrom) {
        if (start < from.lineTo) end = start + 1;
        else {
          start--;
          end = from.lineTo;
        }
      } else {
        continue;
      }
    }
    ranges.push({
      from: start,
      to: end,
      decoration: Decoration.mark({
        class: `tinymist-note-diagnostic-${diagnostic.severity}`,
        attributes: { title: diagnostic.message },
      }),
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges.map(({ from, to, decoration }) => decoration.range(from, to)));
}

export function editorDiagnostics(
  resolveFile: (view: EditorView) => string | null,
  holder: {
    attach(path: string, view: EditorView): void;
    detach(path: string, view: EditorView): void;
    documentChanged?(view: EditorView): void;
  },
): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(setNoteDiagnostics)) return decorations(transaction.newDoc, effect.value);
      }
      return transaction.docChanged ? value.map(transaction.changes) : value;
    },
    provide: (fieldValue) => EditorView.decorations.from(fieldValue),
  });

  class DiagnosticsView {
    private path: string | null;

    constructor(readonly view: EditorView) {
      this.path = resolveFile(view);
      if (this.path) holder.attach(this.path, view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) holder.documentChanged?.(update.view);
      const nextPath = resolveFile(update.view);
      if (nextPath === this.path) return;
      if (this.path) holder.detach(this.path, update.view);
      this.path = nextPath;
      if (this.path) holder.attach(this.path, update.view);
    }

    destroy(): void {
      if (this.path) holder.detach(this.path, this.view);
    }
  }

  return [field, ViewPlugin.fromClass(DiagnosticsView)];
}
