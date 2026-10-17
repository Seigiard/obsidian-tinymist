// Stand-in for the "obsidian" module in tests (scripts/run-tests.mjs aliases it here), so
// the plugin's views mount in jsdom. It models only the documented behaviour the views
// rely on, not Obsidian's implementation: TextFileView.requestSave debounces save(), and
// save() writes getViewData() through vault.modify when it changed since the last load or
// save (save(true), on close, also calls clear()); getState() is `{ file }`, and setState()
// loads `state.file` when it is another file. Notices are recorded in `Notice.shown`;
// setIcon records the icon in `data-icon`.

type Callback = (...args: unknown[]) => unknown;

export class Component {
  load(): void {}
  unload(): void {}
  registerEvent(_ref: unknown): void {}
  register(_cb: Callback): void {}
}

export class Plugin extends Component {
  constructor(public app: unknown) {
    super();
  }
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
  addCommand(_command: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  addStatusBarItem(): HTMLElement {
    return document.createElement("div");
  }
  registerView(_type: string, _factory: unknown): void {}
  registerExtensions(_extensions: string[], _viewType: string): void {}
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(_app: unknown, _plugin: Plugin) {}
}

export class Setting {}

export class Modal {
  constructor(_app: unknown) {}
  open(): void {}
  close(): void {}
}

export class ItemView extends Component {
  contentEl = document.createElement("div") as HTMLElement & {
    addClass(className: string): void;
    createEl(tag: string, options?: { cls?: string }): HTMLElement;
  };
  constructor(_leaf: WorkspaceLeaf) {
    super();
    this.contentEl.addClass = (className) => this.contentEl.classList.add(className);
    this.contentEl.createEl = (tag, options) => {
      const el = document.createElement(tag);
      if (options?.cls) el.className = options.cls;
      this.contentEl.appendChild(el);
      return el;
    };
  }
  async onClose(): Promise<void> {}
}

export class FileSystemAdapter {
  constructor(private basePath = "") {}
  getBasePath(): string {
    return this.basePath;
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

export class TFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop()!;
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
  get extension(): string {
    return this.name.split(".").pop()!;
  }
}

/** An in-memory vault; `writes` records every modify in order. */
export class TestVault {
  files = new Map<string, string>();
  writes: { path: string; data: string }[] = [];
  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }
  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
    this.writes.push({ path: file.path, data });
  }
}

export interface TestApp {
  vault: TestVault;
  scope: Scope;
  workspace: { on(...args: unknown[]): unknown; requestSaveLayout(): void; layoutSaves: number };
  plugins: { plugins: Record<string, unknown> };
}

export function testApp(): TestApp {
  const workspace = {
    layoutSaves: 0,
    on: () => ({}),
    requestSaveLayout() {
      workspace.layoutSaves++;
    },
  };
  return { vault: new TestVault(), scope: new Scope(), workspace, plugins: { plugins: {} } };
}

export class WorkspaceLeaf {
  constructor(public app: TestApp) {}
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
