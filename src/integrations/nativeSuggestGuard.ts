import { patchMethod } from "./exportRedirect";
import { convert } from "../markdown/convert";

interface NativeEditor {
  getCursor(): { line: number; ch: number };
  getLine(line: number): string;
  getValue(): string;
}

interface NativeFile {
  path: string;
}

interface NativeSuggest {
  close(): void;
  trigger(editor: NativeEditor, file: NativeFile | null, open: boolean): unknown;
}

interface NativeSuggestApp {
  workspace?: {
    editorSuggest?: NativeSuggest;
  };
}

export function installNativeSuggestGuard(
  app: unknown,
  isTypstNote: (file: { path: string } | null) => boolean,
): (() => void) | null {
  const suggest = (app as NativeSuggestApp).workspace?.editorSuggest;
  if (!suggest) return null;

  const patch = patchMethod(suggest, "trigger", (original, isActive) =>
    function (this: NativeSuggest, ...args: unknown[]): unknown {
      if (!isActive()) return original.apply(this, args);

      const editor = args[0] as NativeEditor;
      const file = (args[1] as NativeFile | null | undefined) ?? null;
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      if (isTypstNote(file) && cursor.ch >= "/typst".length && line.startsWith("/typst")) {
        const suffix = line.length === "/typst".length ? " #" : "";
        const conversion = convert(
          suffix ? appendToLine(editor.getValue(), cursor.line, suffix) : editor.getValue(),
          null,
        );
        const isTypstLine =
          !conversion.source ||
          (conversion.toTyp(cursor.line, "/typst".length) === 0 &&
            conversion.toTyp(cursor.line, line.length + suffix.length) > 0);
        if (isTypstLine) {
          suggest.close();
          return undefined;
        }
      }
      return original.apply(this, args);
    },
  );
  return patch ? () => patch.restore() : null;
}

function appendToLine(value: string, lineNumber: number, suffix: string): string {
  const lines = value.split("\n");
  if (lineNumber < 0 || lineNumber >= lines.length) return value;
  lines[lineNumber] += suffix;
  return lines.join("\n");
}
