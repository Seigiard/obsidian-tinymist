import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readManifest } from "../src/kit/manifest";
import { nodeFixture } from "./support/nodeFixture";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(existsSync);
const LSP_FIXTURE = resolve("tests/support/font-path-lsp.mjs");
const MANIFEST = {
  version: 1,
  templates: [{
    id: "reference",
    path: "reference.typ",
    params: {
      columns: { type: "int" },
      theme: { type: "enum", values: ["ink", "forest"] },
    },
  }],
  "font-paths": ["../fonts/files"],
};

interface RecordedMessage {
  direction: "from-client" | "to-client";
  message: { method?: string; params?: { command?: string; arguments?: unknown[] } };
}

function received(log: string): RecordedMessage[] {
  return existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedMessage)
    : [];
}

test("readManifest uses exportQuery with write disabled as its third argument", async () => {
  // #given
  const vault = mkdtempSync(join(tmpdir(), "tinymist-kit-manifest-lsp-"));
  const log = join(vault, "messages.jsonl");
  const manifest = join(vault, "kit", "md", "manifest.typ");
  const oldLog = process.env.FONT_PATH_LSP_LOG;
  const oldResult = process.env.KIT_MANIFEST_QUERY_RESULT;
  chmodSync(LSP_FIXTURE, 0o755);
  process.env.FONT_PATH_LSP_LOG = log;
  process.env.KIT_MANIFEST_QUERY_RESULT = JSON.stringify(MANIFEST);
  const restoreSpawn = nodeFixture(LSP_FIXTURE);
  mkdirSync(join(vault, "kit", "md"), { recursive: true });
  writeFileSync(manifest, "#metadata(none) <manifest>");

  // #when
  try {
    await readManifest(LSP_FIXTURE, vault, manifest);

    // #then
    const command = received(log).find((entry) => entry.direction === "from-client" && entry.message.method === "workspace/executeCommand");
    assert.deepEqual(
      { command: command?.message.params, lifecycle: received(log).filter((entry) =>
        entry.direction === "from-client" && ["shutdown", "exit"].includes(entry.message.method ?? ""),
      ).map((entry) => entry.message.method) },
      {
        command: {
          command: "tinymist.exportQuery",
          arguments: [
            manifest,
            { format: "json", selector: "<manifest>", field: "value", one: true },
            { write: false },
          ],
        },
        lifecycle: ["shutdown", "exit"],
      },
    );
  } finally {
    await restoreSpawn();
    if (oldLog === undefined) delete process.env.FONT_PATH_LSP_LOG;
    else process.env.FONT_PATH_LSP_LOG = oldLog;
    if (oldResult === undefined) delete process.env.KIT_MANIFEST_QUERY_RESULT;
    else process.env.KIT_MANIFEST_QUERY_RESULT = oldResult;
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readManifest reads the normative fixture without writing beside the manifest", { skip: !BIN && "tinymist not found", timeout: 30000 }, async () => {
  // #given
  const vault = resolve("tests/fixtures/kit");
  const manifest = join(vault, "md", "manifest.typ");
  const before = readdirSync(join(vault, "md")).sort();

  // #when
  const result = await readManifest(BIN!, vault, manifest);

  // #then
  assert.deepEqual(
    { result, files: readdirSync(join(vault, "md")).sort() },
    { result: MANIFEST, files: before },
  );
});
