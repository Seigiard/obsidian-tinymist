import { isAbsolute, join } from "path";
import type { KitView } from "../markdown/convert";
import { stopManifestReads, type ParsedManifest } from "./manifest";

export type { ParsedManifest } from "./manifest";

export type KitState =
  | { kind: "none" }
  | { kind: "loading"; previous?: ParsedManifest }
  | { kind: "ready"; manifest: ParsedManifest }
  | { kind: "failed"; reason: string };

export type KitStateView =
  | { ready: true; kit: KitView | null }
  | { ready: false; reason: string };

interface KitOptions {
  vaultBase: string;
  bin(): string | null;
  settings(): { kitManifest: string; defaultTemplate: string };
  readManifest(
    binPath: string,
    vaultBase: string,
    manifestAbsPath: string,
    timeoutMs?: number,
  ): Promise<ParsedManifest>;
}

/** Owns the in-memory kit manifest and serializes its reloads. */
export class Kit {
  state: KitState;

  private readonly listeners = new Set<() => void>();
  private worker: Promise<void> | null = null;
  private requestVersion = 0;
  private epoch = 0;
  private forceVersion = 0;
  private lastForceVersion = 0;
  private observedManifestPath: string;
  private loadedManifestPath: string | null = null;
  private lastNotifiedDefault: string;
  private disposed = false;

  constructor(private readonly options: KitOptions) {
    const settings = options.settings();
    this.state = settings.kitManifest.trim() === "" ? { kind: "none" } : { kind: "loading" };
    this.observedManifestPath = settings.kitManifest.trim();
    this.lastNotifiedDefault = settings.defaultTemplate;
  }

  reload(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const manifestPath = this.manifestSetting();
    if (manifestPath !== this.observedManifestPath) {
      this.observedManifestPath = manifestPath;
      this.epoch += 1;
    }
    this.requestVersion += 1;
    if (force) {
      this.forceVersion = this.requestVersion;
      this.epoch += 1;
    }
    if (!this.worker) {
      const worker = this.runReload();
      const wrapped = worker.finally(() => {
        if (this.worker === wrapped) this.worker = null;
      });
      this.worker = wrapped;
    }
    return this.worker;
  }

  onChange(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Mark the configured path missing after a vault rename or delete event. */
  markManifestMissing(path: string): void {
    if (this.disposed || this.manifestSetting() !== path) return;
    this.epoch += 1;
    this.loadedManifestPath = path;
    this.state = { kind: "failed", reason: `Manifest file not found: ${path}` };
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.requestVersion += 1;
    stopManifestReads();
    this.listeners.clear();
  }

  view(): KitStateView {
    const defaultTemplate = this.options.settings().defaultTemplate;
    switch (this.state.kind) {
      case "none":
        return defaultTemplate === ""
          ? { ready: true, kit: null }
          : { ready: true, kit: { templates: {}, defaultTemplate } };
      case "loading":
        return { ready: false, reason: "Typst kit is loading" };
      case "failed":
        return { ready: false, reason: `Typst kit failed: ${this.state.reason}` };
      case "ready":
        return {
          ready: true,
          kit: {
            templates: { ...this.state.manifest.templates },
            defaultTemplate,
          },
        };
    }
  }

  private async runReload(): Promise<void> {
    let handledVersion = 0;
    while (!this.disposed && handledVersion !== this.requestVersion) {
      const version = this.requestVersion;
      const force = this.forceVersion;
      const manifestPath = this.manifestSetting();
      const defaultChanged = this.options.settings().defaultTemplate !== this.lastNotifiedDefault;

      if (manifestPath === "") {
        this.loadedManifestPath = null;
        if (this.state.kind !== "none") {
          this.state = { kind: "none" };
          this.notify();
        } else if (defaultChanged) {
          this.notify();
        }
        handledVersion = version;
        continue;
      }

      const mustRead = manifestPath !== this.loadedManifestPath || force > this.lastForceVersion;
      if (!mustRead) {
        if (defaultChanged) this.notify();
        handledVersion = version;
        continue;
      }
      this.lastForceVersion = force;
      const readEpoch = this.epoch;
      const previous =
        this.state.kind === "ready"
          ? this.state.manifest
          : this.state.kind === "loading"
            ? this.state.previous
            : undefined;
      this.state = previous ? { kind: "loading", previous } : { kind: "loading" };
      this.loadedManifestPath = null;
      this.notify();

      let manifest: ParsedManifest | null = null;
      let failure: string | null = null;
      const bin = this.options.bin();
      if (!bin) {
        failure = "Tinymist binary not found";
      } else {
        try {
          manifest = await this.options.readManifest(
            bin,
            this.options.vaultBase,
            this.manifestAbsolutePath(manifestPath),
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      if (this.disposed) return;

      const superseded = this.epoch !== readEpoch;
      if (!superseded) {
        this.loadedManifestPath = manifestPath;
        this.state = manifest ? { kind: "ready", manifest } : { kind: "failed", reason: failure ?? "Unknown manifest error" };
        this.notify();
        handledVersion = this.requestVersion;
      } else {
        handledVersion = version;
      }
    }
  }

  private manifestSetting(): string {
    return this.options.settings().kitManifest.trim();
  }

  private manifestAbsolutePath(path: string): string {
    return isAbsolute(path) ? path : join(this.options.vaultBase, path);
  }

  private notify(): void {
    this.lastNotifiedDefault = this.options.settings().defaultTemplate;
    for (const listener of this.listeners) listener();
  }

}
