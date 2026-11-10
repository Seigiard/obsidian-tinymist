import { patchMethod } from "./exportRedirect";
import type { ParsedManifest, TemplateParam } from "../kit/manifest";

export interface PropertySuggestionKit {
  manifest: ParsedManifest;
  defaultTemplate: string;
}

interface PropertyEntry {
  name: string;
  widget: string;
  occurrences: number;
}

interface MetadataTypeManager {
  getAllProperties?: () => Record<string, PropertyEntry>;
  getAssignedWidget?: (name: string) => string;
}

interface FrontmatterCache {
  frontmatter?: Record<string, unknown>;
}

interface MetadataCache {
  getCache?: (path: string) => FrontmatterCache | null;
  getFrontmatterPropertyValuesForKey?: (key: string) => string[];
}

interface PropertySuggestionApp {
  metadataTypeManager?: MetadataTypeManager;
  metadataCache?: MetadataCache;
  workspace?: {
    getActiveFile?: () => { path: string } | null;
  };
}

export function installPropertySuggestions(
  app: unknown,
  kit: () => PropertySuggestionKit | null,
): (() => void) | null {
  const propertyApp = app as PropertySuggestionApp;
  const patches: Array<{ restore(): void }> = [];
  const manager = propertyApp.metadataTypeManager;
  const cache = propertyApp.metadataCache;

  if (manager) {
    const propertiesPatch = patchMethod(manager, "getAllProperties", (original, isActive) =>
      function (this: MetadataTypeManager, ...args: unknown[]): unknown {
        const native = original.apply(this, args) as Record<string, PropertyEntry>;
        if (!isActive() || !hasPropertyNameFocus()) return native;

        const frontmatter = activeFrontmatter(propertyApp);
        const readyKit = kit();
        const typstNote = frontmatter?.typst === true;
        const result: Record<string, PropertyEntry> = {};
        if (typstNote && readyKit) {
          addProperty(result, native, "typst-template", "text");
          const template = selectedTemplate(frontmatter, readyKit);
          if (template) {
            for (const [name, parameter] of Object.entries(readyKit.manifest.params[template] ?? {})) {
              addProperty(result, native, `typst-${name.toLowerCase()}`, widgetForParam(parameter), `typst-${name}`);
            }
          }
        } else {
          addProperty(result, native, "typst", "checkbox");
        }

        for (const [name, entry] of Object.entries(native)) {
          const lowerName = name.toLowerCase();
          if (!typstNote && lowerName.startsWith("typst-")) continue;
          if (Object.keys(result).some((suggested) => suggested.toLowerCase() === lowerName)) continue;
          result[name] = entry;
        }
        return result;
      },
    );
    if (propertiesPatch) patches.push(propertiesPatch);

    const widgetPatch = patchMethod(manager, "getAssignedWidget", (original, isActive) =>
      function (this: MetadataTypeManager, ...args: unknown[]): unknown {
        const name = args[0];
        if (!isActive() || typeof name !== "string") return original.apply(this, args);
        const lowerName = name.toLowerCase();
        if (lowerName === "typst") return "checkbox";

        const frontmatter = activeFrontmatter(propertyApp);
        const readyKit = kit();
        if (frontmatter?.typst !== true || !readyKit) return original.apply(this, args);
        if (lowerName === "typst-template") return "text";
        const template = selectedTemplate(frontmatter, readyKit);
        if (!template || !lowerName.startsWith("typst-")) return original.apply(this, args);
        const parameterName = lowerName.slice("typst-".length);
        const parameter = Object.entries(readyKit.manifest.params[template] ?? {})
          .find(([candidate]) => candidate.toLowerCase() === parameterName)?.[1];
        return parameter ? widgetForParam(parameter) : original.apply(this, args);
      },
    );
    if (widgetPatch) patches.push(widgetPatch);
  }

  if (cache) {
    const valuesPatch = patchMethod(cache, "getFrontmatterPropertyValuesForKey", (original, isActive) =>
      function (this: MetadataCache, ...args: unknown[]): unknown {
        const name = args[0];
        if (!isActive() || typeof name !== "string") return original.apply(this, args);
        const frontmatter = activeFrontmatter(propertyApp);
        const readyKit = kit();
        if (frontmatter?.typst !== true || !readyKit) return original.apply(this, args);
        const lowerName = name.toLowerCase();
        if (lowerName === "typst-template") return Object.keys(readyKit.manifest.templates);
        const template = selectedTemplate(frontmatter, readyKit);
        if (!template || !lowerName.startsWith("typst-")) return original.apply(this, args);
        const parameterName = lowerName.slice("typst-".length);
        const parameter = Object.entries(readyKit.manifest.params[template] ?? {})
          .find(([candidate]) => candidate.toLowerCase() === parameterName)?.[1];
        return parameter?.type === "enum" ? parameter.values : original.apply(this, args);
      },
    );
    if (valuesPatch) patches.push(valuesPatch);
  }

  if (patches.length === 0) return null;
  return () => {
    for (const patch of patches.reverse()) patch.restore();
  };
}

function activeFrontmatter(app: PropertySuggestionApp): Record<string, unknown> | null {
  const file = app.workspace?.getActiveFile?.();
  if (!file) return null;
  return app.metadataCache?.getCache?.(file.path)?.frontmatter ?? null;
}

function hasPropertyNameFocus(): boolean {
  const scope = globalThis as typeof globalThis & { activeDocument?: { activeElement?: { closest?: (selector: string) => unknown } | null } };
  const active = (scope.activeDocument ?? scope.document)?.activeElement;
  return typeof active?.closest === "function" && active.closest(".metadata-property-key") !== null;
}

function selectedTemplate(frontmatter: Record<string, unknown>, kit: PropertySuggestionKit): string | null {
  const explicit = frontmatter["typst-template"];
  const candidate = typeof explicit === "string" && explicit.trim() !== "" ? explicit : kit.defaultTemplate;
  if (typeof candidate !== "string") return null;
  const id = candidate.trim();
  if (id === "" || !Object.prototype.hasOwnProperty.call(kit.manifest.templates, id)) return null;
  return id;
}

function addProperty(
  result: Record<string, PropertyEntry>,
  native: Record<string, PropertyEntry>,
  name: string,
  widget: string,
  displayName = name,
): void {
  const nativeName = Object.keys(native).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  result[name] = nativeName === undefined
    ? { name: displayName, widget, occurrences: 0 }
    : native[nativeName];
}

function widgetForParam(parameter: TemplateParam): string {
  switch (parameter.type) {
    case "int":
    case "float":
      return "number";
    case "bool":
      return "checkbox";
    case "array":
      return "multitext";
    case "str":
    case "enum":
      return "text";
  }
}
