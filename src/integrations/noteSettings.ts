import type { KitState } from "../kit/kit";
import type { TemplateParam } from "../kit/manifest";

export interface NoteSettingsKit {
  state: KitState;
  defaultTemplate: string;
}

export interface FormParam {
  name: string;
  param: TemplateParam;
  value: unknown | undefined;
}

export type NoteSettingsForm =
  | { kind: "unavailable"; reason: string }
  | {
    kind: "form";
    template: { current: string; options: string[] };
    params: FormParam[];
    unknownTemplate?: true;
  };

export function selectedTemplate(
  frontmatter: Record<string, unknown>,
  defaultTemplate: string,
): string {
  const explicit = frontmatter["typst-template"];
  const candidate = typeof explicit === "string" && explicit.trim() !== "" ? explicit : defaultTemplate;
  return candidate.trim();
}

export function noteSettingsForm(
  kit: NoteSettingsKit,
  frontmatter: Record<string, unknown>,
): NoteSettingsForm {
  switch (kit.state.kind) {
    case "none":
      return {
        kind: "unavailable",
        reason: "No kit manifest is set in the plugin settings.",
      };
    case "loading":
      return {
        kind: "unavailable",
        reason: "The kit manifest is still loading.",
      };
    case "failed":
      return {
        kind: "unavailable",
        reason: `The kit manifest failed to load: ${kit.state.reason}`,
      };
    case "ready": {
      const manifest = kit.state.manifest;
      const current = selectedTemplate(frontmatter, kit.defaultTemplate);
      const options = Object.keys(manifest.templates);
      if (current === "") {
        return {
          kind: "form",
          template: { current, options },
          params: [],
        };
      }
      if (!Object.prototype.hasOwnProperty.call(manifest.templates, current)) {
        return {
          kind: "form",
          template: { current, options },
          params: [],
          unknownTemplate: true,
        };
      }

      const params = Object.entries(manifest.params[current] ?? {}).map(([name, param]) => ({
        name,
        param,
        value: frontmatter[`typst-${name}`],
      }));
      return {
        kind: "form",
        template: { current, options },
        params,
      };
    }
  }
}

export function applyNoteSetting(
  frontmatter: Record<string, unknown>,
  name: string,
  value: unknown | undefined,
): void {
  const property = name === "template" ? "typst-template" : `typst-${name}`;
  if (value === undefined) {
    delete frontmatter[property];
  } else {
    frontmatter[property] = value;
  }
}
