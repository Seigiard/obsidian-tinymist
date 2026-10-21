# YOLO AI tab-completion bridge

The plugin can show the [YOLO Completion Only](https://github.com/qiulinfan/obsidian-yolo-completion-only) plugin's AI
tab completion (ghost text) inside `.typ` editors. YOLO only wires its tab
completion into Markdown views, so the shared bridge
(`src/editor/shared/yoloBridge.ts`, byte-identical in obsidian-latex-live)
mounts YOLO's rendering into our editor **without YOLO's keymap**, feeds user
edits into YOLO's own trigger path, and accepts suggestions itself. The keys
belong to `src/editor/shared/keyArbiter.ts`. The bridge checks the controller
contract before binding, independently of plugin release numbers, and disables itself
(one console error) if anything throws.

## Setup on a new machine

1. Install and configure YOLO (providers, model, and its own "tab completion"
   toggle). YOLO's config, including API keys, lives in the vault's
   `.obsidian/plugins/yolo/data.json` and is deliberately not tracked by
   Git: configure it per machine.
2. Enable "YOLO tab completion (experimental)" in this plugin's settings. It
   takes effect at once in every open `.typ` editor (no reopening), and the
   setting shows the bound YOLO version or why it is unavailable. Disabling,
   enabling or updating YOLO itself is picked up the same way.
3. Paste the prompt below into YOLO's settings under tab completion
   constraints (`continuationOptions.tabCompletionConstraints`). The bridge
   tells YOLO the file name *with* its extension (`notes.typ`, `notes.tex`),
   while Markdown notes keep YOLO's plain title, so one global constraint
   serves Typst, LaTeX and Markdown.

## Keys and behaviour

| Situation | Key | Result |
|---|---|---|
| Completion popup open | Tab / Enter | The popup wins: Tab accepts; Enter accepts only if that changes the text, else it is a newline. A list a trigger character opened (`#calc.`, `$arrow.`) is not taken by Enter until you type or move the selection. No ghost text is shown while the popup is open. |
| Ghost text visible | Tab | Inserts exactly the text shown (no Markdown escaping of `<label>` or `$x> 0$`), one undo step. |
| Ghost text visible | Enter | Newline; AI text is never accepted with Enter. |
| Ghost text visible | Shift-Tab / Escape | Dismiss. |
| Ghost text visible, 2+ candidates | Up / Down | Cycle candidates. |
| Generating (dots) | Backspace | Deletes normally and re-arms the trigger. |
| Any | "Trigger AI completion (YOLO)" command | Asks YOLO now, bypassing its trigger patterns and delay (YOLO's toggle still applies). |

Triggering uses YOLO's own triggers, delays, cooldown and enable toggle. The
ghost text is dismissed on any change that is not typing (external file
change, formatting, rename), on cursor moves, on blur, when an IME
composition starts, and when switching files. Completion Only preserves literal
TeX and leading whitespace. One suggestion is shared across panes.

After updating YOLO, run the contract check against its new `main.js`
(only main.js is read, never data.json). This loads the complete production
plugin with synthetic host modules and a streaming transport, then exercises
requests, ghost rendering, raw acceptance, debounce, popup priority,
composition and cancellation. It does not extract minified class names or
replace the production controllers:

```sh
YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo
```

## Constraint prompt

```text
First determine the format. If the file title ends in .typ, it is Typst
source: write all math in Typst syntax inside $...$ (epsilon > 0, abs(x),
n >= N), reuse aliases seen in the context (bR, bN, cal(P)), use labels
<name> and references @name, and never use backslash LaTeX commands
(\varepsilon, \ge, \frac, \mathbb). If it ends in .tex, it is LaTeX source:
write valid LaTeX, close every environment you open, and use no Markdown.
Otherwise (a Markdown note; the title has no extension) write Markdown with
LaTeX math as usual. If unsure, use context signals: #import / #let mean
Typst; \documentclass / \begin{ mean LaTeX.
```

Apply the constraint through YOLO's settings UI. Do not export or copy its entire
settings object: it can contain provider credentials.
