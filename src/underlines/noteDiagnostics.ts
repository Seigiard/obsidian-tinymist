import { pathToUri, type LspDiagnostic } from "../lsp/client";
import type { Position, TypstSource } from "../sources";

export interface NoteDiagnostic {
  from: Position;
  to: Position;
  message: string;
  severity: "error" | "warning" | "info";
}

/** Maps diagnostics for a Markdown source's virtual entry back to note positions. */
export function noteDiagnostics(
  source: TypstSource,
  diagnostics: readonly LspDiagnostic[],
  entryUri: string,
): NoteDiagnostic[] {
  if (entryUri !== pathToUri(source.entry)) return [];

  const problems = (source.problems ?? []).map((problem): NoteDiagnostic => ({
    from: { line: problem.line, character: 0 },
    to: { line: problem.line, character: Number.MAX_SAFE_INTEGER },
    message: problem.message,
    severity: problem.fatal ? "error" : "warning",
  }));
  const mapped = diagnostics.map((diagnostic): NoteDiagnostic => ({
    from: source.toSource(diagnostic.range.start),
    to: source.toSource(diagnostic.range.end),
    message: diagnostic.message,
    severity:
      diagnostic.severity === 1
        ? "error"
        : diagnostic.severity === 2
          ? "warning"
          : "info",
  }));
  return [...problems, ...mapped];
}
