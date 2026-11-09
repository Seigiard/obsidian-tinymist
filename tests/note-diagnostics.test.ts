import assert from "node:assert/strict";
import { test } from "node:test";
import type { LspDiagnostic } from "../src/lsp/client";
import type { Position, TypstSource } from "../src/sources";
import { fileUri } from "./support/virtualAddress";

interface SourceOptions {
  problems?: readonly { line: number; message: string; fatal: boolean }[];
}

function source(options: SourceOptions = {}): TypstSource {
  return {
    file: "Notes/A.md",
    entry: "/vault/.typst-cache/notes/Notes/A.md.typ",
    document: "/vault/.typst-cache/notes/Notes/A.md.typ",
    inputs: undefined,
    pinnable: false,
    exportable: true,
    pdf: "Notes/A.pdf",
    problems: options.problems,
    open: () => ({ close: () => {} }),
    toSource: (position: Position) => ({
      line: position.line,
      character: position.character + 6,
    }),
    toEntry: (position: Position) => position,
    reveal: async () => {},
    describe: String,
    on: () => () => {},
    release: () => {},
  };
}

function diagnostic(severity?: number): LspDiagnostic {
  return {
    range: {
      start: { line: 3, character: 5 },
      end: { line: 3, character: 9 },
    },
    severity,
    message: "unknown variable: name",
  };
}

test("entry diagnostics map both columns back to the Markdown note after converter problems", async () => {
  // #given
  const { noteDiagnostics } = await import("../src/underlines/noteDiagnostics");
  const note = source({
    problems: [
      { line: 1, message: "Property typst is repeated", fatal: false },
      { line: 2, message: "Template is unavailable", fatal: true },
    ],
  });

  // #when
  const result = noteDiagnostics(note, [diagnostic(1)], fileUri(note.entry));

  // #then
  assert.deepEqual(result, [
    {
      from: { line: 1, character: 0 },
      to: { line: 1, character: Number.MAX_SAFE_INTEGER },
      message: "Property typst is repeated",
      severity: "warning",
    },
    {
      from: { line: 2, character: 0 },
      to: { line: 2, character: Number.MAX_SAFE_INTEGER },
      message: "Template is unavailable",
      severity: "error",
    },
    {
      from: { line: 3, character: 11 },
      to: { line: 3, character: 15 },
      message: "unknown variable: name",
      severity: "error",
    },
  ]);
});

test("LSP warning and unspecified severities become warning and info", async () => {
  // #given
  const { noteDiagnostics } = await import("../src/underlines/noteDiagnostics");
  const note = source();
  const warning = diagnostic(2);
  const info = { ...diagnostic(), message: "informational" };

  // #when
  const result = noteDiagnostics(note, [warning, info], fileUri(note.entry));

  // #then
  assert.deepEqual(result.map(({ message, severity }) => ({ message, severity })), [
    { message: "unknown variable: name", severity: "warning" },
    { message: "informational", severity: "info" },
  ]);
});

test("a diagnostics batch for another URI does not decorate the note", async () => {
  // #given
  const { noteDiagnostics } = await import("../src/underlines/noteDiagnostics");
  const note = source();

  // #when
  const result = noteDiagnostics(note, [diagnostic(1)], fileUri("/vault/_typst/kit.typ"));

  // #then
  assert.deepEqual(result, []);
});
