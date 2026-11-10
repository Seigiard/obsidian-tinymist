import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { installPropertySuggestions } from "../src/integrations/propertySuggestions";
import type { ParsedManifest } from "../src/kit/manifest";
import TinymistPlugin from "../src/main";
import { TFile, testApp, type TestApp, type TestPropertyEntry } from "./support/obsidian";

type ReadyKit = { manifest: ParsedManifest; defaultTemplate: string };

const MANIFEST = {
  templates: { reference: "/kit/md/reference.typ", letter: "/kit/md/letter.typ" },
  fontPaths: [],
  params: {
    reference: {
      columns: { type: "int" },
      theme: { type: "enum", values: ["ink", "forest"] },
      ratio: { type: "float" },
      draft: { type: "bool" },
      authors: { type: "array" },
      title: { type: "str" },
    },
    letter: {},
  },
} as unknown as ParsedManifest;

const NATIVE_PROPERTIES: Record<string, TestPropertyEntry> = {
  tags: { name: "tags", widget: "multitext", occurrences: 3 },
};

function propertyEntry(name: string, widget: string): TestPropertyEntry {
  return { name, widget, occurrences: 0 };
}

function propertyHarness(options: {
  frontmatter?: Record<string, unknown>;
  kit?: ReadyKit | null;
  nativeProperties?: Record<string, TestPropertyEntry>;
} = {}): {
  app: TestApp;
  focusNameField(): void;
  removeNameField(): void;
  restore: (() => void) | null;
  originals: {
    getAllProperties: TestApp["metadataTypeManager"]["getAllProperties"];
    getAssignedWidget: TestApp["metadataTypeManager"]["getAssignedWidget"];
    getValues: TestApp["metadataCache"]["getFrontmatterPropertyValuesForKey"];
  };
} {
  const app = testApp();
  const file = new TFile("Notes/Plan.md");
  app.workspace.activeFile = file;
  app.metadataCache.setFrontmatter(file.path, options.frontmatter ?? { typst: true, "typst-template": "reference" });
  app.metadataTypeManager.properties = options.nativeProperties ?? { ...NATIVE_PROPERTIES };
  const originals = {
    getAllProperties: app.metadataTypeManager.getAllProperties,
    getAssignedWidget: app.metadataTypeManager.getAssignedWidget,
    getValues: app.metadataCache.getFrontmatterPropertyValuesForKey,
  };
  const nameField = document.createElement("input");
  nameField.className = "metadata-property-key";
  document.body.append(nameField);
  const restore = installPropertySuggestions(app as never, () => options.kit === undefined
    ? { manifest: MANIFEST, defaultTemplate: "reference" }
    : options.kit,
  );
  return {
    app,
    focusNameField: () => nameField.focus(),
    removeNameField: () => nameField.remove(),
    restore,
    originals,
  };
}

test("a focused typst note lists its selected template parameters before native properties", () => {
  // #given
  const h = propertyHarness();
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
        properties: {
          "typst-template": propertyEntry("typst-template", "text"),
          "typst-columns": propertyEntry("typst-columns", "number"),
          "typst-theme": propertyEntry("typst-theme", "text"),
          "typst-ratio": propertyEntry("typst-ratio", "number"),
          "typst-draft": propertyEntry("typst-draft", "checkbox"),
          "typst-authors": propertyEntry("typst-authors", "multitext"),
          "typst-title": propertyEntry("typst-title", "text"),
          tags: NATIVE_PROPERTIES.tags,
        },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a focused typst note with no selected template lists only typst-template", () => {
  // #given
  const h = propertyHarness({
    frontmatter: { typst: true },
    kit: { manifest: MANIFEST, defaultTemplate: "missing" },
  });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "tags"],
        properties: { "typst-template": propertyEntry("typst-template", "text"), tags: NATIVE_PROPERTIES.tags },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a focused typst note uses its ready default template when no template is set", () => {
  // #given
  const h = propertyHarness({ frontmatter: { typst: true } });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
        properties: {
          "typst-template": { name: "typst-template", widget: "text", occurrences: 0 },
          "typst-columns": { name: "typst-columns", widget: "number", occurrences: 0 },
          "typst-theme": { name: "typst-theme", widget: "text", occurrences: 0 },
          "typst-ratio": { name: "typst-ratio", widget: "number", occurrences: 0 },
          "typst-draft": { name: "typst-draft", widget: "checkbox", occurrences: 0 },
          "typst-authors": { name: "typst-authors", widget: "multitext", occurrences: 0 },
          "typst-title": { name: "typst-title", widget: "text", occurrences: 0 },
          tags: { name: "tags", widget: "multitext", occurrences: 3 },
        },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a focused typst note lowercases a camel-case key without changing its suggested name", () => {
  // #given
  const manifest = {
    ...MANIFEST,
    params: { ...MANIFEST.params, reference: { fontSize: { type: "int" } } },
  } as unknown as ParsedManifest;
  const h = propertyHarness({ kit: { manifest, defaultTemplate: "reference" } });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "typst-fontsize", "tags"],
        properties: {
          "typst-template": propertyEntry("typst-template", "text"),
          "typst-fontsize": propertyEntry("typst-fontSize", "number"),
          tags: NATIVE_PROPERTIES.tags,
        },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a focused typst note treats blank templates and surrounding whitespace as absent or trimmed", () => {
  // #given
  const cases = [
    { frontmatter: { typst: true, "typst-template": "" }, defaultTemplate: " reference " },
    { frontmatter: { typst: true, "typst-template": " \t " }, defaultTemplate: " reference " },
    { frontmatter: { typst: true, "typst-template": null }, defaultTemplate: " reference " },
    { frontmatter: { typst: true, "typst-template": " reference " }, defaultTemplate: "letter" },
  ];
  const harnesses = cases.map(({ frontmatter, defaultTemplate }) => propertyHarness({
    frontmatter,
    kit: { manifest: MANIFEST, defaultTemplate },
  }));
  harnesses.forEach((h) => h.focusNameField());

  // #when
  const keys = harnesses.map((h) => Object.keys(h.app.metadataTypeManager.getAllProperties()));

  // #then
  try {
    assert.deepEqual(keys, [
      ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
      ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
      ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
      ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
    ]);
  } finally {
    harnesses.forEach((h) => {
      h.restore?.();
      h.removeNameField();
    });
  }
});

test("a focused typst note with an unknown template does not fall back to its default", () => {
  // #given
  const h = propertyHarness({ frontmatter: { typst: true, "typst-template": "missing" } });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "tags"],
        properties: {
          "typst-template": { name: "typst-template", widget: "text", occurrences: 0 },
          tags: { name: "tags", widget: "multitext", occurrences: 3 },
        },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a native template parameter keeps its native entry in the suggested parameter position", () => {
  // #given
  const h = propertyHarness({
    nativeProperties: {
      "typst-columns": { name: "typst-columns", widget: "date", occurrences: 9 },
      tags: { name: "tags", widget: "multitext", occurrences: 3 },
    },
  });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst-template", "typst-columns", "typst-theme", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "tags"],
        properties: {
          "typst-template": { name: "typst-template", widget: "text", occurrences: 0 },
          "typst-columns": { name: "typst-columns", widget: "date", occurrences: 9 },
          "typst-theme": { name: "typst-theme", widget: "text", occurrences: 0 },
          "typst-ratio": { name: "typst-ratio", widget: "number", occurrences: 0 },
          "typst-draft": { name: "typst-draft", widget: "checkbox", occurrences: 0 },
          "typst-authors": { name: "typst-authors", widget: "multitext", occurrences: 0 },
          "typst-title": { name: "typst-title", widget: "text", occurrences: 0 },
          tags: { name: "tags", widget: "multitext", occurrences: 3 },
        },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a focused ordinary note hides all typst parameters but keeps the typst flag", () => {
  // #given
  const h = propertyHarness({
    frontmatter: {},
    nativeProperties: { ...NATIVE_PROPERTIES, "typst-template": propertyEntry("typst-template", "text") },
  });
  h.focusNameField();

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.deepEqual(
      { keys: Object.keys(properties), properties },
      {
        keys: ["typst", "tags"],
        properties: { typst: propertyEntry("typst", "checkbox"), tags: NATIVE_PROPERTIES.tags },
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a typst note replaces template and enum values while preserving unrelated native values", () => {
  // #given
  const h = propertyHarness();
  h.app.metadataCache.frontmatterPropertyValues = ["native typo"];

  // #when
  const values = [
    h.app.metadataCache.getFrontmatterPropertyValuesForKey("TYPST-TEMPLATE"),
    h.app.metadataCache.getFrontmatterPropertyValuesForKey("typst-theme"),
    h.app.metadataCache.getFrontmatterPropertyValuesForKey("typst-columns"),
  ];

  // #then
  try {
    assert.deepEqual(values, [["reference", "letter"], ["ink", "forest"], ["native typo"]]);
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("a typst note assigns parameter widgets without changing persisted metadata types", () => {
  // #given
  const h = propertyHarness();
  h.app.metadataTypeManager.assignedWidgets = { "typst-columns": "text", unrelated: "date" };

  // #when
  const widgets = ["typst", "typst-columns", "typst-ratio", "typst-draft", "typst-authors", "typst-title", "typst-theme", "unrelated"]
    .map((name) => [name, h.app.metadataTypeManager.getAssignedWidget(name)]);

  // #then
  try {
    assert.deepEqual(
      { widgets, saveCalls: h.app.metadataTypeManager.saveCalls, setTypeCalls: h.app.metadataTypeManager.setTypeCalls },
      {
        widgets: [
          ["typst", "checkbox"],
          ["typst-columns", "number"],
          ["typst-ratio", "number"],
          ["typst-draft", "checkbox"],
          ["typst-authors", "multitext"],
          ["typst-title", "text"],
          ["typst-theme", "text"],
          ["unrelated", "date"],
        ],
        saveCalls: 0,
        setTypeCalls: 0,
      },
    );
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("an ordinary note keeps ready-kit values and parameter widgets native while typst stays a checkbox", () => {
  // #given
  const h = propertyHarness({ frontmatter: {} });
  h.app.metadataCache.frontmatterPropertyValues = ["native value"];
  h.app.metadataTypeManager.assignedWidgets = { "typst-columns": "date" };

  // #when
  const actual = {
    templateValues: h.app.metadataCache.getFrontmatterPropertyValuesForKey("typst-template"),
    themeValues: h.app.metadataCache.getFrontmatterPropertyValuesForKey("typst-theme"),
    columnsWidget: h.app.metadataTypeManager.getAssignedWidget("typst-columns"),
    typstWidget: h.app.metadataTypeManager.getAssignedWidget("typst"),
  };

  // #then
  try {
    assert.deepEqual(actual, {
      templateValues: ["native value"],
      themeValues: ["native value"],
      columnsWidget: "date",
      typstWidget: "checkbox",
    });
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("outside a property name field, the native property collection keeps its identity", () => {
  // #given
  const h = propertyHarness();
  const native = h.app.metadataTypeManager.properties;

  // #when
  const properties = h.app.metadataTypeManager.getAllProperties();

  // #then
  try {
    assert.equal(properties, native);
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("without a ready kit, only the typst flag changes the native panel data", () => {
  // #given
  const h = propertyHarness({ kit: null });
  h.app.metadataCache.frontmatterPropertyValues = ["native value"];
  h.focusNameField();

  // #when
  const actual = {
    properties: h.app.metadataTypeManager.getAllProperties(),
    values: h.app.metadataCache.getFrontmatterPropertyValuesForKey("typst-template"),
    widget: h.app.metadataTypeManager.getAssignedWidget("typst-columns"),
    typstWidget: h.app.metadataTypeManager.getAssignedWidget("typst"),
  };

  // #then
  try {
    assert.deepEqual(actual, {
      properties: { typst: propertyEntry("typst", "checkbox"), tags: NATIVE_PROPERTIES.tags },
      values: ["native value"],
      widget: "text",
      typstWidget: "checkbox",
    });
  } finally {
    h.restore?.();
    h.removeNameField();
  }
});

test("the installer restores private methods and leaves a surviving private method usable", () => {
  // #given
  const h = propertyHarness();
  const valueOnly = testApp();
  const file = new TFile("Notes/Value-only.md");
  valueOnly.workspace.activeFile = file;
  valueOnly.metadataCache.setFrontmatter(file.path, { typst: true });
  const restoreValueOnly = installPropertySuggestions({
    ...valueOnly,
    metadataTypeManager: {},
  } as never, () => ({ manifest: MANIFEST, defaultTemplate: "reference" }));

  // #when
  h.restore?.();
  const valueOnlyResult = valueOnly.metadataCache.getFrontmatterPropertyValuesForKey("typst-template");

  // #then
  try {
    assert.deepEqual(
      {
        restored: {
          getAllProperties: h.app.metadataTypeManager.getAllProperties === h.originals.getAllProperties,
          getAssignedWidget: h.app.metadataTypeManager.getAssignedWidget === h.originals.getAssignedWidget,
          getValues: h.app.metadataCache.getFrontmatterPropertyValuesForKey === h.originals.getValues,
        },
        valueOnlyResult,
        hasRestore: restoreValueOnly !== null,
      },
      {
        restored: { getAllProperties: true, getAssignedWidget: true, getValues: true },
        valueOnlyResult: ["reference", "letter"],
        hasRestore: true,
      },
    );
  } finally {
    restoreValueOnly?.();
    h.removeNameField();
  }
});

class PropertySuggestionsPlugin extends TinymistPlugin {
  async startLsp(_restart: boolean): Promise<void> {}
}

test("plugin load patches property suggestions and unload restores the original methods", async () => {
  // #given
  const app = testApp();
  const originals = {
    getAllProperties: app.metadataTypeManager.getAllProperties,
    getAssignedWidget: app.metadataTypeManager.getAssignedWidget,
    getValues: app.metadataCache.getFrontmatterPropertyValuesForKey,
  };
  const plugin = new PropertySuggestionsPlugin(app as never, {});

  // #when
  await plugin.onload();
  const patched = {
    getAllProperties: app.metadataTypeManager.getAllProperties !== originals.getAllProperties,
    getAssignedWidget: app.metadataTypeManager.getAssignedWidget !== originals.getAssignedWidget,
    getValues: app.metadataCache.getFrontmatterPropertyValuesForKey !== originals.getValues,
  };
  plugin.onunload();
  plugin.unload();

  // #then
  assert.deepEqual(
    {
      patched,
      restored: {
        getAllProperties: app.metadataTypeManager.getAllProperties === originals.getAllProperties,
        getAssignedWidget: app.metadataTypeManager.getAssignedWidget === originals.getAssignedWidget,
        getValues: app.metadataCache.getFrontmatterPropertyValuesForKey === originals.getValues,
      },
    },
    {
      patched: { getAllProperties: true, getAssignedWidget: true, getValues: true },
      restored: { getAllProperties: true, getAssignedWidget: true, getValues: true },
    },
  );
});
