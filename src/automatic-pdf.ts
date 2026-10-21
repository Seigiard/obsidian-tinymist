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

export type AutomaticPdfOutcome =
  | "published"
  | "conflict"
  | "failed"
  | "superseded"
  | "cancelled"
  | "busy";

export interface AutomaticPdfReceipt {
  outcome: AutomaticPdfOutcome;
  generation: number;
  pdfPath: string;
  status: AutomaticPdfStatus;
}

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
  ownedPath?: string;
  declinedPath?: string;
  declinedHash?: string;
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
  authorizationEpoch: number;
  authorizedPath?: string;
  authorizedHash?: string;
  pendingMove?: {
    destinationPath: string;
    hash: string;
  };
}

interface PendingJob {
  sourcePath: string;
  generation: number;
  manual: boolean;
  interactive: boolean;
  outcome?: AutomaticPdfOutcome;
  waiters: Array<(receipt: AutomaticPdfReceipt) => void>;
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
    (candidate.ownedHash === undefined || typeof candidate.ownedHash === "string") &&
    (candidate.ownedPath === undefined || typeof candidate.ownedPath === "string") &&
    (candidate.declinedPath === undefined || typeof candidate.declinedPath === "string") &&
    (candidate.declinedHash === undefined || typeof candidate.declinedHash === "string")
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
  private sourceRenameReconciliations = 0;
  private exporter: AutomaticPdfExporter | null = null;
  private activeJob: PendingJob | null = null;
  private pumping = false;
  private started = false;
  private disposed = false;
  private persistenceErrorNotified = false;

  constructor(private readonly host: AutomaticPdfHost) {
    const stored = normalizeStoredState(host.storedState());
    for (const [path, value] of Object.entries(stored.entries)) {
      const destinationPath = value.destinationPath ?? pdfPath(path);
      this.entries.set(path, {
        ...value,
        destinationPath,
        ownedPath: value.ownedPath ?? (value.ownedHash ? destinationPath : undefined),
        status: "missing",
        generation: 0,
        errorNotified: false,
        authorizationEpoch: 0,
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
    for (const entry of this.entries.values()) {
      entry.generation++;
      this.revokeAuthorization(entry);
    }
    this.resolvePending();
    if (this.activeJob) {
      this.activeJob.outcome = "cancelled";
      const receipt = this.receipt(this.activeJob);
      for (const waiter of this.activeJob.waiters) waiter(receipt);
    }
    this.exporter?.stop();
    this.exporter = null;
  }

  configurationChanged(): void {
    if (this.disposed) return;
    const retry = new Set<string>();
    if (this.activeJob) retry.add(this.activeJob.sourcePath);
    for (const sourcePath of this.pending.keys()) retry.add(sourcePath);
    for (const entry of this.entries.values()) entry.generation++;
    this.resolvePending();
    this.exporter?.stop();
    this.exporter = null;
    this.requeueAfterConfiguration(retry);
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
    this.revokeAuthorization(entry);
    entry.enabled = enabled;
    entry.generation++;
    if (!enabled) {
      this.dropPending(sourcePath);
      entry.declinedPath = undefined;
      entry.declinedHash = undefined;
      entry.status = this.destinationExists(entry.destinationPath ?? pdfPath(sourcePath))
        ? "current"
        : "missing";
      await this.persist();
      return;
    }

    entry.declinedPath = undefined;
    entry.declinedHash = undefined;
    entry.errorNotified = false;
    await this.persist();
    await this.enqueue(sourcePath, false);
  }

  async rebuildPdf(
    sourcePath: string,
    options: { interactive?: boolean } = {},
  ): Promise<AutomaticPdfReceipt> {
    const interactive = options.interactive !== false;
    if (this.disposed || !sourcePath.endsWith(".typ")) {
      return this.receiptWithoutJob(sourcePath, "cancelled");
    }
    if (
      !interactive &&
      (this.activeJob !== null || this.pending.size > 0 || this.sourceRenameReconciliations > 0)
    ) {
      return this.receiptWithoutJob(sourcePath, "busy");
    }
    this.entry(sourcePath);
    // A non-interactive job is never pending: the gate above and pump start it in the same tick.
    return await this.enqueue(sourcePath, true, interactive);
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
        authorizationEpoch: 0,
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
      if (entry) {
        entry.generation++;
        this.revokeAuthorization(entry);
      }
      this.dropPending(path);
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
    if (!isTypstFile(file)) {
      const entry = this.entries.get(oldPath);
      if (!entry) return;
      entry.generation++;
      this.revokeAuthorization(entry);
      this.dropPending(oldPath);
      this.entries.delete(oldPath);
      await this.persist();
      return;
    }
    await this.renameSource(oldPath, file.path);
  }

  private async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const prefix = `${oldPath}/`;
    const moved = [...this.entries.entries()].filter(([path]) => path.startsWith(prefix));
    const operations: Array<{
      entry: Entry;
      oldSourcePath: string;
      newSourcePath: string;
      generation: number;
    }> = [];
    // Rekey every descendant before the first await. A second folder rename
    // must see the latest path for every opted-in source.
    for (const [oldSourcePath, entry] of moved) {
      const suffix = oldSourcePath.slice(prefix.length);
      const newSourcePath = `${newPath}/${suffix}`;
      this.entries.delete(oldSourcePath);
      this.dropPending(oldSourcePath);
      entry.generation++;
      this.revokeAuthorization(entry);
      const oldPdf = pdfPath(oldSourcePath);
      entry.pendingMove =
        entry.ownedHash !== undefined &&
        (entry.ownedPath === oldPdf || entry.pendingMove?.destinationPath === oldPdf)
          ? { destinationPath: pdfPath(newSourcePath), hash: entry.ownedHash }
          : undefined;
      entry.destinationPath = pdfPath(newSourcePath);
      this.entries.set(newSourcePath, entry);
      operations.push({ entry, oldSourcePath, newSourcePath, generation: entry.generation });
    }
    if (!operations.length) return;

    this.sourceRenameReconciliations++;
    try {
      const results = await Promise.all(
        operations.map((operation) =>
          this.reconcileMovedPdf(
            operation.entry,
            operation.oldSourcePath,
            operation.newSourcePath,
            false,
            operation.generation,
          ),
        ),
      );
      if (this.disposed) return;
      await this.persist();
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i];
        if (
          results[i] &&
          this.isLineageCurrent(operation.entry, operation.newSourcePath, operation.generation) &&
          operation.entry.enabled &&
          this.sourceExists(operation.newSourcePath)
        ) {
          void this.enqueue(operation.newSourcePath, false);
        }
      }
    } finally {
      this.sourceRenameReconciliations--;
    }
  }

  private async renameSource(oldPath: string, newPath: string): Promise<void> {
    const entry = this.entries.get(oldPath);
    if (!entry) return;
    this.sourceRenameReconciliations++;
    try {
      this.entries.delete(oldPath);
      this.dropPending(oldPath);
      entry.generation++;
      this.revokeAuthorization(entry);
      entry.pendingMove = undefined;
      entry.destinationPath = pdfPath(newPath);
      this.entries.set(newPath, entry);
      const generation = entry.generation;
      const shouldBuild = await this.reconcileMovedPdf(entry, oldPath, newPath, true, generation);
      if (!this.isLineageCurrent(entry, newPath, generation)) return;
      await this.persist();
      if (shouldBuild && entry.enabled && this.sourceExists(newPath)) void this.enqueue(newPath, false);
    } finally {
      this.sourceRenameReconciliations--;
    }
  }

  private async reconcileMovedPdf(
    entry: Entry,
    oldSourcePath: string,
    newSourcePath: string,
    notifyMoveFailure: boolean,
    generation: number,
  ): Promise<boolean> {
    const oldDestinationPath = pdfPath(oldSourcePath);
    const newDestinationPath = pdfPath(newSourcePath);
    if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
    // Obsidian can dispatch the rename before its descendant index catches up
    // with the already-moved bytes. Let that synchronous dispatch settle before
    // taking either destination snapshot; this is not a timing-based retry.
    await Promise.resolve();
    const oldDestination = await this.readDestination(oldDestinationPath);
    if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
    const newDestination = await this.readDestination(newDestinationPath);
    if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
    if (oldDestination.error || newDestination.error) {
      this.markFailure(entry, "Could not inspect the PDF during source rename.");
      return false;
    }

    const ownsOldDestination =
      oldDestination.exists &&
      entry.ownedHash !== undefined &&
      entry.ownedPath === oldDestinationPath &&
      oldDestination.hash === entry.ownedHash;
    if (ownsOldDestination && !newDestination.exists) {
      const verifiedOldDestination = await this.readDestination(oldDestinationPath);
      if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
      if (!sameSnapshot(oldDestination, verifiedOldDestination)) return true;
      const file = this.host.vault.getAbstractFileByPath(oldDestinationPath);
      if (file instanceof TFile) {
        if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
        try {
          await this.host.fileManager.renameFile(file, newDestinationPath);
          entry.destinationPath = newDestinationPath;
          entry.ownedPath = newDestinationPath;
          entry.pendingMove = undefined;
          return true;
        } catch (error) {
          if (notifyMoveFailure) {
            this.host.notice(`Automatic PDF export could not move ${oldDestinationPath}: ${String(error)}`);
          }
          entry.pendingMove = undefined;
          return true;
        }
      }
    }

    if (
      !oldDestination.exists &&
      newDestination.exists &&
      entry.pendingMove?.destinationPath === newDestinationPath &&
      newDestination.hash === entry.pendingMove.hash
    ) {
      entry.destinationPath = newDestinationPath;
      entry.ownedPath = newDestinationPath;
      entry.pendingMove = undefined;
      return true;
    }

    if (newDestination.exists) {
      if (!entry.enabled) {
        entry.pendingMove = undefined;
        entry.destinationPath = newDestinationPath;
        return false;
      }
      const authorizationEpoch = entry.authorizationEpoch;
      const accepted = await this.confirmReplace({
        sourcePath: newSourcePath,
        destinationPath: newDestinationPath,
        observedBytes: cloneBytes(newDestination.bytes ?? new Uint8Array()),
      });
      if (!accepted) {
        if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
        this.rememberDecline(entry, newDestination);
        entry.pendingMove = undefined;
        this.notifyConflict(entry, newDestinationPath);
        return false;
      }
      if (!this.authorizationIsLiveForPath(entry, newSourcePath, authorizationEpoch)) return false;
      const reread = await this.readDestination(newDestinationPath);
      if (!this.authorizationIsLiveForPath(entry, newSourcePath, authorizationEpoch)) return false;
      if (reread.error || !sameSnapshot(newDestination, reread)) {
        if (!this.isLineageCurrent(entry, newSourcePath, generation)) return false;
        this.notifyConflict(entry, newDestinationPath);
        return false;
      }
      this.rememberAuthorization(entry, reread);
      entry.pendingMove = undefined;
      entry.destinationPath = newDestinationPath;
      return true;
    }

    entry.pendingMove = undefined;
    entry.destinationPath = newDestinationPath;
    return true;
  }

  private async enqueue(
    sourcePath: string,
    manual: boolean,
    interactive = true,
  ): Promise<AutomaticPdfReceipt> {
    if (this.disposed) {
      return this.receiptWithoutJob(sourcePath, "cancelled");
    }
    const entry = this.entries.get(sourcePath);
    if (!entry || (!entry.enabled && !manual)) {
      return this.receiptWithoutJob(sourcePath, "cancelled");
    }
    const generation = ++entry.generation;
    entry.status = "building";
    let resolve!: (receipt: AutomaticPdfReceipt) => void;
    const promise = new Promise<AutomaticPdfReceipt>((done) => {
      resolve = done;
    });
    const existing = this.pending.get(sourcePath);
    if (existing) {
      existing.generation = generation;
      existing.manual ||= manual;
      existing.interactive ||= interactive;
      existing.waiters.push(resolve);
    } else {
      this.pending.set(sourcePath, {
        sourcePath,
        generation,
        manual,
        interactive,
        waiters: [resolve],
      });
    }
    void this.pump().catch((error: unknown) => this.reportUnexpected(error));
    return await promise;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.pending.size) {
        const job = [...this.pending.values()].sort((a, b) =>
          a.sourcePath.localeCompare(b.sourcePath),
        )[0];
        this.pending.delete(job.sourcePath);
        this.activeJob = job;
        try {
          await this.build(job);
        } catch (error) {
          job.outcome = "failed";
          this.reportUnexpected(error);
        } finally {
          if (this.activeJob === job) this.activeJob = null;
          const receipt = this.receipt(job);
          for (const waiter of job.waiters) waiter(receipt);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async build(job: PendingJob): Promise<void> {
    const entry = this.entries.get(job.sourcePath);
    if (!entry) {
      job.outcome = "cancelled";
      return;
    }
    if (!this.isCurrent(job, entry)) {
      this.markNotCurrent(job, entry);
      return;
    }
    const root = this.host.root();
    if (!root || !this.sourceExists(job.sourcePath)) {
      this.markFailure(entry, "The source file is not available.");
      job.outcome = "failed";
      return;
    }

    const destinationPath = pdfPath(job.sourcePath);
    entry.destinationPath = destinationPath;
    const initial = await this.readDestination(destinationPath);
    if (initial.error) {
      this.markFailure(entry, `Could not read ${destinationPath}: ${String(initial.error)}`);
      job.outcome = "failed";
      return;
    }
    const authorized = await this.authorizeInitial(job, entry, initial);
    if (!authorized) {
      if (!this.isCurrent(job, entry)) this.markNotCurrent(job, entry);
      else job.outcome = "conflict";
      return;
    }
    if (!this.isCurrent(job, entry)) {
      this.markNotCurrent(job, entry);
      return;
    }

    let bytes: Uint8Array;
    try {
      const selected = previewEntry(join(root, job.sourcePath), root);
      bytes = await this.getExporter().exportPdf({
        entryPath: selected.filePath,
        root,
        sourceInput: selected.sourceInput,
      });
    } catch (error) {
      if (!this.isCurrent(job, entry)) {
        this.markNotCurrent(job, entry);
        return;
      }
      this.markFailure(entry, `PDF export failed for ${job.sourcePath}: ${String(error)}`);
      job.outcome = "failed";
      return;
    }
    if (!this.isCurrent(job, entry)) {
      this.markNotCurrent(job, entry);
      return;
    }

    const current = await this.readDestination(destinationPath);
    if (current.error) {
      this.markFailure(entry, `Could not reread ${destinationPath}: ${String(current.error)}`);
      job.outcome = "failed";
      return;
    }
    const finalAuthorization = await this.authorizeFinal(job, entry, authorized, current);
    if (!finalAuthorization) {
      if (!this.isCurrent(job, entry)) this.markNotCurrent(job, entry);
      else job.outcome = "conflict";
      return;
    }
    if (!this.isCurrent(job, entry)) {
      this.markNotCurrent(job, entry);
      return;
    }

    try {
      const file = this.host.vault.getAbstractFileByPath(destinationPath);
      if (file instanceof TFile) await this.host.vault.modifyBinary(file, arrayBuffer(bytes));
      else await this.host.vault.createBinary(destinationPath, arrayBuffer(bytes));
    } catch (error) {
      if (!this.isCurrent(job, entry)) {
        this.markNotCurrent(job, entry);
        return;
      }
      entry.status = "stale";
      this.notifyError(entry, `Automatic PDF write failed for ${job.sourcePath}: ${String(error)}`);
      job.outcome = "failed";
      return;
    }

    // A completed Vault write is the publication linearization point. The
    // request may have been superseded while the async write was pending, but
    // the bytes that landed remain plugin-owned at the path where they landed.
    if (this.entries.get(job.sourcePath) === entry) {
      entry.ownedHash = hashBytes(bytes);
      entry.ownedPath = destinationPath;
      entry.destinationPath = destinationPath;
      entry.declinedPath = undefined;
      entry.declinedHash = undefined;
      entry.authorizedPath = undefined;
      entry.authorizedHash = undefined;
    }

    if (this.isCurrent(job, entry)) {
      entry.status = "current";
      entry.errorNotified = false;
      job.outcome = "published";
    } else {
      this.markNotCurrent(job, entry);
    }
    await this.persist();
  }

  private async authorizeInitial(
    job: PendingJob,
    entry: Entry,
    observed: DestinationSnapshot,
  ): Promise<DestinationSnapshot | null> {
    if (!this.isCurrent(job, entry)) return null;
    const authorizationEpoch = entry.authorizationEpoch;
    if (
      !observed.exists ||
      (observed.path === entry.ownedPath && observed.hash === entry.ownedHash)
    ) {
      return observed;
    }
    if (
      !job.manual &&
      entry.declinedPath === observed.path &&
      entry.declinedHash === observed.hash
    ) {
      entry.status = "conflict";
      return null;
    }
    if (
      entry.authorizedPath === observed.path &&
      entry.authorizedHash === observed.hash
    ) {
      return observed;
    }
    if (!job.interactive) {
      entry.status = "conflict";
      return null;
    }
    const accepted = await this.confirmReplace({
      sourcePath: job.sourcePath,
      destinationPath: observed.path,
      observedBytes: cloneBytes(observed.bytes ?? new Uint8Array()),
    });
    if (!accepted) {
      if (!this.isCurrent(job, entry)) return null;
      this.rememberDecline(entry, observed);
      this.notifyConflict(entry, observed.path);
      await this.persist();
      return null;
    }
    if (!this.authorizationIsLive(job, entry, authorizationEpoch)) return null;
    const current = await this.readDestination(observed.path);
    if (!this.authorizationIsLive(job, entry, authorizationEpoch)) return null;
    if (current.error || !sameSnapshot(observed, current)) {
      if (!this.isCurrent(job, entry)) return null;
      this.notifyConflict(entry, observed.path);
      return null;
    }
    this.rememberAuthorization(entry, current);
    return this.isCurrent(job, entry) ? current : null;
  }

  private async authorizeFinal(
    job: PendingJob,
    entry: Entry,
    authorized: DestinationSnapshot,
    current: DestinationSnapshot,
  ): Promise<DestinationSnapshot | null> {
    if (!this.isCurrent(job, entry)) return null;
    if (sameSnapshot(authorized, current)) return current;
    if (current.error) return null;
    if (!current.exists) {
      if (!job.interactive) {
        entry.status = "conflict";
        return null;
      }
      this.notifyConflict(entry, current.path);
      return null;
    }
    const authorizationEpoch = entry.authorizationEpoch;
    if (!job.interactive) {
      entry.status = "conflict";
      return null;
    }
    const accepted = await this.confirmReplace({
      sourcePath: job.sourcePath,
      destinationPath: current.path,
      observedBytes: cloneBytes(current.bytes ?? new Uint8Array()),
    });
    if (!accepted) {
      if (!this.isCurrent(job, entry)) return null;
      this.rememberDecline(entry, current);
      this.notifyConflict(entry, current.path);
      await this.persist();
      return null;
    }
    if (!this.authorizationIsLive(job, entry, authorizationEpoch)) return null;
    const reread = await this.readDestination(current.path);
    if (!this.authorizationIsLive(job, entry, authorizationEpoch)) return null;
    if (reread.error || !sameSnapshot(current, reread)) {
      if (!this.isCurrent(job, entry)) return null;
      this.notifyConflict(entry, current.path);
      return null;
    }
    this.rememberAuthorization(entry, reread);
    return this.isCurrent(job, entry) ? reread : null;
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
    } catch {
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
          ownedPath: entry.ownedPath,
          declinedPath: entry.declinedPath,
          declinedHash: entry.declinedHash,
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
    for (const path of this.pending.keys()) this.dropPending(path);
  }

  private dropPending(sourcePath: string): void {
    const job = this.pending.get(sourcePath);
    if (!job) return;
    this.pending.delete(sourcePath);
    job.outcome = "cancelled";
    const receipt = this.receipt(job);
    for (const waiter of job.waiters) waiter(receipt);
  }

  private receipt(job: PendingJob): AutomaticPdfReceipt {
    const entry = this.entries.get(job.sourcePath);
    return {
      outcome: job.outcome ?? "cancelled",
      generation: job.generation,
      pdfPath: entry?.destinationPath ?? pdfPath(job.sourcePath),
      status: entry?.status ?? "missing",
    };
  }

  private receiptWithoutJob(
    sourcePath: string,
    outcome: AutomaticPdfOutcome,
  ): AutomaticPdfReceipt {
    const entry = this.entries.get(sourcePath);
    return {
      outcome,
      generation: entry?.generation ?? 0,
      pdfPath: entry?.destinationPath ?? pdfPath(sourcePath),
      status: entry?.status ?? "missing",
    };
  }

  private markNotCurrent(job: PendingJob, entry: Entry): void {
    const newerJob = this.pending.get(job.sourcePath);
    job.outcome =
      !this.disposed &&
      this.entries.get(job.sourcePath) === entry &&
      newerJob !== undefined &&
      newerJob.generation > job.generation
        ? "superseded"
        : "cancelled";
  }

  private requeueAfterConfiguration(paths: Set<string>): void {
    for (const sourcePath of paths) {
      if (this.disposed) return;
      const entry = this.entries.get(sourcePath);
      if (!entry?.enabled || !this.sourceExists(sourcePath)) continue;
      void this.enqueue(sourcePath, false);
    }
  }

  private isLineageCurrent(entry: Entry, sourcePath: string, generation: number): boolean {
    return (
      !this.disposed &&
      this.entries.get(sourcePath) === entry &&
      entry.generation === generation
    );
  }

  private authorizationIsLive(job: PendingJob, entry: Entry, authorizationEpoch: number): boolean {
    return this.authorizationIsLiveForPath(entry, job.sourcePath, authorizationEpoch);
  }

  private authorizationIsLiveForPath(
    entry: Entry,
    sourcePath: string,
    authorizationEpoch: number,
  ): boolean {
    return (
      !this.disposed &&
      this.entries.get(sourcePath) === entry &&
      entry.authorizationEpoch === authorizationEpoch
    );
  }

  private revokeAuthorization(entry: Entry): void {
    entry.authorizationEpoch++;
    entry.authorizedPath = undefined;
    entry.authorizedHash = undefined;
  }

  private rememberAuthorization(entry: Entry, observed: DestinationSnapshot): void {
    entry.authorizedPath = observed.path;
    entry.authorizedHash = observed.hash ?? undefined;
    entry.declinedPath = undefined;
    entry.declinedHash = undefined;
  }

  private rememberDecline(entry: Entry, observed: DestinationSnapshot): void {
    entry.declinedPath = observed.path;
    entry.declinedHash = observed.hash ?? undefined;
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
    private readonly configuration?: Partial<LspConfiguration>,
  ) {}

  exportPdf(request: AutomaticPdfExportRequest): Promise<Uint8Array> {
    const run = this.serial.then(async () => {
      if (this.stopped) throw new Error("automatic PDF exporter stopped");
      // Tinymist keeps a project snapshot in the LSP worker. A fresh isolated
      // client for each export observes the saved entry and imported bytes and
      // cannot poison the next export after a failed compile.
      const client = new LspClient(this.binaryPath, this.rootPath, () => {}, this.configuration);
      this.client = client;
      try {
        await client.start();
        if (this.stopped) throw new Error("automatic PDF exporter stopped");
        client.setExportInput(request.sourceInput);
        const result = await client.exportPdf(request.entryPath);
        const data = result?.data;
        if (!data) throw new Error("Tinymist returned no PDF data");
        return new Uint8Array(Buffer.from(data, "base64"));
      } finally {
        client.stop();
        if (this.client === client) this.client = null;
      }
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
}

function sameSnapshot(a: DestinationSnapshot, b: DestinationSnapshot): boolean {
  return a.path === b.path && a.exists === b.exists && a.hash === b.hash && !a.error && !b.error;
}
