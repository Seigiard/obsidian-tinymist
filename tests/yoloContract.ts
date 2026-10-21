// Complete production YOLO plugin through the real bridge; only transport is mocked.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import type { App } from "obsidian";
import { bindYolo, YoloBridge } from "../src/editor/shared/yoloBridge";
import { keyArbiter } from "../src/editor/shared/keyArbiter";
import { press, sleep, typeText, waitFor } from "./support/keyMatrix";
import { loadYolo } from "./support/realYolo";

const real = loadYolo(process.env.YOLO_MAIN!);
function setup(options: Parameters<typeof real.make>[0] = {}) {
  const yolo = real.make(options);
  const plugins = { yolo: yolo.plugin };
  const bridge = new YoloBridge({ plugins: { plugins } } as unknown as App,
    { name: "contract", enabled: () => true });
  const mode = new Compartment();
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc: "Let x = ", selection: { anchor: 8 }, extensions: [
      keyArbiter({ inline: () => bridge.inline }), bridge.extension(() => "chapters/证明.tex"),
      autocompletion({ override: [(ctx) => ({ from: ctx.pos, options: [{ label: "\\frac" }] })] }),
      keymap.of(defaultKeymap), mode.of([]),
    ],
  }) });
  view.focus();
  return { ...yolo, plugins, bridge, view, mode,
    close: () => { bridge.destroy(); yolo.dispose(); view.destroy(); } };
}

test("production bundle satisfies the controller contract without a release allowlist", () => {
  const yolo = real.make({ version: "arbitrary-next-release" });
  assert.equal(typeof bindYolo(yolo.plugin), "object");
  assert.match(String(bindYolo({ ...yolo.plugin, getTabCompletionController: null })), /missing plugin/);
  yolo.dispose();
});

test("real stream renders and Tab inserts literal TeX after mode reconfiguration", async (t) => {
  const c = setup(); t.after(c.close);
  assert.equal(c.bridge.triggerNow(c.view), true);
  await waitFor(() => c.requests.length === 1);
  assert.equal(c.requests[0].body.suffix, "");
  assert.ok(c.requests[0].body.prompt.includes("Let x = "));
  c.view.dispatch({ effects: c.mode.reconfigure(EditorView.lineWrapping) });
  c.requests[0].reply("\\alpha < b");
  await waitFor(() => c.bridge.inline.status(c.view) === "visible");
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "Let x = \\alpha < b");
  assert.equal(c.bridge.inline.status(c.view), "none");
});

test("Escape cancels a real request and ignores a late stream", async (t) => {
  const c = setup(); t.after(c.close);
  c.bridge.triggerNow(c.view);
  await waitFor(() => c.requests.length === 1);
  press(c.view, "Escape"); c.requests[0].reply("late"); await sleep(15);
  assert.equal(c.requests[0].signal.aborted, true);
  assert.equal(c.bridge.inline.status(c.view), "none");
  assert.equal(c.view.state.doc.toString(), "Let x = ");
});

test("cursor movement invalidates the real suggestion", async (t) => {
  const c = setup(); t.after(c.close);
  c.bridge.triggerNow(c.view); await waitFor(() => c.requests.length === 1);
  c.requests[0].reply("raw"); await waitFor(() => c.bridge.inline.status(c.view) === "visible");
  c.view.dispatch({ selection: { anchor: 1 } }); await sleep(0);
  assert.equal(c.bridge.inline.status(c.view), "none");
  assert.equal(c.bridge.inline.accept(c.view), false);
});

test("composition cancels the controller and prevents automatic requests", async (t) => {
  const c = setup({ automatic: true }); t.after(c.close);
  c.bridge.triggerNow(c.view); await waitFor(() => c.requests.length === 1);
  Object.defineProperty(c.view, "composing", { value: true, configurable: true });
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  typeText(c.view, "输入"); await sleep(80);
  assert.equal(c.requests.length, 1); assert.equal(c.requests[0].signal.aborted, true);
  Object.defineProperty(c.view, "composing", { value: false, configurable: true });
});

test("automatic completion delivers the final edit through the real debounce", async (t) => {
  const c = setup({ automatic: true, delay: 25 }); t.after(c.close);
  typeText(c.view, "a"); await sleep(5); typeText(c.view, "b");
  await waitFor(() => c.requests.length === 1);
  assert.ok(c.requests[0].body.prompt.endsWith("Let x = ab"));
  c.requests[0].reply("c"); await waitFor(() => c.bridge.inline.status(c.view) === "visible");
  press(c.view, "Tab"); assert.equal(c.view.state.doc.toString(), "Let x = abc");
});

test("native completion popup takes priority over a pending AI request", async (t) => {
  const c = setup(); t.after(c.close);
  c.bridge.triggerNow(c.view); await waitFor(() => c.requests.length === 1);
  startCompletion(c.view); await waitFor(() => completionStatus(c.view.state) === "active");
  await sleep(0); assert.equal(c.requests[0].signal.aborted, true);
  assert.equal(c.bridge.inline.status(c.view), "none"); press(c.view, "Escape");
});

test("closing an editor disarms its pending automatic request", async () => {
  const c = setup({ automatic: true, delay: 80 });
  typeText(c.view, "typing"); await sleep(0); c.close(); await sleep(120);
  assert.equal(c.requests.length, 0);
});
