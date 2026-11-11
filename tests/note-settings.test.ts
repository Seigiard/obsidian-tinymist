import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNoteSetting, noteSettingsForm } from "../src/integrations/noteSettings";
import type { ParsedManifest } from "../src/kit/manifest";

const MANIFEST: ParsedManifest = {
  templates: {
    reference: "/kit/md/reference.typ",
    letter: "/kit/md/letter.typ",
    "2024": "/kit/md/2024.typ",
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
    "2024": {
      edition: { type: "str" },
    },
  },
};

function readyKit(defaultTemplate = "reference"): { state: { kind: "ready"; manifest: ParsedManifest }; defaultTemplate: string } {
  return { state: { kind: "ready", manifest: MANIFEST }, defaultTemplate };
}

function note(...properties: string[]): string {
  return ["---", "typst: true", ...properties, "---", "Body", ""].join("\n");
}

test("reports why a kit with no manifest cannot show note settings", () => {
  // #given
  const kit = { state: { kind: "none" } as const, defaultTemplate: "reference" };

  // #when
  const form = noteSettingsForm(kit, note());

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
  const form = noteSettingsForm(kit, note());

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
  const form = noteSettingsForm(kit, note());

  // #then
  assert.deepEqual(form, {
    kind: "unavailable",
    reason: "The kit manifest failed to load: manifest.yaml is invalid",
  });
});

test("lists explicit template parameters in manifest order with text values and absent values", () => {
  // #given
  const text = note(
    "typst-template: reference",
    "typst-title: Field notes",
    "typst-columns: 2",
    "typst-draft: false",
  );

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: "Field notes" },
      { name: "columns", param: { type: "int" }, value: "2" },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: "false" },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("reads CRLF frontmatter with the same template and values as LF frontmatter", () => {
  // #given
  const text = note("typst-template: letter", "typst-recipient: Ada").replaceAll("\n", "\r\n");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "recipient", param: { type: "str" }, value: "Ada" }],
  });
});

test("reads frontmatter after a leading BOM", () => {
  // #given
  const text = `\uFEFF${note("typst-template: letter", "typst-recipient: Ada")}`;

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "recipient", param: { type: "str" }, value: "Ada" }],
  });
});

test("trims an unquoted explicit template id", () => {
  // #given
  const text = note("typst-template:   letter  ");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "recipient", param: { type: "str" }, value: undefined }],
  });
});

test("preserves padding inside a quoted template id and reports the converter problem", () => {
  // #given
  const text = note('typst-template: " letter "');

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: {
      current: " letter ",
      options: ["reference", "letter", "2024"],
      explicit: true,
      problem: "Unknown Typst template  letter ",
    },
    params: [],
  });
});

test("selects a numeric-looking template id from its YAML text", () => {
  // #given
  const text = note("typst-template: 2024");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "2024", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "edition", param: { type: "str" }, value: undefined }],
  });
});

test("reports a boolean-looking template id as the converter reads it", () => {
  // #given
  const text = note("typst-template: true");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: {
      current: "true",
      options: ["reference", "letter", "2024"],
      explicit: true,
      problem: "Unknown Typst template true",
    },
    params: [],
  });
});

test("uses the default template but keeps the converter problem for an empty template property", () => {
  // #given
  const text = note("typst-template:");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: {
      current: "reference",
      options: ["reference", "letter", "2024"],
      explicit: false,
      problem: "Property template has no value",
    },
    params: [
      { name: "title", param: { type: "str" }, value: undefined },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("reports an unknown default template when an empty template property falls back to it", () => {
  // #given
  const text = note("typst-template:");

  // #when
  const form = noteSettingsForm(readyKit("missing"), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: {
      current: "missing",
      options: ["reference", "letter", "2024"],
      explicit: false,
      problem: "Unknown default Typst template missing",
    },
    params: [],
  });
});

test("keeps the form empty when both the note and settings omit a template", () => {
  // #given
  const text = note();

  // #when
  const form = noteSettingsForm(readyKit(""), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "", options: ["reference", "letter", "2024"], explicit: false },
    params: [],
  });
});

test("keeps an empty parameter value and reports its converter problem", () => {
  // #given
  const text = note("typst-template: reference", "typst-title:");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: "", problem: "Property title has no value" },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("keeps a null-like parameter as the converter's literal value text", () => {
  // #given
  const text = note("typst-template: reference", "typst-title: ~");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: "~" },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("decodes a quoted enum value and records that it remains a string", () => {
  // #given
  const text = note("typst-template: reference", 'typst-theme: "forest"');

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: undefined },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: "forest", quoted: true },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: undefined },
    ],
  });
});

test("decodes double-quoted escapes and records the quoted string type", () => {
  // #given
  const text = note("typst-template: letter", 'typst-recipient: "say \\"hi\\"\\nnext"');

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "recipient", param: { type: "str" }, value: 'say "hi"\nnext', quoted: true }],
  });
});

test("decodes doubled apostrophes in a single-quoted value", () => {
  // #given
  const text = note("typst-template: letter", "typst-recipient: 'It''s here'");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "letter", options: ["reference", "letter", "2024"], explicit: true },
    params: [{ name: "recipient", param: { type: "str" }, value: "It's here", quoted: true }],
  });
});

test("keeps a block sequence as the array parameter's current value", () => {
  // #given
  const text = note("typst-template: reference", "typst-authors:", "- Alice", "- Bob");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: undefined },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: ["Alice", "Bob"] },
    ],
  });
});

test("decodes every quoted block-sequence item as the array parameter's current value", () => {
  // #given
  const text = note("typst-template: reference", "typst-authors:", '- "Alice"', "- 'O''Brien'");

  // #when
  const form = noteSettingsForm(readyKit(), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: true },
    params: [
      { name: "title", param: { type: "str" }, value: undefined },
      { name: "columns", param: { type: "int" }, value: undefined },
      { name: "theme", param: { type: "enum", values: ["ink", "forest"] }, value: undefined },
      { name: "ratio", param: { type: "float" }, value: undefined },
      { name: "draft", param: { type: "bool" }, value: undefined },
      { name: "authors", param: { type: "array" }, value: ["Alice", "O'Brien"] },
    ],
  });
});

test("reports an unknown trimmed default template on the converter's line zero", () => {
  // #given
  const text = note();

  // #when
  const form = noteSettingsForm(readyKit("  missing  "), text);

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: {
      current: "missing",
      options: ["reference", "letter", "2024"],
      explicit: false,
      problem: "Unknown default Typst template missing",
    },
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
  const form = noteSettingsForm(kit, note());

  // #then
  assert.deepEqual(form, {
    kind: "form",
    template: { current: "reference", options: ["reference", "letter", "2024"], explicit: false },
    params: [],
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
