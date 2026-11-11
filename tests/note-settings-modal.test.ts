import "./support/dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NoteSettingsModal } from "../src/integrations/noteSettingsModal";
import type { NoteSettingsKit } from "../src/integrations/noteSettings";
import type { ParsedManifest } from "../src/kit/manifest";
import { TFile, testApp, type TestApp } from "./support/obsidian";

const MANIFEST: ParsedManifest = {
  templates: {
    reference: "/kit/md/reference.typ",
    letter: "/kit/md/letter.typ",
  },
  fontPaths: [],
  params: {
    reference: {
      title: { type: "enum", values: ["short", "long"] },
      columns: { type: "int" },
      ratio: { type: "float" },
      draft: { type: "bool" },
      subtitle: { type: "str" },
      authors: { type: "array" },
    },
    letter: {
      recipient: { type: "str" },
    },
  },
};

const READY_KIT: NoteSettingsKit = {
  state: { kind: "ready", manifest: MANIFEST },
  defaultTemplate: "reference",
};

afterEach(() => document.body.replaceChildren());

function note(...properties: string[]): string {
  return ["---", "typst: true", ...properties, "---", "Body", ""].join("\n");
}

function openModal(
  text: string,
  kit: NoteSettingsKit = READY_KIT,
): { app: TestApp; file: TFile; modal: NoteSettingsModal } {
  const app = testApp();
  const file = new TFile("Notes/Plan.md");
  app.vault.files.set(file.path, text);
  const modal = new NoteSettingsModal(app as never, file as never, kit);
  modal.open();
  return { app, file, modal };
}

test("the frontmatter stand-in distinguishes a bare empty value from an empty string", async () => {
  // #given
  const app = testApp();
  const file = new TFile("Notes/Plan.md");
  const original = note("typst-title: custom");
  app.vault.files.set(file.path, original);

  // #when
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter["typst-title"] = null;
  });
  app.vault.files.set(file.path, original);
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter["typst-title"] = "";
  });

  // #then
  assert.deepEqual(app.vault.writes, [
    { path: "Notes/Plan.md", data: note("typst-title:") },
    { path: "Notes/Plan.md", data: note('typst-title: ""') },
  ]);
});

function setting(content: HTMLElement, name: string): HTMLElement | undefined {
  return [...content.querySelectorAll<HTMLElement>(".setting-item")]
    .find((row) => row.querySelector(".setting-item-name")?.textContent === name);
}

async function flushWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("Enter writes an integer once without replacing or blurring its input", async () => {
  // #given
  const original = note("typst-template: reference", "typst-columns: 1");
  const { app, modal } = openModal(original);
  await waitFor(() => setting(modal.contentEl, "typst-columns") !== undefined);
  const input = setting(modal.contentEl, "typst-columns")!.querySelector("input")!;
  input.value = "3";
  input.focus();

  // #when
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor(() => app.vault.writes.length === 1);

  // #then
  assert.deepEqual(
    {
      writes: app.vault.writes,
      inputUnchanged: setting(modal.contentEl, "typst-columns")!.querySelector("input") === input,
      activeElementUnchanged: document.activeElement === input,
    },
    {
      writes: [{ path: "Notes/Plan.md", data: note("typst-template: reference", "typst-columns: 3") }],
      inputUnchanged: true,
      activeElementUnchanged: true,
    },
  );
});

test("leaving a text field writes its value", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template: reference", "typst-subtitle: Before"));
  await waitFor(() => setting(modal.contentEl, "typst-subtitle") !== undefined);
  const input = setting(modal.contentEl, "typst-subtitle")!.querySelector("input")!;
  input.value = "After";

  // #when
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => app.vault.writes.length === 1);

  // #then
  assert.deepEqual(app.vault.writes, [
    { path: "Notes/Plan.md", data: note("typst-template: reference", "typst-subtitle: After") },
  ]);
});

test("closing the modal writes a typed value that was not otherwise committed", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template: reference", "typst-subtitle: Before"));
  await waitFor(() => setting(modal.contentEl, "typst-subtitle") !== undefined);
  setting(modal.contentEl, "typst-subtitle")!.querySelector("input")!.value = "After";

  // #when
  modal.close();
  await waitFor(() => app.vault.writes.length === 1);

  // #then
  assert.deepEqual(app.vault.writes, [
    { path: "Notes/Plan.md", data: note("typst-template: reference", "typst-subtitle: After") },
  ]);
});

test("closing the modal preserves an untouched quoted empty string", async () => {
  // #given
  const original = note("typst-template: reference", 'typst-subtitle: ""');
  const { app, file, modal } = openModal(original);
  await waitFor(() => setting(modal.contentEl, "typst-subtitle") !== undefined);

  // #when
  modal.close();
  await new Promise<void>((resolve) => setImmediate(resolve));

  // #then
  assert.deepEqual(
    { writes: app.vault.writes, text: app.vault.files.get(file.path) },
    { writes: [], text: note("typst-template: reference", 'typst-subtitle: ""') },
  );
});

for (const [kind, property] of [
  ["block scalar", ["typst-subtitle: |", "  First line", "  Second line"]],
  ["nested map", ["typst-subtitle:", "  first: line", "  second: line"]],
] as const) {
  test(`a ${kind} property is read-only and Enter, change, and close preserve it`, async () => {
    // #given
    const original = note("typst-template: reference", ...property);
    const { app, file, modal } = openModal(original);
    await waitFor(() => setting(modal.contentEl, "typst-subtitle") !== undefined);
    const row = setting(modal.contentEl, "typst-subtitle")!;
    const eventTarget = row.querySelector("input, select") ?? row;

    // #when
    eventTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    eventTarget.dispatchEvent(new Event("change", { bubbles: true }));
    modal.close();
    await flushWrites();

    // #then
    assert.deepEqual(
      {
        description: row.querySelector(".setting-item-description")!.textContent,
        controls: row.querySelectorAll("input, select").length,
        writes: app.vault.writes,
        text: app.vault.files.get(file.path),
      },
      {
        description: "Type: str. Multi-line value. Edit in Properties. Property subtitle has a multi-line value",
        controls: 0,
        writes: [],
        text: original,
      },
    );
  });
}

test("closing the modal preserves an untouched list-valued property", async () => {
  // #given
  const original = note("typst-template: reference", "typst-subtitle:", "- Alice", "- Bob");
  const { app, file, modal } = openModal(original);
  await waitFor(() => setting(modal.contentEl, "typst-subtitle") !== undefined);

  // #when
  modal.close();
  await new Promise<void>((resolve) => setImmediate(resolve));

  // #then
  assert.deepEqual(
    { writes: app.vault.writes, text: app.vault.files.get(file.path) },
    { writes: [], text: note("typst-template: reference", "typst-subtitle:", "- Alice", "- Bob") },
  );
});

test("an invalid integer writes nothing on Enter or close", async () => {
  // #given
  const original = note("typst-template: reference", "typst-columns: 1");
  const { app, file, modal } = openModal(original);
  await waitFor(() => setting(modal.contentEl, "typst-columns") !== undefined);
  const input = setting(modal.contentEl, "typst-columns")!.querySelector("input")!;
  input.value = "1.5";

  // #when
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  modal.close();
  await new Promise<void>((resolve) => setImmediate(resolve));

  // #then
  assert.deepEqual(
    { writes: app.vault.writes, text: app.vault.files.get(file.path) },
    { writes: [], text: original },
  );
});

for (const field of ["subtitle", "columns"] as const) {
  test(`committing an existing empty ${field} field removes its property`, async () => {
    // #given
    const property = `typst-${field}`;
    const { app, modal } = openModal(note("typst-template: reference", `${property}:`));
    await waitFor(() => setting(modal.contentEl, property) !== undefined);
    const input = setting(modal.contentEl, property)!.querySelector("input")!;

    // #when
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // #then
    assert.deepEqual(app.vault.writes, [
      { path: "Notes/Plan.md", data: note("typst-template: reference") },
    ]);
  });
}

test("changing the template rereads the note and renders the new template rows", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template: reference"));
  await waitFor(() => setting(modal.contentEl, "Template") !== undefined);
  const template = setting(modal.contentEl, "Template")!.querySelector("select")!;
  template.value = "letter";

  // #when
  template.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => setting(modal.contentEl, "typst-recipient") !== undefined);

  // #then
  assert.deepEqual(
    {
      reads: app.vault.reads,
      writes: app.vault.writes,
      rows: [...modal.contentEl.querySelectorAll(".setting-item-name")].map((element) => element.textContent),
    },
    {
      reads: ["Notes/Plan.md", "Notes/Plan.md"],
      writes: [{ path: "Notes/Plan.md", data: note("typst-template: letter") }],
      rows: ["Template", "typst-recipient"],
    },
  );
});

test("a parameter write rereads every problem without replacing controls or focus", async () => {
  // #given
  const original = note("typst-template:", "typst-title:", "typst-columns:");
  const { app, file, modal } = openModal(original);
  await waitFor(() => setting(modal.contentEl, "typst-columns") !== undefined);
  const originalProcessFrontMatter = app.fileManager.processFrontMatter.bind(app.fileManager);
  app.fileManager.processFrontMatter = async (target, update): Promise<void> => {
    await originalProcessFrontMatter(target, update);
    app.vault.files.set(target.path, note("typst-title: short", "typst-columns: 3"));
  };
  const templateRow = setting(modal.contentEl, "Template")!;
  const templateSelect = templateRow.querySelector("select")!;
  const titleRow = setting(modal.contentEl, "typst-title")!;
  const titleSelect = titleRow.querySelector("select")!;
  const columnsRow = setting(modal.contentEl, "typst-columns")!;
  const columnsInput = columnsRow.querySelector("input")!;
  columnsInput.value = "3";
  columnsInput.focus();

  // #when
  columnsInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flushWrites();

  // #then
  assert.deepEqual(
    {
      reads: app.vault.reads,
      writes: app.vault.writes,
      descriptions: [...modal.contentEl.querySelectorAll(".setting-item-description")]
        .map((element) => element.textContent),
      templateProblems: [...modal.contentEl.children]
        .filter((element) => element.tagName === "P")
        .map((element) => element.textContent),
      templateRowUnchanged: setting(modal.contentEl, "Template") === templateRow,
      templateSelectUnchanged: setting(modal.contentEl, "Template")!.querySelector("select") === templateSelect,
      titleRowUnchanged: setting(modal.contentEl, "typst-title") === titleRow,
      titleSelectUnchanged: setting(modal.contentEl, "typst-title")!.querySelector("select") === titleSelect,
      columnsRowUnchanged: setting(modal.contentEl, "typst-columns") === columnsRow,
      columnsInputUnchanged: setting(modal.contentEl, "typst-columns")!.querySelector("input") === columnsInput,
      activeElementUnchanged: document.activeElement === columnsInput,
      text: app.vault.files.get(file.path),
    },
    {
      reads: ["Notes/Plan.md", "Notes/Plan.md"],
      writes: [{ path: "Notes/Plan.md", data: note("typst-template:", "typst-title:", "typst-columns: 3") }],
      descriptions: [
        "Manifest template",
        "Type: enum",
        "Type: int",
        "Type: float",
        "Type: bool",
        "Type: str",
        "Type: array. Current: Default. Edit in Properties.",
      ],
      templateProblems: [],
      templateRowUnchanged: true,
      templateSelectUnchanged: true,
      titleRowUnchanged: true,
      titleSelectUnchanged: true,
      columnsRowUnchanged: true,
      columnsInputUnchanged: true,
      activeElementUnchanged: true,
      text: note("typst-title: short", "typst-columns: 3"),
    },
  );
});

test("the note text selects the rows on open", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template: letter"));

  // #when
  await waitFor(() => modal.contentEl.querySelector(".setting-item-name") !== null);

  // #then
  assert.deepEqual(
    {
      reads: app.vault.reads,
      rows: [...modal.contentEl.querySelectorAll(".setting-item-name")].map((element) => element.textContent),
    },
    {
      reads: ["Notes/Plan.md"],
      rows: ["Template", "typst-recipient"],
    },
  );
});

test("without an explicit template the dropdown selects Default while default-template rows render", async () => {
  // #given
  const { modal } = openModal(note());

  // #when
  await waitFor(() => setting(modal.contentEl, "typst-authors") !== undefined);
  const template = setting(modal.contentEl, "Template")!.querySelector("select")!;

  // #then
  assert.deepEqual(
    {
      selected: template.value,
      rows: [...modal.contentEl.querySelectorAll(".setting-item-name")].map((element) => element.textContent),
    },
    {
      selected: "",
      rows: [
        "Template",
        "typst-title",
        "typst-columns",
        "typst-ratio",
        "typst-draft",
        "typst-subtitle",
        "typst-authors",
      ],
    },
  );
});

test("an empty template has its own selected choice and choosing Default removes it", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template:", "typst-title:"));
  await waitFor(() => setting(modal.contentEl, "typst-title") !== undefined);
  const templateRow = setting(modal.contentEl, "Template")!;
  const template = templateRow.querySelector("select")!;
  const initial = {
    selectedLabel: template.selectedOptions[0]?.textContent,
    selectedIsDefault: template.value === "",
    labels: [...template.options].map((option) => option.textContent),
    templateProblem: templateRow.nextElementSibling?.textContent,
  };
  template.value = "";

  // #when
  template.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => app.vault.writes.length === 1);

  // #then
  assert.deepEqual(
    { initial, writes: app.vault.writes },
    {
      initial: {
        selectedLabel: "(empty)",
        selectedIsDefault: false,
        labels: ["Default", "(empty)", "reference", "letter"],
        templateProblem: "Property template has no value",
      },
      writes: [{ path: "Notes/Plan.md", data: note("typst-title:") }],
    },
  );
});

test("choosing Default removes an empty enum property and keeps its converter problem visible until the write", async () => {
  // #given
  const { app, modal } = openModal(note("typst-template: reference", "typst-title:"));
  await waitFor(() => setting(modal.contentEl, "typst-title") !== undefined);
  const titleRow = setting(modal.contentEl, "typst-title")!;
  const title = titleRow.querySelector("select")!;
  const initial = {
    selectedLabel: title.selectedOptions[0]?.textContent,
    labels: [...title.options].map((option) => option.textContent),
    description: titleRow.querySelector(".setting-item-description")!.textContent,
  };
  title.value = "";

  // #when
  title.dispatchEvent(new Event("change", { bubbles: true }));
  await flushWrites();

  // #then
  assert.deepEqual(
    { initial, writes: app.vault.writes },
    {
      initial: {
        selectedLabel: "(empty)",
        labels: ["Default", "(empty)", "short", "long"],
        description: "Type: enum. Property title has no value",
      },
      writes: [{ path: "Notes/Plan.md", data: note("typst-template: reference") }],
    },
  );
});

test("quoted bool and number values stay strings and are identified as quoted", async () => {
  // #given
  const { modal } = openModal(note(
    "typst-template: reference",
    'typst-columns: "3"',
    'typst-ratio: "1.5"',
    'typst-draft: "false"',
  ));

  // #when
  await waitFor(() => setting(modal.contentEl, "typst-draft") !== undefined);
  const columnsRow = setting(modal.contentEl, "typst-columns")!;
  const ratioRow = setting(modal.contentEl, "typst-ratio")!;
  const draftRow = setting(modal.contentEl, "typst-draft")!;
  const draft = draftRow.querySelector("select")!;

  // #then
  assert.deepEqual(
    {
      columns: {
        value: columnsRow.querySelector("input")!.value,
        description: columnsRow.querySelector(".setting-item-description")!.textContent,
      },
      ratio: {
        value: ratioRow.querySelector("input")!.value,
        description: ratioRow.querySelector(".setting-item-description")!.textContent,
      },
      draft: {
        selectedLabel: draft.selectedOptions[0]?.textContent,
        selectedIsTypedFalse: draft.value === "false",
        optionCount: draft.options.length,
        description: draftRow.querySelector(".setting-item-description")!.textContent,
      },
    },
    {
      columns: {
        value: "3",
        description: "Type: int. Quoted: the template receives a string",
      },
      ratio: {
        value: "1.5",
        description: "Type: float. Quoted: the template receives a string",
      },
      draft: {
        selectedLabel: "false",
        selectedIsTypedFalse: false,
        optionCount: 4,
        description: "Type: bool. Quoted: the template receives a string",
      },
    },
  );
});

test("a YAML block sequence is shown as the array row's current value", async () => {
  // #given
  const { modal } = openModal(note(
    "typst-template: reference",
    "typst-authors:",
    "- Alice",
    "- Bob",
  ));

  // #when
  await waitFor(() => setting(modal.contentEl, "typst-authors") !== undefined);

  // #then
  assert.equal(
    setting(modal.contentEl, "typst-authors")!.querySelector(".setting-item-description")!.textContent,
    "Type: array. Current: Alice, Bob. Edit in Properties.",
  );
});

test("quoted YAML block-sequence items are decoded in the array row's current value", async () => {
  // #given
  const { modal } = openModal(note(
    "typst-template: reference",
    "typst-authors:",
    '- "Alice"',
    "- 'O''Brien'",
  ));

  // #when
  await waitFor(() => setting(modal.contentEl, "typst-authors") !== undefined);

  // #then
  assert.equal(
    setting(modal.contentEl, "typst-authors")!.querySelector(".setting-item-description")!.textContent,
    "Type: array. Current: Alice, O'Brien. Edit in Properties.",
  );
});

test("an enum value outside the manifest choices remains its own selected option", async () => {
  // #given
  const { modal } = openModal(note("typst-template: reference", "typst-title: custom"));

  // #when
  await waitFor(() => setting(modal.contentEl, "typst-title") !== undefined);
  const select = setting(modal.contentEl, "typst-title")!.querySelector("select")!;

  // #then
  assert.deepEqual(
    { selected: select.value, labels: [...select.options].map((option) => option.textContent) },
    { selected: "custom", labels: ["Default", "custom", "short", "long"] },
  );
});

for (const scenario of [
  {
    kind: "enum",
    property: "typst-title",
    original: "custom",
    alternate: "short",
    alternateValue: "short",
  },
  {
    kind: "bool",
    property: "typst-draft",
    original: "yes",
    alternate: "true",
    alternateValue: "true",
  },
] as const) {
  test(`a non-standard ${scenario.kind} choice is a no-op when selected and restores its original text`, async () => {
    // #given
    const { app, modal } = openModal(note("typst-template: reference", `${scenario.property}: ${scenario.original}`));
    await waitFor(() => setting(modal.contentEl, scenario.property) !== undefined);
    const select = setting(modal.contentEl, scenario.property)!.querySelector("select")!;
    const originalOption = select.value;

    // #when
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();
    const writesAfterNoop = [...app.vault.writes];
    select.value = scenario.alternate;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();
    select.value = originalOption;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();

    // #then
    assert.deepEqual(
      {
        selectedLabel: select.selectedOptions[0]?.textContent,
        writesAfterNoop,
        writes: app.vault.writes,
      },
      {
        selectedLabel: scenario.original,
        writesAfterNoop: [],
        writes: [
          {
            path: "Notes/Plan.md",
            data: note("typst-template: reference", `${scenario.property}: ${scenario.alternateValue}`),
          },
          {
            path: "Notes/Plan.md",
            data: note("typst-template: reference", `${scenario.property}: ${scenario.original}`),
          },
        ],
      },
    );
  });
}

for (const scenario of [
  { kind: "enum", property: "typst-title", alternate: "short", alternateValue: "short" },
  { kind: "bool", property: "typst-draft", alternate: "true", alternateValue: "true" },
] as const) {
  test(`an empty ${scenario.kind} choice is a no-op when selected and restores the bare empty property`, async () => {
    // #given
    const { app, modal } = openModal(note("typst-template: reference", `${scenario.property}:`));
    await waitFor(() => setting(modal.contentEl, scenario.property) !== undefined);
    const select = setting(modal.contentEl, scenario.property)!.querySelector("select")!;
    const originalOption = select.value;

    // #when
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();
    const writesAfterNoop = [...app.vault.writes];
    select.value = scenario.alternate;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();
    select.value = originalOption;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushWrites();

    // #then
    assert.deepEqual(
      {
        selectedLabel: select.selectedOptions[0]?.textContent,
        writesAfterNoop,
        writes: app.vault.writes,
      },
      {
        selectedLabel: "(empty)",
        writesAfterNoop: [],
        writes: [
          {
            path: "Notes/Plan.md",
            data: note("typst-template: reference", `${scenario.property}: ${scenario.alternateValue}`),
          },
          {
            path: "Notes/Plan.md",
            data: note("typst-template: reference", `${scenario.property}:`),
          },
        ],
      },
    );
  });
}

test("an unavailable kit renders only its reason", async () => {
  // #given
  const kit: NoteSettingsKit = { state: { kind: "none" }, defaultTemplate: "reference" };
  const { app, modal } = openModal(note(), kit);

  // #when
  await waitFor(() => modal.contentEl.textContent !== "");

  // #then
  assert.deepEqual(
    {
      reads: app.vault.reads,
      text: modal.contentEl.textContent,
      controls: modal.contentEl.querySelectorAll("input, select, button").length,
    },
    {
      reads: ["Notes/Plan.md"],
      text: "No kit manifest is set in the plugin settings.",
      controls: 0,
    },
  );
});
