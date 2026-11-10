import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNoteSetting, noteSettingsForm } from "../src/integrations/noteSettings";
import type { ParsedManifest } from "../src/kit/manifest";

const MANIFEST: ParsedManifest = {
  templates: {
    reference: "/kit/md/reference.typ",
    letter: "/kit/md/letter.typ",
  },
  fontPaths: [],
  params: {
    reference: {
      title: { type: "str" },
      columns: { type: "int" },
      theme: { type: "enum", values: ["ink", "forest"] },
      ratio: { type: "float" },
      draft: { type: "bool" },
      authors: { type: "array" },
    },
    letter: {
      recipient: { type: "str" },
    },
  },
};

function readyKit(defaultTemplate = "reference"): { state: { kind: "ready"; manifest: ParsedManifest }; defaultTemplate: string } {
  return { state: { kind: "ready", manifest: MANIFEST }, defaultTemplate };
}

test("reports why a kit with no manifest cannot show note settings", () => {
  // #given
  const kit = { state: { kind: "none" } as const, defaultTemplate: "reference" };

  // #when
  const form = noteSettingsForm(kit, { typst: true });

  // #then
  assert.deepEqual(form, {
    kind: "unavailable",
    reason: "No kit manifest is set in the plugin settings.",
  });
});

test("reports when a kit manifest is still loading", () => {
  // #given
  const kit = { state: { kind: "loading", previous: MANIFEST } as const, defaultTemplate: "reference" };

  // #when
  const form = noteSettingsForm(kit, { typst: true });

  // #then
  assert.deepEqual(form, {
    kind: "unavailable",
    reason: "The kit manifest is still loading.",
  });
});

test("reports the kit manifest load failure", () => {
  // #given
  const kit = { state: { kind: "failed", reason: "manifest.yaml is invalid" } as const, defaultTemplate: "reference" };

  // #when
  const form = noteSettingsForm(kit, { typst: true });

  // #then
  assert.deepEqual(form, {
    kind: "unavailable",
    reason: "The kit manifest failed to load: manifest.yaml is invalid",
  });
});

test("lists the explicit template parameters in manifest order with their frontmatter values", () => {
  // #given
  const frontmatter = {
    typst: true,
    "typst-template": "reference",
    "typst-title": "Field notes",
    "typst-columns": 2,
    "typst-draft": false,
  };

  // #when
  const form = noteSettingsForm(readyKit(), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter"] },
    params: [
      { name: "title", param: { type: "str" }, value: "Field notes" },
      { name: "columns", param: { type: "int" }, value: 2 },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: false },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("uses the default template when frontmatter has no string template", () => {
  // #given
  const frontmatter = { typst: true, "typst-template": false, "typst-recipient": "Ada" };

  // #when
  const form = noteSettingsForm(readyKit("letter"), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter"] },
    params: [{ name: "recipient", param: { type: "str" }, value: "Ada" }],
  });
});

test("keeps an empty resolved template as the default selection", () => {
  // #given
  const frontmatter = { typst: true };

  // #when
  const form = noteSettingsForm(readyKit(""), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "", options: ["reference", "letter"] },
    params: [],
  });
});

test("keeps a valid template form empty when the manifest declares no parameters", () => {
  // #given
  const kit = {
    state: { kind: "ready" as const, manifest: { ...MANIFEST, params: {} } },
    defaultTemplate: "reference",
  };

  // #when
  const form = noteSettingsForm(kit, { typst: true });

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter"] },
    params: [],
  });
});

test("uses the trimmed default template when the explicit template is empty", () => {
  // #given
  const frontmatter = { typst: true, "typst-template": "" };

  // #when
  const form = noteSettingsForm(readyKit("  letter  "), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter"] },
    params: [{ name: "recipient", param: { type: "str" }, value: undefined }],
  });
});

test("uses a trimmed explicit template id", () => {
  // #given
  const frontmatter = { typst: true, "typst-template": "  letter  " };

  // #when
  const form = noteSettingsForm(readyKit(), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter"] },
    params: [{ name: "recipient", param: { type: "str" }, value: undefined }],
  });
});

test("uses a trimmed default template when frontmatter has no string template", () => {
  // #given
  const frontmatter = { typst: true, "typst-template": false };

  // #when
  const form = noteSettingsForm(readyKit("  letter  "), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter"] },
    params: [{ name: "recipient", param: { type: "str" }, value: undefined }],
  });
});

test("retains an unknown selected template without inventing parameters", () => {
  // #given
  const frontmatter = { typst: true, "typst-template": "missing" };

  // #when
  const form = noteSettingsForm(readyKit(), frontmatter);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "missing", options: ["reference", "letter"] },
    params: [],
    unknownTemplate: true,
  });
});

test("writes a parameter value without changing unrelated frontmatter", () => {
  // #given
  const frontmatter: Record<string, unknown> = {
    typst: true,
    tags: ["draft"],
    "typst-template": "reference",
  };

  // #when
  applyNoteSetting(frontmatter, "columns", 3);

  // #then
  assert.deepEqual(frontmatter, {
    typst: true,
    tags: ["draft"],
    "typst-template": "reference",
    "typst-columns": 3,
  });
});

test("writes a selected template under the typst template property", () => {
  // #given
  const frontmatter: Record<string, unknown> = {
    typst: true,
    title: "Quarterly letter",
    "typst-template": "reference",
  };

  // #when
  applyNoteSetting(frontmatter, "template", "letter");

  // #then
  assert.deepEqual(frontmatter, {
    typst: true,
    title: "Quarterly letter",
    "typst-template": "letter",
  });
});

test("clears only the requested typst setting", () => {
  // #given
  const frontmatter: Record<string, unknown> = {
    typst: true,
    tags: ["draft"],
    "typst-template": "reference",
    "typst-theme": "forest",
  };

  // #when
  applyNoteSetting(frontmatter, "theme", undefined);

  // #then
  assert.deepEqual(frontmatter, {
    typst: true,
    tags: ["draft"],
    "typst-template": "reference",
  });
});

test("clears the selected template without changing other frontmatter", () => {
  // #given
  const frontmatter: Record<string, unknown> = {
    typst: true,
    tags: ["draft"],
    "typst-template": "reference",
    "typst-theme": "forest",
  };

  // #when
  applyNoteSetting(frontmatter, "template", undefined);

  // #then
  assert.deepEqual(frontmatter, {
    typst: true,
    tags: ["draft"],
    "typst-theme": "forest",
  });
});
