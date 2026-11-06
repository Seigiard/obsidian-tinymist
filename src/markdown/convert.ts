export interface KitView {
  templates: Record<string, string>;
  defaultTemplate: string;
}

export interface Problem {
  line: number;
  message: string;
  fatal: boolean;
}

/** The caller strips BOM and CRLF before this call; lines are zero-based and columns are UTF-16 code units. */
export interface Conversion {
  source: boolean;
  typ: string;
  toMd(line: number, column: number): number;
  toTyp(line: number, column: number): number;
  problems: Problem[];
}

interface LineMap {
  toMd: number[];
  toTyp: number[];
}

interface Piece {
  text: string;
  sourceStart: number;
  sourceLength: number;
  identity: boolean;
}

interface EmphasisRange {
  start: number;
  end: number;
  width: number;
  strong: boolean;
}

const BUILT_INS =
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";
const FORBIDDEN_LINE_BREAKS = new Set(["\r", "\u000b", "\f", "\u0085", "\u2028", "\u2029"]);
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const INVALID_PROPERTY_NAMES = new Set([
  "none",
  "auto",
  "true",
  "false",
  "not",
  "and",
  "or",
  "let",
  "set",
  "show",
  "context",
  "if",
  "else",
  "for",
  "in",
  "while",
  "break",
  "continue",
  "return",
  "import",
  "include",
  "as",
  "_",
]);
const MAX_ARRAY_DEPTH = 32;

class MappedLineBuilder {
  private readonly pieces: Piece[] = [];

  appendSource(text: string, sourceStart: number): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart, sourceLength: text.length, identity: true });
  }

  appendMapped(text: string, sourceStart: number, sourceLength: number): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart, sourceLength, identity: false });
  }

  appendEscaped(character: string, sourceStart: number): void {
    this.appendInserted("\\", sourceStart);
    this.appendSource(character, sourceStart);
  }

  appendInserted(text: string, anchor = 0): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart: anchor, sourceLength: 0, identity: false });
  }

  appendBuilder(builder: MappedLineBuilder): void {
    for (const piece of builder.pieces) this.pieces.push(piece);
  }

  finish(sourceLength: number): { text: string; map: LineMap } {
    const text = this.pieces.map((piece) => piece.text).join("");
    const toMd = new Array<number>(text.length + 1).fill(0);
    const toTyp = new Array<number>(sourceLength + 1).fill(0);
    let outputOffset = 0;

    for (const piece of this.pieces) {
      const outputLength = piece.text.length;
      if (piece.sourceLength === 0) {
        for (let column = 0; column <= outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart;
        }
      } else if (piece.identity && outputLength === piece.sourceLength) {
        for (let column = 0; column <= outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart + column;
          if (piece.sourceStart + column <= sourceLength) {
            toTyp[piece.sourceStart + column] = outputOffset + column;
          }
        }
      } else {
        for (let column = 0; column < outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart;
        }
        toMd[outputOffset + outputLength] = piece.sourceStart + piece.sourceLength;
        for (let column = 0; column < piece.sourceLength; column += 1) {
          if (piece.sourceStart + column <= sourceLength) {
            toTyp[piece.sourceStart + column] = outputOffset;
          }
        }
        if (piece.sourceStart + piece.sourceLength <= sourceLength) {
          toTyp[piece.sourceStart + piece.sourceLength] = outputOffset + outputLength;
        }
      }
      outputOffset += outputLength;
    }

    return { text, map: { toMd, toTyp } };
  }
}

export function convert(text: string, kit: KitView | null): Conversion {
  const input = typeof text === "string" ? text : String(text ?? "");
  const lines = input.split("\n");
  const frontmatterEnd = findFrontmatterEnd(lines);

  if (frontmatterEnd < 0 || !hasSourceFlag(lines, frontmatterEnd)) {
    return emptyConversion();
  }

  const problems: Problem[] = [];
  const outputLines: string[] = [];
  const maps: LineMap[] = [];
  const template = selectTemplate(lines, frontmatterEnd, kit, problems);

  addGeneratedLine(
    outputLines,
    maps,
    `${BUILT_INS}${template.path === undefined ? "" : `#import ${quoteString(template.path)}: *; `}#show: template.with(`,
    lines[0].length,
  );

  let continuation = false;
  for (let line = 1; line < frontmatterEnd; line += 1) {
    const sourceLine = lines[line];
    let output = "";
    if (continuation && isIndentedNonBlank(sourceLine)) {
      continuation = true;
    } else {
      continuation = false;
      const property = parseProperty(sourceLine);
      if (property) {
        const hasContinuation = isIndentedNonBlank(lines[line + 1] ?? "");
        const multiline = isBlockValue(property.value) || hasContinuation;
        continuation = hasContinuation;
        if (!PROPERTY_NAME.test(property.name) || INVALID_PROPERTY_NAMES.has(property.name)) {
          addProblem(problems, line, `Property name ${property.name || "<empty>"} is not a Typst identifier`, false);
        } else if (property.name !== "template" && property.name !== "") {
          const literal = parseValue(property.value);
          if (literal === undefined || multiline) {
            addProblem(problems, line, `Property ${property.name} has no scalar value`, false);
          } else {
            output = `${property.name}: ${literal},`;
          }
        } else if (multiline) {
          addProblem(problems, line, `Property ${property.name} has no scalar value`, false);
        }
        if (multiline) output = "";
      }
    }
    addGeneratedLine(outputLines, maps, sanitizeLine(output), sourceLine.length);
  }

  addGeneratedLine(outputLines, maps, ")", lines[frontmatterEnd].length);

  let fence: FenceState | undefined;
  for (let line = frontmatterEnd + 1; line < lines.length; line += 1) {
    const sourceLine = lines[line];
    const builder = new MappedLineBuilder();

    if (fence) {
      if (fence.closeLine === line) {
        if (fence.kind === "other") {
          builder.appendInserted(`${fence.indentation}${"`".repeat(fence.outputTicks)}`);
        }
        fence = undefined;
      } else {
        appendNormalized(builder, sourceLine, 0);
        if (fence.kind === "typ" && hasForbiddenLineBreak(sourceLine)) {
          addProblem(problems, line, "Typst code contains a line-break character", true);
        }
        if (fence.kind === "other" && fence.closeLine < 0 && line === lines.length - 1) {
          builder.appendInserted(`${line === fence.openingLine ? " " : ""}${"`".repeat(fence.outputTicks)}`);
        }
      }
    } else {
      const opening = parseFenceOpening(sourceLine);
      if (opening) {
        const analysis = analyzeFence(lines, line, opening);
        fence = analysis;
        if (opening.kind === "other") {
          builder.appendInserted(`${opening.indentation}${"`".repeat(analysis.outputTicks)}${opening.word}`);
          if (analysis.closeLine < 0 && line === lines.length - 1) {
            builder.appendInserted(` ${"`".repeat(analysis.outputTicks)}`);
          }
        }
      } else if (sourceLine.startsWith("/typst")) {
        const code = sourceLine.slice(6);
        appendNormalized(builder, code, 6);
        if (hasForbiddenLineBreak(sourceLine)) {
          addProblem(problems, line, "Typst code contains a line-break character", true);
        }
      } else {
        builder.appendBuilder(convertProseLine(sourceLine));
      }
    }

    const result = builder.finish(sourceLine.length);
    outputLines.push(result.text);
    maps.push(result.map);
  }

  problems.sort((left, right) => left.line - right.line);

  return {
    source: true,
    typ: outputLines.map(sanitizeLine).join("\n"),
    toMd(line, column) {
      if (line < 0 || line >= maps.length || column < 0 || column >= maps[line].toMd.length) return column;
      return maps[line].toMd[column];
    },
    toTyp(line, column) {
      if (line < 0 || line >= maps.length || column < 0 || column >= maps[line].toTyp.length) return column;
      return maps[line].toTyp[column];
    },
    problems,
  };
}

interface FenceOpening {
  indentation: string;
  ticks: number;
  kind: "typ" | "other";
  word: string;
}

interface FenceState {
  openingLine: number;
  closeLine: number;
  indentation: string;
  outputTicks: number;
  kind: "typ" | "other";
}

function parseFenceOpening(line: string): FenceOpening | undefined {
  let index = 0;
  while (index < line.length && line[index] === " " && index < 3) index += 1;
  const indentation = line.slice(0, index);
  if (line[index] !== "`") return undefined;
  const tickStart = index;
  while (index < line.length && line[index] === "`") index += 1;
  const ticks = index - tickStart;
  if (ticks < 3) return undefined;
  const info = line.slice(index);
  if (info.includes("`")) return undefined;
  const trimmed = info.trim();
  if (trimmed === "typ") return { indentation, ticks, kind: "typ", word: "" };
  const firstWord = trimmed.split(/\s+/u, 1)[0] ?? "";
  const word = /^[A-Za-z0-9_+.#-]+$/u.test(firstWord) ? firstWord : "";
  return { indentation, ticks, kind: "other", word };
}

function isFenceClose(line: string, minimumTicks: number): boolean {
  let index = 0;
  while (index < line.length && line[index] === " " && index < 3) index += 1;
  if (line[index] !== "`") return false;
  const start = index;
  while (index < line.length && line[index] === "`") index += 1;
  if (index - start < minimumTicks) return false;
  return /^[ \t]*$/u.test(line.slice(index));
}

function longestBacktickRun(line: string): number {
  let longest = 0;
  let run = 0;
  for (const character of line) {
    if (character === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

function analyzeFence(lines: readonly string[], openingLine: number, opening: FenceOpening): FenceState {
  let closeLine = -1;
  for (let line = openingLine + 1; line < lines.length; line += 1) {
    if (isFenceClose(lines[line], opening.ticks)) {
      closeLine = line;
      break;
    }
  }
  const contentEnd = closeLine < 0 ? lines.length : closeLine;
  let longest = 0;
  for (let line = openingLine + 1; line < contentEnd; line += 1) {
    longest = Math.max(longest, longestBacktickRun(lines[line]));
  }
  return {
    openingLine,
    closeLine,
    indentation: opening.indentation,
    outputTicks: Math.max(3, longest + 1),
    kind: opening.kind,
  };
}

function emptyConversion(): Conversion {
  return {
    source: false,
    typ: "",
    toMd: (_line, column) => column,
    toTyp: (_line, column) => column,
    problems: [],
  };
}

function findFrontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return -1;
  for (let line = 1; line < lines.length; line += 1) {
    if (lines[line] === "---") return line;
  }
  return -1;
}

function hasSourceFlag(lines: readonly string[], end: number): boolean {
  return lines.slice(1, end).some((line) => /^typst:[ \t]*true[ \t]*$/u.test(line));
}

function addGeneratedLine(output: string[], maps: LineMap[], line: string, sourceLength: number): void {
  const builder = new MappedLineBuilder();
  builder.appendInserted(line);
  const result = builder.finish(sourceLength);
  output.push(result.text);
  maps.push(result.map);
}

function addProblem(problems: Problem[], line: number, message: string, fatal: boolean): void {
  problems.push({ line, message, fatal });
}

function selectTemplate(
  lines: readonly string[],
  end: number,
  kit: KitView | null,
  problems: Problem[],
): { path: string | undefined } {
  let explicit: { line: number; id: string } | undefined;
  for (let line = 1; line < end; line += 1) {
    const property = parseProperty(lines[line]);
    if (property?.name === "template" && !explicit) {
      explicit = { line, id: unquoteTemplateId(property.value.trim()) };
    }
  }

  if (explicit) {
    const path = lookupTemplate(kit, explicit.id);
    if (path === undefined) {
      addProblem(problems, explicit.line, `Unknown Typst template ${explicit.id || "<empty>"}`, true);
    }
    return { path };
  }

  const defaultTemplate = kit && typeof kit.defaultTemplate === "string" ? kit.defaultTemplate.trim() : "";
  if (defaultTemplate === "") return { path: undefined };
  const path = lookupTemplate(kit, defaultTemplate);
  if (path === undefined) {
    addProblem(problems, 0, `Unknown default Typst template ${defaultTemplate}`, true);
  }
  return { path };
}

function lookupTemplate(kit: KitView | null, id: string): string | undefined {
  if (!kit || !kit.templates || typeof kit.templates !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(kit.templates, id)) return undefined;
  const path = kit.templates[id];
  return typeof path === "string" ? path : undefined;
}

function parseProperty(line: string): { name: string; value: string } | undefined {
  const match = /^typst-([^:]*):[ \t]*(.*)$/u.exec(sanitizeLine(line));
  return match ? { name: match[1], value: match[2] } : undefined;
}

function isIndentedNonBlank(line: string): boolean {
  return /^[ \t]+\S/u.test(line);
}

function unquoteTemplateId(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseValue(value: string, depth = 0): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || isBlockValue(trimmed)) return undefined;
  if (trimmed === "true" || trimmed === "false" || NUMBER.test(trimmed)) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    if (flowArrayDepth(trimmed) > MAX_ARRAY_DEPTH) return undefined;
    const array = parseArray(trimmed, depth);
    if (array !== undefined) return array;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return quoteString(trimmed.slice(1, -1));
  }
  return quoteString(trimmed);
}

function isBlockValue(value: string): boolean {
  return /^[|>](?:[+-]?[0-9]?|[0-9]?[+-]?)[ \t]*$/u.test(value);
}

function parseArray(value: string, depth: number): string | undefined {
  if (depth >= MAX_ARRAY_DEPTH) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === "") return "()";
  const items = splitArrayItems(inner);
  if (!items) return undefined;
  const literals: string[] = [];
  for (const item of items) {
    const literal = parseValue(item, depth + 1);
    if (literal === undefined) return undefined;
    literals.push(literal);
  }
  return `(${literals.join(", ")},)`;
}

function flowArrayDepth(value: string): number {
  let depth = 0;
  let longest = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
      longest = Math.max(longest, depth);
    } else if (character === "]") {
      depth -= 1;
    }
  }
  return longest;
}

function splitArrayItems(value: string): string[] | undefined {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (character === "," && depth === 0) {
      const item = value.slice(start, index).trim();
      if (item === "") return undefined;
      items.push(item);
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return undefined;
  const last = value.slice(start).trim();
  if (last !== "") items.push(last);
  return items.length === 0 ? undefined : items;
}

function quoteString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sanitizeLine(line: string): string {
  let result = "";
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (!isForbiddenLineBreak(line[index])) continue;
    result += line.slice(start, index);
    result += " ";
    start = index + 1;
  }
  return start === 0 ? line : result + line.slice(start);
}

function appendNormalized(builder: MappedLineBuilder, text: string, sourceStart: number): void {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isForbiddenLineBreak(text[index])) continue;
    if (index > start) builder.appendSource(text.slice(start, index), sourceStart + start);
    builder.appendMapped(" ", sourceStart + index, 1);
    start = index + 1;
  }
  if (start < text.length) builder.appendSource(text.slice(start), sourceStart + start);
}

function isForbiddenLineBreak(character: string): boolean {
  return FORBIDDEN_LINE_BREAKS.has(character);
}

function hasForbiddenLineBreak(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isForbiddenLineBreak(text[index])) return true;
  }
  return false;
}

function convertProseLine(line: string): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const normalized = sanitizeLine(line);
  const heading = /^(#+)([ \t]+)(.*)$/u.exec(normalized);
  if (heading) {
    builder.appendMapped("=".repeat(heading[1].length), 0, heading[1].length);
    builder.appendSource(heading[2], heading[1].length);
    builder.appendBuilder(convertInline(line.slice(heading[1].length + heading[2].length), heading[1].length + heading[2].length, true));
    return builder;
  }

  const unordered = /^([ \t]*)([-*+])([ \t]+)(.*)$/u.exec(normalized);
  if (unordered) {
    const markerStart = unordered[1].length;
    builder.appendSource(unordered[1], 0);
    builder.appendMapped("-", markerStart, 1);
    builder.appendSource(unordered[3], markerStart + 1);
    builder.appendBuilder(convertInline(line.slice(markerStart + 1 + unordered[3].length), markerStart + 1 + unordered[3].length, true));
    return builder;
  }

  const ordered = /^([ \t]*)(\d+\.)([ \t]+)(.*)$/u.exec(normalized);
  if (ordered) {
    const contentStart = ordered[1].length + ordered[2].length + ordered[3].length;
    builder.appendSource(ordered[1], 0);
    builder.appendSource(ordered[2], ordered[1].length);
    builder.appendSource(ordered[3], ordered[1].length + ordered[2].length);
    builder.appendBuilder(convertInline(line.slice(contentStart), contentStart, true));
    return builder;
  }

  const indentation = /^[ \t]*/u.exec(line)?.[0] ?? "";
  builder.appendSource(indentation, 0);
  builder.appendBuilder(convertInline(line.slice(indentation.length), indentation.length, true));
  return builder;
}

interface CodeRange {
  start: number;
  end: number;
  width: number;
}

interface UrlRange {
  start: number;
  end: number;
}

function convertInline(text: string, sourceOffset: number, lineStart = false): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const codeRanges = findCodeRanges(text);
  const urls = findUrls(text, codeRanges);
  const emphasis = findEmphasisRanges(text, codeRanges);
  let index = 0;

  while (index < text.length) {
    const code = codeRanges.find((range) => range.start === index);
    if (code) {
      if (code.width === 1) {
        appendNormalized(builder, text.slice(code.start, code.end), sourceOffset + code.start);
      } else {
        let content = text.slice(code.start + code.width, code.end - code.width);
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/u.test(content)) {
          content = content.slice(1, -1);
        }
        content = sanitizeLine(content);
        builder.appendMapped(`#std.raw(${quoteString(content)});`, sourceOffset + code.start, code.end - code.start);
      }
      index = code.end;
      continue;
    }

    const url = urls.find((range) => range.start === index);
    if (url) {
      builder.appendMapped(`#std.link(${quoteString(text.slice(url.start, url.end))});`, sourceOffset + url.start, url.end - url.start);
      index = url.end;
      continue;
    }

    const mark = emphasis.find((range) => range.start === index);
    if (mark) {
      const marker = mark.strong ? "*" : "_";
      builder.appendMapped(marker, sourceOffset + mark.start, mark.width);
      builder.appendBuilder(convertInline(text.slice(mark.start + mark.width, mark.end - mark.width), sourceOffset + mark.start + mark.width));
      builder.appendMapped(marker, sourceOffset + mark.end - mark.width, mark.width);
      index = mark.end;
      continue;
    }

    const width = codePointWidth(text, index);
    const character = text.slice(index, index + width);
    if (character === "\\") {
      const next = text[index + 1];
      if (next && isMarkdownEscapeTarget(next)) {
        builder.appendSource(text.slice(index, index + 2), sourceOffset + index);
        index += 2;
      } else {
        builder.appendMapped("\\\\", sourceOffset + index, 1);
        index += 1;
      }
      continue;
    }

    if (character === "/" && (text[index + 1] === "/" || text[index + 1] === "*" || isEmphasisMarkerAt(emphasis, index - 1) || isEmphasisMarkerAt(emphasis, index + 1))) {
      builder.appendEscaped(character, sourceOffset + index);
      index += 1;
      continue;
    }

    if (isForbiddenLineBreak(character)) {
      builder.appendMapped(" ", sourceOffset + index, width);
      index += width;
      continue;
    }

    if (character === "#" || character === "$" || character === "@" || character === "<" || character === "~" || character === "[" || character === "]" || character === "`" || character === "*" || character === "_") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (lineStart && index === 0 && (character === "=" || (character === "/" && text[index + 1] === " "))) {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    builder.appendSource(character, sourceOffset + index);
    index += width;
  }

  return builder;
}

function isEmphasisMarkerAt(ranges: EmphasisRange[], index: number): boolean {
  return ranges.some(
    (range) =>
      (index >= range.start && index < range.start + range.width) ||
      (index >= range.end - range.width && index < range.end),
  );
}

function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`" || isEscaped(text, index)) {
      index += codePointWidth(text, index);
      continue;
    }
    let width = 1;
    while (text[index + width] === "`") width += 1;
    const start = index;
    let close = index + width;
    let end = -1;
    while (close < text.length) {
      if (text[close] !== "`") {
        close += 1;
        continue;
      }
      const runStart = close;
      while (close < text.length && text[close] === "`") close += 1;
      if (close - runStart === width) {
        end = close;
        break;
      }
    }
    if (end >= 0) {
      ranges.push({ start, end, width });
      index = end;
    } else {
      index = start + width;
    }
  }
  return ranges;
}

function findUrls(text: string, codeRanges: CodeRange[]): UrlRange[] {
  const ranges: UrlRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (codeRanges.some((range) => index >= range.start && index < range.end)) {
      const code = codeRanges.find((range) => index >= range.start && index < range.end);
      index = code?.end ?? index + 1;
      continue;
    }
    const scheme = text.startsWith("https://", index) ? "https://" : text.startsWith("http://", index) ? "http://" : "";
    if (scheme === "") {
      index += codePointWidth(text, index);
      continue;
    }
    let end = index + scheme.length;
    while (end < text.length && !/[\s<]/u.test(text[end])) end += 1;
    while (end > index + scheme.length && ".,:;!?'\"*_~)".includes(text[end - 1])) {
      if (text[end - 1] === ")" && text.slice(index, end).includes("(")) break;
      end -= 1;
    }
    if (end > index + scheme.length) {
      ranges.push({ start: index, end });
      index = end;
    } else {
      index += scheme.length;
    }
  }
  return ranges;
}

function findEmphasisRanges(text: string, codeRanges: Array<{ start: number; end: number }>): EmphasisRange[] {
  const ranges: EmphasisRange[] = [];
  let index = 0;
  while (index < text.length) {
    const code = codeRanges.find((range) => index >= range.start && index < range.end);
    if (code) {
      index = code.end;
      continue;
    }
    if ((text[index] !== "*" && text[index] !== "_") || isEscaped(text, index)) {
      index += codePointWidth(text, index);
      continue;
    }

    const marker = text[index];
    const strong = text[index + 1] === marker;
    const width = strong ? 2 : 1;
    if (!canOpen(text, index, width)) {
      index += width;
      continue;
    }
    const close = findClosingDelimiter(text, index + width, marker, width, codeRanges);
    if (close < 0) {
      index += width;
      continue;
    }
    ranges.push({ start: index, end: close + width, width, strong });
    index = close + width;
  }
  return ranges;
}

function findClosingDelimiter(
  text: string,
  start: number,
  marker: string,
  width: number,
  codeRanges: Array<{ start: number; end: number }>,
): number {
  for (let index = start; index <= text.length - width; index += 1) {
    const code = codeRanges.find((range) => index >= range.start && index < range.end);
    if (code) {
      index = code.end - 1;
      continue;
    }
    if (text[index] !== marker || !text.startsWith(marker.repeat(width), index) || isEscaped(text, index)) continue;
    if (canClose(text, index, width)) return index;
  }
  return -1;
}

function canOpen(text: string, index: number, width: number): boolean {
  const next = characterAt(text, index + width);
  const previous = index > 0 ? characterAt(text, index - codePointWidthBefore(text, index)) : "";
  if (!next || /\s/u.test(next)) return false;
  return !(isWord(previous) && isWord(next));
}

function canClose(text: string, index: number, width: number): boolean {
  const previousIndex = index > 0 ? index - codePointWidthBefore(text, index) : -1;
  const previous = previousIndex >= 0 ? characterAt(text, previousIndex) : "";
  const next = index + width < text.length ? characterAt(text, index + width) : "";
  if (!previous || /\s/u.test(previous)) return false;
  return !(isWord(previous) && isWord(next));
}

function characterAt(text: string, index: number): string {
  return index >= 0 && index < text.length ? String.fromCodePoint(text.codePointAt(index) ?? 0) : "";
}

function codePointWidthBefore(text: string, index: number): number {
  if (index >= 2 && (text.charCodeAt(index - 2) & 0xfc00) === 0xd800 && (text.charCodeAt(index - 1) & 0xfc00) === 0xdc00) return 2;
  return 1;
}

function codePointWidth(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function isWord(character: string): boolean {
  return character !== "" && /[\p{L}\p{N}]/u.test(character) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isMarkdownEscapeTarget(character: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(character);
}
