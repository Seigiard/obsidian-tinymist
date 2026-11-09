import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function vaultPath(root: string, vaultRelativePath: string): string {
  return resolve(root, vaultRelativePath);
}

export function virtualAddress(root: string, vaultPath: string): string {
  return join(root, ".typst-cache", "notes", `${vaultPath}.typ`);
}

export function fileUri(path: string): string {
  return pathToFileURL(path).href;
}
