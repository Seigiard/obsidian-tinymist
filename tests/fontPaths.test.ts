import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { typstMathAt } from "../src/editor/typstFragment";
import { FragmentBackend, TypstRender } from "../src/editor/typstRender";
import { LspClient } from "../src/lsp/client";
import { TypstFragmentRenderer } from "../src/lsp/fragmentRenderer";
import TinymistPlugin from "../src/main";
import { DEFAULT_SETTINGS, TinymistSettings } from "../src/settings";

interface FontPathLspClientConstructor {
  new (
    binPath: string,
    rootPath: string,
    onDiagnostics: (uri: string) => void,
    options: { fontPaths: readonly string[] },
  ): LspClient;
}

interface FontPathFragmentRendererConstructor {
  new (options: {
    bin(): string | null;
    root: string;
    fontPaths(): readonly string[];
  }): TypstFragmentRenderer;
}

interface RecordedMessage {
  direction: "from-client" | "to-client";
  message: {
    method?: string;
    params?: {
      initializationOptions?: { fontPaths?: readonly string[] };
      settings?: { fontPaths?: readonly string[]; typstExtraArgs?: readonly string[] };
    };
  };
}

interface FontPathSettings extends TinymistSettings {
  fontPaths: readonly string[];
}

const FontPathLspClient = LspClient as unknown as FontPathLspClientConstructor;
const FontPathFragmentRenderer = TypstFragmentRenderer as unknown as FontPathFragmentRendererConstructor;
const LSP_FIXTURE = resolve("tests/support/font-path-lsp.mjs");
const RENDER_ROOT = resolve("tests/fixtures");
const RENDER_FILE = join(RENDER_ROOT, "book", "chapters", "ch1.typ");
const RENDER_TEXT = readFileSync(RENDER_FILE, "utf8");
const FIRST_RENDERED_SVG =
  '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M 1 1h 2v 2h -2Z"/></svg>';
const SECOND_RENDERED_SVG =
  '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg"><path fill="#0d0e0f" d="M 2 2h 3v 3h -3Z"/></svg>';

function renderPage(): string {
  return [
    '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg">',
    '<g transform="translate(0 16)"><path fill="#010203" d="M 0 0h 1v 1h -1Z"/></g>',
    '<path fill="#0a0b0c" d="M 1 1h 2v 2h -2Z"/></svg>',
  ].join("");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the fake language server");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function received(log: string, method: string): RecordedMessage[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedMessage)
    .filter((entry) => entry.direction === "from-client" && entry.message.method === method);
}

async function withFakeServer<T>(run: (vault: string, messages: (method: string) => RecordedMessage[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tinymist-font-paths-"));
  const log = join(dir, "messages.jsonl");
  const before = process.env.FONT_PATH_LSP_LOG;
  chmodSync(LSP_FIXTURE, 0o755);
  process.env.FONT_PATH_LSP_LOG = log;
  try {
    return await run(dir, (method) => received(log, method));
  } finally {
    if (before === undefined) delete process.env.FONT_PATH_LSP_LOG;
    else process.env.FONT_PATH_LSP_LOG = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withLifecycleServer<T>(
  run: (vault: string, bin: string, messages: (method: string) => RecordedMessage[]) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tinymist-font-path-lifecycle-"));
  const log = join(dir, "messages.jsonl");
  const starts = join(dir, "starts");
  const bin = join(dir, "lsp.mjs");
  const beforeLog = process.env.FONT_PATH_LSP_LOG;
  const beforeStarts = process.env.FONT_PATH_LSP_STARTS;
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const log = process.env.FONT_PATH_LSP_LOG;
const starts = process.env.FONT_PATH_LSP_STARTS;
const start = existsSync(starts) ? Number(readFileSync(starts, "utf8")) + 1 : 1;
writeFileSync(starts, String(start));
const page = Buffer.from(start === 1
  ? '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0 16)"><path fill="#010203" d="M 0 0h 1v 1h -1Z"/></g><path fill="#0a0b0c" d="M 1 1h 2v 2h -2Z"/></svg>'
  : '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0 16)"><path fill="#010203" d="M 0 0h 1v 1h -1Z"/></g><path fill="#0d0e0f" d="M 2 2h 3v 3h -3Z"/></svg>'
).toString("base64");
let buffer = Buffer.alloc(0);
function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(json, "utf8")}\\r\\n\\r\\n\${json}\`);
}
function respond(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  } else if (message.method === "initialized") {
    send({ jsonrpc: "2.0", id: "configuration", method: "workspace/configuration", params: { items: [{ section: "tinymist" }] } });
  } else if (message.method === "workspace/executeCommand") {
    send({ jsonrpc: "2.0", id: message.id, result: { items: [{ page: 0, data: page }] } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"))?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    if (message.method !== "shutdown" && message.method !== "exit") appendFileSync(log, \`\${JSON.stringify({ direction: "from-client", message })}\\n\`);
    respond(message);
  }
});
`,
  );
  chmodSync(bin, 0o755);
  process.env.FONT_PATH_LSP_LOG = log;
  process.env.FONT_PATH_LSP_STARTS = starts;
  try {
    return await run(dir, bin, (method) => received(log, method));
  } finally {
    if (beforeLog === undefined) delete process.env.FONT_PATH_LSP_LOG;
    else process.env.FONT_PATH_LSP_LOG = beforeLog;
    if (beforeStarts === undefined) delete process.env.FONT_PATH_LSP_STARTS;
    else process.env.FONT_PATH_LSP_STARTS = beforeStarts;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("main LSP initialization sends every resolved configured font path", async () => {
  await withFakeServer(async (vault, messages) => {
    // #given
    const fontPaths = [join(vault, "vault fonts"), "/Library/Application Support/Typst Fonts"];
    const lsp = new FontPathLspClient(LSP_FIXTURE, vault, () => {}, { fontPaths });
    try {
      // #when
      await lsp.start();

      // #then
      assert.deepEqual(messages("initialize")[0]?.message.params?.initializationOptions?.fontPaths, fontPaths);
    } finally {
      lsp.stop();
    }
  });
});

test("preview source activation and clearing preserve configured font paths", async () => {
  await withFakeServer(async (vault, messages) => {
    // #given
    const fontPaths = [join(vault, "vault fonts")];
    const source = join(vault, "book", "chapters", "one.typ");
    const lsp = new FontPathLspClient(LSP_FIXTURE, vault, () => {}, { fontPaths });
    try {
      await lsp.start();

      // #when
      lsp.setPreviewSource(source);
      lsp.setPreviewSource();
      await waitFor(() => messages("workspace/didChangeConfiguration").length === 2);

      // #then
      assert.deepEqual(
        messages("workspace/didChangeConfiguration").map((entry) => ({
          fontPaths: entry.message.params?.settings?.fontPaths,
          typstExtraArgs: entry.message.params?.settings?.typstExtraArgs,
        })),
        [
          { fontPaths, typstExtraArgs: ["--root", vault, "--input", `preview-source=${source}`] },
          { fontPaths, typstExtraArgs: [] },
        ],
      );
    } finally {
      lsp.stop();
    }
  });
});

test("a restarted fragment compiler receives changed and cleared font paths", async () => {
  await withFakeServer(async (vault, messages) => {
    // #given
    let fontPaths: readonly string[] = [join(vault, "vault fonts")];
    const renderer = new FontPathFragmentRenderer({
      bin: () => LSP_FIXTURE,
      root: vault,
      fontPaths: () => fontPaths,
    });
    try {
      // #when
      await renderer.render(vault, "$x$");
      fontPaths = [];
      renderer.stop();
      await renderer.render(vault, "$y$");

      // #then
      assert.deepEqual(
        messages("initialize").map((entry) => entry.message.params?.initializationOptions?.fontPaths),
        [[join(vault, "vault fonts")], []],
      );
    } finally {
      renderer.dispose();
    }
  });
});

test("saving changed font paths clears a successful fragment render from cache", async () => {
  // #given
  const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin & {
    settings: FontPathSettings;
    saveData(data: unknown): Promise<void>;
  };
  plugin.settings = { ...DEFAULT_SETTINGS, fontPaths: ["/fonts/old"] };
  const seen: (readonly string[])[] = [];
  const backend: FragmentBackend = {
    async render() {
      seen.push(plugin.settings.fontPaths);
      return renderPage();
    },
  };
  const render = new TypstRender(backend, RENDER_ROOT);
  plugin.fragments = null;
  plugin.typstRender = render;
  plugin.saveData = async () => {};
  const doc = Text.of(RENDER_TEXT.split("\n"));
  const math = typstMathAt(doc, RENDER_TEXT.indexOf("EE[X] = integral"))!;
  try {
    await render.math(RENDER_FILE, doc, math);
    plugin.settings.fontPaths = [];

    // #when
    await plugin.saveSettings();
    await render.math(RENDER_FILE, doc, math);

    // #then
    assert.deepEqual(seen, [["/fonts/old"], []]);
  } finally {
    render.dispose();
  }
});

test("applying unchanged font paths starts a fresh fragment render", async () => {
  await withLifecycleServer(async (vault, bin, messages) => {
    // #given
    const fragments = new TypstFragmentRenderer({ bin: () => bin, root: vault });
    const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin & {
      settings: FontPathSettings;
      saveData(data: unknown): Promise<void>;
    };
    plugin.settings = { ...DEFAULT_SETTINGS, fontPaths: ["/fonts/unchanged"] };
    Reflect.set(plugin, "savedFontPaths", ["/fonts/unchanged"]);
    plugin.fragments = fragments;
    const render = new TypstRender(fragments, RENDER_ROOT);
    plugin.typstRender = render;
    plugin.saveData = async () => {};
    plugin.startLsp = async () => {};
    const doc = Text.of(RENDER_TEXT.split("\n"));
    const math = typstMathAt(doc, RENDER_TEXT.indexOf("EE[X] = integral"))!;
    try {
      const first = await render.math(RENDER_FILE, doc, math);

      // #when
      await plugin.applyFontPaths(["/fonts/unchanged"]);
      const second = await render.math(RENDER_FILE, doc, math);

      // #then
      assert.deepEqual(
        [first.ok ? first.svg : first, second.ok ? second.svg : second, messages("workspace/executeCommand").length],
        [FIRST_RENDERED_SVG, SECOND_RENDERED_SVG, 2],
      );
    } finally {
      render.dispose();
      fragments.dispose();
    }
  });
});
