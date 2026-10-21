// Load the whole installed bundle. Host modules and streaming transport are synthetic;
// the production controllers, request construction and settings defaults are unchanged.
import { readFileSync } from "node:fs";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";

type Obj = Record<string, any>;
export interface ModelRequest {
  body: Obj;
  signal: AbortSignal;
  reply(text: string, finish?: boolean): void;
}

export function loadYolo(file: string) {
  const source = readFileSync(file, "utf8");
  return { file, make(options: { automatic?: boolean; delay?: number; version?: string } = {}) {
    const requests: ModelRequest[] = [];
    const fetch = (_url: string, init: RequestInit) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; } });
      const signal = init.signal as AbortSignal;
      requests.push({ body: JSON.parse(String(init.body)), signal, reply(text, finish = true) {
        if (closed) return;
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ text }] })}\n\n`));
        if (finish) { closed = true; stream.close(); }
      } });
      signal.addEventListener("abort", () => {
        if (!closed) { closed = true; stream.close(); }
      }, { once: true });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    };
    class Plugin { constructor(readonly app: Obj, readonly manifest: Obj) {} }
    class HostClass {}
    const host = { Plugin, PluginSettingTab: HostClass, Setting: HostClass, Notice: HostClass,
      MarkdownView: HostClass, Platform: { isDesktop: true }, getLanguage: () => "en" };
    const require = (name: string) => {
      if (name === "@codemirror/state") return cmState;
      if (name === "@codemirror/view") return cmView;
      if (name === "obsidian") return host;
      throw new Error(`Unexpected production dependency: ${name}`);
    };
    const module = { exports: {} as Obj };
    new Function("require", "module", "exports", "fetch", source)(require, module, module.exports, fetch);
    const Constructor = module.exports.default;
    if (typeof Constructor !== "function") throw new Error("YOLO bundle has no default plugin export");
    const workspace = { getActiveFile: () => null, getActiveViewOfType: () => null, iterateAllLeaves: () => {} };
    const plugin = new Constructor({ workspace }, { id: "yolo", version: options.version ?? "future-release" });
    plugin.settings.providers = [{ id: "fixture", baseUrl: "https://api.inceptionlabs.ai/v1", apiKey: "synthetic" }];
    plugin.settings.chatModels = [{ id: "fim", providerId: "fixture", model: "mercury-edit-2", enable: true }];
    Object.assign(plugin.settings.continuationOptions, { enableTabCompletion: true, tabCompletionModelId: "fim" });
    Object.assign(plugin.settings.continuationOptions.tabCompletionOptions, {
      idleTriggerEnabled: options.automatic ?? false, autoTriggerDelayMs: options.delay ?? 25,
      autoTriggerCooldownMs: 0, boundaryDelayMs: options.delay ?? 25, minContextLength: 1,
      cacheEnabled: false, contextEnabled: false,
    });
    return { plugin, requests, dispose: () => plugin.onunload() };
  } };
}
