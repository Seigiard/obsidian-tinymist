import type { KitState } from "../kit/kit";
import type { TemplateParam } from "../kit/manifest";
import { convert, sanitizeLine, type KitView } from "../markdown/convert";
import { findFrontmatterEnd, readFrontmatter, readFrontmatterValue, unquoteTemplateId } from "../markdown/frontmatter";

export interface NoteSettingsKit {
  state: KitState;
  defaultTemplate: string;
}

export interface FormParam {
  name: string;
  param: TemplateParam;
  value: unknown | undefined;
  quoted?: boolean;
  multiline?: boolean;
  problem?: string;
}

export type NoteSettingsForm =
  | { kind: "unavailable"; reason: string }
  | {
    kind: "form";
     template: { current: string; options: string[]; explicit: boolean; problem?: string };
    params: FormParam[];
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
  text: string,
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
      const kitView: KitView = {
        templates: manifest.templates,
        defaultTemplate: kit.defaultTemplate,
      };
      const normalizedText = text.replace(/^\ufeff/u, "").replaceAll("\r\n", "\n");
      const lines = normalizedText.split("\n").map(sanitizeLine);
      const frontmatterEnd = findFrontmatterEnd(lines);
      const entries = frontmatterEnd < 0 ? [] : readFrontmatter(lines, frontmatterEnd);
      const conversion = convert(normalizedText, kitView);
      const templateEntry = entries.find((entry) => "name" in entry && entry.name === "template");
      const explicitTemplate = templateEntry !== undefined && "name" in templateEntry && !templateEntry.multiline
        ? unquoteTemplateId(templateEntry.value.trim())
        : "";
      const current = explicitTemplate !== "" ? explicitTemplate : kit.defaultTemplate.trim();
      const options = manifestTemplateIds(manifest.templates);
      const templateProblem = findProblem(
        conversion.problems,
        0,
      ) ?? findProblem(
        conversion.problems,
        templateEntry === undefined ? 0 : templateEntry.line,
      );
      if (current === "") {
        return {
          kind: "form",
          template: withProblem({ current, options, explicit: explicitTemplate !== "" }, templateProblem),
          params: [],
        };
      }
      if (!Object.prototype.hasOwnProperty.call(manifest.templates, current)) {
        return {
          kind: "form",
          template: withProblem({ current, options, explicit: explicitTemplate !== "" }, templateProblem),
          params: [],
        };
      }

      const params = Object.entries(manifest.params[current] ?? {}).map(([name, param]) => {
        const entry = entries.find((candidate) => "name" in candidate && candidate.name === name);
        const problem = entry === undefined || !("name" in entry) ? undefined : findProblem(conversion.problems, entry.line);
        const parsed = entry === undefined || !("name" in entry)
          ? undefined
          : entry.sequence === undefined
            ? readFrontmatterValue(entry.value)
            : { value: entry.sequence.map((item) => readFrontmatterValue(item).value), quoted: false };
        return {
          name,
          param,
          value: parsed?.value,
          ...(parsed?.quoted === true ? { quoted: true } : {}),
          ...(entry !== undefined && "name" in entry && entry.multiline === true && entry.sequence === undefined
            ? { multiline: true }
            : {}),
          ...(problem === undefined ? {} : { problem }),
        };
      });
      return {
        kind: "form",
        template: withProblem({ current, options, explicit: explicitTemplate !== "" }, templateProblem),
        params,
      };
    }
  }
}

function manifestTemplateIds(templates: Record<string, string>): string[] {
  const ids = Object.keys(templates);
  const numeric = ids.filter((id) => /^(?:0|[1-9]\d*)$/u.test(id));
  return [...ids.filter((id) => !numeric.includes(id)), ...numeric];
}

function findProblem(problems: readonly { line: number; message: string }[], line: number): string | undefined {
  return problems.find((problem) => problem.line === line)?.message;
}

function withProblem<T extends object>(value: T, problem: string | undefined): T & { problem?: string } {
  if (problem === undefined) return value;
  return { ...value, problem };
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
