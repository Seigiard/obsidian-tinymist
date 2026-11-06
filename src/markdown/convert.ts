export interface KitView {
  templates: Record<string, string>;
  defaultTemplate: string;
}

export interface Problem {
  line: number;
  message: string;
  fatal: boolean;
}

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
const FORBIDDEN_LINE_BREAKS = /[\r\u000b\f\u0085\u2028\u2029]/u;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

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

  appendInserted(text: string, anchor = 0): void {
    if (text.length === 0) return;
    this.pieces.push({ text, sourceStart: anchor, sourceLength: 0, identity: false });
  }

  appendBuilder(builder: MappedLineBuilder): void {
    this.pieces.push(...builder.pieces);
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

  for (let line = 1; line < frontmatterEnd; line += 1) {
    const property = parseProperty(lines[line]);
    let output = "";
    if (property) {
      if (!PROPERTY_NAME.test(property.name)) {
        addProblem(problems, line, `Property name ${property.name || "<empty>"} is not a Typst identifier`, false);
      } else if (property.name !== "template" && property.name !== "") {
        const literal = parseValue(property.value);
        if (literal === undefined) {
          addProblem(problems, line, `Property ${property.name} has no scalar value`, false);
        } else {
          output = `${property.name}: ${literal},`;
        }
      }
    }
    addGeneratedLine(outputLines, maps, sanitizeLine(output), lines[line].length);
  }

  addGeneratedLine(outputLines, maps, ")", lines[frontmatterEnd].length);

  let fence: "typ" | "other" | undefined;
  for (let line = frontmatterEnd + 1; line < lines.length; line += 1) {
    const sourceLine = lines[line];
    const builder = new MappedLineBuilder();

    if (fence === "typ") {
      if (sourceLine === "```") {
        fence = undefined;
      } else {
        appendNormalized(builder, sourceLine, 0);
        if (FORBIDDEN_LINE_BREAKS.test(sourceLine)) {
          addProblem(problems, line, "Typst code contains a line-break character", true);
        }
      }
    } else if (fence === "other") {
      appendNormalized(builder, sourceLine, 0);
      if (sourceLine === "```") fence = undefined;
    } else if (sourceLine === "```typ") {
      fence = "typ";
    } else if (sourceLine.startsWith("```")) {
      fence = "other";
      appendNormalized(builder, sourceLine, 0);
    } else if (sourceLine.startsWith("/typst")) {
      const code = sourceLine.slice(6);
      appendNormalized(builder, code, 6);
      if (FORBIDDEN_LINE_BREAKS.test(sourceLine)) {
        addProblem(problems, line, "Typst code contains a line-break character", true);
      }
    } else {
      builder.appendBuilder(convertProseLine(sourceLine));
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
      explicit = { line, id: property.value.trim() };
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
  return match ? { name: match[1], value: match[2] } : undefined;
}

function parseValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || isBlockValue(trimmed)) return undefined;
  if (trimmed === "true" || trimmed === "false" || NUMBER.test(trimmed)) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const array = parseArray(trimmed);
    if (array !== undefined) return array;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return quoteString(trimmed.slice(1, -1));
  }
  return quoteString(trimmed);
}

function isBlockValue(value: string): boolean {
  return /^[|>][+-]?[0-9]*[ \t]*$/u.test(value);
}

function parseArray(value: string): string | undefined {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return "()";
  const items = splitArrayItems(inner);
  if (!items) return undefined;
  const literals: string[] = [];
  for (const item of items) {
    const literal = parseValue(item);
    if (literal === undefined) return undefined;
    literals.push(literal);
  }
  return `(${literals.join(", ")},)`;
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
  return line.replace(/[\r\u000b\f\u0085\u2028\u2029]/gu, " ");
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
  return FORBIDDEN_LINE_BREAKS.test(character);
}

function convertProseLine(line: string): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const heading = /^(#+)([ \t]+)(.*)$/u.exec(line);
  if (heading) {
    builder.appendMapped("=".repeat(heading[1].length), 0, heading[1].length);
    builder.appendSource(heading[2], heading[1].length);
    builder.appendBuilder(convertInline(heading[3], heading[1].length + heading[2].length));
    return builder;
  }

  const unordered = /^([ \t]*)([-*+])([ \t]+)(.*)$/u.exec(line);
  if (unordered) {
    const markerStart = unordered[1].length;
    builder.appendSource(unordered[1], 0);
    builder.appendMapped("-", markerStart, 1);
    builder.appendSource(unordered[3], markerStart + 1);
    builder.appendBuilder(convertInline(unordered[4], markerStart + 1 + unordered[3].length));
    return builder;
  }

  const ordered = /^([ \t]*)(\d+\.)([ \t]+)(.*)$/u.exec(line);
  if (ordered) {
    const contentStart = ordered[1].length + ordered[2].length + ordered[3].length;
    builder.appendSource(ordered[1], 0);
    builder.appendSource(ordered[2], ordered[1].length);
    builder.appendSource(ordered[3], ordered[1].length + ordered[2].length);
    builder.appendBuilder(convertInline(ordered[4], contentStart));
    return builder;
  }

  builder.appendBuilder(convertInline(line, 0));
  return builder;
}

function convertInline(text: string, sourceOffset: number): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const codeRanges = findCodeRanges(text);
  const emphasis = findEmphasisRanges(text, codeRanges);
  let index = 0;

  while (index < text.length) {
    const code = codeRanges.find((range) => range.start === index);
    if (code) {
      appendNormalized(builder, text.slice(code.start, code.end), sourceOffset + code.start);
      index = code.end;
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

    if (character === "/" && text[index + 1] === "/") {
      if (isHttpScheme(text, index)) {
        builder.appendSource("//", sourceOffset + index);
      } else {
        builder.appendMapped("\\//", sourceOffset + index, 2);
      }
      index += 2;
      continue;
    }

    if (character === "/" && text[index + 1] === "*") {
      builder.appendMapped("\\/", sourceOffset + index, 1);
      builder.appendMapped("\\*", sourceOffset + index + 1, 1);
      index += 2;
      continue;
    }

    if (FORBIDDEN_LINE_BREAKS.test(character)) {
      builder.appendMapped(" ", sourceOffset + index, width);
      index += width;
      continue;
    }

    if (character === "#" || character === "$" || character === "@" || character === "<" || character === "~" || character === "[" || character === "]" || character === "`" || character === "*" || character === "_") {
      builder.appendMapped(`\\${character}`, sourceOffset + index, width);
      index += width;
      continue;
    }

    if ((character === "=" || character === "/") && index === 0) {
      builder.appendMapped(`\\${character}`, sourceOffset + index, width);
      index += width;
      continue;
    }

    builder.appendSource(character, sourceOffset + index);
    index += width;
  }

  return builder;
}

function findCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`" || isEscaped(text, index)) {
      index += codePointWidth(text, index);
      continue;
    }
    let width = 1;
    while (text[index + width] === "`") width += 1;
    const delimiter = "`".repeat(width);
    let close = index + width;
    while (close < text.length) {
      if (text.startsWith(delimiter, close) && !isEscaped(text, close)) {
        ranges.push({ start: index, end: close + width });
        index = close + width;
        break;
      }
      close += 1;
    }
    if (close >= text.length) index += width;
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
  const next = characterBeforeOrAfter(text, index + width, 1);
  const previous = index > 0 ? characterBeforeOrAfter(text, index - codePointWidthBefore(text, index), 1) : "";
  if (!next || /\s/u.test(next)) return false;
  return !(isWord(previous) && isWord(next));
}

function canClose(text: string, index: number, width: number): boolean {
  const previousIndex = index > 0 ? index - codePointWidthBefore(text, index) : -1;
  const previous = previousIndex >= 0 ? characterBeforeOrAfter(text, previousIndex, 1) : "";
  const next = index + width < text.length ? characterBeforeOrAfter(text, index + width, 1) : "";
  if (!previous || /\s/u.test(previous)) return false;
  return !(isWord(previous) && isWord(next));
}

function characterBeforeOrAfter(text: string, index: number, _direction: number): string {
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
  return character !== "" && /[\p{L}\p{N}]/u.test(character);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isMarkdownEscapeTarget(character: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(character);
}

function isHttpScheme(text: string, slash: number): boolean {
  return text.slice(Math.max(0, slash - 5), slash) === "http:" || text.slice(Math.max(0, slash - 6), slash) === "https:";
}
