// Stand-in for the "obsidian" module in tests (scripts/run-tests.mjs aliases it here), so
// the plugin's views mount in jsdom. It models only the documented behaviour the views
// rely on, not Obsidian's implementation: TextFileView.requestSave debounces save(), and
// save() writes getViewData() through vault.modify when it changed since the last load or
// save (save(true), on close, also calls clear()); getState() is `{ file }`, and setState()
// loads `state.file` when it is another file. Notices are recorded in `Notice.shown`;
// setIcon records the icon in `data-icon`.

type Callback = (...args: unknown[]) => unknown;

type EventCallback = (...args: unknown[]) => unknown;

export class Component {
  private cleanup: Callback[] = [];

  load(): void {}
  unload(): void {
    for (const callback of this.cleanup.splice(0).reverse()) callback();
  }
  registerEvent(ref: unknown): void {
    const detach = (ref as { detach?: unknown } | null)?.detach;
    if (typeof detach === "function") this.register(() => detach.call(ref));
  }
  register(cb: Callback): void {
    this.cleanup.push(cb);
  }
}

export class TAbstractFile {
  constructor(public path: string) {}

  get name(): string {
    return this.path.split("/").pop()!;
  }
}

export class Scope {
  keys: { modifiers: string[]; key: string | null; func: Callback }[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[], key: string | null, func: Callback) {
    const handler = { modifiers, key, func };
    this.keys.push(handler);
    return handler;
  }
}

export class Notice {
  static shown: string[] = [];
  constructor(message: string, _timeout?: number) {
    Notice.shown.push(message);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.dataset.icon = icon;
}

export interface ViewStateResult {
  history: boolean;
}

export const MarkdownRenderer = {
  async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
    el.textContent = markdown;
  },
};

export class TFile extends TAbstractFile {
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
  get extension(): string {
    return this.name.split(".").pop()!;
  }
}

export class TFolder extends TAbstractFile {}

export class FileSystemAdapter {
  constructor(
    private basePath = "/vault",
    private files: Map<string, string> = new Map(),
  ) {}

  getBasePath(): string {
    return this.basePath;
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
}

export class MenuItem {
  title = "";
  checked = false;
  disabled = false;
  icon = "";
  private click: Callback = () => {};

  setTitle(title: string): this {
    this.title = title;
    return this;
  }

  setChecked(checked: boolean): this {
    this.checked = checked;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }

  onClick(click: Callback): this {
    this.click = click;
    return this;
  }

  async trigger(): Promise<void> {
    await this.click();
  }
}

export class Menu {
  readonly items: MenuItem[] = [];

  addItem(configure: (item: MenuItem) => void): this {
    const item = new MenuItem();
    configure(item);
    this.items.push(item);
    return this;
  }
}

/** An in-memory vault; `writes` records every modify in order. */
export class TestVault {
  files = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();
  writes: { path: string; data: string }[] = [];
  binaryWrites: { path: string; data: Uint8Array }[] = [];
  binaryReadStarted: string[] = [];
  binaryWriteStarted: { path: string; data: Uint8Array }[] = [];
  binaryReadBarriers: Promise<void>[] = [];
  binaryWriteBarriers: Promise<void>[] = [];
  failNextBinaryWrite: Error | null = null;
  adapter: FileSystemAdapter;
  private events = new Map<string, Set<EventCallback>>();
  private folderRenameIndexDelay: { oldPath: string; newPath: string } | null = null;

  constructor(basePath = "/vault") {
    this.adapter = new FileSystemAdapter(basePath, this.files);
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }
  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
    this.writes.push({ path: file.path, data });
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const data = this.binaryFiles.get(file.path);
    const copy = data?.slice();
    this.binaryReadStarted.push(file.path);
    const barrier = this.binaryReadBarriers.shift();
    if (barrier) await barrier;
    if (!copy) throw new Error(`Missing binary file: ${file.path}`);
    return copy.buffer;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    this.throwBinaryWriteFailure();
    const copy = new Uint8Array(data.slice(0));
    this.binaryWriteStarted.push({ path, data: copy });
    const barrier = this.binaryWriteBarriers.shift();
    if (barrier) await barrier;
    this.binaryFiles.set(path, copy);
    this.binaryWrites.push({ path, data: copy });
    return new TFile(path);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.throwBinaryWriteFailure();
    const copy = new Uint8Array(data.slice(0));
    this.binaryWriteStarted.push({ path: file.path, data: copy });
    const barrier = this.binaryWriteBarriers.shift();
    if (barrier) await barrier;
    this.binaryFiles.set(file.path, copy);
    this.binaryWrites.push({ path: file.path, data: copy });
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const indexedPath = this.indexedPhysicalPath(path);
    if (!indexedPath) return null;
    if (this.files.has(indexedPath) || this.binaryFiles.has(indexedPath)) return new TFile(path);
    const prefix = indexedPath.endsWith("/") ? indexedPath : `${indexedPath}/`;
    for (const candidate of [...this.files.keys(), ...this.binaryFiles.keys()]) {
      if (candidate.startsWith(prefix)) return new TFolder(path);
    }
    return null;
  }

  getFiles(): TFile[] {
    return [...this.files.keys(), ...this.binaryFiles.keys()].map((path) => new TFile(path));
  }

  on(name: string, callback: EventCallback): { name: string; callback: EventCallback; detach(): void } {
    let callbacks = this.events.get(name);
    if (!callbacks) this.events.set(name, (callbacks = new Set()));
    callbacks.add(callback);
    return { name, callback, detach: () => callbacks.delete(callback) };
  }

  async emit(name: string, ...args: unknown[]): Promise<void> {
    const pending = [...(this.events.get(name) ?? [])].map((callback) => callback(...args));
    await Promise.all(pending);
  }

  beginFolderRenameIndexDelay(oldPath: string, newPath: string): void {
    this.folderRenameIndexDelay = { oldPath, newPath };
  }

  dispatchFolderRenameAfterPhysicalMove(file: TFolder, oldPath: string): Promise<void> {
    const pending = [...(this.events.get("rename") ?? [])].map((callback) => {
      try {
        return Promise.resolve(callback(file, oldPath));
      } catch (error) {
        return Promise.reject(error);
      }
    });
    this.folderRenameIndexDelay = null;
    return Promise.all(pending).then(() => undefined);
  }

  private indexedPhysicalPath(path: string): string | null {
    const delay = this.folderRenameIndexDelay;
    if (!delay) return path;
    if (path === delay.newPath || path.startsWith(`${delay.newPath}/`)) return null;
    if (path === delay.oldPath) return delay.newPath;
    if (path.startsWith(`${delay.oldPath}/`)) {
      return `${delay.newPath}/${path.slice(delay.oldPath.length + 1)}`;
    }
    return path;
  }

  private throwBinaryWriteFailure(): void {
    if (!this.failNextBinaryWrite) return;
    const error = this.failNextBinaryWrite;
    this.failNextBinaryWrite = null;
    throw error;
  }
}

export class TestFileManager {
  readonly renames: { from: string; to: string }[] = [];
  failNext: Error | null = null;

  constructor(private vault: TestVault) {}

  async renameFile(file: TFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    this.renames.push({ from: oldPath, to: newPath });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const text = this.vault.files.get(oldPath);
    if (text !== undefined) {
      this.vault.files.delete(oldPath);
      this.vault.files.set(newPath, text);
    }
    const binary = this.vault.binaryFiles.get(oldPath);
    if (binary !== undefined) {
      this.vault.binaryFiles.delete(oldPath);
      this.vault.binaryFiles.set(newPath, binary);
    }
    file.path = newPath;
  }
}

export class TestWorkspace {
  layoutSaves = 0;
  private events = new Map<string, Set<EventCallback>>();
  private layoutReady: Callback[] = [];

  on(name: string, callback: EventCallback): { name: string; callback: EventCallback; detach(): void } {
    let callbacks = this.events.get(name);
    if (!callbacks) this.events.set(name, (callbacks = new Set()));
    callbacks.add(callback);
    return { name, callback, detach: () => callbacks.delete(callback) };
  }

  onLayoutReady(callback: Callback): void {
    this.layoutReady.push(callback);
  }

  async runLayoutReady(): Promise<void> {
    await Promise.all(this.layoutReady.map((callback) => callback()));
  }

  requestSaveLayout(): void {
    this.layoutSaves++;
  }

  getActiveViewOfType(): null {
    return null;
  }

  getLeavesOfType(): WorkspaceLeaf[] {
    return [];
  }
}

export interface TestApp {
  vault: TestVault;
  scope: Scope;
  workspace: TestWorkspace;
  fileManager: TestFileManager;
  plugins: { plugins: Record<string, unknown> };
  pluginData: Record<string, unknown>;
}

export function testApp(basePath = "/vault"): TestApp {
  const vault = new TestVault(basePath);
  return {
    vault,
    scope: new Scope(),
    workspace: new TestWorkspace(),
    fileManager: new TestFileManager(vault),
    plugins: { plugins: {} },
    pluginData: {},
  };
}

export class WorkspaceLeaf {
  view: unknown = null;
  constructor(public app: TestApp) {}

  detach(): void {}
}

export class Plugin extends Component {
  constructor(
    public app: TestApp,
    public manifest: Record<string, unknown> = {},
  ) {
    super();
  }

  async loadData(): Promise<unknown> {
    return structuredClone(this.app.pluginData);
  }

  async saveData(data: unknown): Promise<void> {
    this.app.pluginData = structuredClone(data as Record<string, unknown>);
  }

  registerView(_type: string, _creator: Callback): void {}
  registerExtensions(_extensions: string[], _type: string): void {}
  addCommand(_command: unknown): void {}
  addSettingTab(_tab: unknown): void {}

  addStatusBarItem(): { setText(text: string): void } {
    return { setText: () => {} };
  }
}

export class Modal extends Component {
  titleEl = document.createElement("div");
  contentEl = document.createElement("div");

  constructor(public app: TestApp) {
    super();
  }

  open(): void {}
  close(): void {}
}

export class PluginSettingTab extends Component {
  containerEl = document.createElement("div");

  constructor(
    public app: TestApp,
    public plugin: Plugin,
  ) {
    super();
  }
}

export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_description: string): this { return this; }
  setHeading(): this { return this; }
  addText(_configure: Callback): this { return this; }
  addToggle(_configure: Callback): this { return this; }
  addDropdown(_configure: Callback): this { return this; }
}

export class ItemView extends Component {
  containerEl = document.createElement("div");
  contentEl = document.createElement("div");

  constructor(public leaf: WorkspaceLeaf) {
    super();
    const headerEl = document.createElement("div");
    headerEl.className = "view-header";
    this.contentEl.className = "view-content";
    this.containerEl.append(headerEl, this.contentEl);
    document.body.appendChild(this.containerEl);
  }

  async onClose(): Promise<void> {
    this.containerEl.remove();
  }
}

export abstract class TextFileView extends Component {
  /** requestSave's debounce (2 s in Obsidian). */
  static requestSaveMs = 2000;
  app: TestApp;
  leaf: WorkspaceLeaf;
  file: TFile | null = null;
  data = "";
  scope: Scope | null = null;
  contentEl: HTMLElement & { addClasses(classes: string[]): void };
  private lastSaved: string | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    const el = document.createElement("div") as HTMLElement & { addClasses(classes: string[]): void };
    el.addClasses = (classes) => el.classList.add(...classes);
    this.contentEl = el;
    document.body.appendChild(el);
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;

  requestSave = (): void => {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      void this.save();
    }, TextFileView.requestSaveMs);
  };

  async save(clear?: boolean): Promise<void> {
    if (!this.file) return;
    const data = this.getViewData();
    const changed = data !== this.lastSaved;
    this.lastSaved = clear ? null : data;
    if (clear) this.clear();
    if (changed) await this.app.vault.modify(this.file, data);
  }

  async loadFile(file: TFile): Promise<void> {
    if (this.file) await this.onUnloadFile(this.file);
    this.file = file;
    this.data = this.lastSaved = await this.app.vault.read(file);
    this.setViewData(this.data, true);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.save(true);
  }

  async onRename(_file: TFile): Promise<void> {}

  // Represent the documented base file-view contribution without copying Obsidian internals.
  onPaneMenu(menu: Menu, _source: string): void {
    menu.addItem((item) => item.setTitle("Base file action"));
  }

  async onClose(): Promise<void> {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    if (this.file) await this.onUnloadFile(this.file);
    this.file = null;
    this.contentEl.remove();
  }

  getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const path = (state as { file?: unknown } | null)?.file;
    if (typeof path === "string" && path !== this.file?.path) await this.loadFile(new TFile(path));
  }

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  /** The header actions, as Obsidian draws them: a clickable element with an aria-label. */
  actions: HTMLElement[] = [];

  addAction(icon: string, title: string, cb: Callback): HTMLElement {
    const el = document.createElement("a");
    el.dataset.icon = icon;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", (e) => cb(e));
    this.actions.push(el);
    return el;
  }
}
