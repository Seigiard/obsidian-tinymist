// Browser smoke for selection paint order in the Typst editor. Computed styles cannot reveal
// whether the active-line layer covers CodeMirror's selection layer, so this samples screenshots.
// Usage: node scripts/selection-smoke.mjs (CHROME_BIN overrides the browser).
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(".");
const CHROME = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));

if (!CHROME) {
  console.error("selection-smoke: Chrome not found (set CHROME_BIN)");
  process.exit(1);
}

const ENTRY = String.raw`
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine } from "@codemirror/view";

window.__selectionSmoke = {
  mount(doc, selection, width, dark) {
    window.__view?.destroy();
    const host = document.getElementById("host");
    host.style.width = width + "px";
    window.__view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection,
        extensions: [drawSelection(), highlightActiveLine(), EditorView.lineWrapping, EditorView.darkTheme.of(dark)],
      }),
    });
    window.__view.focus();
  },
  point(pos) {
    const rect = window.__view.coordsAtPos(pos);
    return { x: Math.floor(rect.left + 2), y: Math.floor(rect.top + 2) };
  },
};
window.__ready = true;
`;

const PAGE_CSS = `
html, body { margin: 0; }
body { padding: 24px; }
body.theme-light {
  --background-primary: rgb(255, 255, 255);
  --background-primary-alt: rgb(250, 250, 250);
  --mono-100: black;
  --background-modifier-hover: color-mix(in oklch, var(--mono-100) 6.7%, transparent);
  --text-normal: rgb(34, 34, 34);
  --interactive-accent: hsl(258, 88%, 66%);
  --text-selection: color-mix(in oklch, var(--interactive-accent) 20%, transparent);
}
body.theme-dark {
  --background-primary: rgb(28, 28, 28);
  --background-primary-alt: rgb(35, 35, 35);
  --mono-100: white;
  --background-modifier-hover: color-mix(in oklch, var(--mono-100) 6.7%, transparent);
  --text-normal: rgb(230, 230, 230);
  --interactive-accent: hsl(258, 88%, 66%);
  --text-selection: color-mix(in oklch, var(--interactive-accent) 33%, transparent);
}
body.things-light {
  --background-modifier-hover: #e2e5e9;
}
#host { height: 260px; }
#host .cm-editor { height: 100%; }
#host .cm-scroller { font-family: Menlo, monospace; font-size: 16px; line-height: 24px; }
`;

const PALETTES = {
  light: {
    className: "theme-light",
    dark: false,
    inactive: [255, 255, 255, 255],
  },
  "things-light": {
    className: "theme-light things-light",
    dark: false,
    inactive: [255, 255, 255, 255],
  },
  dark: {
    className: "theme-dark",
    dark: true,
    inactive: [28, 28, 28, 255],
  },
};

const ACTIVE_LINE_MIN_DISTANCE = 5;
const SELECTION_MIN_DISTANCE = 16;
const CDP_TIMEOUT_MS = Number(process.env.SELECTION_SMOKE_CDP_TIMEOUT_MS ?? 5000);

const work = mkdtempSync(join(tmpdir(), "selection-smoke-"));
const profile = join(work, "profile");
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

async function writePage() {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts", sourcefile: "selection-smoke-entry.ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
  });
  writeFileSync(join(work, "bundle.js"), out.outputFiles[0].text);
  const styles = readFileSync(join(ROOT, "styles.css"), "utf8");
  writeFileSync(
    join(work, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>` +
      `<body><div class="tym-editor-content lsp-cm-view"><div id="host"></div></div>` +
      `<script src="/bundle.js"></script><style>${styles}</style></body></html>`,
  );
}

function serve() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = join(work, path);
    if (!file.startsWith(work + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

function launch() {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const url = new Promise((resolveUrl, rejectUrl) => {
    let stderr = "";
    const timer = setTimeout(() => rejectUrl(new Error(`Chrome did not start: ${stderr.slice(-400)}`)), 20000);
    chrome.stderr.on("data", (data) => {
      stderr += data;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    chrome.on("exit", () => rejectUrl(new Error(`Chrome exited: ${stderr.slice(-400)}`)));
  });
  return { chrome, url };
}

function kill(chrome) {
  if (!chrome || chrome.exitCode !== null) return Promise.resolve();
  const exited = new Promise((resolveExit) => chrome.once("exit", resolveExit));
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
  return Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = resolveOpen;
    ws.onerror = () => rejectOpen(new Error("DevTools connection failed"));
  });
  let id = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };
  ws.onclose = () => rejectPending(new Error("DevTools connection closed"));
  ws.onerror = () => rejectPending(new Error("DevTools connection failed"));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const call = message.id && pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolveCall, rejectCall) => {
      const callId = ++id;
      const timer = setTimeout(() => {
        pending.delete(callId);
        rejectCall(new Error(`DevTools ${method} timed out after ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      pending.set(callId, { resolve: resolveCall, reject: rejectCall, timer });
      try {
        ws.send(JSON.stringify({ id: callId, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(callId);
        rejectCall(error);
      }
    });
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    return { ws, page, evaluate };
  } catch (error) {
    ws.close();
    throw error;
  }
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const results = [];

function check(theme, scenario, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ theme, scenario, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${theme} ${scenario}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function pixelDistance(left, right) {
  return Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - right[index])));
}

function checkDistance(theme, scenario, left, right, minimum) {
  const actual = pixelDistance(left, right);
  const pass = actual >= minimum;
  results.push({ theme, scenario, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${theme} ${scenario}: expected at least ${minimum} RGB levels, got ${actual}`);
}

async function pixels(page, evaluate, points) {
  const { data } = await page("Page.captureScreenshot", { format: "png", fromSurface: true });
  return evaluate(`(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${data}";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return ${JSON.stringify(points)}.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data]);
  })()`);
}

async function mount(evaluate, palette, doc, anchor, head, width = 560) {
  await evaluate(`document.body.className = ${JSON.stringify(palette.className)}, __selectionSmoke.mount(${JSON.stringify(doc)}, { anchor: ${anchor}, head: ${head} }, ${width}, ${palette.dark}), true`);
  await evaluate("document.fonts.ready.then(() => true)");
  await sleep(100);
}

async function singleLine(cdp, theme, palette) {
  // #given
  const first = "prefix leading suffix";
  const doc = `${first}\ninactive control`;
  const from = doc.indexOf("leading");
  const to = from + "leading".length;
  await mount(cdp.evaluate, palette, doc, from, to);

  // #when
  const points = await cdp.evaluate(`[
    __selectionSmoke.point(${from + 2}),
    __selectionSmoke.point(${doc.indexOf("suffix") + 2}),
    __selectionSmoke.point(${first.length + 1 + 2})
  ]`);
  const [selected, unselected, inactive] = await pixels(cdp.page, cdp.evaluate, points);

  // #then
  checkDistance(theme, "single-line selected text on the active line", selected, unselected, SELECTION_MIN_DISTANCE);
  checkDistance(theme, "single-line active line remains identifiable", unselected, inactive, ACTIVE_LINE_MIN_DISTANCE);
}

async function multiline(cdp, theme, palette) {
  // #given
  const first = "prefix leading control";
  const second = "leading active suffix";
  const doc = `${first}\n${second}`;
  const anchor = first.indexOf("leading");
  const head = first.length + 1 + "leading".length;
  await mount(cdp.evaluate, palette, doc, anchor, head);

  // #when
  const points = await cdp.evaluate(`[
    __selectionSmoke.point(${anchor + 2}),
    __selectionSmoke.point(2),
    __selectionSmoke.point(${first.length + 1 + 2}),
    __selectionSmoke.point(${doc.indexOf("suffix") + 2})
  ]`);
  const [inactiveSelected, inactive, activeSelected, active] = await pixels(cdp.page, cdp.evaluate, points);

  // #then
  checkDistance(theme, "inactive-line selection control", inactiveSelected, inactive, SELECTION_MIN_DISTANCE);
  check(theme, "inactive-line background control", inactive, palette.inactive);
  checkDistance(theme, "multiline selection on its active endpoint line", activeSelected, active, SELECTION_MIN_DISTANCE);
  checkDistance(theme, "multiline active line remains identifiable", active, inactive, ACTIVE_LINE_MIN_DISTANCE);
}

async function wrapped(cdp, theme, palette) {
  // #given
  const first = `prefix ${"word ".repeat(22)}leading ${"tail ".repeat(8)}`;
  const doc = `${first}\ninactive control`;
  const anchor = doc.indexOf("word");
  const head = doc.indexOf("tail") + "tail".length;
  await mount(cdp.evaluate, palette, doc, anchor, head, 300);

  // #when
  const points = await cdp.evaluate(`[
    __selectionSmoke.point(${doc.indexOf("leading") + 2}),
    __selectionSmoke.point(2),
    __selectionSmoke.point(${first.length + 1 + 2})
  ]`);
  const [selected, unselected, inactive] = await pixels(cdp.page, cdp.evaluate, points);

  // #then
  checkDistance(theme, "wrapped selection on the active line", selected, unselected, SELECTION_MIN_DISTANCE);
  checkDistance(theme, "wrapped active line remains identifiable", unselected, inactive, ACTIVE_LINE_MIN_DISTANCE);
}

let chrome = null;
let server = null;
let ws = null;
let cleanupPromise = null;

function cleanup() {
  cleanupPromise ??= (async () => {
    try {
      ws?.close();
    } catch {
      // The browser may already have closed the DevTools socket.
    }
    await kill(chrome);
    await new Promise((resolveClose) => (server ? server.close(resolveClose) : resolveClose()));
    rmSync(work, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

function handleSignal(exitCode) {
  void cleanup().then(() => process.exit(exitCode));
}

process.once("SIGINT", () => handleSignal(130));
process.once("SIGTERM", () => handleSignal(143));

try {
  await writePage();
  server = await serve();
  const launched = launch();
  chrome = launched.chrome;
  const cdp = await connect(await launched.url);
  ws = cdp.ws;
  await cdp.page("Runtime.enable");
  await cdp.page("Page.enable");
  await cdp.page("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp.page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/index.html` });
  for (let attempt = 0; attempt < 200 && !(await cdp.evaluate("window.__ready === true").catch(() => false)); attempt++) await sleep(25);

  console.log(`selection-smoke: ${CHROME}`);
  check("control", "pixel distance extracts the largest RGB difference", pixelDistance([0, 0, 0, 255], [15, 16, 15, 255]), 16);
  checkDistance("control", "active-line threshold accepts its minimum", [0, 0, 0, 255], [4, 5, 4, 255], ACTIVE_LINE_MIN_DISTANCE);
  check("control", "active-line threshold rejects a nearly invisible tint", pixelDistance([0, 0, 0, 255], [4, 4, 4, 255]) >= ACTIVE_LINE_MIN_DISTANCE, false);
  check("control", "selection threshold rejects a nearly invisible tint", pixelDistance([0, 0, 0, 255], [15, 15, 15, 255]) >= SELECTION_MIN_DISTANCE, false);
  for (const [theme, palette] of Object.entries(PALETTES)) {
    await singleLine(cdp, theme, palette);
    await multiline(cdp, theme, palette);
    await wrapped(cdp, theme, palette);
  }
} catch (error) {
  results.push({ theme: "--", scenario: "smoke run", pass: false });
  console.error(`FAIL smoke run: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
}

const failed = results.filter((result) => !result.pass);
console.log(`selection-smoke: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
