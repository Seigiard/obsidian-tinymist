import type { KitView, Problem } from "./convert";

export interface FrontmatterPropertyEntry {
  line: number;
  name: string;
  value: string;
  multiline: boolean;
}

export interface FrontmatterLineEntry {
  line: number;
}

export type FrontmatterEntry = FrontmatterPropertyEntry | FrontmatterLineEntry;

export type PropertyConversion = { kind: "value"; literal: string } | { kind: "skip" } | { kind: "problem"; message: string };

interface ParsedQuotedValue {
  value: string;
  failure?: string;
}

type ValueFailure = "empty" | "multiline" | "malformed" | "quoted" | "deep" | "escape";

type ValueResult = { literal: string } | { failure: ValueFailure; escape?: string };

interface TemplateSelection {
  path: string | undefined;
}

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

export function hasSourceFlag(lines: readonly string[], end: number): boolean {
  return lines.slice(1, end).some((line) => {
    const match = /^typst:(.*)$/u.exec(line);
    return match !== null && stripYamlComment(match[1]).trim() === "true";
  });
}

export function readFrontmatter(lines: readonly string[], end: number): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (let line = 1; line < end; line += 1) {
    const property = parseProperty(lines[line]);
    if (property) {
      entries.push({
        line,
        name: property.name,
        value: property.value,
        multiline: isBlockValue(property.value) || isIndentedNonBlank(lines[line + 1]),
      });
    } else {
      entries.push({ line });
    }
  }
  return entries;
}

export function selectTemplate(entries: readonly FrontmatterEntry[], kit: KitView | null, problems: Problem[]): TemplateSelection {
  let explicit: { line: number; id: string } | undefined;
  for (const entry of entries) {
    if ("name" in entry && entry.name === "template" && !entry.multiline && explicit === undefined) {
      const id = unquoteTemplateId(entry.value.trim());
      if (id !== "") explicit = { line: entry.line, id };
    }
  }

  if (explicit !== undefined) {
    const path = lookupTemplate(kit, explicit.id);
    if (path === undefined) {
      problems.push({ line: explicit.line, message: `Unknown Typst template ${explicit.id || "<empty>"}`, fatal: true });
    }
    return { path };
  }

  const defaultTemplate = kit && typeof kit.defaultTemplate === "string" ? kit.defaultTemplate.trim() : "";
  if (defaultTemplate === "") return { path: undefined };
  const path = lookupTemplate(kit, defaultTemplate);
  if (path === undefined) {
    problems.push({ line: 0, message: `Unknown default Typst template ${defaultTemplate}`, fatal: true });
  }
  return { path };
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
    return entry.multiline ? { kind: "problem", message: "Property template has a multi-line value" } : { kind: "skip" };
  }
  const parsed = entry.multiline ? { failure: "multiline" as const } : parseValue(entry.value);
  if ("failure" in parsed) return { kind: "problem", message: propertyFailureMessage(entry.name, parsed) };
  return { kind: "value", literal: parsed.literal };
}

function lookupTemplate(kit: KitView | null, id: string): string | undefined {
  if (!kit || !kit.templates || typeof kit.templates !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(kit.templates, id)) return undefined;
  const path = kit.templates[id];
  return typeof path === "string" ? path : undefined;
}

function parseProperty(line: string): { name: string; value: string } | undefined {
  const match = /^typst-([^:]*):[ \t]*(.*)$/u.exec(line);
  return match === null ? undefined : { name: match[1], value: stripYamlComment(match[2]) };
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

function propertyFailureMessage(name: string, result: { failure: ValueFailure; escape?: string }): string {
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
      return `Property ${name} has an unknown escape ${result.escape ?? "\\"}`;
  }
}

function parseValue(value: string, depth = 0): ValueResult {
  const trimmed = value.trim();
  if (trimmed === "") return { failure: "empty" };
  if (isBlockValue(trimmed)) return { failure: "multiline" };
  if (trimmed === "true" || trimmed === "false" || NUMBER.test(trimmed)) return { literal: trimmed };
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseArray(trimmed, depth);
  if (trimmed.startsWith('"')) {
    if (!isCompleteQuotedScalar(trimmed, '"')) return { failure: "quoted" };
    const decoded = decodeDoubleQuoted(trimmed.slice(1, -1));
    return decoded.failure === undefined
      ? { literal: quoteString(decoded.value) }
      : { failure: "escape", escape: decoded.failure };
  }
  if (trimmed.startsWith("'")) {
    if (!isCompleteQuotedScalar(trimmed, "'")) return { failure: "quoted" };
    return { literal: quoteString(trimmed.slice(1, -1).replaceAll("''", "'")) };
  }
  return { literal: quoteString(trimmed) };
}

function isCompleteQuotedScalar(value: string, quote: string): boolean {
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote === '"' && character === "\\") {
      if (index + 1 >= value.length) return false;
      index += 1;
      continue;
    }
    if (character === quote) return index === value.length - 1;
  }
  return false;
}

function isBlockValue(value: string): boolean {
  return /^[|>](?:[+-]?[0-9]?|[0-9]?[+-]?)[ \t]*$/u.test(value);
}

function parseArray(value: string, depth: number): ValueResult {
  if (depth >= MAX_ARRAY_DEPTH) return { failure: "deep" };
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
      quote = character;
      quoteAllowed = false;
    } else if (!/\s/u.test(character)) {
      quoteAllowed = false;
    }
  }
  if (quote !== undefined || depth !== 0) return undefined;
  const last = value.slice(start).trim();
  if (last !== "") items.push(last);
  return items.length === 0 ? undefined : items;
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
    if (escape === undefined) return { value: result, failure: "\\" };
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
      if (digits.length === width && new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(digits) && codePoint <= 0x10ffff) {
        result += String.fromCodePoint(codePoint);
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
    if (character === "#" && depth === 0 && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) return value.slice(0, index).trimEnd();
    if (!/\s/u.test(character)) quoteAllowed = false;
  }
  return value.trimEnd();
}
