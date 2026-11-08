import { join, posix } from "path";
import { LspClient } from "../lsp/client";

export interface ParsedManifest {
  templates: Record<string, string>;
  fontPaths: string[];
}

const activeClients = new Set<LspClient>();

/** Validate the exported kit metadata and turn its paths into plugin paths. */
export function parseManifest(
  value: unknown,
  manifestVaultDir: string,
  vaultBase: string,
): ParsedManifest | { error: string } {
  if (!isRecord(value) || value.version !== 1) {
    return { error: "Manifest version must be 1" };
  }
  if (!Array.isArray(value.templates)) {
    return { error: "Manifest templates must be an array" };
  }

  const templates: Record<string, string> = {};
  for (const template of value.templates) {
    if (!isRecord(template) || typeof template.id !== "string" || typeof template.path !== "string") {
      return { error: "Manifest template must have string id and path" };
    }
    if (Object.prototype.hasOwnProperty.call(templates, template.id)) {
      return { error: `Manifest template id is duplicated: ${template.id}` };
    }
    templates[template.id] = `/${posix.join(manifestVaultDir.replaceAll("\\", "/"), template.path)}`;
  }

  const rawFontPaths = value["font-paths"];
  if (rawFontPaths !== undefined && (!Array.isArray(rawFontPaths) || rawFontPaths.some((path) => typeof path !== "string"))) {
    return { error: "Manifest font-paths must be an array of strings" };
  }
  const fontPaths = (rawFontPaths as string[] | undefined ?? []).map((path) =>
    join(vaultBase, manifestVaultDir, path),
  );
  return { templates, fontPaths };
}

/** Read a manifest through an isolated Tinymist client without writing an export. */
export async function readManifest(
  binPath: string,
  vaultBase: string,
  manifestAbsPath: string,
  timeoutMs = 15000,
): Promise<unknown> {
  const client = new LspClient(binPath, vaultBase, () => {}, {});
  activeClients.add(client);
  try {
    await client.start();
    const result = await client.exportQuery(
      manifestAbsPath,
      { format: "json", selector: "<manifest>", field: "value", one: true },
      timeoutMs,
    );
    if (typeof result === "string") return JSON.parse(result);
    if (isRecord(result) && typeof result.data === "string") {
      return JSON.parse(Buffer.from(result.data, "base64").toString("utf8"));
    }
    return result;
  } finally {
    activeClients.delete(client);
    client.stop();
  }
}

/** Stop an isolated manifest client when its owning kit is disposed. */
export function stopManifestReads(): void {
  for (const client of activeClients) client.stop();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
