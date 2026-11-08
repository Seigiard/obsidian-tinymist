interface FenceOpening {
  indentation: string;
  ticks: number;
  kind: "typ" | "other";
  word: string;
}

export interface FenceState {
  closeLine: number;
  indentation: string;
  outputTicks: number;
  kind: "typ" | "other";
}

const FENCE_WORD = /^[\p{XID_Start}_][\p{XID_Continue}_-]*$/u;

export function parseFenceOpening(line: string): FenceOpening | undefined {
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
  const firstWord = trimmed.split(/\s+/u, 1)[0];
  const word = FENCE_WORD.test(firstWord) ? firstWord : "";
  return { indentation, ticks, kind: "other", word };
}

export function analyzeFence(lines: readonly string[], openingLine: number, opening: FenceOpening): FenceState {
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
