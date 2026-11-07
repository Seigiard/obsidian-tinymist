/** The kit templates available to the markdown converter. */
export interface KitView {
  templates: Record<string, string>;
  defaultTemplate: string;
}

/** A conversion diagnostic; fatal problems make the generated Typst unsafe to compile. */
export interface Problem {
  line: number;
  message: string;
  fatal: boolean;
}

/** The converted note and zero-based UTF-16 line/column maps; a false source is not a print source, has empty typ, and both maps return their input column. */
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
  mapToStart: boolean;
}

interface EmphasisRange {
  start: number;
  end: number;
  width: number;
  strong: boolean;
}

interface FenceOpening {
  indentation: string;
  ticks: number;
  kind: "typ" | "other";
  word: string;
}

interface FenceState {
  closeLine: number;
  indentation: string;
  outputTicks: number;
  kind: "typ" | "other";
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

interface InlineOptions {
  lineStart?: boolean;
}

interface FrontmatterEntry {
  line: number;
  name?: string;
  value?: string;
  multiline: boolean;
}

const BUILT_INS =
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";
const FORBIDDEN_LINE_BREAKS = new Set(["\r", "\u000b", "\f", "\u0085", "\u2028", "\u2029"]);
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const FENCE_WORD = /^[\p{XID_Start}_][\p{XID_Continue}_-]*$/u;
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
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
    this.pieces.push({ text, sourceStart, sourceLength: text.length, identity: true, mapToStart: false });
  }

  appendMapped(text: string, sourceStart: number, sourceLength: number): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart, sourceLength, identity: false, mapToStart: false });
  }

  appendEscaped(character: string, sourceStart: number): void {
    this.appendInserted("\\", sourceStart);
    this.appendSource(character, sourceStart);
  }

  appendInserted(text: string, anchor = 0): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart: anchor, sourceLength: 0, identity: false, mapToStart: false });
  }

  appendMappedToStart(text: string, sourceStart: number, sourceLength: number): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart, sourceLength, identity: false, mapToStart: true });
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
      } else if (piece.mapToStart) {
        for (let column = 0; column <= outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart;
        }
        for (let column = 0; column < piece.sourceLength; column += 1) {
          toTyp[piece.sourceStart + column] = outputOffset;
        }
        toTyp[piece.sourceStart + piece.sourceLength] = outputOffset + outputLength;
      } else if (piece.identity) {
        for (let column = 0; column <= outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart + column;
          toTyp[piece.sourceStart + column] = outputOffset + column;
        }
      } else {
        for (let column = 0; column < outputLength; column += 1) {
          toMd[outputOffset + column] = piece.sourceStart;
        }
        toMd[outputOffset + outputLength] = piece.sourceStart + piece.sourceLength;
        for (let column = 0; column < piece.sourceLength; column += 1) {
          toTyp[piece.sourceStart + column] = outputOffset;
        }
        toTyp[piece.sourceStart + piece.sourceLength] = outputOffset + outputLength;
      }
      outputOffset += outputLength;
    }

    return { text, map: { toMd, toTyp } };
  }
}

/** The caller strips BOM and CRLF before this call; lines are zero-based and columns are UTF-16 code units. */
export function convert(text: string, kit: KitView | null): Conversion {
  const input = typeof text === "string" ? text : String(text ?? "");
  const rawLines = input.split("\n");
  const lines = rawLines.map(sanitizeLine);
  const frontmatterEnd = findFrontmatterEnd(lines);

  if (frontmatterEnd < 0 || !hasSourceFlag(lines, frontmatterEnd)) {
    return emptyConversion();
  }

  const problems: Problem[] = [];
  const outputLines: string[] = [];
  const maps: LineMap[] = [];
  const frontmatter = readFrontmatter(lines, frontmatterEnd);
  const template = selectTemplate(frontmatter, kit, problems);

  addGeneratedLine(
    outputLines,
    maps,
    `${BUILT_INS}${template.path === undefined ? "" : `#import ${quoteString(template.path)}: *; `}#show: template.with(`,
    lines[0].length,
  );

  for (const entry of frontmatter) {
    const sourceLine = lines[entry.line];
    let output = "";
    if (entry.name !== undefined) {
      if (!PROPERTY_NAME.test(entry.name) || INVALID_PROPERTY_NAMES.has(entry.name)) {
        addProblem(problems, entry.line, `Property name ${entry.name || "<empty>"} is not a Typst identifier`, false);
      } else if (entry.name !== "template") {
        const parsed = entry.multiline ? { failure: "multiline" as const } : parseValue(entry.value ?? "");
        if ("failure" in parsed) {
          addProblem(problems, entry.line, propertyFailureMessage(entry.name, parsed), false);
        } else {
          output = `${entry.name}: ${parsed.literal},`;
        }
      } else if (entry.multiline) {
        addProblem(problems, entry.line, propertyFailureMessage(entry.name, { failure: "multiline" }), false);
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
        if (fence.kind === "typ" && hasForbiddenLineBreak(rawLines[line])) {
          addProblem(problems, line, "Typst code contains a line-break character", true);
        }
        if (fence.kind === "other" && fence.closeLine < 0 && line === lines.length - 1) {
          builder.appendInserted(`${sourceLine.endsWith("`") ? " " : ""}${"`".repeat(fence.outputTicks)}`);
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
        if (hasForbiddenLineBreak(rawLines[line])) {
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
    typ: outputLines.join("\n"),
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
  const word = FENCE_WORD.test(firstWord) ? firstWord : "";
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
  return lines.slice(1, end).some((line) => {
    const match = /^typst:[ \t]*(.*)$/u.exec(line);
    return match !== null && stripYamlComment(match[1]).trim() === "true";
  });
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

function readFrontmatter(lines: readonly string[], end: number): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (let line = 1; line < end; line += 1) {
    const property = parseProperty(lines[line]);
    entries.push(
      property
        ? {
            line,
            name: property.name,
            value: property.value,
            multiline: isBlockValue(property.value) || isIndentedNonBlank(lines[line + 1] ?? ""),
          }
        : { line, multiline: false },
    );
  }
  return entries;
}

function selectTemplate(
  entries: readonly FrontmatterEntry[],
  kit: KitView | null,
  problems: Problem[],
): { path: string | undefined } {
  let explicit: { line: number; id: string } | undefined;
  for (const entry of entries) {
    if (entry.name === "template" && !entry.multiline && !explicit) {
      explicit = { line: entry.line, id: unquoteTemplateId((entry.value ?? "").trim()) };
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
  const match = /^typst-([^:]*):[ \t]*(.*)$/u.exec(line);
  return match ? { name: match[1], value: stripYamlComment(match[2]) } : undefined;
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

type ValueFailure = "empty" | "multiline" | "malformed" | "deep" | "escape";

type ValueResult = { literal: string } | { failure: ValueFailure; escape?: string };

function propertyFailureMessage(name: string, result: { failure: ValueFailure; escape?: string }): string {
  switch (result.failure) {
    case "empty":
      return `Property ${name} has no value`;
    case "multiline":
      return `Property ${name} has a multi-line value`;
    case "malformed":
      return `Property ${name} has a malformed list`;
    case "deep":
      return `Property ${name} nests lists deeper than ${MAX_ARRAY_DEPTH} levels`;
    case "escape":
      return `Property ${name} has an unknown escape ${result.escape ?? "\\"}`;
  }
}

function parseValue(value: string, depth = 0): ValueResult {
  const trimmed = value.trim();
  if (trimmed === "") return { failure: "empty" };
  if (isBlockValue(trimmed)) return { failure: "multiline" };
  if (trimmed === "true" || trimmed === "false" || NUMBER.test(trimmed)) return { literal: trimmed };
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseArray(trimmed, depth);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const decoded = decodeDoubleQuoted(trimmed.slice(1, -1));
    return decoded.failure === undefined
      ? { literal: quoteString(decoded.value) }
      : { failure: "escape", escape: decoded.failure };
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return { literal: quoteString(trimmed.slice(1, -1).replaceAll("''", "'")) };
  }
  return { literal: quoteString(trimmed) };
}

function isBlockValue(value: string): boolean {
  return /^[|>](?:[+-]?[0-9]?|[0-9]?[+-]?)[ \t]*$/u.test(value);
}

function parseArray(value: string, depth: number): ValueResult {
  if (depth >= MAX_ARRAY_DEPTH) return { failure: "deep" };
  const inner = value.slice(1, -1).trim();
  if (inner === "") return { literal: "()" };
  const items = splitArrayItems(inner);
  if (!items) return { failure: "malformed" };
  const literals: string[] = [];
  for (const item of items) {
    const parsed = parseValue(item, depth + 1);
    if ("failure" in parsed) {
      return parsed.failure === "deep" || parsed.failure === "escape" ? parsed : { failure: "malformed" };
    }
    literals.push(parsed.literal);
  }
  return { literal: `(${literals.join(", ")},)` };
}

function splitArrayItems(value: string): string[] | undefined {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let quoteAllowed = true;
  let afterQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === "'" && character === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
        afterQuote = true;
      }
    } else if (character === "[") {
      if (afterQuote) return undefined;
      depth += 1;
      quoteAllowed = true;
    } else if (character === "]") {
      depth -= 1;
      if (depth < 0) return undefined;
      if (afterQuote) afterQuote = false;
      quoteAllowed = false;
    } else if (character === "," && depth === 0) {
      const item = value.slice(start, index).trim();
      if (item === "") return undefined;
      items.push(item);
      start = index + 1;
      quoteAllowed = true;
      afterQuote = false;
    } else if (afterQuote) {
      if (!/\s/u.test(character)) return undefined;
    } else if ((character === '"' || character === "'") && quoteAllowed) {
      quote = character;
      quoteAllowed = false;
    } else if (!/\s/u.test(character)) {
      quoteAllowed = false;
    }
  }
  if (quote || depth !== 0) return undefined;
  const last = value.slice(start).trim();
  if (last !== "") items.push(last);
  return items.length === 0 ? undefined : items;
}

function quoteString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\0", "\\0")}"`;
}

function decodeDoubleQuoted(value: string): { value: string; failure?: string } {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape === undefined) return { value: result, failure: "\\" };
    const simple = new Map([
      ["\\", "\\"],
      ['"', '"'],
      ["'", "'"],
      ["/", "/"],
      ["n", "\n"],
      ["t", "\t"],
      ["r", "\r"],
      ["0", "\0"],
      [" ", " "],
    ]).get(escape);
    if (simple !== undefined) {
      result += simple;
      index += 1;
      continue;
    }
    const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (width > 0) {
      const digits = value.slice(index + 2, index + 2 + width);
      if (digits.length === width && new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(digits)) {
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        index += width + 1;
        continue;
      }
    }
    return { value: result, failure: `\\${escape}` };
  }
  return { value: result };
}

function stripYamlComment(value: string): string {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let quoteAllowed = true;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === "'" && character === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if ((character === '"' || character === "'") && quoteAllowed) {
      quote = character;
      quoteAllowed = false;
      continue;
    }
    if (character === "[") {
      depth += 1;
      quoteAllowed = true;
      continue;
    }
    if (character === "]") {
      depth = Math.max(0, depth - 1);
      quoteAllowed = false;
      continue;
    }
    if (character === "," && depth > 0) {
      quoteAllowed = true;
      continue;
    }
    if (character === "#" && index > 0 && (value[index - 1] === " " || value[index - 1] === "\t")) return value.slice(0, index).trimEnd();
    if (!/\s/u.test(character)) quoteAllowed = false;
  }
  return value.trimEnd();
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
    builder.appendBuilder(
      convertInline(normalized.slice(heading[1].length + heading[2].length), heading[1].length + heading[2].length, { lineStart: true }),
    );
    return builder;
  }

  const unordered = /^([ \t]*)([-*+])([ \t]+)(.*)$/u.exec(normalized);
  if (unordered) {
    const markerStart = unordered[1].length;
    builder.appendSource(unordered[1], 0);
    builder.appendMapped("-", markerStart, 1);
    builder.appendSource(unordered[3], markerStart + 1);
    builder.appendBuilder(
      convertInline(normalized.slice(markerStart + 1 + unordered[3].length), markerStart + 1 + unordered[3].length, { lineStart: true }),
    );
    return builder;
  }

  const ordered = /^([ \t]*)(\d+\.)([ \t]+)(.*)$/u.exec(normalized);
  if (ordered) {
    const contentStart = ordered[1].length + ordered[2].length + ordered[3].length;
    builder.appendSource(ordered[1], 0);
    builder.appendSource(ordered[2], ordered[1].length);
    builder.appendSource(ordered[3], ordered[1].length + ordered[2].length);
    builder.appendBuilder(convertInline(normalized.slice(contentStart), contentStart, { lineStart: true }));
    return builder;
  }

  const indentationLength = leadingIndentLength(normalized);
  appendNormalized(builder, normalized.slice(0, indentationLength), 0);
  builder.appendBuilder(convertInline(normalized.slice(indentationLength), indentationLength, { lineStart: true }));
  return builder;
}

function convertInline(
  text: string,
  sourceOffset: number,
  options: InlineOptions = {},
): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const codeRanges = findCodeRanges(text);
  const urls = findUrls(text, codeRanges);
  const emphasis = findEmphasisRanges(text, codeRanges, urls);
  const codeByStart = new Map(codeRanges.map((range) => [range.start, range]));
  const urlByStart = new Map(urls.map((range) => [range.start, range]));
  const emphasisByStart = new Map(emphasis.map((range) => [range.start, range]));
  const lineStartIndex = options.lineStart ? leadingIndentLength(text) : -1;
  let index = 0;

  while (index < text.length) {
    const code = codeByStart.get(index);
    if (code) {
      let content = text.slice(code.start + code.width, code.end - code.width);
      if (code.width === 1 && !content.includes("`")) {
        appendNormalized(builder, text.slice(code.start, code.end), sourceOffset + code.start);
      } else {
        const rawContentStart = code.start + code.width;
        const rawContentEnd = code.end - code.width;
        let contentStart = rawContentStart;
        let contentEnd = rawContentEnd;
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/u.test(content)) {
          content = content.slice(1, -1);
          contentStart += 1;
          contentEnd -= 1;
        }
        appendGeneratedLiteral(
          builder,
          "#std.raw(\"",
          content,
          "\");",
          sourceOffset + code.start,
          sourceOffset + contentStart,
          sourceOffset + code.end,
        );
      }
      index = code.end;
      continue;
    }

    const url = urlByStart.get(index);
    if (url) {
      appendGeneratedLiteral(builder, "#std.link(\"", text.slice(url.start, url.end), "\");", sourceOffset + url.start, sourceOffset + url.start, sourceOffset + url.end);
      index = url.end;
      continue;
    }

    const mark = emphasisByStart.get(index);
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
        builder.appendEscaped("\\", sourceOffset + index);
        index += 1;
      }
      continue;
    }

    if (character === "/") {
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

    if (character === "-" && text[index + width] === "?") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (
      options.lineStart &&
      index === lineStartIndex &&
      (character === "=" || (character === "+" && (!text[index + width] || /\s/u.test(text[index + width]))))
    ) {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    builder.appendSource(character, sourceOffset + index);
    index += width;
  }

  return builder;
}

function appendGeneratedLiteral(
  builder: MappedLineBuilder,
  prefix: string,
  content: string,
  suffix: string,
  sourceStart: number,
  contentStart: number,
  sourceEnd: number,
): void {
  builder.appendMappedToStart(prefix, sourceStart, contentStart - sourceStart);
  let offset = 0;
  while (offset < content.length) {
    const width = codePointWidth(content, offset);
    const character = content.slice(offset, offset + width);
    if (character === "\\" || character === '"') {
      builder.appendEscaped(character, contentStart + offset);
    } else if (isForbiddenLineBreak(character)) {
      builder.appendMapped(" ", contentStart + offset, width);
    } else {
      builder.appendSource(character, contentStart + offset);
    }
    offset += width;
  }
  builder.appendMappedToStart(suffix, contentStart + content.length, sourceEnd - (contentStart + content.length));
}

function leadingIndentLength(text: string): number {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || isForbiddenLineBreak(text[index]))) index += 1;
  return index;
}

function findCodeRanges(text: string): CodeRange[] {
  const runs: Array<{ start: number; width: number; escaped: boolean }> = [];
  let index = 0;
  let backslashes = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      if (text[index] === "\\") backslashes += 1;
      else backslashes = 0;
      index += codePointWidth(text, index);
      continue;
    }
    const start = index;
    while (index < text.length && text[index] === "`") index += 1;
    runs.push({ start, width: index - start, escaped: backslashes % 2 === 1 });
    backslashes = 0;
  }

  const nextSameRun = new Array<number>(runs.length).fill(-1);
  const nextByWidth = new Map<number, number>();
  for (let run = runs.length - 1; run >= 0; run -= 1) {
    const current = runs[run];
    const openingWidth = current.escaped ? current.width - 1 : current.width;
    nextSameRun[run] = openingWidth > 0 ? nextByWidth.get(openingWidth) ?? -1 : -1;
    nextByWidth.set(current.width, current.start);
  }

  const ranges: CodeRange[] = [];
  let consumedThrough = 0;
  for (let run = 0; run < runs.length; run += 1) {
    const current = runs[run];
    if (current.start < consumedThrough) continue;
    const openingStart = current.start + (current.escaped ? 1 : 0);
    const openingWidth = current.width - (current.escaped ? 1 : 0);
    if (openingWidth <= 0) continue;
    const close = nextSameRun[run];
    if (close >= 0) {
      ranges.push({ start: openingStart, end: close + openingWidth, width: openingWidth });
      consumedThrough = close + openingWidth;
    }
  }
  return ranges;
}

function findUrls(text: string, codeRanges: CodeRange[]): UrlRange[] {
  const ranges: UrlRange[] = [];
  let index = 0;
  let codeIndex = 0;
  while (index < text.length) {
    while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= index) codeIndex += 1;
    const code = codeRanges[codeIndex];
    if (code && index >= code.start && index < code.end) {
      index = code.end;
      continue;
    }
    const scheme = text.startsWith("https://", index) ? "https://" : text.startsWith("http://", index) ? "http://" : "";
    if (scheme === "") {
      index += codePointWidth(text, index);
      continue;
    }
    let end = index + scheme.length;
    let hasOpeningParenthesis = false;
    while (end < text.length && !/[\s<]/u.test(text[end])) {
      if (text[end] === "(") hasOpeningParenthesis = true;
      if (code && end >= code.start) break;
      end += 1;
    }
    while (end > index + scheme.length && ".,:;!?'\"*_~)".includes(text[end - 1])) {
      if (text[end - 1] === ")" && hasOpeningParenthesis) break;
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

function findEmphasisRanges(text: string, codeRanges: CodeRange[], urls: UrlRange[]): EmphasisRange[] {
  const ranges: EmphasisRange[] = [];
  const closing = findClosingDelimiters(text, codeRanges, urls);
  let index = 0;
  let codeIndex = 0;
  let urlIndex = 0;
  while (index < text.length) {
    while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= index) codeIndex += 1;
    while (urlIndex < urls.length && urls[urlIndex].end <= index) urlIndex += 1;
    const code = codeRanges[codeIndex];
    const url = urls[urlIndex];
    if (code && index >= code.start && index < code.end) {
      index = code.end;
      continue;
    }
    if (url && index >= url.start && index < url.end) {
      index = url.end;
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
    const close = findClosing(closing, index + width, marker, width);
    if (close < 0) {
      index += width;
      continue;
    }
    ranges.push({ start: index, end: close + width, width, strong });
    index = close + width;
  }
  return ranges;
}

function findClosingDelimiters(text: string, codeRanges: CodeRange[], urls: UrlRange[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  let index = 0;
  let codeIndex = 0;
  let urlIndex = 0;
  while (index < text.length) {
    while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= index) codeIndex += 1;
    while (urlIndex < urls.length && urls[urlIndex].end <= index) urlIndex += 1;
    const code = codeRanges[codeIndex];
    const url = urls[urlIndex];
    if (code && index >= code.start && index < code.end) {
      index = code.end;
      continue;
    }
    if (url && index >= url.start && index < url.end) {
      index = url.end;
      continue;
    }
    if ((text[index] !== "*" && text[index] !== "_") || isEscaped(text, index)) {
      index += codePointWidth(text, index);
      continue;
    }
    const marker = text[index];
    const strong = text[index + 1] === marker;
    const width = strong ? 2 : 1;
    if (canClose(text, index, width)) {
      const key = `${marker}${width}`;
      const positions = result.get(key);
      if (positions) positions.push(index);
      else result.set(key, [index]);
    }
    index += width;
  }
  return result;
}

function findClosing(delimiters: Map<string, number[]>, start: number, marker: string, width: number): number {
  const positions = delimiters.get(`${marker}${width}`) ?? [];
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < start) low = middle + 1;
    else high = middle;
  }
  return positions[low] ?? -1;
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
  return character !== "" && /[\p{Alphabetic}\p{N}]/u.test(character) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isMarkdownEscapeTarget(character: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(character);
}
