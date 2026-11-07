import { join } from "node:path";

export function virtualAddress(root: string, vaultPath: string): string {
  return `${join(root, vaultPath)}.typ`;
}
