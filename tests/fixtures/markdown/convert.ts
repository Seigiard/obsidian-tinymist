import { convert as implementation } from "../../../src/markdown/convert";
import type { Conversion, KitView } from "../../../src/markdown/convert";

export type { Conversion, KitView };

export function convert(text: string, kit: KitView | null): Conversion {
  return implementation(text, kit);
}
