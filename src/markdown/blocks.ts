import { quoteString } from "./frontmatter";
import { analyzeFence, parseFenceOpening, type FenceState } from "./fences";
import { convertInlineText, convertProseLine, type InlineState, type ProblemReporter } from "./inline";
import { MappedLineBuilder } from "./lineMap";

export interface BlockConversion {
  end: number;
  lines: MappedLineBuilder[];
}

interface TableCell {
  text: string;
  start: number;
}

interface TableRow {
  cells: TableCell[];
}

interface QuoteEntry {
  text: string;
  offset: number;
  line: number;
}

interface QuotePrefix {
  text: string;
  offset: number;
}

const MAX_QUOTE_NESTING = 32;

export function convertBlock(
  lines: readonly string[],
  line: number,
  state: InlineState,
  reportProblem: (line: number, message: string) => void,
): BlockConversion | undefined {
  const table = readTable(lines, line);
  if (table !== undefined) return renderTable(table, state, reportProblem);

  const first = readQuotePrefix(lines[line]);
  if (first === undefined) return undefined;
  const entries: QuoteEntry[] = [];
  let end = line;
  while (end < lines.length) {
    const prefix = readQuotePrefix(lines[end]);
    if (prefix === undefined) break;
    entries.push({ text: prefix.text, offset: prefix.offset, line: end });
    end += 1;
  }
  return { end, lines: renderQuote(entries, state, reportProblem) };
}

function readTable(lines: readonly string[], start: number): { end: number; header: TableRow; rows: TableRow[] } | undefined {
  const header = parseTableRow(lines[start]);
  if (header === undefined || start + 1 >= lines.length || !isTableDelimiter(lines[start + 1])) return undefined;
  let end = start + 2;
  const rows: TableRow[] = [];
  while (end < lines.length) {
    const row = parseTableRow(lines[end]);
    if (row === undefined) break;
    rows.push(row);
    end += 1;
  }
  return { end, header, rows };
}

function renderTable(
  table: { end: number; header: TableRow; rows: TableRow[] },
  state: InlineState,
  reportProblem: (line: number, message: string) => void,
  sourceLine: (line: number) => number = (line) => line,
): BlockConversion {
  const lines: MappedLineBuilder[] = [];
  const columns = table.header.cells.length;
  const headerLine = table.end - table.rows.length - 2;
  const header = new MappedLineBuilder();
  header.appendInserted(`#std.table(columns: ${columns}, std.table.header(`);
  appendCells(header, table.header.cells, state, (message) => reportProblem(sourceLine(headerLine), message));
  header.appendInserted(")");
  if (table.rows.length === 0) header.appendInserted(")");
  else header.appendInserted(",");
  lines.push(header);
  lines.push(new MappedLineBuilder());

  table.rows.forEach((row, index) => {
    const line = new MappedLineBuilder();
    const rowLine = table.end - table.rows.length + index;
    const normalized = normalizeCells(row, columns, table.header.cells.length, reportProblem, sourceLine(rowLine));
    appendCells(line, normalized, state, (message) => reportProblem(sourceLine(rowLine), message));
    line.appendInserted(index === table.rows.length - 1 ? ")" : ",");
    lines.push(line);
  });
  return { end: table.end, lines };
}

function appendCells(
  builder: MappedLineBuilder,
  cells: readonly TableCell[],
  state: InlineState,
  reportProblem: ProblemReporter | undefined,
): void {
  cells.forEach((cell, index) => {
    if (index > 0) builder.appendInserted(", ");
    builder.appendInserted("[");
    builder.appendBuilder(convertInlineText(cell.text, cell.start, reportProblem, state, { lineStart: true, escapeMarkdownMarkers: true }));
    builder.appendInserted("]");
  });
}

function normalizeCells(
  row: TableRow,
  columns: number,
  headerColumns: number,
  reportProblem: (line: number, message: string) => void,
  line: number,
): TableCell[] {
  if (row.cells.length > columns) {
    reportProblem(line, `Table row has ${row.cells.length} cells, the header has ${headerColumns}`);
    return row.cells.slice(0, columns);
  }
  const cells = row.cells.slice();
  while (cells.length < columns) cells.push({ text: "", start: 0 });
  return cells;
}

function parseTableRow(line: string | undefined): TableRow | undefined {
  if (line === undefined) return undefined;
  let start = 0;
  while (start < line.length && line[start] === " " && start < 3) start += 1;
  if (line[start] !== "|") return undefined;
  const trimmedEnd = line.trimEnd().length;
  const end = line.slice(0, trimmedEnd).endsWith("|") ? trimmedEnd - 1 : trimmedEnd;
  const cells: TableCell[] = [];
  let cellStart = start + 1;
  let index = cellStart;
  while (index < end) {
    if (line[index] === "\\" && line[index + 1] === "|") {
      index += 2;
      continue;
    }
    if (line[index] !== "|") {
      index += 1;
      continue;
    }
    cells.push(makeCell(line, cellStart, index));
    cellStart = index + 1;
    index += 1;
  }
  cells.push(makeCell(line, cellStart, end));
  return { cells };
}

function makeCell(line: string, start: number, end: number): TableCell {
  let text = line.slice(start, end).trim();
  text = text.replaceAll("\\|", "|");
  const leftTrim = line.slice(start, end).length - line.slice(start, end).trimStart().length;
  return { text, start: start + leftTrim };
}

function isTableDelimiter(line: string | undefined): boolean {
  const row = parseTableRow(line);
  return row !== undefined && row.cells.length > 0 && row.cells.every((cell) => /^:?-+:?$/u.test(cell.text));
}

function readQuotePrefix(line: string | undefined): QuotePrefix | undefined {
  if (line === undefined) return undefined;
  let index = 0;
  while (index < line.length && line[index] === " " && index < 3) index += 1;
  if (line[index] !== ">") return undefined;
  index += 1;
  if (line[index] === " " || line[index] === "\t") index += 1;
  return { text: line.slice(index), offset: index };
}

function renderQuote(
  entries: readonly QuoteEntry[],
  state: InlineState,
  reportProblem: (line: number, message: string) => void,
  quoteDepth = 0,
): MappedLineBuilder[] {
  const first = entries[0];
  const callout = /^\[!([^\]]+)\]([+-])?(?:[ \t]+(.*))?$/u.exec(first.text);
  const lines: MappedLineBuilder[] = [];
  const opener = new MappedLineBuilder();
  let bodyEntries: readonly QuoteEntry[];
  if (callout) {
    const kind = callout[1].toLowerCase();
    opener.appendInserted(`#callout(kind: ${quoteString(kind)}, title: `);
    if (callout[3] === undefined || callout[3] === "") {
      opener.appendInserted("none");
    } else {
      opener.appendInserted("[");
      opener.appendBuilder(
        convertInlineText(
          callout[3],
          first.offset + first.text.indexOf(callout[3]),
          (message) => reportProblem(first.line, message),
          state,
          { lineStart: true, escapeMarkdownMarkers: true },
        ),
      );
      opener.appendInserted("]");
    }
    opener.appendInserted(")[");
    bodyEntries = entries.slice(1);
  } else {
    opener.appendInserted("#std.quote(block: true)[");
    bodyEntries = entries;
  }

  const body = renderQuoteBody(bodyEntries, state, reportProblem, quoteDepth);
  if (body.length === 0) {
    opener.appendInserted("]");
    lines.push(opener);
    return lines;
  }
  if (callout) {
    lines.push(opener);
    for (const bodyLine of body) lines.push(bodyLine);
  } else {
    opener.appendBuilder(body[0]);
    lines.push(opener);
    for (let index = 1; index < body.length; index += 1) lines.push(body[index]);
  }
  lines[lines.length - 1].appendInserted("]");
  return lines;
}

function renderQuoteBody(
  entries: readonly QuoteEntry[],
  state: InlineState,
  reportProblem: (line: number, message: string) => void,
  quoteDepth: number,
): MappedLineBuilder[] {
  const lines: MappedLineBuilder[] = [];
  const sourceLines = entries.map((entry) => entry.text);
  let index = 0;
  let fence: FenceState | undefined;
  while (index < entries.length) {
    const entry = entries[index];

    if (state.commentOpen) {
      lines.push(convertProseLine(entry.text, (message) => reportProblem(entry.line, message), entry.offset, state));
      index += 1;
      continue;
    }

    if (fence !== undefined) {
      const builder = new MappedLineBuilder();
      if (fence.closeLine === index) {
        if (fence.kind === "other") builder.appendInserted(`${fence.indentation}${"`".repeat(fence.outputTicks)}`);
        fence = undefined;
      } else {
        const rawText = fence.kind === "typ" && fence.closeLine < 0 && index === entries.length - 1
          ? stripTrailingRawTypstComment(entry.text)
          : entry.text;
        builder.appendSource(rawText, entry.offset);
        if (fence.kind === "other" && fence.closeLine < 0 && index === entries.length - 1) {
          builder.appendInserted(` ${"`".repeat(fence.outputTicks)}`, entry.text.length);
        }
      }
      lines.push(builder);
      index += 1;
      continue;
    }

    const nested = readQuotePrefix(entry.text);
    if (nested !== undefined) {
      if (quoteDepth >= MAX_QUOTE_NESTING) {
        lines.push(convertProseLine(entry.text, (message) => reportProblem(entry.line, message), entry.offset, state));
        index += 1;
        continue;
      }
      const nestedEntries: QuoteEntry[] = [];
      while (index < entries.length) {
        const prefix = readQuotePrefix(entries[index].text);
        if (prefix === undefined) break;
        nestedEntries.push({ text: prefix.text, offset: entries[index].offset + prefix.offset, line: entries[index].line });
        index += 1;
      }
      const nestedLines = renderQuote(nestedEntries, state, reportProblem, quoteDepth + 1);
      for (const nestedLine of nestedLines) lines.push(nestedLine);
      continue;
    }

    const opening = parseFenceOpening(entry.text);
    if (opening !== undefined) {
      fence = analyzeFence(sourceLines, index, opening);
      const builder = new MappedLineBuilder();
      if (opening.kind === "other") {
        builder.appendInserted(`${opening.indentation}${"`".repeat(fence.outputTicks)}${opening.word}`);
        if (fence.closeLine < 0 && index === entries.length - 1) {
          builder.appendInserted(` ${"`".repeat(fence.outputTicks)}`, entry.text.length);
        }
      }
      lines.push(builder);
      index += 1;
      continue;
    }

    if (entry.text.startsWith("/typst")) {
      const builder = new MappedLineBuilder();
      const rawText = index === entries.length - 1 ? stripTrailingRawTypstComment(entry.text.slice(6)) : entry.text.slice(6);
      builder.appendSource(rawText, entry.offset + 6);
      lines.push(builder);
      index += 1;
      continue;
    }

    const table = readTable(sourceLines, index);
    if (table !== undefined) {
      const shifted = shiftTableOffsets(table, entries, index);
      const rendered = renderTable(shifted, state, reportProblem, (line) => entries[index + line]?.line ?? entry.line);
      for (const renderedLine of rendered.lines) lines.push(renderedLine);
      index = table.end;
      continue;
    }

    if (entry.text === "") {
      lines.push(new MappedLineBuilder());
    } else {
      lines.push(convertProseLine(entry.text, (message) => reportProblem(entry.line, message), entry.offset, state));
    }
    index += 1;
  }
  return lines;
}

function stripTrailingRawTypstComment(text: string): string {
  let inString = false;
  let blockCommentDepth = 0;
  let blockCommentStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (blockCommentDepth > 0) {
      if (text.startsWith("/*", index)) {
        blockCommentDepth += 1;
        index += 1;
      } else if (text.startsWith("*/", index)) {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === '"') inString = false;
      continue;
    }
    if (text[index] === '"') {
      inString = true;
      continue;
    }
    if (text.startsWith("//", index)) return text.slice(0, index);
    if (text.startsWith("/*", index)) {
      blockCommentDepth = 1;
      blockCommentStart = index;
      index += 1;
    }
  }
  return blockCommentDepth > 0 && blockCommentStart >= 0 ? text.slice(0, blockCommentStart) : text;
}

function shiftTableOffsets(
  table: { end: number; header: TableRow; rows: TableRow[] },
  entries: readonly QuoteEntry[],
  start: number,
): { end: number; header: TableRow; rows: TableRow[] } {
  const shift = (row: TableRow, line: number): TableRow => ({
    cells: row.cells.map((cell) => ({ ...cell, start: cell.start + (entries[line]?.offset ?? 0) })),
  });
  return {
    end: table.end,
    header: shift(table.header, start),
    rows: table.rows.map((row, index) => shift(row, start + index + 2)),
  };
}
