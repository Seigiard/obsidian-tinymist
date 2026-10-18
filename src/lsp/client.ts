import { spawn, ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}

export type LspStatus = "starting" | "running" | "stopped" | "failed";

export function pathToUri(p: string): string {
  return pathToFileURL(p).href;
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

/**
 * The form pathToUri produces for a server URI. Servers percent-encode differently
 * (`&`, `^`, CJK), and diagnostics are routed by exact URI.
 */
export function canonicalUri(uri: string): string {
  try {
    return pathToUri(uriToPath(uri));
  } catch {
    return uri;
  }
}

/** LSP CompletionContext (1 Invoked, 2 TriggerCharacter, 3 TriggerForIncompleteCompletions). */
export interface LspCompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}

/** One incremental textDocument/didChange entry. */
export interface LspContentChange {
  range: LspRange;
  text: string;
}

/** `tinymist.exportSvg`'s result when nothing is written: one base64 SVG per page (0-based). */
export interface ExportSvgResult {
  items?: { page: number; data: string | null }[];
  total_pages?: number;
}

export interface ExportPdfResult {
  data?: string;
  path?: string;
}

/** Settings sent to tinymist. The index permits future compiler settings to be cloned. */
export interface LspConfiguration {
  exportPdf: string;
  formatterMode: string;
  customizedShowDocument: boolean;
  typstExtraArgs: string[];
  [key: string]: unknown;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal LSP client over stdio. Document sync is full text or incremental,
 * as the caller chooses. Unknown server->client requests are answered with a
 * null result on purpose; extend explicitly when a feature needs more.
 */
export class LspClient {
  status: LspStatus = "stopped";
  onStatusChange: ((s: LspStatus) => void) | null = null;

  private proc: ChildProcess | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private versions = new Map<string, number>();
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  /** Raw server capabilities from the initialize response. */
  serverCapabilities: Record<string, unknown> | null = null;
  /** The file tinymist compiles as main (null: whichever file is focused). */
  mainFile: string | null = null;
  private configuration: LspConfiguration = {
    exportPdf: "never",
    formatterMode: "typstyle",
    customizedShowDocument: true,
    typstExtraArgs: [] as string[],
  };

  constructor(
    private binPath: string,
    private rootPath: string,
    private onDiagnostics: (uri: string) => void,
    configuration?: LspConfiguration,
  ) {
    if (configuration) {
      this.configuration = {
        ...configuration,
        typstExtraArgs: [...configuration.typstExtraArgs],
      };
    }
  }

  cloneConfiguration(): LspConfiguration {
    return {
      ...this.configuration,
      typstExtraArgs: [...this.configuration.typstExtraArgs],
    };
  }

  diagnostics(uri: string): LspDiagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  /** The server's process id while it runs. */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    this.proc = spawn(this.binPath, ["lsp"], {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (err) => {
      console.error("[tinymist] spawn failed:", err);
      this.setStatus("failed");
      // A process that never started emits no exit: fail its initialize now, not at the timeout.
      this.rejectAll(new Error(`could not start tinymist: ${err.message}`));
    });
    this.proc.on("exit", (code) => {
      if (this.status !== "stopped") {
        console.error(`[tinymist] lsp exited with code ${code}`);
        this.setStatus("failed");
      }
      this.rejectAll(new Error("language server exited"));
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.debug("[tinymist:lsp]", String(chunk).trimEnd());
    });

    try {
      const initResult = (await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToUri(this.rootPath),
          workspaceFolders: [
            { uri: pathToUri(this.rootPath), name: "vault" },
          ],
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: { relatedInformation: false },
              // What src/editor/shared/lspCompletion.ts handles: contexts,
              // numbered snippets, labelDetails, InsertReplaceEdit ranges and
              // additionalTextEdits (always applied), list item defaults.
              completion: {
                contextSupport: true,
                completionItem: {
                  snippetSupport: true,
                  labelDetailsSupport: true,
                  insertReplaceSupport: true,
                  deprecatedSupport: true,
                  preselectSupport: true,
                  tagSupport: { valueSet: [1] },
                  documentationFormat: ["markdown", "plaintext"],
                },
                completionList: {
                  itemDefaults: [
                    "editRange",
                    "insertTextFormat",
                    "data",
                  ],
                },
              },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: {},
              rename: { prepareSupport: false },
              formatting: {},
              semanticTokens: {
                requests: { full: true },
                tokenTypes: [
                  "namespace", "type", "class", "enum", "interface", "struct",
                  "typeParameter", "parameter", "variable", "property",
                  "enumMember", "event", "function", "method", "macro",
                  "keyword", "modifier", "comment", "string", "number",
                  "regexp", "operator", "decorator", "bool", "punct", "escape",
                  "link", "raw", "label", "ref", "heading", "marker", "term",
                  "delim", "pol", "error", "text",
                ],
                tokenModifiers: [
                  "declaration", "definition", "readonly", "static",
                  "deprecated", "abstract", "async", "modification",
                  "documentation", "defaultLibrary", "math", "strong", "emph",
                ],
                formats: ["relative"],
                multilineTokenSupport: false,
                overlappingTokenSupport: false,
              },
            },
            workspace: {
              configuration: true,
              workspaceEdit: { documentChanges: true },
            },
          },
          initializationOptions: this.configuration,
        },
        20000,
      )) as { capabilities?: Record<string, unknown> } | null;
      this.serverCapabilities = initResult?.capabilities ?? null;
      this.notify("initialized", {});
      this.setStatus("running");
    } catch (err) {
      // stop() during the start ended it: stopped, not failed.
      if (this.status !== "stopped") this.setStatus("failed");
      const proc = this.proc;
      this.proc = null;
      if (proc && !proc.killed) proc.kill();
      throw err;
    }
  }

  /** Register a handler for a server->client notification method. */
  onNotification(method: string, cb: (params: unknown) => void): void {
    this.notificationHandlers.set(method, cb);
  }

  /** LSP previews use compiler configuration, not the CLI preview inputs. */
  setPreviewSource(source?: string): void {
    const args = source
      ? ["--root", this.rootPath, "--input", `preview-source=${source}`]
      : [];
    if (JSON.stringify(args) === JSON.stringify(this.configuration.typstExtraArgs)) return;
    this.configuration.typstExtraArgs = args;
    this.notify("workspace/didChangeConfiguration", { settings: this.configuration });
    // A configuration change resets tinymist's entry: label completion comes back
    // empty, and every request fails while a main was pinned, until it is set again.
    this.pinMain(this.mainFile);
  }

  /** Configure only this client's export input; unlike setPreviewSource it never pins a main. */
  setExportInput(source?: string): void {
    const retained: string[] = [];
    const args = this.configuration.typstExtraArgs;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--root" && args[i + 1] === this.rootPath) {
        i++;
        continue;
      }
      if (arg === "--input" && args[i + 1]?.startsWith("preview-source=")) {
        i++;
        continue;
      }
      retained.push(arg);
    }
    if (source) {
      retained.push("--root", this.rootPath, "--input", `preview-source=${source}`);
    }
    if (JSON.stringify(retained) === JSON.stringify(args)) return;
    this.configuration.typstExtraArgs = retained;
    this.notify("workspace/didChangeConfiguration", { settings: this.configuration });
  }

  /** Pin tinymist's main file (null: follow the focused file again). */
  pinMain(path: string | null): void {
    this.mainFile = path;
    this.executeCommand("tinymist.pinMain", [path]).catch((err) => {
      console.warn("[tinymist] pinMain failed:", err);
    });
  }

  stop(): void {
    const proc = this.proc;
    this.setStatus("stopped");
    this.rejectAll(new Error("client stopped"));
    if (!proc) return;
    this.proc = null;
    try {
      this.sendRaw({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" }, proc);
      this.sendRaw({ jsonrpc: "2.0", method: "exit" }, proc);
    } catch {
      // ignore; we kill below anyway
    }
    setTimeout(() => {
      if (!proc.killed) proc.kill();
    }, 500);
  }

  didOpen(path: string, text: string): void {
    const uri = pathToUri(path);
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version: 1, text },
    });
  }

  didChange(path: string, text: string): void {
    this.sendChanges(path, [{ text }]);
  }

  /** Incremental sync: `changes` apply in order, each to the result of the previous. */
  didChangeRanges(path: string, changes: LspContentChange[]): void {
    if (changes.length) this.sendChanges(path, changes);
  }

  private sendChanges(path: string, contentChanges: unknown[]): void {
    const uri = pathToUri(path);
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges,
    });
  }

  didSave(path: string): void {
    this.notify("textDocument/didSave", {
      textDocument: { uri: pathToUri(path) },
    });
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  completion(
    path: string,
    pos: LspPosition,
    context?: LspCompletionContext,
  ): Promise<unknown> {
    return this.request(
      "textDocument/completion",
      { textDocument: { uri: pathToUri(path) }, position: pos, context },
      5000,
    );
  }

  /** completionProvider.triggerCharacters from the initialize result. */
  completionTriggerCharacters(): string[] {
    const provider = this.serverCapabilities?.completionProvider as
      | { triggerCharacters?: string[] }
      | undefined;
    return provider?.triggerCharacters ?? [];
  }

  hover(path: string, pos: LspPosition): Promise<unknown> {
    return this.request(
      "textDocument/hover",
      { textDocument: { uri: pathToUri(path) }, position: pos },
      5000,
    );
  }

  definition(path: string, pos: LspPosition): Promise<unknown> {
    return this.request(
      "textDocument/definition",
      { textDocument: { uri: pathToUri(path) }, position: pos },
      5000,
    );
  }

  rename(path: string, pos: LspPosition, newName: string): Promise<unknown> {
    return this.request(
      "textDocument/rename",
      { textDocument: { uri: pathToUri(path) }, position: pos, newName },
      10000,
    );
  }

  formatting(path: string): Promise<unknown> {
    return this.request(
      "textDocument/formatting",
      {
        textDocument: { uri: pathToUri(path) },
        options: { tabSize: 2, insertSpaces: true },
      },
      10000,
    );
  }

  semanticTokensFull(path: string): Promise<unknown> {
    return this.request(
      "textDocument/semanticTokens/full",
      { textDocument: { uri: pathToUri(path) } },
      10000,
    );
  }

  /**
   * Compile `path` (an open document's text) and return its pages as SVG, never
   * writing a file. The actions object `{write: false}` must be the THIRD argument:
   * as the second it is ignored, `data` comes back null and tinymist writes
   * `<name>.svg` next to the source.
   */
  exportSvg(
    path: string,
    opts: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<ExportSvgResult | null> {
    return this.executeCommand("tinymist.exportSvg", [path, opts, { write: false }], timeoutMs);
  }

  /** Decode-only native PDF export. Tinymist receives write:false as its third argument. */
  exportPdf(path: string, timeoutMs = 30000): Promise<ExportPdfResult | null> {
    return this.executeCommand<ExportPdfResult>(
      "tinymist.exportPdf",
      [path, {}, { write: false }],
      timeoutMs,
    );
  }

  executeCommand<T = unknown>(
    command: string,
    args: unknown[],
    timeoutMs = 15000,
  ): Promise<T> {
    return this.request(
      "workspace/executeCommand",
      { command, arguments: args },
      timeoutMs,
    ) as Promise<T>;
  }

  private setStatus(s: LspStatus): void {
    this.status = s;
    this.onStatusChange?.(s);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        this.handleMessage(JSON.parse(body));
      } catch (err) {
        console.error("[tinymist] bad message:", err);
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      // Preserve explicit compiler settings if the server pulls configuration.
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items =
          (msg.params as { items?: { section?: string }[] } | undefined)?.items ?? [];
        result = items.map(({ section }) => {
          if (section === "tinymist") return this.configuration;
          const key = section?.replace(/^tinymist\./, "");
          return key && Object.hasOwn(this.configuration, key)
            ? this.configuration[key as keyof typeof this.configuration]
            : null;
        });
      } else if (msg.method === "workspace/applyEdit") {
        result = { applied: false };
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.method !== undefined) {
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as {
          uri: string;
          diagnostics?: LspDiagnostic[];
        };
        const uri = canonicalUri(params.uri);
        this.diagnosticsByUri.set(uri, params.diagnostics ?? []);
        this.onDiagnostics(uri);
        return;
      }
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        try {
          handler(msg.params);
        } catch (err) {
          console.error(`[tinymist] ${msg.method} handler failed:`, err);
        }
      }
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: object): void {
    if (!this.proc) return;
    this.sendRaw(msg, this.proc);
  }

  private sendRaw(msg: object, proc: ChildProcess): void {
    const json = JSON.stringify(msg);
    proc.stdin?.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }
}
