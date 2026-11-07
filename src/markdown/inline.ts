import { MappedLineBuilder } from "./lineMap";
import { quoteString } from "./frontmatter";

export interface InlineState {
  commentOpen: boolean;
}

export type ProblemReporter = (message: string) => void;

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
  escapeMarkdownMarkers?: boolean;
}

interface MarkdownLinkRange {
  start: number;
  end: number;
  labelStart: number;
  labelEnd: number;
  target: string;
  image: boolean;
}

interface WikilinkRange {
  start: number;
  end: number;
  display: string;
  displayStart: number;
}

interface ImageRange {
  start: number;
  end: number;
  path: string;
  width?: number;
  height?: number;
}

interface LinebreakRange {
  start: number;
  end: number;
}

interface Delimiter {
  index: number;
  marker: string;
  width: number;
  open: boolean;
  close: boolean;
}

const MAX_LINK_NESTING = 32;

export function convertInlineText(
  text: string,
  sourceOffset = 0,
  reportProblem?: ProblemReporter,
  state?: InlineState,
  options: InlineOptions = {},
): MappedLineBuilder {
  const inlineState = state ?? { commentOpen: false };
  const prepared = stripComments(text, inlineState);
  reportUnsupportedConstructs(prepared, reportProblem);
  return convertInline(prepared, sourceOffset, options);
}

export function convertProseLine(line: string, reportProblem?: ProblemReporter, sourceOffset = 0, state?: InlineState): MappedLineBuilder {
  const inlineState = state ?? { commentOpen: false };
  const prepared = stripComments(line, inlineState);
  reportUnsupportedConstructs(prepared, reportProblem);
  return convertProseLinePrepared(prepared, reportProblem, sourceOffset);
}

function convertInline(text: string, sourceOffset: number, options: InlineOptions = {}, linkDepth = 0): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const codeRanges = findCodeRanges(text);
  const urls = linkDepth < MAX_LINK_NESTING ? findUrls(text, codeRanges) : [];
  const emphasis = findEmphasisRanges(text, codeRanges, urls);
  const markdownLinks = linkDepth < MAX_LINK_NESTING ? findMarkdownLinks(text, codeRanges) : [];
  const wikilinks = findWikilinks(text, codeRanges);
  const images = findImageRanges(text, codeRanges, linkDepth < MAX_LINK_NESTING);
  const linebreaks = findLinebreaks(text, codeRanges);
  const codeByStart = new Map(codeRanges.map((range) => [range.start, range]));
  const urlByStart = new Map(urls.map((range) => [range.start, range]));
  const emphasisByStart = new Map(emphasis.map((range) => [range.start, range]));
  const markdownByStart = new Map(markdownLinks.map((range) => [range.start, range]));
  const wikilinkByStart = new Map(wikilinks.map((range) => [range.start, range]));
  const imageByStart = new Map(images.map((range) => [range.start, range]));
  const linebreakByStart = new Map(linebreaks.map((range) => [range.start, range]));
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

    const image = imageByStart.get(index);
    if (image) {
      const dimensions = image.width === undefined ? "" : `, width: ${image.width}pt${image.height === undefined ? "" : `, height: ${image.height}pt`}`;
      builder.appendInserted(`#std.image(${quoteString(image.path)}${dimensions});`, sourceOffset + image.start);
      index = image.end;
      continue;
    }

    const markdown = markdownByStart.get(index);
    if (markdown) {
      if (markdown.image) {
        if (/^https?:\/\//iu.test(markdown.target)) {
          if (markdown.labelStart === markdown.labelEnd) {
            builder.appendInserted(`#std.link(${quoteString(markdown.target)});`, sourceOffset + markdown.start);
          } else {
            builder.appendInserted(`#std.link(${quoteString(markdown.target)})[`, sourceOffset + markdown.start);
            builder.appendBuilder(convertInline(text.slice(markdown.labelStart, markdown.labelEnd), sourceOffset + markdown.labelStart, {}, linkDepth + 1));
            builder.appendInserted("];", sourceOffset + markdown.end);
          }
        } else {
          builder.appendInserted(`#std.image(${quoteString(markdown.target)});`, sourceOffset + markdown.start);
        }
      } else if (/^https?:\/\//iu.test(markdown.target)) {
        builder.appendInserted(`#std.link(${quoteString(markdown.target)})[`, sourceOffset + markdown.start);
        builder.appendBuilder(convertInline(text.slice(markdown.labelStart, markdown.labelEnd), sourceOffset + markdown.labelStart, {}, linkDepth + 1));
        builder.appendInserted("];", sourceOffset + markdown.end);
      } else {
        builder.appendBuilder(convertInline(text.slice(markdown.labelStart, markdown.labelEnd), sourceOffset + markdown.labelStart, {}, linkDepth + 1));
      }
      index = markdown.end;
      continue;
    }

    const wikilink = wikilinkByStart.get(index);
    if (wikilink) {
      builder.appendBuilder(convertInline(wikilink.display, sourceOffset + wikilink.displayStart, {}, linkDepth));
      index = wikilink.end;
      continue;
    }

    const linebreak = linebreakByStart.get(index);
    if (linebreak) {
      builder.appendInserted("#std.linebreak();", sourceOffset + linebreak.start);
      index = linebreak.end;
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
      builder.appendBuilder(convertInline(text.slice(mark.start + mark.width, mark.end - mark.width), sourceOffset + mark.start + mark.width, {}, linkDepth));
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

    if (character === "#" || character === "$" || character === "@" || character === "<" || character === "~" || character === "[" || character === "]" || character === "`" || character === "*" || character === "_" || character === "/") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (character === "-" && text[index + width] === "?") {
      builder.appendEscaped(character, sourceOffset + index);
      index += width;
      continue;
    }

    if (options.lineStart && index === 0) {
      if (options.escapeMarkdownMarkers && (character === "-" || character === "+") && isWhitespace(text[index + width])) {
        builder.appendEscaped(character, sourceOffset + index);
        index += width;
        continue;
      }
      if (character === "-" && isNonMarkdownWhitespace(text[index + width])) {
        builder.appendEscaped(character, sourceOffset + index);
        index += width;
        continue;
      }
      if (character >= "0" && character <= "9") {
        let digitEnd = index;
        while (digitEnd < text.length && text[digitEnd] >= "0" && text[digitEnd] <= "9") digitEnd += 1;
        const whitespace = options.escapeMarkdownMarkers ? isWhitespace(text[digitEnd + 1]) : isNonMarkdownWhitespace(text[digitEnd + 1]);
        if (text[digitEnd] === "." && whitespace) {
          builder.appendSource(text.slice(index, digitEnd), sourceOffset + index);
          builder.appendEscaped(".", sourceOffset + digitEnd);
          index = digitEnd + 1;
          continue;
        }
      }
      if (
        (character === "=" && (!options.escapeMarkdownMarkers || isWhitespace(text[index + width]))) ||
        (character === "+" && (!text[index + width] || /\s/u.test(text[index + width])))
      ) {
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

function convertProseLinePrepared(line: string, _reportProblem: ProblemReporter | undefined, sourceOffset: number): MappedLineBuilder {
  const builder = new MappedLineBuilder();
  const heading = /^(#+)([ \t]+)(.*)$/u.exec(line);
  if (heading) {
    builder.appendMapped("=".repeat(heading[1].length), sourceOffset, heading[1].length);
    builder.appendSource(heading[2], sourceOffset + heading[1].length);
    builder.appendBuilder(convertInline(line.slice(heading[1].length + heading[2].length), sourceOffset + heading[1].length + heading[2].length, { lineStart: true }));
    return builder;
  }
  const unordered = /^([ \t]*)([-*+])([ \t]+)(.*)$/u.exec(line);
  if (unordered) {
    const markerStart = unordered[1].length;
    const contentStart = markerStart + 1 + unordered[3].length;
    builder.appendSource(unordered[1], sourceOffset);
    builder.appendMapped("-", sourceOffset + markerStart, 1);
    builder.appendSource(unordered[3], sourceOffset + markerStart + 1);
    appendListText(builder, line.slice(contentStart), sourceOffset + contentStart);
    return builder;
  }
  const ordered = /^([ \t]*)(\d+\.)([ \t]+)(.*)$/u.exec(line);
  if (ordered) {
    const contentStart = ordered[1].length + ordered[2].length + ordered[3].length;
    builder.appendSource(ordered[1], sourceOffset);
    builder.appendSource(ordered[2], sourceOffset + ordered[1].length);
    builder.appendSource(ordered[3], sourceOffset + ordered[1].length + ordered[2].length);
    appendListText(builder, line.slice(contentStart), sourceOffset + contentStart);
    return builder;
  }
  const indentationLength = leadingIndentLength(line);
  builder.appendSource(line.slice(0, indentationLength), sourceOffset);
  builder.appendBuilder(convertInline(line.slice(indentationLength), sourceOffset + indentationLength, { lineStart: true }));
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

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
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
    let openingParentheses = 0;
    let closingParentheses = 0;
    while (end < text.length && isUrlCharacter(text, end)) {
      if (code && end >= code.start) break;
      const character = characterAt(text, end);
      if (character === "(") openingParentheses += 1;
      if (character === ")") closingParentheses += 1;
      end += codePointWidth(text, end);
    }
    const candidateEnd = end;
    while (end > index + scheme.length && ".,:;!?\'\"*_~)".includes(text[end - 1])) {
      if (text[end - 1] === ")") {
        if (closingParentheses <= openingParentheses) break;
        closingParentheses -= 1;
      }
      end -= 1;
    }
    if (end > index + scheme.length && utf8ByteLength(text.slice(index, end)) <= 8000) {
      ranges.push({ start: index, end });
      index = end;
    } else if (candidateEnd > index + scheme.length) {
      index = candidateEnd;
    } else {
      index += scheme.length;
    }
  }
  return ranges;
}

function isUrlCharacter(text: string, index: number): boolean {
  const character = characterAt(text, index);
  if (character === "") return false;
  if (character.codePointAt(0)! <= 0x7f) return ASCII_URL_CHARACTERS.includes(character);
  return /[\p{L}\p{M}\p{N}]/u.test(character);
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += codePointWidth(text, index)) {
    const codePoint = text.codePointAt(index)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const ASCII_URL_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#@!$&'()*+,;=%\"";

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
  const previous = characterAt(text, index - codePointWidthBefore(text, index));
  if (!next || /\s/u.test(next)) return false;
  return !(isWord(previous) && isWord(next));
}

function canClose(text: string, index: number, width: number): boolean {
  const previous = characterAt(text, index - codePointWidthBefore(text, index));
  const next = characterAt(text, index + width);
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
  return /[\p{Alphabetic}\p{N}]/u.test(character) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isMarkdownEscapeTarget(character: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(character);
}

function stripComments(text: string, state: InlineState): string {
  if (!state.commentOpen && !text.includes("%%")) return text;
  const codeRanges = findCodeRanges(text);
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (state.commentOpen) {
      const close = findCommentDelimiter(text, index, codeRanges);
      if (close < 0) return result;
      state.commentOpen = false;
      index = close + 2;
      continue;
    }
    const open = findCommentDelimiter(text, index, codeRanges);
    if (open < 0) {
      result += text.slice(index);
      return result;
    }
    result += text.slice(index, open);
    state.commentOpen = true;
    index = open + 2;
  }
  return result;
}

function findCommentDelimiter(text: string, from: number, codeRanges: readonly CodeRange[]): number {
  let index = text.indexOf("%%", from);
  while (index >= 0 && isInsideRange(index, codeRanges)) index = text.indexOf("%%", index + 2);
  return index;
}

function reportUnsupportedConstructs(text: string, reportProblem?: ProblemReporter): void {
  if (!reportProblem) return;
  if (!text.includes("![[") && !text.includes("![") && !text.includes("<") && !text.includes("$") && !text.includes("[^")) return;

  const codeRanges = findCodeRanges(text);
  if (hasUnsupportedEmbed(text, codeRanges)) reportProblem("Note embed has no Typst form");
  if (hasRemoteImage(text, codeRanges)) reportProblem("Remote image has no Typst form");
  if (hasUnsupportedHtml(text, codeRanges)) reportProblem("HTML has no Typst form");
  if (hasLatexMath(text, codeRanges)) reportProblem("LaTeX math has no Typst form");
  if (hasFootnote(text, codeRanges)) reportProblem("Footnote has no Typst form");
}

function hasRemoteImage(text: string, codeRanges: readonly CodeRange[]): boolean {
  return findMarkdownLinks(text, codeRanges).some((range) => range.image && /^https?:\/\//iu.test(range.target));
}

function hasUnsupportedEmbed(text: string, codeRanges: readonly CodeRange[]): boolean {
  let index = 0;
  while (index < text.length - 2) {
    const start = text.indexOf("![[", index);
    if (start < 0) return false;
    if (!isInsideRange(start, codeRanges)) {
      const end = text.indexOf("]]", start + 3);
      if (end >= 0) {
        const path = text.slice(start + 3, end).split("|", 1)[0].trim();
        if (!isImagePath(path)) return true;
        index = end + 2;
        continue;
      }
    }
    index = start + 3;
  }
  return false;
}

function hasUnsupportedHtml(text: string, codeRanges: readonly CodeRange[]): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "<" || isEscaped(text, index) || isInsideRange(index, codeRanges)) continue;
    const end = text.indexOf(">", index + 1);
    if (end < 0) continue;
    const tag = text.slice(index, end + 1);
    if (!/^<br\s*\/?>(?:$|.)/iu.test(tag) && /^<\/?[A-Za-z][^>]*>$/u.test(tag)) return true;
    index = end;
  }
  return false;
}

function hasLatexMath(text: string, codeRanges: readonly CodeRange[]): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && !isEscaped(text, index) && !isInsideRange(index, codeRanges)) return true;
  }
  return false;
}

function hasFootnote(text: string, codeRanges: readonly CodeRange[]): boolean {
  for (let index = 0; index < text.length - 2; index += 1) {
    if (text[index] !== "[" || text[index + 1] !== "^" || isEscaped(text, index) || isInsideRange(index, codeRanges)) continue;
    const close = text.indexOf("]", index + 2);
    if (close >= 0) return true;
  }
  return false;
}

function findMarkdownLinks(text: string, codeRanges: readonly CodeRange[]): MarkdownLinkRange[] {
  if (!text.includes("](")) return [];
  const ranges: MarkdownLinkRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (isInsideRange(index, codeRanges)) {
      index += 1;
      continue;
    }
    const image = text[index] === "!" && text[index + 1] === "[";
    const bracket = image ? index + 1 : text[index] === "[" ? index : -1;
    if (bracket < 0 || isEscaped(text, bracket)) {
      index += codePointWidth(text, index);
      continue;
    }
    const closeBracket = findClosingBracket(text, bracket + 1);
    if (closeBracket < 0 || text[closeBracket + 1] !== "(") {
      index = bracket + 1;
      continue;
    }
    const closeParen = findClosingParen(text, closeBracket + 2);
    if (closeParen < 0) {
      index = closeBracket + 2;
      continue;
    }
    ranges.push({
      start: image ? index : bracket,
      end: closeParen + 1,
      labelStart: bracket + 1,
      labelEnd: closeBracket,
      target: parseMarkdownDestination(text.slice(closeBracket + 2, closeParen)),
      image,
    });
    index = closeParen + 1;
  }
  return ranges;
}

function findWikilinks(text: string, codeRanges: readonly CodeRange[]): WikilinkRange[] {
  if (!text.includes("[[")) return [];
  const ranges: WikilinkRange[] = [];
  let index = 0;
  while (index < text.length - 3) {
    const start = text.indexOf("[[", index);
    if (start < 0) break;
    if (isInsideRange(start, codeRanges) || isEscaped(text, start)) {
      index = start + 2;
      continue;
    }
    if (start > 0 && text[start - 1] === "!") {
      index = start + 2;
      continue;
    }
    const close = text.indexOf("]]", start + 2);
    if (close < 0) break;
    const body = text.slice(start + 2, close);
    const separator = body.indexOf("|");
    const target = (separator < 0 ? body : body.slice(0, separator)).trim();
    const explicitDisplay = separator < 0 ? "" : body.slice(separator + 1);
    const display = explicitDisplay === "" ? wikilinkTargetDisplay(target) : explicitDisplay;
    const displayStart = separator < 0 ? start + 2 + wikilinkTargetDisplayStart(target) : start + 2 + separator + 1;
    ranges.push({ start, end: close + 2, display, displayStart });
    index = close + 2;
  }
  return ranges;
}

function findImageRanges(text: string, codeRanges: readonly CodeRange[], recognizeMarkdownLinks = true): ImageRange[] {
  if (!text.includes("![")) return [];
  const ranges: ImageRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "!" && text[index + 1] === "[" && text[index + 2] === "[") {
      if (isInsideRange(index, codeRanges)) {
        index += 3;
        continue;
      }
      const close = text.indexOf("]]", index + 3);
      if (close >= 0) {
        const parts = text.slice(index + 3, close).split("|");
        const path = parts.shift()?.trim() ?? "";
        if (isImagePath(path)) {
          const dimensions = parseDimensions(parts.join("|").trim());
          ranges.push({ start: index, end: close + 2, path, ...dimensions });
          index = close + 2;
          continue;
        }
      }
    }
    index += 1;
  }

  if (!recognizeMarkdownLinks) return ranges;
  for (const range of findMarkdownLinks(text, codeRanges)) {
    if (!range.image) continue;
    if (/^https?:\/\//iu.test(range.target)) continue;
    ranges.push({ start: range.start, end: range.end, path: range.target });
  }
  return ranges;
}

function findLinebreaks(text: string, codeRanges: readonly CodeRange[]): LinebreakRange[] {
  if (!text.includes("<br")) return [];
  const ranges: LinebreakRange[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (isInsideRange(index, codeRanges) || text[index] !== "<") continue;
    const match = /^(?:<br>|<br\/>|<br \/>)/iu.exec(text.slice(index));
    if (!match || isEscaped(text, index)) continue;
    ranges.push({ start: index, end: index + match[0].length });
    index += match[0].length - 1;
  }
  return ranges;
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg)$/iu.test(path.split("#", 1)[0]);
}

function parseMarkdownDestination(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const close = value.indexOf(">");
    if (close >= 0) return value.slice(1, close);
  }
  const match = /^(\S+)/u.exec(value);
  return match?.[1] ?? "";
}

function parseDimensions(value: string): { width?: number; height?: number } {
  if (value === "") return {};
  const match = /^(\d+)(?:x(\d+))?$/iu.exec(value);
  if (!match) return {};
  return { width: Number(match[1]), height: match[2] === undefined ? undefined : Number(match[2]) };
}

function wikilinkTargetDisplay(target: string): string {
  const hash = target.indexOf("#");
  if (hash < 0) return target;
  if (target.startsWith("#")) return target.slice(hash + 1);
  return target.slice(0, hash);
}

function wikilinkTargetDisplayStart(target: string): number {
  const hash = target.indexOf("#");
  if (hash >= 0 && target.startsWith("#")) return hash + 1;
  return 0;
}

function findClosingBracket(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "[") depth += 1;
    else if (text[index] === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function findClosingParen(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function isInsideRange(index: number, ranges: readonly CodeRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
