# obsidian-tinymist agent guidance

- This plugin is a thin frontend for the Tinymist language server. Language
  intelligence, compilation, and preview rendering belong upstream; the
  plugin owns editor UI, LSP/preview process lifecycle, and Obsidian
  integration. Reject changes that reimplement upstream capabilities.
- Keep the runtime dependency footprint minimal. CodeMirror 6 and Lezer
  packages are provided by Obsidian at runtime and must stay in the esbuild
  `external` list; never bundle a second copy. The dev pins of `@codemirror/*`
  (`overrides` and devDependencies) are the versions the `minAppVersion`
  Obsidian ships (1.13.7: view 6.43.8, state 6.7.0), so tests run on the
  runtime's CodeMirror; raise them only together with `minAppVersion`, in both
  repositories (the shared modules run on the same versions).
- Obsidian inlines its own copy of the CM6 language plumbing, so Lezer style
  props and `syntaxHighlighting` never decorate custom views. All highlighting
  (the baseline tokenizer in `src/editor/highlightPlugin.ts`, LSP semantic
  tokens in `src/editor/semanticTokens.ts`) goes through direct decorations.
  The baseline tokenizer skips escapes in markup, math, strong and emphasis
  (`\$5` opens no math, `*a \* b*` is one strong); `*` and `_` follow Typst's
  word rule (`inWord`, which the live scanner imports from there: `snake_case`
  is text) and a formula inside strong or emphasis stays math, so neither
  flips the math tinting of the lines below.
- The LSP client is hand-rolled and minimal on purpose. Unknown server
  requests get a `null` response and a debug log; extend explicitly when a
  feature needs it. Edits reach the server incrementally through
  `LspDocument` (`src/editor/typstEditor.ts`), never during an IME
  composition; sync it before any request that depends on the text. Panes
  showing the same file share one server-side copy per `LspClient` (didOpen
  for the first pane, didClose for the last), so an edit reaches the server
  once. Saves never write while a composition is open (`TypstView.save`).
  `TypstView` keeps a CRLF file CRLF (CodeMirror and the server hold LF;
  `getViewData` converts back), so opening a file and switching away never
  rewrites it.
- Editor diagnostics go only through `setTypingDiagnostics` (editorKit;
  `TypstView.applyDiagnostics`), never `setDiagnostics` on the editor:
  `typingDiagnostics()` holds new ones on the line being typed until a pause
  or the cursor leaves it.
- Editor keys: Tab, Shift-Tab, Enter, Escape, ArrowUp and ArrowDown are owned
  by `keyArbiter` (`src/editor/shared/keyArbiter.ts`), which must stay the
  FIRST extension of the editor state. Enter accepts a completion only when
  that changes the text, never from a list a trigger character opened
  (`#calc.` + Enter is a newline) until something is typed or the selection
  moved, and never accepts AI text. Never bind these keys anywhere else
  (no `completionKeymap`, no YOLO keymap); add Enter behaviour as an arbiter
  `enter` hook. The Tab the arbiter declines is `typstTab` at the end of the
  view keymap (nest a list item, else `indentOrInsertTab`), also passed as
  the arbiter's `tabFallback`. Obsidian hotkeys that would swallow editor
  keys go through the view's `Scope` (`registerEditorScope`); Mod-S and
  Mod-F keep their Obsidian meaning.
- `src/editor/shared/` is shared with obsidian-latex-live and must stay
  byte-identical there; this repository holds the canonical copy. Shared
  modules may only `import type` from `obsidian` (tests bundle them without
  Obsidian). `styles.css` embeds `src/editor/shared/editor.css` verbatim
  between the `shared:editor.css` markers; update both together.
- The shared live input plugin reconciles actual DOM focus after updates in a
  coalesced microtask, applying all `EditorView.focusChangeEffect` hooks together.
  CodeMirror may discard a pending focus transaction after a render/selection
  update; repairing only the live field leaves cursor preview unfocused. Defer
  this during composition and retain both focus/blur race regressions.
- Render hover (`renderHover`, `src/editor/shared/renderHover.ts`; its test
  `tests/renderHover.test.ts` is identical in both repositories) is
  `Prec.high`, so its section stays above the language server's and lint's
  wherever the view mounts it. An async `render` gets a spinner 400 ms after
  the pointer rests; CodeMirror restarts a pending hover on every view update,
  and those restarts reuse the pending render. A settled render is never
  reused by a later hover: caches (MathJax nodes, SVGs, crops) belong to the
  renderer and key on its epoch. Failures render as `hoverError`; positions a
  live widget renders are skipped through `replacedAt`. The section anchors at
  the start of the pointer's line within the target (`end` is the target's
  end), never at the target's start: CodeMirror hides a tooltip whose anchor is
  scrolled out and places the merged hover at its lowest section anchor, so a
  long display scrolled past its first line would hide tinymist's section too
  (`tests/renderHover.test.ts` checks the anchor). A render still pending when
  the pointer leaves the editor shows nothing. `cursorPreview` (same module,
  T-S13 in the same test; setting-gated) is a `showTooltip` field: while the
  focused editor's main cursor is in a target, its rendering floats below the
  target's last row (the tooltip view's `getCoords`: a rect from the top of the
  target's first row to the bottom of its last, its left edge at the anchor, so
  a formula that soft-wraps never covers the row being typed, and a preview
  CodeMirror flips above for want of room below clears the whole target; smoke
  B8). It renders again after every edit in the same tooltip
  view (kept while the target's start maps onto itself), so typing never
  rebuilds or blanks it: a pending render keeps the last one, an older render
  never lands over a newer one, and a `hoverError` after a rendering keeps
  that rendering marked `is-error`. It hides while the completion list is open
  (`is-covered`; both sit below the line), takes no clicks
  (`pointer-events: none`) and binds no keys; it goes when the cursor leaves
  the target or the editor blurs (a state set on a focused editor picks the
  focus up in a microtask).
- Live preview (`src/editor/shared/livePreview.ts`; its test
  `tests/livePreview.test.ts` is identical in both repositories): one StateField
  holds every decoration (block widgets and replaced line breaks throw from a
  ViewPlugin). `liveInput()` is mounted always and OUTSIDE
  `livePreviewCompartment` (a field added by a reconfiguration never sees that
  transaction's effects); `livePreview({ language, renderer })` goes inside it,
  so a mode toggle is one reconfigure, and `HistoryCache.restore` gets the
  compartment content for the view's mode. It binds no keys: keyArbiter stays
  first and the only owner of Tab, Shift-Tab, Enter, Escape and the arrows;
  vertical motion into block widgets goes only through the `enterBlocks`
  transaction filter, and the golden key matrix passes unchanged with live
  preview on. The filter corrects only line moves: userEvent exactly "select", a
  goal column on the range (cursorLineUp/Down, their Shift forms, PageUp/Down)
  and as many ranges as before, so Select All, Mod-Home/End, Cmd-ArrowUp/Down,
  snippet fields and Escape's simplifySelection are never redirected; a line
  move into a block at the document's end or start stops on its first or last
  line. A line move that lands one line past the line after a block stops on
  the block too when that line is outside the viewport the view last drew
  (CodeMirror places undrawn lines by their characters: a short or blank line
  there gets almost no height); transaction filters see no view, so
  `drawnViewport` records each view's viewport by its state (T-S7, smoke B7).
  jsdom's vertical motion returns no goal column: tests that press arrows
  into blocks patch `EditorView.prototype.moveVertically` to add one. A
  construct shows its source while the editor has focus, or its search panel is
  open (findNext and replace keep the focus in the panel; the current match must
  show), and a selection touches it (inclusively), so completion popups, snippet
  fields and YOLO ghost text always sit in visible source. A language's
  `decorate` keeps a construct's decorations within its own lines (a selection
  move re-decorates only the constructs on the lines it left or entered; the
  test compares that with a full build). A construct that tests the selection
  on fewer lines says so with the optional `reveals` (LaTeX Live's theorem
  boxes: their `\begin` and `\end` lines), so a move inside a long one
  re-decorates only the constructs on the lines moved over, not the box and
  its whole body (T-S5; Typst uses none). `decorate` draws rendered
  constructs through `renderConstruct`. A construct with an error diagnostic
  in it (overlapping it, or empty and inside or at its edge; one that only
  ends where it starts does not count) stays source; a revealed block keeps
  its rendering below it (the last one, `is-error` when the new source fails,
  no dotted mark: the lint underline shows). Diagnostics still reach the editor only through
  `setTypingDiagnostics`, the field rebuilds on lint's `setDiagnosticsEffect`,
  and the live layer never dispatches `setDiagnostics`. While the mouse is down
  and during `input.type.compose` the decorations are only mapped
  (`compositionend` refreshes); renders that land are shown through
  `refreshLive` carrying their keys, which re-decorates only the constructs
  waiting for them (`refreshLive.of(null)` rebuilds everything), never
  mid-composition, and the scheduler never waits on visible renders that are
  cached but held by the mouse or a composition (it would spin through
  microtasks and starve the mouseup). The view draws the replacements within one
  line only near the viewport (4,000 characters on each side, and the main
  selection's lines), through a function in `EditorView.decorations`: CodeMirror
  compares every replaced range of a set on each update. Block replacements and
  replacements over line breaks stay in the field's static sets; atomic ranges,
  `replacedAt` and `enterBlocks` read the whole sets, and tests comparing
  decorations include the function's output. A scanner that throws leaves that
  text as source (logged once). A `FragmentRenderer` keys its results on its
  `epoch` and calls `subscribe`'s listener when that changes; a construct still
  rendering stays source (no placeholders). A new epoch empties the cache but
  keeps its successful renders by request identity (the key without its
  `${epoch}|` prefix, so only keys built with `ctx.request`): while a
  construct's render for the new epoch is pending, `ctx.result` answers with
  the earlier rendering (display-only: the render stays queued, it is never a
  hit, `ctx.peek` never returns it), so a template or definitions change never
  flashes the document back to source; the new result replaces it, a failure
  shows the source and its error mark, and a construct whose own text changed
  has no earlier rendering. Those renderings count against the cache bound and
  are evicted first when no build shows them (`renderStats().cached`). An
  epoch-free request (`ctx.request(.., epochFree)`: what the epoch cannot
  change, LaTeX Live's images and crops) has `*` in place of the epoch and
  stays cached across epochs. Asynchronous renders run one at a time per
  renderer, by kind: while one is in flight, requests of a kind that has
  answered with a promise wait, other kinds (and kinds not seen yet) keep
  rendering, so a formula never waits for a PDF page. `isLive` says the
  compartment holds live preview, `liveActive` that it decorates (the
  document is within maxLines). A pending or failed `RenderWidget`
  keeps what its element shows only when that was its own construct's (the same
  request, or the preview below the block being edited): CodeMirror hands any
  dropped widget's DOM to `updateDOM`, with the old widget. Block widgets, the
  preview below a revealed block and BlockWrapper boxes get no vertical margins
  (CodeMirror's height map and vertical motion miss them); their late size
  changes are remeasured through a line attribute. The render hover never shows
  over a live widget (`renderHover` checks `replacedAt` itself). Search: other
  matches inside rendered widgets stay hidden (accepted). External changes
  (`setDocText`) are ordinary edits that rebuild the field; each pane has its
  own mode. After changing `livePreview.ts` or its styles, also run
  `node scripts/browser-smoke.mjs` (headless Chrome, skipped without it: B1
  arrows through blocks, including blocks at the document's edges, and the jumps
  that must not be redirected; B2 IME; B3 drag; B4 gutter drift; B5 performance
  on `scripts/gen-perf-fixture.mjs`'s 5,700-line chapter, typing in a revealed
  block until its preview re-rendered, cursor moves inside a 190-line theorem
  box, and the page staying responsive with the mouse held during the
  prefetch; B6 arrows through theorem boxes, drawn as LaTeX Live draws them,
  one line at a time, gutter aligned; B7 ArrowDown at the pane's bottom edge,
  the drawn viewport ending at a block; B8 the cursor preview below a
  soft-wrapped formula, and above a display near the window's bottom). Both
  scripts are identical in the two repositories.
- Typst formula renders (`typstRenderHover`, above `lspHoverTooltip`, setting
  `hoverRender`) come from a second `tinymist lsp` owned by the plugin
  (`TypstFragmentRenderer`, `src/lsp/fragmentRenderer.ts`), never from the
  editor's server: it never pins a main or touches the preview, and its
  diagnostics are dropped. tinymist's own hover closes on an edit or a
  selection change like the render's, and inside a rendered formula drops a
  symbol's bare "Sampled Values" answer (alias signatures stay). The renderer
  starts on the first render and stops after 5 min idle, when a compile passes
  the render timeout (5 s), on every settings save (a new binary path; a
  render the save interrupted runs once more on the new process) and in
  `onunload`. The 5 s include the start: a slower start goes on for the next
  render, and a binary that cannot be spawned fails at once (`LspClient`
  rejects its pending requests on the spawn `error`, which comes without an
  `exit`); `stop()` during `LspClient.start` leaves it `stopped`, not
  `failed`. A fragment compiles as the in-memory document
  `<folder>/.obsidian-tinymist-fragment.typ` (didOpen, then didChange with the
  same text: some server states refuse the export otherwise; one change+export
  pair at a time per document), never written. `LspClient.exportSvg` always
  sends `{write: false}` as the THIRD argument (as the second it is ignored
  and tinymist writes `<name>.svg` into the vault); `tests/fragmentRenderer.test.ts`
  checks that no `.svg` or fragment file appears. Never batch fragments into
  one document: one bad formula fails them all. The page returned is the last
  one holding the fragment's mark (`FRAGMENT_MARK`: an inline formula's
  baseline marker, a paper page's foreground), else the last page: a kept
  document template may add pages before or after the fragment.
- A fragment's preamble (`src/editor/typstFragment.ts`) is the book main's
  top-level statements before its include of the chapter (relative import
  paths and the leading path of file-reading calls, `image`/`read`/`yaml`/
  `json`/…, made root-absolute: the fragment sits in the chapter's folder; no
  `#include`, no bare `#show:` template rule but in a paper render), or the
  statements of the nearest `.tinymist-fragment.typ` instead, then the
  buffer's own top-level statements that end before the formula. Math inside a top-level statement is
  never a fragment. A fragment failing with `unknown variable: x`, where `x`
  occurs before the formula in the enclosing top-level `#` expression (a
  closure parameter, a `for`/`let` binding), or with a context error inside
  `context`, shows no hover section (`needsEnclosingCode`): the document
  compiles, the fragment cannot. An error Typst locates on a preamble line
  shows that line (`book/main.typ:4: #set …`, located at every render, not
  cached) in place of the formula. An error inside an imported file (a
  template saved half-typed) is the preamble line importing it:
  `typstExportError` takes the first error's first row in the fragment
  document, its own or its trace's ("help: while importing"; "while calling" a
  template function points at the formula, which keeps the error), and shows a
  repeated line once. SVGs: the sentinel ink becomes `currentColor`, the
  marker gives the baseline, ids are prefixed per render, and sizes are in em
  (1em = 16pt). `TypstRender` caches formulas by folder, preamble hash, mode
  and formula; paper renders are never kept (a page shows images and data
  files no epoch follows: a re-exported figure must show at the next hover),
  in its cache or in `last`, and a page the renderer itself failed is not
  tried again (no view keeps it: a retry would only bump the file's epoch). At each render it records the `.typ` files the
  file's preambles read (`dependencies`): every `main.typ` from its folder up
  (bookMain may pick any), the files its project statements come from, and the
  quoted `.typ` paths those statements and the buffer's preamble statements
  name, followed through the whole text of each file named; never the book
  main's includes, a chapter's own `#include`s or the file itself. A vault
  modify (`fileChanged(path, event)`), 300 ms after the last change (well past
  the renderer's file watcher), drops the renders of the files that read it and
  bumps their `epoch(file)`; a create, delete or rename (a folder too) drops
  those of every other file. So a chapter's autosave at every typing pause
  keeps its own renders (its statements are keyed through the buffer) and those
  of the other open chapters (they never read it), while a template, alias
  file or book main edit renders every file reading it again (design §5.5).
  Live mode keys a view's renders on `epoch(viewFile)`. Obsidian sends no
  events for dotfiles, so `.tinymist-fragment.typ` is re-read on every render
  (its text is in the key); live widgets pick up its edits only at the next
  epoch or when the file is reopened.
- Typst live preview (`src/editor/typstScan.ts`, `src/editor/typstLive.ts`,
  `TypstLiveRenderer` in `typstRender.ts`; tests in
  `tests/typstLivePreview.test.ts`, the mode in `tests/typstView.test.ts`)
  renders formulas in markup only. Dollars pair by typstMathSpans' rule
  (`mathClose`; a `"` right after `#` opens a code string there too, so
  `#"$"` pairs with nothing for the hover and the cursor preview either);
  statements, keyword expressions (`#if`, `#for`, `#context`, …), call
  arguments and code blocks are never looked into, while the content blocks a
  call carries (`#theorem[…]`, `#[…]`) are scanned. A display formula
  takes its trailing `<label>` into its range and is a block when alone on its
  lines. A formula's key is `ctx.request`'s plus the hash of the file's
  statements above it (collected in the scan exactly as `topLevelStatements`
  takes them; a test compares): without that part a `#let` edit would keep
  stale renders. While a new render is pending, or failed on a preamble line
  (`PreambleFailure`), a formula keeps its last rendering (no flash of source
  while a statement above is typed): its own, found by its source and `nth`
  (which occurrence of that source it is: the same source under other
  statements renders differently), remembered per view (`typstLiveLanguage()`
  makes one language per view; past max(2000, twice the document's formulas)
  the occurrences gone from the text are dropped, never the document's). A new
  epoch empties the view's cache, so a failure on a preamble line carries
  `last` instead: `TypstRender`'s last rendering of the formula under the same
  statements of its own file (book main and templates aside), which
  `TypstLiveRenderer` draws; a template or book main saved half-typed keeps
  every rendering, and only a formula never rendered shows the failure. Its
  own Typst errors keep the source with the dotted underline;
  `needsEnclosingCode` failures and failures of the renderer itself
  (`transient`: no binary, a timeout) keep it quietly. Those are tried again
  once each, automatically, when the renderer next answers a render (a slow
  start, a restart; one that fails again waits), and all of them by
  `TypstRender.retryFailed` (settings save, switching a view to live); a retry
  bumps only the epochs of the files with failures. Until a new epoch's renders
  land, a view's formulas keep their renderings from the epoch before (the
  shared core's stale-while-revalidate; on the scratch typst-book a template
  edit left none of 38 formulas as source, against all of them for 114 ms
  before). Each view has one `TypstLiveRenderer` per file
  (`subscribe` through `TypstRender.onChange`, only when the file's epoch
  changed; a rename builds a new one). The mode lives in the view state
  (`getState().mode`); `setState` applies a state's mode and keeps the leaf's
  when there is none (as Markdown views); new views take the setting
  `editingMode` (default source). The header action (book-open/code) and the
  command "Toggle live preview" (no hotkey; Mod-E stays the preview toggle) go
  through `TypstView.setMode`, which only reconfigures `livePreviewCompartment`
  and refuses files over `LIVE_MAX_LINES` with a Notice (such files open in
  source). `typstEditorExtensions` mounts `liveInput()` and the compartment
  (`host.live`) after `semanticTokensExtension`, so `stateFor`, and with it
  `HistoryCache.restore`, carries the mode's content. "Show render statistics"
  shows `renderStats` in a Notice.
- Typst paper hover (`typstRenderHover`, T-T7 in
  `tests/fragmentRenderer.test.ts`): with the pointer on the `#name` of a call
  in markup (`typstCallAt`: the scanner records calls, never statements,
  keyword expressions, calls in code, math, raw text or comments) that carries
  a content block (`#theorem[…]`, `#box(…)[…]`) or is `#figure(…)`/`#image(…)`,
  at most `PAPER_MAX_CHARS` (4,000) long, the call renders through the same
  renderer (mode `paper`, never cached) on a white page `PAPER_WIDTH_PT`
  (400 pt) wide and as tall as the call, in the book's look: its preamble
  keeps the document template rules (bare `#show:`, the book main's and the
  chapter's: theorem boxes built on show rules, caption styles), and the
  frame's page set rule inside the template's body gives the call a page of
  its own (`paperSource`, marked for the renderer: the pages the template adds
  around it are not shown). A template holding its body in a container allows
  no page set rule there: on any Typst error the call renders again without
  the template rules (so a call's own error shows from that render). Numbers
  count within the call (定理 0.1: its chapter's counters are not known).
  Shown at `PAPER_PT` (12 pt per em, a PDF at 100%) in an `lsp-lp-paper` card,
  inverted (`is-inverted`) when "Invert preview colors" is auto and Obsidian's
  theme is dark. References and citations a call cannot resolve alone
  (another chapter's label, a bibliography key) show as `@key`/`[key]`
  through show rules in the frame instead of failing the page (numbered ones
  render as usual). A call whose literal `image("…")` paths total more than
  `PAPER_MAX_IMAGE_BYTES` (10 MB) is not rendered and says so (a page embeds
  its images: a 25 MB PNG took 3.5 s to render and 1.2 s to show, and one past
  50 MB passed the render timeout, which stops the renderer live views use).
  Its content is markup: formulas in it hover as math. A failure shows
  Typst's error with the call's first line. The cursor preview
  (`typstCursorPreview`, setting `cursorPreview`, default off) renders the
  formula around the cursor from the buffer: inline math in both modes,
  display math in source mode and in live mode only when it is not a block
  (a revealed block keeps its own rendering below it, also under an error
  diagnostic) or live preview does not decorate (`liveActive`: a document
  grown past maxLines).
- `skipGroup` memoizes its results per text (by where a group opens): an
  unclosed group ends at its line, so the group around it goes on and would
  scan the next unclosed one again (a dozen unclosed `#box[` lines froze the
  editor for seconds, doubling with each one; now linear). An unclosed group
  inside a closed one still ends at its line, as in Typst (`#theorem[` then
  `Let #f(a, b` then `]`: the `]` closes the theorem).
- The Typst scanner's recursion (content blocks, strong/emph) stops at
  `MAX_DEPTH` (64) levels and `skipGroup`/`skipEmbedded` pass `#` over as text
  past `MAX_NESTING` (100): deeper markup stays source and the scan never
  overflows the stack (20,000 nested `#[` did before).
- Typst text constructs in live mode (the same scanner and language; T-T6 in
  `tests/typstLivePreview.test.ts`) follow Typst's own lexer and parser, not
  Markdown's: check a new rule against
  `typst compile --features html --format html` (and `typst query` for list
  depth) before encoding it. Headings (`=` run, then whitespace, first on a
  line or in a content block: `#block[= Title]`) take a line class
  `lsp-lp-h1…h6` and hide their marker unless the cursor is on the line.
  `*strong*`/`_emph_` close on their line; a delimiter between two letters or
  digits of a non-CJK script is text (`2*3`, `snake_case`, `*a*b` closes
  later). `- `, `+ ` and `/ term:` are items first on a line or first in
  a content block. An item's body holds the lines below it indented deeper than
  its marker (blank lines too); a run is the items of one kind that are
  siblings, in one body or at the top, whatever their indentation (`  + a` then
  `+ b` is one enum). Blank, comment and `#let/#set/#show/#import` lines keep
  it; other content outside the last item's body ends it. `+` numbers count
  through the run (an explicit `3.` sets them), bullets go •, ‣, – by the
  number of enclosing lists (enums do not count). A marker shows only while
  the marker itself is touched (a term: `/ Term:`), so it stays while the item
  is typed. `@key` becomes a chip (`Supplement @key` with a `[supplement]` of
  plain markup on the same line: no numbers; the supplement without its
  strong/emph delimiters, `@key` alone when it holds raw text, a reference or
  a label), `<key>` a faint chip (chips keep the editor's text size and weight
  on a heading line); nothing inside an `http(s)://` link is markup. A
  construct holding an error diagnostic keeps all its markup visible. The scan
  treats `$`, `#`, escapes, comments and raw text exactly as for formulas, so
  math pairing and the preamble hash do not move (the hash test includes text
  constructs; a supplement holding code or math is left to the markup scan for
  that reason). The test also compares every
  selection move's decorations with a full build and checks Tab, Shift-Tab,
  Enter, Escape and Backspace at every position against source mode.
- `src/editor/typstEditor.ts` builds the editor's extension list without
  runtime Obsidian imports so tests mount the real stack; Obsidian-only
  parts (hover, Markdown info, the YOLO bridge instance) come in through the
  host. Tests that need a view mount it on `tests/support/obsidian.ts`, the
  stand-in `scripts/run-tests.mjs` aliases `obsidian` to; extend it with the
  documented behaviour a test needs, never with Obsidian's own code.
- Spawned processes (`tinymist lsp`, `tinymist preview`, the fragment
  renderer's `tinymist lsp`) must always be killed in `onunload` and view close
  paths. No orphan processes.
- Desktop only (`isDesktopOnly: true`) while the binary is required. Do not
  add mobile code paths without a roadmap decision.
- Never commit build artifacts (`main.js`, sourcemaps) or `node_modules`.
- Update [docs/roadmap.md](docs/roadmap.md) checkboxes when a milestone item
  lands; do not rewrite history otherwise.
- Verify changes with `npm test` (the real-tinymist test runs when a binary
  is found; `TINYMIST_BIN` overrides), `npm run build` and a manual smoke
  test in a real vault (open a `.typ` file, check diagnostics/completion,
  hover a formula that uses a template alias: rendered above tinymist's
  hover, and `pgrep -fl "tinymist lsp"` shows exactly one more process, gone
  after disabling the plugin; open the preview) before reporting success.
  After a YOLO update run
  `YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo`.
  That check loads the full Completion Only production bundle with a synthetic
  host and transport, preserving the actual request/controller path. Keep the
  structural bridge guard; do not add a release-number allowlist or minifier-name
  extraction. The fake-controller golden key matrix remains in `npm test`.
  CI runs native Tinymist tests on Windows, macOS and Linux and the production
  YOLO contract on Windows and Linux. Its native download resolves the latest
  stable upstream release and checks the supplied digest; POSIX needs no PowerShell.
- Installed copies drift from the source: `node scripts/check-install.mjs
  <vault>...` compares a vault's plugin files with this checkout (run
  `npm run build` first).


## Public releases

- Public identity: `manifest.json` ID `typst-live`, display name `Typst Live`.
  Keep internal `tinymist-typst`/`tinymist-preview` view types and virtual
  fragment document names stable; existing workspace state uses them.
- Author-owned source and documentation are MIT, copyright 2026 Qiulin Fan.
  Upstream software and copyrightable text in recorded protocol fixtures keep
  their original licenses; retain `THIRD_PARTY_NOTICES.md` and `licenses/`.
  Never rewrite development dependencies' individual lockfile licenses.
- The public plugin does not install or update Tinymist or itself. Users install
  the binary separately. Runtime network/file disclosures belong in both root
  READMEs, including local preview, package downloads by the external compiler,
  and the optional YOLO bridge's configured model service.
- Release tags use the exact manifest version, such as `0.1.0`, without a `v`
  prefix. `package.json`, the root lockfile package, and `versions.json` must
  agree; the version map's minimum app version must match the manifest.
- `.github/workflows/release.yml` performs `npm ci`, tests, and a production
  build from the tag, then publishes `main.js`, `manifest.json`, `styles.css`,
  and `SHA256SUMS`. Existing releases fail closed; do not clobber assets, force
  tags, or force-push. Build output stays ignored and is never committed.
- Optional GitHub build provenance runs only when repository variable
  `RELEASE_ATTESTATION` is `true`, or `workflow_dispatch` on an unpublished tag
  requests `attest: true`. This is optional provenance, not a prerequisite for
  runtime installation. Configure it before creating a future release tag;
  republishing an existing version remains forbidden.
- Development adapters derive the install directory from the manifest ID.
  Changing public identity does not authorize reading, copying, or migrating
  personal vault configuration. Preserve older local installations unless
  the user specifically requests their migration.
