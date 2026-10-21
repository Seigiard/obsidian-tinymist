// T-T2..T-T4, T-T7: the dedicated fragment renderer (src/lsp/fragmentRenderer.ts) and the
// render glue (src/editor/typstRender.ts) against a real tinymist, on a copy of the
// synthetic book in tests/fixtures/book inside a temporary vault. Skipped when no
// tinymist binary is found (TINYMIST_BIN overrides the lookup). Binaries that do not
// start are synthetic shell scripts and always run.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Text } from "@codemirror/state";
import { fragmentSource, readSvg, typstMathAt } from "../src/editor/typstFragment";
import { FragmentResult, TypstRender, typstPaperAt } from "../src/editor/typstRender";
import { LspClient, LspDiagnostic, pathToUri } from "../src/lsp/client";
import { FRAGMENT_DOC, FragmentError, TypstFragmentRenderer } from "../src/lsp/fragmentRenderer";
import { nodeFixture } from "./support/nodeFixture";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeout = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await sleep(10);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every file below `dir`, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

const inline = (body: string) => ({ body, display: false });

/** A valid 1x1 RGB PNG (synthetic test data). */
function onePixelPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 4 + body.length);
    return out;
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 200, 30, 30]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const width = (svg: string) => readSvg(svg, "f-")!.width;
/** The glyphs a render uses (ids are content hashes, prefixed per render). */
const glyphs = (r: FragmentResult) =>
  r.ok ? new Set([...r.svg.matchAll(/href="#f[\w]+-(g[0-9A-F]+)"/g)].map((m) => m[1])) : new Set<string>();

test("the fragment renderer against a real tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, async (t) => {
  const vault = mkdtempSync(join(tmpdir(), "tinymist-fragments-"));
  cpSync("tests/fixtures/book", join(vault, "book"), { recursive: true });
  const before = files(vault);
  const chapters = join(vault, "book", "chapters");
  const debug = console.debug;
  console.debug = () => {}; // the client forwards tinymist's stderr log here
  const renderer = new TypstFragmentRenderer({ bin: () => BIN!, root: vault });
  const pids: number[] = [];

  try {
    await t.test("T-T2: renders fresh SVG from memory, never stale, never on disk; errors carry Typst's message", async () => {
      assert.equal(renderer.pid, null, "started lazily");
      const first = await renderer.render(chapters, fragmentSource("", inline("$x^2$")));
      pids.push(renderer.pid!);
      assert.match(first, /^<svg\b/);
      assert.ok(readSvg(first, "f-")!.baseline! > 0, "the baseline marker is in the page");

      // Each cycle is 1pt wider than the one before: a stale export shows as a wrong width.
      const source = (i: number) => fragmentSource("", inline(`$x$#box(width: ${i}pt, height: 1pt)`));
      const w0 = width(await renderer.render(chapters, source(0)));
      let stale = 0;
      for (let i = 1; i <= 200; i++) {
        if (Math.abs(width(await renderer.render(chapters, source(i))) - (w0 + i)) > 0.01) stale++;
      }
      assert.equal(stale, 0);

      // Concurrent renders of one folder are serialized: each gets its own source's page.
      const widths = await Promise.all([3, 7, 5].map(async (i) => width(await renderer.render(chapters, source(i)))));
      assert.deepEqual(widths.map((w) => Math.round(w - w0)), [3, 7, 5]);

      await assert.rejects(
        renderer.render(chapters, fragmentSource("", inline("$frac(1, $"))),
        (e: Error) => e instanceof FragmentError && e.message === "unclosed delimiter",
      );
      await assert.rejects(
        renderer.render(chapters, fragmentSource("", inline("$bX + 1$"))),
        (e: Error) => e instanceof FragmentError && /^unknown variable: bX\nhint: /.test(e.message),
      );
      assert.match(await renderer.render(chapters, fragmentSource("", inline("$y$"))), /^<svg\b/, "fine after an error");
      // A preamble that emits pages (a kept template's cover): the formula is on the last.
      const paged = await renderer.render(chapters, `#page[cover]\n${fragmentSource("", inline("$y$"))}`);
      assert.notEqual(readSvg(paged, "f-")!.baseline, null, "the formula's page, with its marker");
      assert.equal(renderer.pid, pids[0], "one process throughout");
      assert.deepEqual(files(vault), before, `no .svg, no ${FRAGMENT_DOC}`);
    });

    await t.test("T-T3: template aliases through main.typ and the chapter; chapter lets only before the formula", async () => {
      const render = new TypstRender(renderer, vault);
      const open = (rel: string, edit?: (text: string) => string) => {
        const path = join(vault, "book", rel);
        let text = readFileSync(path, "utf8");
        if (edit) text = edit(text);
        return { path, doc: Text.of(text.split("\n")) };
      };
      const renderAt = async (f: { path: string; doc: Text }, needle: string) => {
        const m = typstMathAt(f.doc, f.doc.toString().indexOf(needle));
        assert.ok(m, `a formula at ${needle}`);
        return render.math(f.path, f.doc, m);
      };

      const ch1 = open("chapters/ch1.typ");
      const r = await renderAt(ch1, "EE[X] = integral");
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(r.wEm > 3 && r.hEm > 0.8 && r.vaEm < 0, "sized in em, below the baseline by the depth");
      assert.ok(!r.svg.includes("#0a0b0c") && r.svg.includes("currentColor"));
      // Above ch1's own import only the book main's (root-absolute) import provides them.
      const top = open("chapters/ch1.typ", (text) => `$RR times EE[X]$\n${text}`);
      assert.ok((await renderAt(top, "RR times")).ok);

      // A formula written before the chapter's #let does not see it (an unsaved edit).
      const ch2 = open("chapters/ch2.typ", (text) => text.replace("$L$ 还只是字母", "$Lip$ 还只是字母"));
      const early = await renderAt(ch2, "Lip$ 还只是字母");
      assert.ok(!early.ok && /unknown variable: Lip/.test(early.message), JSON.stringify(early));
      assert.ok((await renderAt(ch2, "norm(grad f(x)")).ok);

      // main.typ's rule between the includes applies to ch2's vectors, not ch1's.
      const vec1 = await renderAt(open("chapters/ch1.typ", (t) => `${t}\n$vec(1, 2)$\n`), "vec(1, 2)");
      const vec2 = await renderAt(open("chapters/ch2.typ", (t) => `${t}\n$vec(1, 2)$\n`), "vec(1, 2)");
      assert.ok(vec1.ok && vec2.ok);
      assert.notDeepEqual(glyphs(vec1), glyphs(vec2), "brackets in ch2, parentheses in ch1");

      // notes/ has a .tinymist-fragment.typ: its aliases, not the book's.
      const notes = open("notes/scratch.typ");
      assert.ok((await renderAt(notes, "note + RR")).ok);

      // Chinese text in math (a font load on first use).
      assert.ok((await renderAt(open("chapters/ch1.typ", (t) => `${t}\n$"概率" + x$\n`), '"概率" + x')).ok);

      // The cache: a second hover renders nothing; a change of another file drops it.
      let calls = 0;
      const counted = new TypstRender({ render: (d, s) => (calls++, renderer.render(d, s)) }, vault);
      await counted.math(ch1.path, ch1.doc, typstMathAt(ch1.doc, ch1.doc.toString().indexOf("EE[X] ="))!);
      await counted.math(ch1.path, ch1.doc, typstMathAt(ch1.doc, ch1.doc.toString().indexOf("EE[X] ="))!);
      assert.equal(calls, 1);
      render.dispose();
      counted.dispose();
      assert.deepEqual(files(vault), before);
    });

    await t.test("T-T7: paper mode renders a #theorem[...] call on a page 400pt wide in the book's styles", async () => {
      const render = new TypstRender(renderer, vault);
      const path = join(chapters, "ch1.typ");
      // A 1x1 PNG next to the chapter, read relative to it (the fragment sits in its folder).
      const png = join(chapters, "dot.png");
      writeFileSync(png, onePixelPng());
      try {
        const text = `${readFileSync(path, "utf8")}\n#figure(image("dot.png", width: 1cm), caption: [点])\n`;
        const doc = Text.of(text.split("\n"));
        const theorem = typstPaperAt(doc, text.indexOf("#theorem") + 1);
        assert.ok(theorem?.body.startsWith("#theorem(title: [全期望])[") && theorem.body.endsWith("]"), theorem?.body);
        const t0 = performance.now();
        const r = await render.paper(path, doc, theorem!);
        const ms = performance.now() - t0;
        assert.ok(r.ok, JSON.stringify(r));
        assert.equal(Math.round(r.wEm * 12), 400, "the page's fixed width");
        assert.ok(r.hEm * 12 > 30 && r.hEm * 12 < 300, `as tall as the call: ${r.hEm * 12}pt`);
        assert.match(r.svg, /fill="#ffffff"/i, "a white page");
        assert.match(r.svg, /#1f5fbf/i, "the template's accent: the book's preamble applied");
        assert.ok(!r.svg.includes("currentColor"), "the page keeps its own ink");
        // References to what lies outside the call (a numbered equation, a chapter heading
        // numbered by the dropped template, a bibliography key) show as keys, not errors.
        const refs = `${text}\n#theorem[见 @eq:var、@chap:prob 与 #cite(<wang2022>)。]\n`;
        const refsDoc = Text.of(refs.split("\n"));
        const cited = await render.paper(path, refsDoc, typstPaperAt(refsDoc, refs.lastIndexOf("#theorem") + 1)!);
        assert.ok(cited.ok, JSON.stringify(cited));
        const figure = typstPaperAt(doc, text.indexOf("#figure(image") + 2);
        const f = await render.paper(path, doc, figure!);
        assert.ok(f.ok && Math.round(f.wEm * 12) === 400, JSON.stringify(f).slice(0, 300));
        assert.match(f.svg, /<image\b/, "the image, read from the chapter's folder");
        // The book's document template applies (its caption colour), not its title page.
        assert.match(f.svg, /#6b2fa3/i, "the document template's caption colour");
        assert.ok(!f.svg.includes("#010203"), "the page's mark stripped");
        // A template rule adding a page after the call (the call's page is the marked one);
        // one holding the body in a container (no page of its own there: rendered without).
        for (const rule of ["#show: rest => { rest; pagebreak(); [colophon] }", "#show: rest => block(inset: 2pt, rest)"]) {
          const t = text.replace('\n#figure(image("dot.png"', `\n${rule}\n#figure(image("dot.png"`);
          const d = Text.of(t.split("\n"));
          const r = await render.paper(path, d, typstPaperAt(d, t.indexOf("#figure(image") + 2)!);
          assert.ok(r.ok && Math.round(r.wEm * 12) === 400 && /<image\b/.test(r.svg), `${rule}: ${JSON.stringify(r).slice(0, 300)}`);
        }
        console.log(`# T-T7 paper render of ch1's theorem: ${ms.toFixed(1)} ms`);
      } finally {
        rmSync(png);
        render.dispose();
      }
      assert.deepEqual(files(vault), before);
    });

    await t.test("T-T4: the editor's server keeps its diagnostics and labels; dispose and idle stop the process", async () => {
      const ch1 = join(chapters, "ch1.typ");
      const main = join(vault, "book", "main.typ");
      const publishes: LspDiagnostic[][] = [];
      const primary = new LspClient(BIN!, vault, (uri) => {
        if (uri === pathToUri(ch1)) publishes.push(primary.diagnostics(uri));
      });
      await primary.start();
      pids.push(primary.pid!);
      try {
        // ch1 with one warning in the editor buffer (an error would leave no compiled
        // document, so no labels), compiled through its book.
        const text = readFileSync(ch1, "utf8").replace("= 概率", '#text(font: "No Such Font")[x]\n= 概率');
        primary.didOpen(ch1, text);
        primary.pinMain(main);
        await waitFor(() => publishes.at(-1)?.length === 1, 10000);
        const at = text.indexOf("@eq:inner") + 1;
        const lines = text.slice(0, at).split("\n");
        const labels = async () => {
          const res = (await primary.completion(
            ch1,
            { line: lines.length - 1, character: lines.at(-1)!.length },
            { triggerKind: 2, triggerCharacter: "@" },
          )) as { items?: { label: string }[] } | { label: string }[] | null;
          const items = Array.isArray(res) ? res : (res?.items ?? []);
          return items.map((i) => i.label);
        };
        let found: string[] = [];
        for (let i = 0; i < 50 && !found.includes("eq:inner"); i++) {
          found = await labels();
          if (!found.includes("eq:inner")) await sleep(100);
        }
        assert.ok(found.includes("eq:inner"), `ch2's label completes in ch1 through the pinned main: ${found}`);

        const seen = publishes.length;
        for (let i = 0; i < 100; i++) {
          await renderer.render(chapters, fragmentSource('#import "../template.typ": *', inline(`$EE[X_${i}]$`)));
        }
        await sleep(500);
        assert.ok(
          publishes.slice(seen).every((d) => d.length === 1),
          `ch1's diagnostics after the renders: ${JSON.stringify(publishes.slice(seen))}`,
        );
        assert.equal(primary.diagnostics(pathToUri(ch1)).length, 1);
        assert.ok((await labels()).includes("eq:inner"), "labels still complete");
      } finally {
        primary.stop();
      }

      const pid = renderer.pid!;
      assert.ok(alive(pid));
      renderer.dispose();
      await waitFor(() => !alive(pid), 3000);
      await assert.rejects(renderer.render(chapters, "$x$"), /disposed/);

      const idle = new TypstFragmentRenderer({ bin: () => BIN!, root: vault, idleMs: 300 });
      try {
        await idle.render(chapters, fragmentSource("", inline("$z$")));
        const idlePid = idle.pid!;
        pids.push(idlePid);
        await waitFor(() => idle.pid === null, 3000);
        await waitFor(() => !alive(idlePid), 3000);
        // The next render starts a new process.
        await idle.render(chapters, fragmentSource("", inline("$z$")));
        pids.push(idle.pid!);
        assert.notEqual(idle.pid, idlePid);
      } finally {
        idle.dispose();
      }

      // The timeout covers the start: the render fails, the start goes on for the next one.
      const hasty = new TypstFragmentRenderer({ bin: () => BIN!, root: vault, timeoutMs: 1 });
      try {
        await assert.rejects(hasty.render(chapters, fragmentSource("", inline("$x$"))), /^Error: rendering took longer than 0.001 s$/);
        const hastyPid = hasty.pid!;
        pids.push(hastyPid);
        assert.ok(hastyPid, "still starting");
        await sleep(1500);
        // A compile past the timeout fails and takes the (possibly stuck) process down.
        await assert.rejects(
          hasty.render(chapters, fragmentSource("", inline('$"首次加载中文字体" + x$'))),
          /^Error: rendering took longer than 0.001 s$/,
        );
        assert.equal(hasty.pid, null);
        await waitFor(() => !alive(hastyPid), 3000);
      } finally {
        hasty.dispose();
      }

      // A settings save (stop) during a cold start: the render runs again on a new process,
      // and the stopped client is stopped, not failed ("lsp exited" is not logged).
      const errors: unknown[][] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      const saved = new TypstFragmentRenderer({ bin: () => BIN!, root: vault });
      try {
        const pending = saved.render(chapters, fragmentSource("", inline("$s$")));
        while (saved.pid === null) await new Promise((r) => setImmediate(r));
        const cold = saved.pid;
        pids.push(cold);
        saved.stop();
        assert.match(await pending, /^<svg\b/, "rendered, not \"client stopped\"");
        pids.push(saved.pid!);
        assert.notEqual(saved.pid, cold);

        const client = new LspClient(BIN!, vault, () => {});
        const starting = client.start();
        const clientPid = client.pid!;
        pids.push(clientPid);
        client.stop();
        await assert.rejects(starting, /client stopped/);
        assert.equal(client.status, "stopped");
        await waitFor(() => !alive(cold) && !alive(clientPid), 3000);
        await sleep(100);
        assert.deepEqual(errors, []);
      } finally {
        saved.dispose();
        console.error = error;
      }
      assert.deepEqual(files(vault), before);
    });
  } finally {
    renderer.dispose();
    await waitFor(() => pids.every((p) => !alive(p)), 3000).catch(() => {});
    console.debug = debug;
    await rm(vault, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
  assert.deepEqual(pids.filter(alive), [], "no tinymist left running");
});

test("a binary that cannot start fails a render at once; one that hangs, at the render timeout", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tinymist-badbin-"));
  // Synthetic stand-ins: a file without the executable bit, and a server that never answers.
  const noexec = join(dir, "noexec");
  writeFileSync(noexec, "#!/bin/sh\n", { mode: 0o644 });
  const hung = join(dir, "hung");
  writeFileSync(hung, "setInterval(() => {}, 1000);\n");
  const restoreSpawn = nodeFixture(hung);
  const errors: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  const broken = new TypstFragmentRenderer({ bin: () => noexec, root: dir });
  const slow = new TypstFragmentRenderer({ bin: () => hung, root: dir, timeoutMs: 300 });
  try {
    let t0 = Date.now();
    await assert.rejects(broken.render(dir, "$x$"), process.platform === "win32"
      ? /^Error: could not start tinymist: spawn .* (?:ENOENT|EACCES|EFTYPE)$/
      : /^Error: could not start tinymist: spawn .* EACCES$/);
    assert.ok(Date.now() - t0 < 2000, `failed after ${Date.now() - t0} ms`);
    assert.equal(broken.pid, null);
    assert.match(String(errors[0]?.[0]), /spawn failed/);

    t0 = Date.now();
    await assert.rejects(slow.render(dir, "$x$"), /^Error: rendering took longer than 0.3 s$/);
    assert.ok(Date.now() - t0 < 2000, `failed after ${Date.now() - t0} ms`);
    const pid = slow.pid!;
    assert.ok(pid && alive(pid), "the start goes on");
    slow.dispose();
    await waitFor(() => !alive(pid), 3000);
  } finally {
    broken.dispose();
    slow.dispose();
    await restoreSpawn();
    console.error = error;
    await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});
