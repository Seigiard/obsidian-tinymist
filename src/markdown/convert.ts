import { convertBlock } from "./blocks";
import { analyzeFence, parseFenceOpening, type FenceState } from "./fences";
import { convertProperty, findFrontmatterEnd, hasSourceFlag, quoteString, readFrontmatter, selectTemplate } from "./frontmatter";
import { convertProseLine, type InlineState } from "./inline";
import { hasForbiddenLineBreak, MappedLineBuilder, sanitizeLine, type LineMap } from "./lineMap";

/** The kit templates available to the markdown converter: template id to Typst import path; defaultTemplate is an id, or empty for no import. */
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

/**
 * The converted note and zero-based UTF-16 line/column maps. Generated lines
 * map every column to 0. `source: false` means the note is not a print source:
 * `typ` and `problems` are empty, and both maps return the input column. A line
 * outside the note or a column past its end returns the input column unchanged.
 */
export interface Conversion {
  source: boolean;
  typ: string;
  toMd(line: number, column: number): number;
  toTyp(line: number, column: number): number;
  problems: Problem[];
}

const BUILT_INS =
  "#let template(body, ..args) = body; #let callout(kind: none, title: none, body) = std.block(inset: 6pt, stroke: 0.5pt)[*#title* #body]; ";

/** The caller strips BOM and CRLF before this call; lines are zero-based and columns are UTF-16 code units. */
export function convert(text: string, kit: KitView | null): Conversion {
  const input = typeof text === "string" ? text : String(text ?? "");
  const rawLines = input.split("\n");
  const lines = rawLines.map(sanitizeLine);
  const frontmatterEnd = findFrontmatterEnd(lines);

  if (frontmatterEnd < 0) return emptyConversion();

  const frontmatter = readFrontmatter(lines, frontmatterEnd);
  if (!hasSourceFlag(frontmatter)) return emptyConversion();

  const problems: Problem[] = [];
  const outputLines: string[] = [];
  const maps: LineMap[] = [];
  const template = selectTemplate(frontmatter, kit);
  if (template.kind === "problem") problems.push({ line: template.line, message: template.message, fatal: true });
  const templateImport = template.kind === "value" && template.path !== undefined ? `#import ${quoteString(template.path)}: *; ` : "";

  addGeneratedLine(outputLines, maps, `${BUILT_INS}${templateImport}#show: template.with(`, lines[0].length);

  const seenProperties = new Set<string>();
  let seenSourceFlag = false;
  for (const entry of frontmatter) {
    const sourceLine = lines[entry.line];
    let output = "";
    if ("name" in entry) {
      if (seenProperties.has(entry.name)) {
        problems.push({ line: entry.line, message: `Property ${entry.name} is repeated`, fatal: false });
      } else {
        seenProperties.add(entry.name);
        const result = convertProperty(entry);
        if (result.kind === "problem") problems.push({ line: entry.line, message: result.message, fatal: false });
        else if (result.kind === "value") output = `${entry.name}: ${result.literal},`;
      }
    } else if ("flag" in entry) {
      if (seenSourceFlag) problems.push({ line: entry.line, message: "Property typst is repeated", fatal: false });
      else seenSourceFlag = true;
    }
    addGeneratedLine(outputLines, maps, output, sourceLine.length);
  }

  addGeneratedLine(outputLines, maps, ")", lines[frontmatterEnd].length);

  let fence: FenceState | undefined;
  const inlineState: InlineState = { commentOpen: false };
  for (let line = frontmatterEnd + 1; line < lines.length; line += 1) {
    const sourceLine = lines[line];
    const builder = new MappedLineBuilder();

    if (fence !== undefined) {
      if (fence.closeLine === line) {
        if (fence.kind === "other") builder.appendInserted(`${fence.indentation}${"`".repeat(fence.outputTicks)}`);
        fence = undefined;
      } else {
        builder.appendSource(sourceLine, 0);
        if (fence.kind === "typ" && hasForbiddenLineBreak(rawLines[line])) {
          problems.push({ line, message: "Typst code contains a line-break character", fatal: true });
        }
        if (fence.kind === "other" && fence.closeLine < 0 && line === lines.length - 1) {
          builder.appendInserted(`${sourceLine.endsWith("`") ? " " : ""}${"`".repeat(fence.outputTicks)}`, sourceLine.length);
        }
      }
    } else {
      if (inlineState.commentOpen) {
        builder.appendBuilder(convertProseLine(sourceLine, (message) => problems.push({ line, message, fatal: false }), 0, inlineState));
      } else {
        const opening = parseFenceOpening(sourceLine);
        if (opening !== undefined) {
          const analysis = analyzeFence(lines, line, opening);
          fence = analysis;
          if (opening.kind === "other") {
            builder.appendInserted(`${opening.indentation}${"`".repeat(analysis.outputTicks)}${opening.word}`);
            if (analysis.closeLine < 0 && line === lines.length - 1) builder.appendInserted(` ${"`".repeat(analysis.outputTicks)}`);
          }
        } else if (sourceLine.startsWith("/typst")) {
          builder.appendSource(sourceLine.slice(6), 6);
          if (hasForbiddenLineBreak(rawLines[line])) {
            problems.push({ line, message: "Typst code contains a line-break character", fatal: true });
          }
        } else {
          const block = convertBlock(lines, line, inlineState, (problemLine, message) => problems.push({ line: problemLine, message, fatal: false }));
          if (block !== undefined) {
            for (let blockLine = 0; blockLine < block.lines.length; blockLine += 1) {
              const result = block.lines[blockLine].finish(lines[line + blockLine].length);
              outputLines.push(result.text);
              maps.push(result.map);
            }
            line = block.end - 1;
            continue;
          }
          builder.appendBuilder(convertProseLine(sourceLine, (message) => problems.push({ line, message, fatal: false }), 0, inlineState));
        }
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
      if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || line >= maps.length || column < 0 || column >= maps[line].toMd.length) return column;
      return maps[line].toMd[column];
    },
    toTyp(line, column) {
      if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || line >= maps.length || column < 0 || column >= maps[line].toTyp.length) return column;
      return maps[line].toTyp[column];
    },
    problems,
  };
}

function addGeneratedLine(output: string[], maps: LineMap[], line: string, sourceLength: number): void {
  const builder = new MappedLineBuilder();
  builder.appendInserted(line);
  const result = builder.finish(sourceLength);
  output.push(result.text);
  maps.push(result.map);
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
