export interface LineMap {
  toMd: number[];
  toTyp: number[];
}

interface Piece {
  text: string;
  sourceStart: number;
  sourceLength: number;
  identity: boolean;
}

export const FORBIDDEN_LINE_BREAKS = new Set(["\r", "\u000b", "\f", "\u0085", "\u2028", "\u2029"]);

export class MappedLineBuilder {
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
    this.appendMapped(text, anchor, 0);
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

export function sanitizeLine(line: string): string {
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

export function isForbiddenLineBreak(character: string): boolean {
  return FORBIDDEN_LINE_BREAKS.has(character);
}

export function hasForbiddenLineBreak(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isForbiddenLineBreak(text[index])) return true;
  }
  return false;
}
