import { createHash } from "crypto";
import { join } from "path";
import {
  EventRef,
  FileManager,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
} from "obsidian";
import { LspClient, LspConfiguration } from "./lsp/client";
import { previewEntry } from "./preview/previewEntry";

export type AutomaticPdfStatus =
  | "building"
  | "current"
  | "error"
  | "conflict"
  | "stale"
  | "missing";

export interface AutomaticPdfExportRequest {
  entryPath: string;
  root: string;
  sourceInput?: string;
}

export interface AutomaticPdfExporter {
  exportPdf(request: AutomaticPdfExportRequest): Promise<Uint8Array>;
  stop(): void;
}

export interface AutomaticPdfReplaceRequest {
  sourcePath: string;
  destinationPath: string;
  observedBytes: Uint8Array;
}

export interface AutomaticPdfStoredEntry {
  enabled: boolean;
  destinationPath?: string;
  ownedHash?: string;
}

export interface AutomaticPdfStoredState {
  entries: Record<string, AutomaticPdfStoredEntry>;
}

export interface AutomaticPdfHost {
  vault: Vault;
  fileManager: FileManager;
  root(): string | null;
  onLayoutReady(callback: () => void): void;
  registerEvent(event: EventRef): void;
  createExporter(): AutomaticPdfExporter;
  confirmReplace(request: AutomaticPdfReplaceRequest): Promise<boolean>;
  persist(state: AutomaticPdfStoredState): Promise<void>;
  notice(message: string): void;
  storedState(): AutomaticPdfStoredState | undefined;
}

interface Entry extends AutomaticPdfStoredEntry {
  status: AutomaticPdfStatus;
  generation: number;
  errorNotified: boolean;
}

interface PendingJob {
  sourcePath: string;
  generation: number;
  manual: boolean;
  waiters: Array<() => void>;
}

interface DestinationSnapshot {
  path: string;
  exists: boolean;
  bytes: Uint8Array | null;
  hash: string | null;
  error?: Error;
}

function emptyStoredState(): AutomaticPdfStoredState {
  return { entries: {} };
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isStoredEntry(value: unknown): value is AutomaticPdfStoredEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.destinationPath === undefined || typeof candidate.destinationPath === "string") &&
    (candidate.ownedHash === undefined || typeof candidate.ownedHash === "string")
  );
}

function normalizeStoredState(value: unknown): AutomaticPdfStoredState {
  if (!value || typeof value !== "object") return emptyStoredState();
  const entriesValue = (value as { entries?: unknown }).entries;
  if (!entriesValue || typeof entriesValue !== "object") return emptyStoredState();
  const entries: Record<string, AutomaticPdfStoredEntry> = {};
  for (const [path, entry] of Object.entries(entriesValue)) {
    if (!isStoredEntry(entry)) continue;
    entries[path] = { ...entry };
  }
  return { entries };
}

function pdfPath(sourcePath: string): string {
  return sourcePath.replace(/\.typ$/i, ".pdf");
}

function isTypstFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === "typ";
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Owns automatic PDF work, publication permission, and source-file lineage.
 * Obsidian and the native compiler stay behind AutomaticPdfHost.
 */
export class AutomaticPdfController {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, PendingJob>();
  private exporter: AutomaticPdfExporter | null = null;
  private pumping = false;
  private started = false;
  private disposed = false;
  private persistenceErrorNotified = false;

  constructor(private readonly host: AutomaticPdfHost) {
    const stored = normalizeStoredState(host.storedState());
    for (const [path, value] of Object.entries(stored.entries)) {
      this.entries.set(path, {
        ...value,
        destinationPath: value.destinationPath ?? pdfPath(path),
        status: "missing",
        generation: 0,
        errorNotified: false,
      });
    }
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.host.registerEvent(this.host.vault.on("modify", (file) => this.onModify(file)));
    this.host.registerEvent(this.host.vault.on("delete", (file) => this.onDelete(file)));
    this.host.registerEvent(
      this.host.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
    this.host.onLayoutReady(() => {
      void this.startup().catch((error: unknown) => this.reportUnexpected(error));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.generation++;
    this.resolvePending();
    this.exporter?.stop();
    this.exporter = null;
  }

  configurationChanged(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) entry.generation++;
    this.resolvePending();
    this.exporter?.stop();
    this.exporter = null;
  }

  automaticPdfEnabled(sourcePath: string): boolean {
    return this.entries.get(sourcePath)?.enabled ?? false;
  }

  automaticPdfStatus(sourcePath: string): AutomaticPdfStatus {
    return this.entries.get(sourcePath)?.status ?? "missing";
  }

  async setAutomaticPdf(sourcePath: string, enabled: boolean): Promise<void> {
    if (this.disposed || !sourcePath.endsWith(".typ")) return;
    const entry = this.entry(sourcePath);
    entry.enabled = enabled;
    entry.generation++;
    if (!enabled) {
      this.pending.delete(sourcePath);
      entry.status = this.destinationExists(entry.destinationPath ?? pdfPath(sourcePath))
        ? "current"
        : "missing";
      await this.persist();
      return;
    }

    await this.persist();
    await this.enqueue(sourcePath, false);
  }

  async rebuildPdf(sourcePath: string): Promise<void> {
    if (this.disposed || !sourcePath.endsWith(".typ")) return;
    this.entry(sourcePath);
    await this.enqueue(sourcePath, true);
  }

  private entry(sourcePath: string): Entry {
    let entry = this.entries.get(sourcePath);
    if (!entry) {
      entry = {
        enabled: false,
        destinationPath: pdfPath(sourcePath),
        status: "missing",
        generation: 0,
        errorNotified: false,
      };
      this.entries.set(sourcePath, entry);
    }
    return entry;
  }

  private async startup(): Promise<void> {
    if (this.disposed) return;
    for (const [sourcePath, entry] of this.entries) {
      if (!entry.enabled || !this.sourceExists(sourcePath)) continue;
      void this.enqueue(sourcePath, false);
    }
  }

  private async onModify(file: TAbstractFile): Promise<void> {
    if (!isTypstFile(file)) return;
    const entry = this.entries.get(file.path);
    if (!entry?.enabled || this.disposed) return;
    void this.enqueue(file.path, false);
  }

  private async onDelete(file: TAbstractFile): Promise<void> {
    if (this.disposed) return;
    const prefix = file instanceof TFolder ? `${file.path}/` : null;
    const paths = [...this.entries.keys()].filter((path) =>
      prefix ? path.startsWith(prefix) : path === file.path,
    );
    if (!paths.length) return;
    for (const path of paths) {
      const entry = this.entries.get(path);
      if (entry) entry.generation++;
      this.pending.delete(path);
      this.entries.delete(path);
    }
    await this.persist();
  }

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.disposed) return;
    if (file instanceof TFolder) {
      await this.renameFolder(oldPath, file.path);
      return;
    }
    if (!isTypstFile(file)) return;
    await this.renameSource(oldPath, file.path);
  }

  private async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const prefix = `${oldPath}/`;
    const moved = [...this.entries.entries()].filter(([path]) => path.startsWith(prefix));
    for (const [oldSourcePath, entry] of moved) {
      const suffix = oldSourcePath.slice(prefix.length);
      const newSourcePath = `${newPath}/${suffix}`;
      this.entries.delete(oldSourcePath);
      this.pending.delete(oldSourcePath);
      entry.generation++;
      entry.destinationPath = pdfPath(newSourcePath);
      this.entries.set(newSourcePath, entry);
      await this.reconcileMovedPdf(entry, oldSourcePath, newSourcePath, false);
      if (entry.enabled && this.sourceExists(newSourcePath)) void this.enqueue(newSourcePath, false);
    }
    if (moved.length) await this.persist();
  }

  private async renameSource(oldPath: string, newPath: string): Promise<void> {
    const entry = this.entries.get(oldPath);
    if (!entry) return;
    this.entries.delete(oldPath);
    this.pending.delete(oldPath);
    entry.generation++;
    entry.destinationPath = pdfPath(newPath);
    this.entries.set(newPath, entry);
    const shouldBuild = await this.reconcileMovedPdf(entry, oldPath, newPath, true);
    await this.persist();
    if (shouldBuild && entry.enabled && this.sourceExists(newPath)) void this.enqueue(newPath, false);
  }

  private async reconcileMovedPdf(
    entry: Entry,
    oldSourcePath: string,
    newSourcePath: string,
    notifyMoveFailure: boolean,
  ): Promise<boolean> {
    const oldDestinationPath = pdfPath(oldSourcePath);
    const newDestinationPath = pdfPath(newSourcePath);
    const oldDestination = await this.readDestination(oldDestinationPath);
    const newDestination = await this.readDestination(newDestinationPath);
    if (oldDestination.error || newDestination.error) {
      this.markFailure(entry, "Could not inspect the PDF during source rename.");
      return false;
    }

    const ownsOldDestination =
      oldDestination.exists &&
      entry.ownedHash !== undefined &&
      oldDestination.hash === entry.ownedHash;
    if (ownsOldDestination && !newDestination.exists) {
      const file = this.host.vault.getAbstractFileByPath(oldDestinationPath);
      if (file instanceof TFile) {
        try {
          await this.host.fileManager.renameFile(file, newDestinationPath);
          entry.destinationPath = newDestinationPath;
          return true;
        } catch (error) {
          if (notifyMoveFailure) {
            this.host.notice(`Automatic PDF export could not move ${oldDestinationPath}: ${String(error)}`);
          }
          return true;
        }
      }
    }

    if (!oldDestination.exists && newDestination.exists && newDestination.hash === entry.ownedHash) {
      entry.destinationPath = newDestinationPath;
      return true;
    }

    if (newDestination.exists) {
      entry.status = "conflict";
      await this.confirmReplace({
        sourcePath: newSourcePath,
        destinationPath: newDestinationPath,
        observedBytes: cloneBytes(newDestination.bytes ?? new Uint8Array()),
      });
      this.notifyConflict(entry, newDestinationPath);
      return false;
    }

    entry.destinationPath = newDestinationPath;
    return true;
  }

  private async enqueue(sourcePath: string, manual: boolean): Promise<void> {
    if (this.disposed) return;
    const entry = this.entries.get(sourcePath);
    if (!entry || (!entry.enabled && !manual)) return;
    const generation = ++entry.generation;
    entry.status = "building";
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const existing = this.pending.get(sourcePath);
    if (existing) {
      existing.generation = generation;
      existing.manual ||= manual;
      existing.waiters.push(resolve);
    } else {
      this.pending.set(sourcePath, {
        sourcePath,
        generation,
        manual,
        waiters: [resolve],
      });
    }
    void this.pump().catch((error: unknown) => this.reportUnexpected(error));
    await promise;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.pending.size) {
        const job = this.pending.values().next().value as PendingJob;
        this.pending.delete(job.sourcePath);
        try {
          await this.build(job);
        } catch (error) {
          this.reportUnexpected(error);
        } finally {
          for (const waiter of job.waiters) waiter();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async build(job: PendingJob): Promise<void> {
    const entry = this.entries.get(job.sourcePath);
    if (!entry || !this.isCurrent(job, entry)) return;
    const root = this.host.root();
    if (!root || !this.sourceExists(job.sourcePath)) {
      this.markFailure(entry, "The source file is not available.");
      return;
    }

    const destinationPath = pdfPath(job.sourcePath);
    entry.destinationPath = destinationPath;
    const initial = await this.readDestination(destinationPath);
    if (initial.error) {
      this.markFailure(entry, `Could not read ${destinationPath}: ${String(initial.error)}`);
      return;
    }
    const authorized = await this.authorizeInitial(job, entry, initial);
    if (!authorized || !this.isCurrent(job, entry)) return;

    let bytes: Uint8Array;
    try {
      const selected = previewEntry(join(root, job.sourcePath), root);
      bytes = await this.getExporter().exportPdf({
        entryPath: selected.filePath,
        root,
        sourceInput: selected.sourceInput,
      });
    } catch (error) {
      if (this.disposed || !this.isCurrent(job, entry)) return;
      this.markFailure(entry, `PDF export failed for ${job.sourcePath}: ${String(error)}`);
      return;
    }
    if (!this.isCurrent(job, entry)) return;

    const current = await this.readDestination(destinationPath);
    if (current.error) {
      this.markFailure(entry, `Could not reread ${destinationPath}: ${String(current.error)}`);
      return;
    }
    const finalAuthorization = await this.authorizeFinal(job, entry, authorized, current);
    if (!finalAuthorization || !this.isCurrent(job, entry)) return;

    try {
      const file = this.host.vault.getAbstractFileByPath(destinationPath);
      if (file instanceof TFile) await this.host.vault.modifyBinary(file, arrayBuffer(bytes));
      else await this.host.vault.createBinary(destinationPath, arrayBuffer(bytes));
    } catch (error) {
      if (this.disposed || !this.isCurrent(job, entry)) return;
      entry.status = "stale";
      this.notifyError(entry, `Automatic PDF write failed for ${job.sourcePath}: ${String(error)}`);
      return;
    }

    if (!this.isCurrent(job, entry)) return;
    entry.ownedHash = hashBytes(bytes);
    entry.destinationPath = destinationPath;
    entry.status = "current";
    entry.errorNotified = false;
    await this.persist();
  }

  private async authorizeInitial(
    job: PendingJob,
    entry: Entry,
    observed: DestinationSnapshot,
  ): Promise<DestinationSnapshot | null> {
    if (!observed.exists || observed.hash === entry.ownedHash) return observed;
    const accepted = await this.confirmReplace({
      sourcePath: job.sourcePath,
      destinationPath: observed.path,
      observedBytes: cloneBytes(observed.bytes ?? new Uint8Array()),
    });
    if (!accepted || !this.isCurrent(job, entry)) {
      this.notifyConflict(entry, observed.path);
      return null;
    }
    const current = await this.readDestination(observed.path);
    if (current.error || !sameSnapshot(observed, current)) {
      this.notifyConflict(entry, observed.path);
      return null;
    }
    return current;
  }

  private async authorizeFinal(
    job: PendingJob,
    entry: Entry,
    authorized: DestinationSnapshot,
    current: DestinationSnapshot,
  ): Promise<DestinationSnapshot | null> {
    if (sameSnapshot(authorized, current)) return current;
    if (current.error) return null;
    if (!current.exists) {
      this.notifyConflict(entry, current.path);
      return null;
    }
    const accepted = await this.confirmReplace({
      sourcePath: job.sourcePath,
      destinationPath: current.path,
      observedBytes: cloneBytes(current.bytes ?? new Uint8Array()),
    });
    if (!accepted || !this.isCurrent(job, entry)) {
      this.notifyConflict(entry, current.path);
      return null;
    }
    const reread = await this.readDestination(current.path);
    if (reread.error || !sameSnapshot(current, reread)) {
      this.notifyConflict(entry, current.path);
      return null;
    }
    return reread;
  }

  private isCurrent(job: PendingJob, entry: Entry): boolean {
    return (
      !this.disposed &&
      this.entries.get(job.sourcePath) === entry &&
      entry.generation === job.generation &&
      (entry.enabled || job.manual)
    );
  }

  private getExporter(): AutomaticPdfExporter {
    if (!this.exporter) this.exporter = this.host.createExporter();
    return this.exporter;
  }

  private async readDestination(path: string): Promise<DestinationSnapshot> {
    const file = this.host.vault.getAbstractFileByPath(path);
    if (!file) return { path, exists: false, bytes: null, hash: null };
    if (!(file instanceof TFile)) {
      return { path, exists: true, bytes: null, hash: null, error: new Error("destination is not a file") };
    }
    try {
      const bytes = new Uint8Array(await this.host.vault.readBinary(file));
      return { path, exists: true, bytes, hash: hashBytes(bytes) };
    } catch (error) {
      return {
        path,
        exists: true,
        bytes: null,
        hash: null,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private sourceExists(path: string): boolean {
    return this.host.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  private destinationExists(path: string): boolean {
    return this.host.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  private async confirmReplace(request: AutomaticPdfReplaceRequest): Promise<boolean> {
    try {
      return await this.host.confirmReplace(request);
    } catch (error) {
      this.host.notice(`Automatic PDF confirmation failed: ${String(error)}`);
      return false;
    }
  }

  private async persist(): Promise<void> {
    try {
      const entries: Record<string, AutomaticPdfStoredEntry> = {};
      for (const [path, entry] of this.entries) {
        entries[path] = {
          enabled: entry.enabled,
          destinationPath: entry.destinationPath,
          ownedHash: entry.ownedHash,
        };
      }
      await this.host.persist({ entries });
      this.persistenceErrorNotified = false;
    } catch (error) {
      if (!this.persistenceErrorNotified) {
        this.persistenceErrorNotified = true;
        this.host.notice(`Automatic PDF settings could not be saved: ${String(error)}`);
      }
    }
  }

  private markFailure(entry: Entry, message: string): void {
    entry.status = this.destinationExists(entry.destinationPath ?? "") ? "stale" : "error";
    this.notifyError(entry, message);
  }

  private notifyError(entry: Entry, message: string): void {
    if (entry.errorNotified) return;
    entry.errorNotified = true;
    this.host.notice(message);
  }

  private notifyConflict(entry: Entry, destinationPath: string): void {
    entry.status = "conflict";
    if (entry.errorNotified) return;
    entry.errorNotified = true;
    this.host.notice(`Automatic PDF export needs confirmation for ${destinationPath}.`);
  }

  private reportUnexpected(error: unknown): void {
    if (!this.disposed) this.host.notice(`Automatic PDF export stopped unexpectedly: ${String(error)}`);
  }

  private resolvePending(): void {
    for (const job of this.pending.values()) {
      for (const waiter of job.waiters) waiter();
    }
    this.pending.clear();
  }
}

/** Native Tinymist adapter. It never asks Tinymist to write the destination file. */
export class NativeAutomaticPdfExporter implements AutomaticPdfExporter {
  private client: LspClient | null = null;
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly binaryPath: string,
    private readonly rootPath: string,
    private readonly configuration?: LspConfiguration,
  ) {}

  exportPdf(request: AutomaticPdfExportRequest): Promise<Uint8Array> {
    const run = this.serial.then(async () => {
      if (this.stopped) throw new Error("automatic PDF exporter stopped");
      const client = await this.ensureClient();
      client.setExportInput(request.sourceInput);
      const result = await client.exportPdf(request.entryPath);
      const data = result?.data;
      if (!data) throw new Error("Tinymist returned no PDF data");
      return new Uint8Array(Buffer.from(data, "base64"));
    });
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): void {
    this.stopped = true;
    this.client?.stop();
    this.client = null;
  }

  private async ensureClient(): Promise<LspClient> {
    if (!this.client) {
      const client = new LspClient(this.binaryPath, this.rootPath, () => {}, this.configuration);
      this.client = client;
      try {
        await client.start();
      } catch (error) {
        client.stop();
        this.client = null;
        throw error;
      }
    }
    return this.client;
  }
}

function sameSnapshot(a: DestinationSnapshot, b: DestinationSnapshot): boolean {
  return a.path === b.path && a.exists === b.exists && a.hash === b.hash && !a.error && !b.error;
}
