import { MappedLineBuilder } from "./lineMap";

interface EmphasisRange {
  start: number;
  end: number;
  width: number;
  strong: boolean;
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

interface Delimiter {
  index: number;
  marker: string;
  width: number;
  open: boolean;
  close: boolean;
}

export function convertInline(text: string, sourceOffset: number, options: InlineOptions = {}): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const codeRanges = findCodeRanges(text);
  const urls = findUrls(text, codeRanges);
  const emphasis = findEmphasisRanges(text, codeRanges, urls);
  const codeByStart = new Map(codeRanges.map((range) => [range.start, range]));
  const urlByStart = new Map(urls.map((range) => [range.start, range]));
  const emphasisByStart = new Map(emphasis.map((range) => [range.start, range]));
  let index = 0;

  while (index < text.length) {
    const code = codeByStart.get(index);
    if (code) {
      let content = text.slice(code.start + code.width, code.end - code.width);
      if (code.width === 1 && !content.includes("`")) {
        builder.appendSource(text.slice(code.start, code.end), sourceOffset + code.start);
      } else {
        let contentStart = code.start + code.width;
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/u.test(content)) {
          content = content.slice(1, -1);
          contentStart += 1;
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

    if (character === "#" || character === "$" || character === "@" || character === "<" || character === "~" || character === "[" || character === "]" || character === "`" || character === "*" || character === "_") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (character === "/") {
      builder.appendEscaped(character, sourceOffset + index);
      index += 1;
      continue;
    }

    if (character === "-" && text[index + width] === "?") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (options.lineStart && index === 0) {
      if (character === "-" && isNonMarkdownWhitespace(text[index + width])) {
        builder.appendEscaped(character, sourceOffset + index);
        index += width;
        continue;
      }
      if (character >= "0" && character <= "9") {
        let digitEnd = index;
        while (digitEnd < text.length && text[digitEnd] >= "0" && text[digitEnd] <= "9") digitEnd += 1;
        if (text[digitEnd] === "." && isNonMarkdownWhitespace(text[digitEnd + 1])) {
          builder.appendSource(text.slice(index, digitEnd), sourceOffset + index);
          builder.appendEscaped(".", sourceOffset + digitEnd);
          index = digitEnd + 1;
          continue;
        }
      }
      if (character === "=" || (character === "+" && (!text[index + width] || /\s/u.test(text[index + width])))) {
        builder.appendEscaped(character, sourceOffset + index);
        index += width;
        continue;
      }
    }

    builder.appendSource(character, sourceOffset + index);
    index += width;
  }

  return builder;
}

export function convertProseLine(line: string): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const heading = /^(#+)([ \t]+)(.*)$/u.exec(line);
  if (heading) {
    builder.appendMapped("=".repeat(heading[1].length), 0, heading[1].length);
    builder.appendSource(heading[2], heading[1].length);
    builder.appendBuilder(convertInline(line.slice(heading[1].length + heading[2].length), heading[1].length + heading[2].length, { lineStart: true }));
    return builder;
  }
  const unordered = /^([ \t]*)([-*+])([ \t]+)(.*)$/u.exec(line);
  if (unordered) {
    const markerStart = unordered[1].length;
    const contentStart = markerStart + 1 + unordered[3].length;
    builder.appendSource(unordered[1], 0);
    builder.appendMapped("-", markerStart, 1);
    builder.appendSource(unordered[3], markerStart + 1);
    appendListText(builder, line.slice(contentStart), contentStart);
    return builder;
  }
  const ordered = /^([ \t]*)(\d+\.)([ \t]+)(.*)$/u.exec(line);
  if (ordered) {
    const contentStart = ordered[1].length + ordered[2].length + ordered[3].length;
    builder.appendSource(ordered[1], 0);
    builder.appendSource(ordered[2], ordered[1].length);
    builder.appendSource(ordered[3], ordered[1].length + ordered[2].length);
    appendListText(builder, line.slice(contentStart), contentStart);
    return builder;
  }
  const indentationLength = leadingIndentLength(line);
  builder.appendSource(line.slice(0, indentationLength), 0);
  builder.appendBuilder(convertInline(line.slice(indentationLength), indentationLength, { lineStart: true }));
  return builder;
}

function appendListText(builder: MappedLineBuilder, text: string, sourceOffset: number): void {
  let index = 0;
  while (index < text.length) {
    const marker = text[index];
    if (marker === "-" || marker === "*") {
      let contentStart = index + 1;
      if (contentStart >= text.length || (text[contentStart] !== " " && text[contentStart] !== "\t")) break;
      while (contentStart < text.length && (text[contentStart] === " " || text[contentStart] === "\t")) contentStart += 1;
      builder.appendMapped("-", sourceOffset + index, 1);
      builder.appendSource(text.slice(index + 1, contentStart), sourceOffset + index + 1);
      index = contentStart;
      continue;
    }

    let digitEnd = index;
    while (digitEnd < text.length && text[digitEnd] >= "0" && text[digitEnd] <= "9") digitEnd += 1;
    if (digitEnd === index || text[digitEnd] !== ".") break;
    let contentStart = digitEnd + 1;
    if (contentStart >= text.length || (text[contentStart] !== " " && text[contentStart] !== "\t")) break;
    while (contentStart < text.length && (text[contentStart] === " " || text[contentStart] === "\t")) contentStart += 1;
    builder.appendSource(text.slice(index, digitEnd + 1), sourceOffset + index);
    builder.appendSource(text.slice(digitEnd + 1, contentStart), sourceOffset + digitEnd + 1);
    index = contentStart;
  }
  builder.appendBuilder(convertInline(text.slice(index), sourceOffset + index, { lineStart: true }));
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
  builder.appendMapped(prefix, sourceStart, contentStart - sourceStart);
  let offset = 0;
  while (offset < content.length) {
    const width = codePointWidth(content, offset);
    const character = content.slice(offset, offset + width);
    if (character === "\\" || character === '"') {
      builder.appendEscaped(character, contentStart + offset);
    } else {
      builder.appendSource(character, contentStart + offset);
    }
    offset += width;
  }
  builder.appendMapped(suffix, contentStart + content.length, sourceEnd - (contentStart + content.length));
}

function leadingIndentLength(text: string): number {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  return index;
}

function isNonMarkdownWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character) && character !== " " && character !== "\t";
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
    while (end > index + scheme.length && ".,:;!?\'\"*_~)".includes(text[end - 1])) {
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
  const delimiters = findDelimiters(text, codeRanges, urls);
  const closing = new Map<string, number[]>();
  for (const delimiter of delimiters) {
    if (!delimiter.close) continue;
    const key = `${delimiter.marker}${delimiter.width}`;
    const positions = closing.get(key);
    if (positions) positions.push(delimiter.index);
    else closing.set(key, [delimiter.index]);
  }

  const ranges: EmphasisRange[] = [];
  let delimiterIndex = 0;
  while (delimiterIndex < delimiters.length) {
    const delimiter = delimiters[delimiterIndex];
    if (!delimiter.open) {
      delimiterIndex += 1;
      continue;
    }
    const close = findClosing(closing, delimiter.index + delimiter.width, delimiter.marker, delimiter.width);
    if (close < 0) {
      delimiterIndex += 1;
      continue;
    }
    ranges.push({ start: delimiter.index, end: close + delimiter.width, width: delimiter.width, strong: delimiter.width === 2 });
    const end = close + delimiter.width;
    do {
      delimiterIndex += 1;
    } while (delimiterIndex < delimiters.length && delimiters[delimiterIndex].index < end);
  }
  return ranges;
}

function findDelimiters(text: string, codeRanges: CodeRange[], urls: UrlRange[]): Delimiter[] {
  const delimiters: Delimiter[] = [];
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
    const start = index;
    while (index < text.length && text[index] === marker) index += 1;
    const width = index - start;
    if (width === 1 || width === 2) {
      delimiters.push({ index: start, marker, width, open: canOpen(text, start, width), close: canClose(text, start, width) });
    }
  }
  return delimiters;
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
