# obsidian-tinymist roadmap

## 2026-09-30 checkpoint

The user considers the current Typst plugin sufficient for now; independent feature
development stops at this checkpoint while LaTeX work continues. The shared focus
race was repaired in the canonical live-preview core and copied identically to
LaTeX Live. The full suite passed 279/279 without skips; shared browser checks passed
31/31. The installed builds in all three existing vaults match this checkout.
Actual Obsidian paper/math rendering and cursor SVG preview were checked. This does
not claim that every remaining beta/manual or future-roadmap item was completed.

The project goal is Tinymist-grade Typst editing inside Obsidian by being a
thin Obsidian frontend for the real Tinymist language server, exactly like the
VS Code / Neovim / Zed / Helix integrations. We do not reimplement the
compiler, the language service, or the preview pipeline; we write the glue.

## Architecture bet

- One `tinymist` binary provides LSP language intelligence and the preview
  server (incremental compilation, reflexo vector IR, WebSocket push,
  typst.ts WASM renderer in a static page).
- The plugin owns: a CodeMirror 6 editor in a custom `TextFileView` for
  `.typ` files, an LSP client over stdio, a preview `ItemView` embedding the
  preview page, process lifecycle, and settings.
- Desktop only until further notice. A typst.ts WASM preview fallback for
  mobile is a possible later phase, never a blocker for desktop milestones.

## v0.1 — basic end-to-end slice (current)

- [x] Repository scaffold, esbuild + TypeScript build, dev install script.
- [x] Register `.typ` extension to a custom CodeMirror 6 editor view
      (baseline syntax highlighting via a hand-written stream parser).
- [x] Spawn `tinymist lsp` (binary path setting, PATH auto-detection),
      LSP handshake, full-text document sync.
- [x] Diagnostics rendered in the editor (lint underlines + gutter).
- [x] Completion and hover backed by the LSP.
- [x] Preview: spawn `tinymist preview --root <vault>` for the active file,
      embed the served page in a side pane, updates on save (short save
      debounce so edits feel live).
- [x] Verified against the real qlblog QLNotes books (multi-file `#import`,
      registry bridge, cetz, Chinese system fonts).

## v0.2 — editor depth

- [x] Preview through the LSP session (`tinymist.doStartPreview`) instead of
      a separate process: unsaved-buffer preview and bidirectional
      cursor/click sync (jump to source via `customizedShowDocument`
      notifications, follow cursor via `tinymist.scrollPreview`; clickable
      pages require `--partial-rendering`).
- [x] Semantic-token highlighting from the LSP layered over the base grammar.
- [x] Go to definition (F12 / Cmd+click) and rename across vault files.
- [x] Formatting via the built-in typstyle formatter (format-on-command).
- [x] Dark-theme handling for the preview (`--invert-colors` setting).
- [x] Dynamic preview ports (`127.0.0.1:0`).
- [x] Project-owned `.tinymist-preview.typ` entries for styled chapter previews
      using Tinymist inputs and original-source includes.
- [x] Experimental YOLO bridge: drive the YOLO plugin's AI tab completion
      inside `.typ` editors (default-off setting; ghost text, Tab accept).
- [x] Completion that keeps up: every server item (no truncation), trigger
      characters and completion contexts, textEdit ranges (mid-word),
      additionalTextEdits (postfix), numbered snippets, symbol glyphs and
      docs; math-aware activation (2 letters in math) and ranking by the
      document's own symbols.
- [x] One key arbiter for Tab/Shift-Tab/Enter/Escape/arrows, shared with
      obsidian-latex-live: Tab accepts, smart Enter (an exact match is a
      newline), Tab typed ahead of the popup, list continuation on Enter.
- [x] YOLO bridge rebuilt on YOLO's own triggers: no keymap clash, no reopen
      after toggling, raw accept, file title with extension, contract check
      (`npm run test:yolo`).
- [x] Editor ergonomics: external changes merged as minimal diffs, per-file
      undo history, cursor/scroll/focus restore, IME-aware sync and saves,
      Obsidian hotkey scope (Mod-/, Mod-D, Mod-G, Mod-Enter, Mod-Alt-F,
      Mod-B/Mod-I, Mod-E preview, Mod-F search), `$` and quote pairing,
      comment toggling, themed caret, panels and tooltips.
- [x] Incremental document sync; semantic tokens mapped through edits made
      during a request, with the baseline tokenizer on edited lines.
- [x] Cross-chapter labels: a chapter compiles through the book `main.typ`
      that includes it (tinymist `pinMain`; setting, default on).
- [ ] Find references UI and optional format-on-save.
- [ ] Signature help, folding, document symbols/outline panel (the server
      already pushes outline notifications; needs a view).
- [ ] Multi-preview lifecycle (one preview task at a time today).

## Render preview and live editing

A hover render of the formula under the pointer and a live-preview editing
mode (constructs render in place and show their source when the cursor enters
them), with the shared core in `src/editor/shared/` used by obsidian-latex-live
too. Built in phases that each end runnable and tested.

- [x] P0 prerequisites (2026-09-29): dev CodeMirror pinned to Obsidian
      1.13.7's runtime (view 6.43.8, state 6.7.0), which brings the
      `BlockWrapper` types and runs the tests on the runtime's CodeMirror.
- [x] P1 hover render in source mode through a dedicated renderer
      `tinymist lsp` (virtual documents, `tinymist.exportSvg` without writing).
      GUI checks H7–H10 done in Obsidian (2026-09-29, the synthetic Typst
      template book in the courses vault); `node scripts/check-install.mjs`
      passes on the deployed vaults.
  - [x] Shared `renderHover` (2026-09-29, `src/editor/shared/renderHover.ts`):
        the render section above the language server's (`Prec.high`), 300 ms
        hover, a spinner for a render still pending 400 ms after the pointer
        rests, one render per hover across CodeMirror's restarts, `hoverError`,
        `.lsp-render-hover` styles in `editor.css`. The section anchors at the
        start of the pointer's line within the formula: anchored at the
        formula's start, a display scrolled past its first line hid the whole
        hover, tinymist's section included (checked in headless Chrome). A render
        still pending when the pointer leaves the editor shows nothing.
  - [x] Typst render hover (2026-09-29; GUI checks H7–H10 done):
        `LspClient.exportSvg` (`{write: false}` third),
        `TypstFragmentRenderer` (second `tinymist lsp`, lazy, 5 min idle
        stop, 5 s timeout, killed on unload and settings save),
        `typstFragment.ts` (top-level statements, book-main
        and chapter preamble, `.tinymist-fragment.typ` override, frame, SVG
        baseline/currentColor/ids), `TypstRender` (LRU 2000, invalidation on
        `.typ` changes), the hover section above tinymist's, setting "Render
        formulas on hover" (default on). Tests T-T1..T-T4 on the synthetic book
        in `tests/fixtures/book`. Measured on the synthetic typst-book (three
        chapters, template aliases, cetz, Chinese): 108 of 109 formulas render
        (the other, `$#r$`, uses a closure parameter a fragment cannot see; its
        hover shows no section instead of a false error), cold 35 ms, median
        0.42 ms, a cached hover 0.07 ms (preamble included); no file written.
    - [x] Review fixes (2026-09-29): math that needs the code around it (a
          closure's, loop's or block's variable, `context`) shows no section,
          typos keep their error (`needsEnclosingCode`; `#(…).map(…)` chains
          count as one expression); a book main's relative file paths
          (`image`, `read`, `yaml`, `json`, …) made root-absolute like its
          imports, so a main reading data before its includes no longer
          fails every chapter formula; renders dropped 300 ms after the last
          `.typ` change (a late template write rendered stale for good); a
          per-file `epoch(file)`, so a file's own autosaves keep its renders
          and epoch; the 5 s timeout covers the renderer's start, and a
          binary that cannot be spawned fails at once (it waited 20 s); a
          render a settings save interrupts runs again, and the stopped
          client stays `stopped`; an error on a preamble line shows that
          line (`file:line: statement`) in place of the formula;
          tinymist's section closes on typing and drops a symbol's bare
          sampled values inside a rendered formula. Checked on the scratch
          typst-book: 108 rendered, 1 without a section, 0 errors; a late
          template write 30 of 30 fresh.
- [ ] P2 shared live-preview core, live math, mode toggle.
  - [x] Shared core (2026-09-29, headless; `src/editor/shared/livePreview.ts`):
        one StateField (reveal while focused and a selection touches the
        construct, inclusively; frozen while the mouse is down and mapped
        during IME compositions; constructs with an error diagnostic or a
        failed render stay source; a selection move re-decorates only the
        constructs on its lines), a rendering kept below a revealed block
        (the last one while the new source renders or fails), the
        `enterBlocks` transaction filter for ArrowUp/Down (no key bound),
        a per-renderer cache (never evicting what an open view uses) with a
        viewport-first scheduler (sync renders in a microtask, one async
        render in flight, idle prefetch), block height remeasure,
        `renderStats`, the `.lsp-lp-*` styles, and no render hover over a
        live widget (`replacedAt`). Tests T-S1..T-S12 in
        `tests/livePreview.test.ts` (identical in both repositories; the
        golden key matrix unchanged with live preview on); browser smoke
        B1..B5 in `scripts/browser-smoke.mjs` (5,700 lines: mount 14 ms,
        typing p95 4-5 ms, cursor move p50 0.6 ms, scroll frame p90 16.7 ms;
        gutter drift 0 px, 136 px without the remeasure).
  - [x] Typst live math (2026-09-29, headless; `typstScan.ts`,
        `typstLive.ts`, `TypstLiveRenderer`): inline `$x$` and display
        `$ x $` formulas in markup render in place through the fragment
        renderer (a block over its lines when alone on them, its trailing
        `<label>` included in the reveal range; math in statements, call
        arguments and keyword expressions stays source); a formula Typst
        rejects keeps its source with a dotted underline, one that needs its
        enclosing code keeps it quietly. The file's statements above a formula
        are in its key, and a formula keeps its last rendering while a new
        one is pending or a statement above is broken. Test T-T5 in
        `tests/typstLivePreview.test.ts`, including live mode on the synthetic
        book against a real tinymist. Measured on the scratch typst-book
        (template aliases, cetz, Chinese): 93 formulas in three chapters, all
        rendered, none failed, each chapter complete within 0.4 s. On a
        generated 5,700-line chapter (4,987 formulas) all rendered by the idle
        prefetch in 18 s, and the Typst editor stack in headless Chrome gave
        mount 21 ms, typing p95 8.7 ms (source mode 0.3 ms), cursor move p50
        0.6 ms, scroll frame p90 16.7 ms; arrows through Typst blocks, IME,
        drag and gutter drift (0 px with tinymist's SVGs) as B1-B4.
  - [x] Mode toggle (2026-09-29, headless): the view state's `mode`
        (restored with the workspace), the header action (book-open/code),
        the command "Toggle live preview" (no default hotkey), the setting
        "Default editing mode" (source), the refusal over 10,000 lines, the
        compartment content in `HistoryCache.restore`, the command "Show
        render statistics". In Obsidian (P7, 2026-09-29) the toggle, the view
        state and live math on the template book were checked; the IME,
        drag and long-chapter checks of L1-L9 and L15 are left to the beta
        trial (headless and browser smoke cover them).
  - [x] Review fixes to the shared core (2026-09-29, headless; identical in
        both repositories): the scheduler no longer spins through microtasks
        (a frozen editor) when the mouse or a composition holds a refresh
        while the idle prefetch runs; `enterBlocks` corrects only line moves
        (a goal column, as many ranges as before), so Select All,
        Cmd-ArrowUp/Down, Shift-Cmd-ArrowDown and Escape are never pulled
        into a block, and ArrowDown/ArrowUp into a block at the document's
        end or start visit its lines; the search panel's current match
        reveals its formula; an error that only touches a formula's edge no
        longer keeps it source; a failed preview below a block never shows
        another block's rendering; a throwing scanner leaves the text as
        source; renders that land re-decorate only the constructs waiting for
        them; the replacements within one line are drawn near the viewport
        only; chips keep the text size on heading lines and a supplement
        shows without its `*`/`_`; `scripts/gen-perf-fixture.mjs` generates
        the long chapters. Ten new or rewritten cases in
        `tests/livePreview.test.ts` fail on the previous core; all 241 tests
        pass (1 skipped). Browser smoke 21/21 (B1's six new checks fail on
        the previous core; B5 on the generated 5,700-line chapter: mount
        14 ms, typing p95 4-5.5 ms, typing inside a revealed block settled
        p95 4-5 ms, cursor move p50 0.2 ms, scroll frame p90 16.7 ms; the
        page stays responsive with the mouse held during the prefetch, which
        hung it before). The Typst stack on the dense 5,700-line chapter
        (about 12,500 replaced ranges): cursor move p50 0.2-0.3 ms (1.1-1.3 ms
        before), typing p95 9.4-10.9 ms (7.5-9.9 ms before, within the
        noise between runs).
  - [x] Review fixes to Typst live math (2026-09-29, headless;
        `typstRender.ts`, `typstLive.ts`, `typstScan.ts`,
        `fragmentRenderer.ts`): a modified `.typ` file drops only the renders
        of the files whose preambles read it (imports followed through the
        files they name; every `main.typ` above counts), so a chapter's
        autosave no longer re-renders the other open chapters; a template
        saved half-typed is a preamble error at its import (Typst's trace),
        and each formula keeps its last rendering through it; the fallback
        while a statement above changes is each formula occurrence's own and
        per view (no other occurrence's rendering, none lost past 2000
        formulas); a render the renderer failed (a slow start, a restart) is
        tried again once when the renderer next answers, bumping only its
        file. Twelve new or changed tests fail on the previous code; all 251
        tests pass (1 skipped). On the scratch typst-book against a real
        tinymist: ch1's autosave left ch2 and ch3 untouched (0 re-renders;
        before, 22 and 27 re-renders after 155-170 ms of source); a
        background 3,000-line chapter re-rendered nothing (2,625 renders,
        8.1 s before); a half-typed `template.typ` kept all 93 renderings
        with no error mark (93 marks before), the hover naming
        `main.typ:3`'s import; a `#let` typed at the top of the 3,000-line
        chapter kept all 2,625 renderings while 1,392 renders were pending
        (the top 35 went to source before); a cold start past the render
        timeout (1.5 s against 1 s) left all three formulas rendered without
        a retry command. `TypstRender.math` costs
        40 µs per call (34 µs before). Open: a real template or book main
        edit still shows the chapters' source for 130-200 ms until their new
        renders land (the shared core drops the old epoch's cache; a
        stale-while-revalidate change is requested there).
  - [x] Stale-while-revalidate across epochs (2026-09-29, headless; shared
        core, identical in both repositories): a new epoch empties the render
        cache but each construct keeps its rendering from the epoch before
        (by request identity, display-only: never a hit or a peek) until its
        own render lands; a failure shows the source with its error mark, a
        construct whose text changed has no earlier rendering, and those
        renderings count against the cache bound (evicted first when nothing
        shows them; `renderStats().cached`). Three new cases in
        `tests/livePreview.test.ts` fail on the previous core. On the scratch
        typst-book with ch1-ch3 live against a real tinymist, a template alias
        saved left 0 of 38 formulas as source while they rendered again (the
        previous core: all 38 for 114 ms), every one re-rendered 586 ms after
        the write (the 300 ms change debounce included).
- [x] P3 text constructs: headings, strong/emph, lists, `@label` chips.
  - [x] Typst text constructs (2026-09-29, headless; `typstScan.ts`,
        `typstLive.ts`): headings (size by level, the `=` marker hidden off
        the cursor's line), `*strong*` and `_emph_` with Typst's word-boundary
        rule, `- `/`+ `/`/ term:` items (bullets •, ‣, – by list depth,
        numbers per run as Typst groups items, bold terms; a marker shows only
        while touched), `@key` chips with an optional plain supplement, faint
        `<key>` chips, nothing inside links; code, raw text, comments and math
        stay untouched. The rules were checked against `typst compile
        --format html` and `typst query`. Test T-T6 in
        `tests/typstLivePreview.test.ts`: scanner table, reveal rules, error
        diagnostics, selection moves equal to a full build, Tab/Shift-Tab/
        Enter/Escape/Backspace identical to source mode at every position.
        Measured on the scratch typst-book (three chapters, template, cetz,
        Chinese) against a real tinymist: every construct decorated once, all
        93 formulas rendered, every reveal correct, no file written, the
        renderer exited. In headless Chrome on 5,700 lines: the book's chapter
        mix repeated gave mount 23 ms, typing p95 6.2 ms, cursor move p50
        0.6 ms and scroll frame p90 16.7 ms. A synthetic chapter with a
        construct on nearly every line (about 12,500 replaced ranges) gave
        typing p95 8 ms, but its cursor move p50 was 1.2 ms, over the 1 ms
        budget: CodeMirror compares every replaced range of the document on
        each update (0.2 ms with formulas only). GUI check L10 done in
        Obsidian (2026-09-29): headings, template aliases in math, `@ref`
        and `<label>` chips, `\$5` no longer tinting the prose after it.
  - [x] Review fixes to the Typst scanner and highlighter (2026-09-29,
        headless): a content block may open with a heading (`#block[= T]`),
        and list items are one run when siblings whatever their indentation
        (`  + a` then `+ b` numbers 1, 2), as `typst compile --format html`
        parses them; the baseline tokenizer skips escapes, so `\$5` no longer
        tints the rest of the file as math.
  - [x] Scanner hardening (2026-09-29, headless): the scanner's recursion
        (content blocks, strong/emph) stops at 64 levels and `skipGroup` /
        `skipEmbedded` pass `#` over as text past 100, so 20,000 nested `#[`
        no longer overflow the stack (the text below them stays source);
        escaped delimiters inside `*strong*`/`_emph_` no longer close them in
        the baseline tokenizer (the escaped `\$` fix was already in; checked on
        the scratch ch1's `\$5` line).
- [x] P6 paper-mode hover of `#call[...]`, `#figure`, `#image`; cursor preview.
      GUI check H12 done in Obsidian (2026-09-29): hovering `#definition`
      in ch1 renders the template's box, title and the display with its
      number; the number reads 0.1 because a call rendered alone does not
      know its chapter (known limit). H13 checked on the shared cursor
      preview in LaTeX Live.
  - [x] Paper hover (2026-09-29, headless; T-T7): the pointer on the `#name`
        of a call in markup with a content body, or of `#figure`/`#image`, at
        most 4,000 characters, renders the call through the fragment renderer
        on a white page 400 pt wide in the book's styles (book main and chapter
        statements above it, the template's chrome dropped), shown at 12 pt
        per em in a paper card inverted when "Invert preview colors" is auto
        in a dark theme; references a call cannot resolve alone (another
        chapter's label, an equation or heading numbered only by the dropped
        template, a citation) show as `@key`/`[key]`. On the scratch
        typst-book (theorem boxes built on `figure`, proofs, examples, a
        footnote, cetz, PNG, SVG and table figures) all 19 calls of ch1-ch3
        render (7 failed on unresolved references before those rules): first
        108 ms (Chinese fonts), then p50 3.9 ms, max 36 ms (cetz); checked by
        eye in light and inverted frames. No file written; the renderer exited.
  - [x] Cursor preview (2026-09-29, headless; T-S13 in
        `tests/renderHover.test.ts`, shared): setting "Preview the formula at
        the cursor" (default off): the formula around the cursor renders below
        it and again after every key in the same tooltip (the last rendering
        stays while one is pending or failing), hidden while the completion
        list is open, gone when the cursor leaves or the editor blurs; inline
        math in both modes, display math in source mode and in live preview
        when not a block. Typing 25 keys in a formula of the scratch ch1
        against a real tinymist: each key to its new rendering p50 4.2 ms,
        p95 6.3 ms, max 20 ms (budget 40 ms). All 262 tests pass (1 skipped);
        browser smoke 21/21 (B5: mount 8-12 ms, typing p95 3.3-4 ms, cursor
        move p50 0.2 ms, scroll frame p90 16.7 ms).
  - [x] Review fixes to the shared core for P4-P6 (2026-09-29, headless;
        identical in both repositories, `styles.css` synced): a revealed
        block with an error diagnostic in it keeps its rendering below (the
        last one, `is-error` when the new source fails; it vanished before),
        and `liveActive` (live preview mounted and decorating) replaces
        `isLive` in `typstCursorPreview`, so a live view past maxLines shows
        the preview for display math; the cursor preview hangs below the
        formula's last row, not its first (a soft-wrapped formula no longer
        covers the rows being typed; its left edge stays at the formula's
        start); `ctx.request(.., epochFree)` keys a request without the epoch
        (LaTeX Live's images and crops survive a definitions change);
        asynchronous renders queue by kind, so kinds that answer
        synchronously keep rendering while one is in flight (Typst's single
        kind is unchanged: one at a time, in order); ArrowDown from the line
        above a block where the drawn viewport ends no longer lands one line
        past the (undrawn, estimated) line after it (`drawnViewport`); in a
        dark theme a box head keeps its hue lightened to oklch L 0.72
        (elegantbook's `color=black` was black on the dark background). Four
        new cases in `tests/livePreview.test.ts` and the new T-S13 case fail
        on the previous core; the typstRender cursor-preview test covers a
        live view past maxLines. All 268 tests pass (1 skipped, as before);
        LaTeX Live's 407 too. Browser smoke 29/29 in both repositories (new
        B7: at the pane's bottom edge ArrowDown landed on line 55, now 37, the
        block; B8: in a 420 px pane the preview's top moved from 25 px, over
        the formula's second row, to 137.5 px, below its last; B5 here: mount
        6 ms, typing p95 3-4 ms, cursor move p50 0.2 ms, scroll frame p90
        16.7 ms). On the scratch typst-book against a real tinymist, a `(`
        typed into a display block of ch1 with its error diagnostic landed:
        1 lint range and the block's last rendering below it marked
        `is-error`, no dotted mark (before: nothing rendered). On LaTeX Live's
        compiled scratch elegantbook in headless Chrome: ch2's formulas were
        all drawn after 140 ms instead of after its two crops (330 ms), and on
        ch3 ArrowDown at the pane's bottom edge stopped on the block (line 68)
        instead of line 76.
  - [x] Review fixes to the Typst side of P4-P6 (2026-09-29, headless;
        `typstRender.ts`, `typstFragment.ts`, `typstScan.ts`,
        `typstEditor.ts`, `highlightPlugin.ts`, `fragmentRenderer.ts`):
        paper renders are never kept (a page shows images and data files no
        epoch follows: a re-exported figure showed the old image until the
        next epoch; on the scratch typst-book the replaced `heatmap.png` now
        shows at the next hover, 600 ms after the write), in the cache or in
        `last` (up to 12 MB SVGs with embedded images, in maps bounded by
        count), and one the renderer failed no longer bumps the file's epoch
        when the renderer next answers; a paper render keeps the document
        template rules (bare `#show:`, the book main's and the chapter's), so
        theorem boxes built on show rules, captions (图 0.1 below, 表 0.1
        above) and the book's
        fonts show as in the book (before: a plain centred figure with
        "定理 0.1: …" below), on a page of the call's own found by a mark in
        its foreground (the pages a template adds before or after the call
        are not shown); a template that holds its body in a container fails
        the page set rule and the call renders again without them (numbers
        count within the call: 定理 0.1). All 19 calls of ch1-ch3 render
        (first 55 ms, p50 4.4 ms). A call whose `image("…")` files total more
        than 10 MB is not rendered and says so (on the scratch book a 9 MB PNG
        took 0.2 s to render and 0.2-0.3 s to show, 25 MB 3.5 s and 1.2 s, and
        a 53 MB one passed the 5 s timeout and stopped the renderer live views
        use; now refused at once, the renderer kept). `skipGroup` is
        memoized per text: each unclosed content block rescanned those below
        it (18 unclosed `#box[` lines took 7.1 s per scan, doubling with each
        line; now 1 ms, 300 lines 17 ms; 4,000 random snippets scan exactly as
        before). The baseline tokenizer follows Typst's word rule for `*` and
        `_` and keeps math inside strong/emph as math (`snake_case` or
        `*a $u*v$ b*` flipped the math tinting of the rest of the file; a
        whole 5,700-line chapter tokenizes in 2.7 ms, 2.5 ms before);
        `typstMathSpans` takes a `"` right after `#` as a code string, so
        `#"$"` no longer pairs with the next formula for the hover and the
        cursor preview. Six new tests fail on the previous code; all 274 tests
        pass (1 skipped). The shared part of TY-R1 followed (next item).
  - [x] Shared core after the reviews (2026-09-29, headless; identical in
        both repositories): the cursor preview's `getCoords` rect runs from
        the top of the target's first row to the bottom of its last, so a
        preview CodeMirror flips above a display near the pane's bottom sits
        above its first row instead of over its lower rows and the cursor line
        (the review's probe: flipped to 291-343 px, the `$` line's top at
        343 px, the cursor line at 391-410 px no longer covered; a wrapped
        inline formula still gets it below its last row, 74-126 px); and
        `LiveLanguage.reveals` (optional) names where a construct tests the
        selection, so a move inside a long LaTeX theorem box re-decorates only
        the constructs on the lines moved over (Typst declares none; its
        behaviour is unchanged). New cases: T-S5 with `reveals` and a
        `reveals` that throws; B5 cursor moves inside a 190-line box of a
        3,193-line document (p50 0.1 ms, 5.95 decorate calls per move; 2,321
        without `reveals`); B8 a display near the window's bottom (the
        preview's bottom at the `\[` line's top, 299.5 px; at 367 px, over
        the display, with the previous rect). All 276 tests pass (1 skipped,
        as before); browser smoke 31/31 in both repositories (B5 here: mount
        7.1 ms, typing p95 4.2 ms, cursor move p50 0.2 ms, scroll frame p90
        16.7 ms).
- [x] P7 verification on multi-file books with templates (2026-09-29,
      Obsidian 1.13.7, the courses vault's synthetic typst-book next to the
      LaTeX projects): live mode and hovers without console errors; measured
      numbers are in the headless and browser-smoke entries above.

## v0.3 — product polish

- [ ] Binary management: auto-download a pinned tinymist release per platform
      with checksum verification and explicit user consent; keep the manual
      path setting as the escape hatch.
- [ ] Export commands (PDF/SVG/PNG) and open-exported-file affordances.
- [ ] Package UX: browse/download `@preview` packages, local package path
      settings.
- [ ] Obsidian ergonomics: file creation command and template, better icons,
      mobile-safe manifest gating, settings migration.
- [ ] Community plugin store submission readiness (guidelines, review).

## v0.4+ — exploration

- [ ] Notes and kgdistiller integration: recognize the notes `#kn[...]` /
      `#ref[...]` markers for navigation, and surface related kgdistiller
      records (`kgd neighbors`) for the record citing the current source line.
- [ ] Mobile story: feasibility studied 2026-09-29 (`docs/mobile-feasibility.md`):
      typst.ts in a Worker renders and exports on device (Typst 0.15 build),
      tinymist-web gives completion/hover but has no fonts or export yet;
      first make the plugins load safely on mobile (no top-level Node
      requires), then ship the editor layer, then typst.ts.
- [ ] Math-notes ergonomics: snippet library, symbol picker.

## Non-goals

- Reimplementing or forking the Typst compiler, Tinymist, or the preview
  frontend. Upstream evolves; we track releases.
- Replacing Obsidian's Markdown editor or parsing `.typ` content into
  Obsidian's link graph (until a concrete need appears).
- WASM compilation on desktop. The native binary is strictly better there
  (system fonts, speed, full LSP).
