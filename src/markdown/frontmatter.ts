import type { KitView } from "./convert";

interface FrontmatterPropertyEntry {
  line: number;
  name: string;
  value: string;
  multiline: boolean;
  empty: boolean;
  sequence?: string[];
}

interface FrontmatterLineEntry {
  line: number;
}

type FrontmatterFlagEntry = {
  line: number;
  value: string;
  multiline: boolean;
  empty: boolean;
  flag: true;
};

type FrontmatterEntry = FrontmatterPropertyEntry | FrontmatterFlagEntry | FrontmatterLineEntry;

type PropertyConversion = { kind: "value"; literal: string } | { kind: "skip" } | { kind: "problem"; message: string };

type ParsedQuotedValue = { value: string } | { escape: string };

type ValueFailure = "empty" | "multiline" | "malformed" | "quoted" | "deep" | "escape";

type FailedValueResult = { failure: Exclude<ValueFailure, "escape"> } | { failure: "escape"; escape: string };
type ValueResult = { literal: string } | FailedValueResult;

type TemplateConversion = { kind: "value"; path: string | undefined } | { kind: "problem"; line: number; message: string };

const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
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
const DOUBLE_QUOTE_ESCAPES = new Map([
  ["\\", "\\"],
  ['"', '"'],
  ["'", "'"],
  ["/", "/"],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["0", "\0"],
  [" ", " "],
]);

export function findFrontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return -1;
  for (let line = 1; line < lines.length; line += 1) {
    if (lines[line] === "---") return line;
  }
  return -1;
}

export function hasSourceFlag(entries: readonly FrontmatterEntry[]): boolean {
  const flag = entries.find((entry) => "flag" in entry);
  return flag !== undefined && !flag.multiline && flag.value.trim() === "true";
}

export function readFrontmatter(lines: readonly string[], end: number): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (let line = 1; line < end; line += 1) {
    const property = parseProperty(lines[line]);
    if (property) {
      const multiline = isBlockValue(property.value) || hasContinuation(lines, line, end, property.value);
      if (property.kind === "flag") entries.push({ line, value: property.value, multiline, empty: property.empty, flag: true });
      else entries.push({
        line,
        name: property.name,
        value: property.value,
        multiline,
        empty: property.empty,
        sequence: property.name === "template" || property.value.trim() !== ""
          ? undefined
          : readSequence(lines, line, end),
      });
    } else {
      entries.push({ line });
    }
  }
  return entries;
}

export function selectTemplate(entries: readonly FrontmatterEntry[], kit: KitView | null): TemplateConversion {
  for (const entry of entries) {
    if ("name" in entry && entry.name === "template") {
      if (entry.multiline) break;
      const id = unquoteTemplateId(entry.value.trim());
      if (id !== "") {
        const path = lookupTemplate(kit, id);
        if (path === undefined) {
          return { kind: "problem", line: entry.line, message: `Unknown Typst template ${id}` };
        }
        return { kind: "value", path };
      }
      break;
    }
  }

  const defaultTemplate = kit && typeof kit.defaultTemplate === "string" ? kit.defaultTemplate.trim() : "";
  if (defaultTemplate === "") return { kind: "value", path: undefined };
  const path = lookupTemplate(kit, defaultTemplate);
  if (path === undefined) {
    return { kind: "problem", line: 0, message: `Unknown default Typst template ${defaultTemplate}` };
  }
  return { kind: "value", path };
}

export function quoteString(value: string): string {
  let result = '"';
  for (const character of value) {
    switch (character) {
      case "\\":
        result += "\\\\";
        break;
      case '"':
        result += '\\"';
        break;
      case "\n":
        result += "\\n";
        break;
      case "\t":
        result += "\\t";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\0":
        result += "\\u{0}";
        break;
      case "\u000b":
        result += "\\u{b}";
        break;
      case "\f":
        result += "\\u{c}";
        break;
      case "\u0085":
        result += "\\u{85}";
        break;
      case "\u2028":
        result += "\\u{2028}";
        break;
      case "\u2029":
        result += "\\u{2029}";
        break;
      default:
        result += character;
    }
  }
  return `${result}"`;
}

export function convertProperty(entry: FrontmatterPropertyEntry): PropertyConversion {
  if (!PROPERTY_NAME.test(entry.name) || INVALID_PROPERTY_NAMES.has(entry.name)) {
    return { kind: "problem", message: `Property name ${entry.name || "<empty>"} is not a Typst identifier` };
  }
  if (entry.name === "template") {
    if (entry.multiline) return { kind: "problem", message: "Property template has a multi-line value" };
    if (entry.empty) {
      return { kind: "problem", message: "Property template has no value" };
    }
    return { kind: "skip" };
  }
  const parsed = entry.sequence !== undefined
    ? parseSequence(entry.sequence)
    : entry.multiline
      ? { failure: "multiline" as const }
      : parseValue(entry.value);
  if ("failure" in parsed) return { kind: "problem", message: propertyFailureMessage(entry.name, parsed) };
  return { kind: "value", literal: parsed.literal };
}

function lookupTemplate(kit: KitView | null, id: string): string | undefined {
  if (!kit || !kit.templates || typeof kit.templates !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(kit.templates, id)) return undefined;
  const path = kit.templates[id];
  return typeof path === "string" ? path : undefined;
}

function parseProperty(line: string):
  | { kind: "flag"; value: string; empty: boolean }
  | { kind: "property"; name: string; value: string; empty: boolean }
  | undefined {
  if (line.startsWith("typst:")) {
    const rawValue = line.slice("typst:".length);
    if (rawValue === "" || /^[ \t]/u.test(rawValue)) {
      return { kind: "flag", value: stripYamlComment(rawValue), empty: rawValue.trim() === "" };
    }
  }
  const match = /^typst-([^:]*):[ \t]*(.*)$/u.exec(line);
  return match === null
    ? undefined
    : { kind: "property", name: match[1], value: stripYamlComment(match[2]), empty: match[2].trim() === "" };
}

/** A continuation is an indented line, blank lines before one, or a column-0 `- ` sequence. */
function hasContinuation(lines: readonly string[], line: number, end: number, value: string): boolean {
  for (let next = line + 1; next < end; next += 1) {
    const trimmed = lines[next].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (value.trim() === "" && /^-([ \t]|$)/u.test(lines[next])) return true;
    return /^[ \t]+\S/u.test(lines[next]);
  }
  return false;
}

function readSequence(lines: readonly string[], line: number, end: number): string[] | undefined {
  const items: string[] = [];
  let blockScalar = false;
  for (let next = line + 1; next < end; next += 1) {
    const trimmed = lines[next].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const marker = /^[ \t]*-([ \t]|$)/u.exec(lines[next]);
    if (blockScalar && marker === null && /^[ \t]+\S/u.test(lines[next])) continue;
    blockScalar = false;
    if (marker !== null) {
      const item = stripYamlComment(lines[next].slice(marker[0].length));
      items.push(item);
      blockScalar = isBlockValue(item.trim());
      continue;
    }
    if (/^[ \t]+\S/u.test(lines[next])) return undefined;
    break;
  }
  return items.length === 0 ? undefined : items;
}

function unquoteTemplateId(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function propertyFailureMessage(name: string, result: FailedValueResult): string {
  switch (result.failure) {
    case "empty":
      return `Property ${name} has no value`;
    case "multiline":
      return `Property ${name} has a multi-line value`;
    case "malformed":
      return `Property ${name} has a malformed list`;
    case "quoted":
      return `Property ${name} has a malformed value`;
    case "deep":
      return `Property ${name} nests lists deeper than ${MAX_ARRAY_DEPTH} levels`;
    case "escape":
      return `Property ${name} has an unknown escape ${result.escape}`;
  }
}

function parseValue(value: string, depth = 0): ValueResult {
  const trimmed = value.trim();
  if (trimmed === "") return { failure: "empty" };
  if (isBlockValue(trimmed)) return { failure: "multiline" };
  if (trimmed === "true" || trimmed === "false" || NUMBER.test(trimmed)) return { literal: trimmed };
  if (trimmed.startsWith("[")) return parseArray(trimmed, depth);
  if (trimmed.startsWith('"')) {
    if (!isCompleteQuotedScalar(trimmed)) return { failure: "quoted" };
    const decoded = decodeDoubleQuoted(trimmed.slice(1, -1));
    return "escape" in decoded ? { failure: "escape", escape: decoded.escape } : { literal: quoteString(decoded.value) };
  }
  if (trimmed.startsWith("'")) {
    if (!isCompleteQuotedScalar(trimmed)) return { failure: "quoted" };
    return { literal: quoteString(trimmed.slice(1, -1).replaceAll("''", "'")) };
  }
  return { literal: quoteString(trimmed) };
}

function isCompleteQuotedScalar(value: string): boolean {
  return findClosingQuote(value, 0) === value.length - 1;
}

function isBlockValue(value: string): boolean {
  return /^[|>](?:[+-]?[0-9]?|[0-9]?[+-]?)[ \t]*$/u.test(value);
}

function parseArray(value: string, depth: number): ValueResult {
  if (depth >= MAX_ARRAY_DEPTH) return { failure: "deep" };
  if (!value.endsWith("]")) return { failure: "malformed" };
  const inner = value.slice(1, -1).trim();
  if (inner === "") return { literal: "()" };
  const items = splitArrayItems(inner);
  if (items === undefined) return { failure: "malformed" };
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

function parseSequence(items: readonly string[]): ValueResult {
  if (items.some((item) => item.trim() === "")) return { failure: "malformed" };
  const literals: string[] = [];
  for (const item of items) {
    const parsed = parseValue(item, 1);
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
  let quoteAllowed = true;
  let afterQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "[") {
      if (afterQuote) return undefined;
      depth += 1;
      quoteAllowed = true;
    } else if (character === "]") {
      depth -= 1;
      if (depth < 0) return undefined;
      quoteAllowed = false;
    } else if (character === ",") {
      if (depth === 0) {
        const item = value.slice(start, index).trim();
        if (item === "") return undefined;
        items.push(item);
        start = index + 1;
      }
      quoteAllowed = true;
      afterQuote = false;
    } else if (afterQuote) {
      if (!/\s/u.test(character)) return undefined;
    } else if ((character === '"' || character === "'") && quoteAllowed) {
      const closing = findClosingQuote(value, index);
      if (closing < 0) return undefined;
      index = closing;
      quoteAllowed = false;
      afterQuote = true;
    } else if (!/\s/u.test(character)) {
      quoteAllowed = false;
    }
  }
  if (depth !== 0) return undefined;
  const last = value.slice(start).trim();
  if (last !== "") items.push(last);
  return items;
}

function decodeDoubleQuoted(value: string): ParsedQuotedValue {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[index + 1];
    const simple = DOUBLE_QUOTE_ESCAPES.get(escape);
    if (simple !== undefined) {
      result += simple;
      index += 1;
      continue;
    }
    const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (width > 0) {
      const digits = value.slice(index + 2, index + 2 + width);
      const codePoint = Number.parseInt(digits, 16);
      if (new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(digits)) {
        if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          result += String.fromCodePoint(codePoint);
          index += width + 1;
          continue;
        }
        return { escape: value.slice(index, index + width + 2) };
      }
    }
    return { escape: `\\${escape}` };
  }
  return { value: result };
}

function findClosingQuote(value: string, start: number): number {
  const quote = value[start];
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote === '"' && character === "\\") {
      if (index + 1 >= value.length) return -1;
      index += 1;
      continue;
    }
    if (character === quote) return index;
  }
  return -1;
}

function stripYamlComment(value: string): string {
  const isArray = value.trimStart().startsWith("[");
  let depth = 0;
  let quoteAllowed = true;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && quoteAllowed) {
      const closing = findClosingQuote(value, index);
      if (closing < 0) return value.trimEnd();
      index = closing;
      quoteAllowed = false;
      continue;
    }
    if (isArray && character === "[") {
      depth += 1;
      quoteAllowed = true;
      continue;
    }
    if (isArray && character === "]") {
      depth = Math.max(0, depth - 1);
      quoteAllowed = false;
      continue;
    }
    if (isArray && character === "," && depth > 0) {
      quoteAllowed = true;
      continue;
    }
    if (character === "#" && depth === 0 && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) return value.slice(0, index).trimEnd();
    if (!/\s/u.test(character)) quoteAllowed = false;
  }
  return value.trimEnd();
}
