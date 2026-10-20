import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import TinymistPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FileSystemAdapter, Notice } from "./support/obsidian";

function pluginFor(root: string, binaryPath: string): TinymistPlugin {
  const plugin = Object.create(TinymistPlugin.prototype) as TinymistPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS, binaryPath };
  plugin.lsp = null;
  plugin.preview = { onLspRestart: () => {} } as TinymistPlugin["preview"];
  plugin.app = {
    vault: { adapter: new FileSystemAdapter(root) },
    workspace: {
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
    },
  } as TinymistPlugin["app"];
  return plugin;
}

function writeLspBinary(path: string): void {
  writeFileSync(path, `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString();
    const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length) || buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    if (message.method === "exit") process.exit(0);
  }
});
`);
  chmodSync(path, 0o755);
}

function useWindowsDiscoveryPaths(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function hideDirectBinaryCandidates(): () => void {
  const fs = require("fs") as typeof import("fs");
  const exists = fs.existsSync;
  fs.existsSync = () => false;
  return () => { fs.existsSync = exists; };
}

test("a restart discovers a configured Tinymist binary that appeared after the initial lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-binary-retry-"));
  const binary = join(root, "tinymist");
  const plugin = pluginFor(root, binary);
  const restorePlatform = useWindowsDiscoveryPaths();
  try {
    // #given
    await plugin.startLsp(false);
    writeLspBinary(binary);

    // #when
    await plugin.startLsp(true);

    // #then
    assert.equal(plugin.lsp?.status, "running");
  } finally {
    plugin.lsp?.stop();
    restorePlatform();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured binary takes precedence and remains cached after its first successful lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-binary-cache-"));
  const binary = join(root, "tinymist");
  const plugin = pluginFor(root, binary);
  try {
    // #given
    writeLspBinary(binary);

    // #when
    const first = plugin.resolveBinary();
    rmSync(binary);
    const cached = plugin.resolveBinary();

    // #then
    assert.deepEqual([first, cached], [binary, binary]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATH discovery finds an executable when direct common-location probes are unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-binary-path-"));
  const bin = join(root, "bin");
  const binary = join(bin, "tinymist");
  const plugin = pluginFor(root, "");
  const home = process.env.HOME;
  mkdirSync(bin);
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  writeFileSync(join(root, ".profile"), `export PATH="${bin}"\n`);
  const restoreExists = hideDirectBinaryCandidates();
  process.env.HOME = root;
  try {
    // #given

    // #when
    const discovered = plugin.resolveBinary();

    // #then
    assert.equal(discovered, binary);
  } finally {
    restoreExists();
    process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing configured binary leaves language-server restart as a handled failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-binary-missing-"));
  const plugin = pluginFor(root, join(root, "tinymist"));
  const restorePlatform = useWindowsDiscoveryPaths();
  Notice.shown = [];
  try {
    // #given
    const message = "Tinymist: binary not found. Install tinymist (brew install tinymist) or set its path in the plugin settings.";

    // #when
    await plugin.startLsp(true);

    // #then
    assert.deepEqual([plugin.lsp, Notice.shown], [null, [message]]);
  } finally {
    restorePlatform();
    rmSync(root, { recursive: true, force: true });
  }
});
