export interface KitView {
  templates: Record<string, string>;
  defaultTemplate: string;
}

export interface Conversion {
  source: boolean;
  typ: string;
  toMd(line: number, column: number): number;
  toTyp(line: number, column: number): number;
  problems: { line: number; message: string; fatal: boolean }[];
}

type Convert = (text: string, kit: KitView | null) => Conversion;

let implementation: Convert | undefined;
try {
  implementation = require("../../../src/markdown/convert").convert as Convert;
} catch {
  // The production module is created by the implementer after this test lock.
}

export function convert(text: string, kit: KitView | null): Conversion {
  if (!implementation) throw new Error("convert is not implemented");
  return implementation(text, kit);
}
