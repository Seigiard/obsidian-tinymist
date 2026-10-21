<h1 align="center">Typst Live</h1>
<p align="center">Write Typst, read rendered math, and preview your project inside Obsidian.</p>

<p align="center">
  <a href="https://github.com/qiulinfan/obsidian-tinymist/releases/latest"><img src="https://img.shields.io/github/v/release/qiulinfan/obsidian-tinymist?style=flat-square&color=00b894" alt="Latest release"></a>
  <a href="https://github.com/qiulinfan/obsidian-tinymist/actions/workflows/ci.yml"><img src="https://github.com/qiulinfan/obsidian-tinymist/actions/workflows/ci.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/qiulinfan/obsidian-tinymist/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-636e72?style=flat-square" alt="MIT"></a>
  <img src="https://img.shields.io/badge/Obsidian-1.13.7%2B-7c3aed?style=flat-square" alt="Obsidian 1.13.7 or newer">
  <img src="https://img.shields.io/badge/platform-desktop-6c5ce7?style=flat-square" alt="Desktop only">
</p>

<p align="center"><b>English</b> | <a href="./README_zh-CN.md">简体中文</a></p>

Typst Live is an independent Obsidian frontend for the
[Tinymist](https://github.com/Myriad-Dreamin/tinymist) language server. Keep
`.typ` files beside your notes, edit them with language intelligence, and use
Tinymist's real compiler and incremental preview.

## Highlights

| Write and read in one editor | Keep the whole project in view |
|:--|:--|
| Switch between source and live reading mode. Math, headings, emphasis, lists, and references stay readable while the source remains editable. | Preview unsaved changes, use your project's template, and move between source and rendered pages in both directions. |

## Features

| Feature | What you get |
| --- | --- |
| Typst editor | A CodeMirror 6 view for `.typ`, with syntax and language-server semantic highlighting. |
| Language intelligence | Diagnostics, snippet completion, hover documentation, go to definition, rename, and typstyle formatting. |
| Live reading mode | Rendered math and text constructs, with source revealed when you edit them. |
| Math and paper hovers | Project-aware formula rendering and previews of content calls such as figures and theorem boxes. |
| Incremental preview | Tinymist's SVG preview in a side pane, including unsaved changes. |
| Automatic sibling PDF | Opt in per `.typ` file from its source menu or the open preview header to build a same-stem PDF beside it after saved changes, with confirmation before replacing existing or externally changed bytes. |
| Source navigation | Move the editor cursor to scroll the preview; click the preview to return to the corresponding source. |
| Multi-file books | Chapters can use the book main's imports and a project-owned preview template. |
| Optional YOLO bridge | AI ghost text in `.typ` files using your separately configured YOLO plugin; off by default. |

## Quick Start

1. Install and enable Typst Live using the release assets below.
2. Install [Tinymist](https://github.com/Myriad-Dreamin/tinymist/releases)
   separately. On macOS with Homebrew: `brew install tinymist`.
3. Open a `.typ` file. If the server is not found, set its absolute executable
   path in **Settings → Typst Live**.
4. Use the editor's preview action or **Typst Live: Open preview**.
5. Use the book/code action to switch reading modes. Hover over math, or enable
   **Cursor preview** to see the formula around the cursor while typing.
6. In a Typst pane menu or the open preview header, enable **Automatic PDF export**
   for the selected file when you want a sibling PDF. Use **Rebuild PDF** for an
   explicit rebuild after an imported theme, widget, or image changes.

Try a small document:

```typst
#set heading(numbering: "1.")

= A small example

A right triangle satisfies $ x^2 + y^2 = z^2 $.
```

Requires **Obsidian 1.13.7+**, a filesystem-backed desktop vault, and a local
Tinymist executable. Development and integration tests use Tinymist 0.15.2.
Mobile is not supported in this release.

## Installation

### Community directory

Open the [Typst Live community listing](https://community.obsidian.md/plugins/typst-live), choose **Add to Obsidian**, then enable **Typst Live**.

### GitHub release

Download `main.js`, `manifest.json`, and `styles.css` from
[Releases](https://github.com/qiulinfan/obsidian-tinymist/releases/latest).
Create `<vault>/.obsidian/plugins/typst-live/`, copy the three files there, then
reload Obsidian and enable **Typst Live** in Community plugins.

The first public release is **0.1.0**.

Only one enabled plugin should own the `.typ` editor in a vault. Earlier
personal development installs used `obsidian-tinymist`; disable that copy
before enabling this release. This plugin does not copy or migrate its settings.

### Development

```sh
npm ci
npm test
npm run build
scripts/install-dev.sh /absolute/path/to/vault
```

The development installer uses the ID in `manifest.json`. It refuses to replace
an existing directory that is not a symlink.

## Styled chapter previews

If a chapter imports layout functions without applying the complete document
layout, place `.tinymist-preview.typ` in its folder or an ancestor inside the
vault. The nearest file receives the selected source through
`sys.inputs.at("preview-source")`, a root-relative Typst path:

```typst
#import "template.typ": chapter-layout
#show: chapter-layout
#include sys.inputs.at("preview-source")
```

Your template owns the styling. Without a wrapper, the selected file is previewed
directly. A `main.typ` that includes a chapter can supply book-wide labels and
imports. Reopen the preview after adding or removing a wrapper.

## Project font paths

If a project uses fonts stored in the Vault, open **Settings → Typst Live → Font paths**.
Enter one font file or folder per line. Each entry may be an absolute path or a path relative
to the Vault root. Relative paths are portable when the Vault moves; spaces in paths are kept,
and blank lines are ignored. The paths are sent to both Tinymist language-server processes
through Tinymist's native `fontPaths` configuration.

Typing changes a draft only. Click **Apply and restart language server** to save the paths,
restart the main server, restart the fragment renderer on its next render, and clear successful
formula renders made with the old paths. The existing **Restart language server** command also
uses the saved paths. No compiler restart or render-cache invalidation happens for each keystroke.

## Optional AI completion

Install and configure [YOLO](https://github.com/qiulinfan/obsidian-yolo), then
turn on **YOLO tab completion (experimental)** in Typst Live. The bridge uses
YOLO's model, triggers, and enable toggle; it does not provide an AI service.

- **Tab** accepts visible ghost text; **Shift-Tab** or **Escape** dismisses it.
- **Enter** inserts a newline and never accepts AI text.
- Ordinary completion lists take priority over AI suggestions.

The bridge was checked against YOLO **1.6.9.7**. Other versions may need a new
contract check. See [setup and format constraints](docs/yolo-bridge.md).

## Privacy and network use

The plugin has no telemetry, analytics, account requirement, or hosted backend.
It does not install or update itself or Tinymist. Tinymist is a separately
installed program that the plugin starts for language intelligence and preview.

- **Local preview:** Tinymist serves HTTP/WebSocket preview data on
  `127.0.0.1` at a temporary port. This is communication on your computer,
  not a remote preview service.
- **Typst packages:** Tinymist/Typst may fetch an uncached `@preview` package
  when your document imports it. The [Typst package registry](https://github.com/typst/packages)
  documents these downloads and the cache. Cached packages can be used offline.
- **Optional AI:** enabling the YOLO bridge passes source context to YOLO and
  its configured local or remote model provider. Provider accounts, charges,
  and data handling follow that provider and YOLO's configuration. The bridge
  is off by default; editing and preview do not require it.
- **Files outside the vault:** executable discovery checks the configured path,
  Homebrew/Cargo/WinGet locations, and the login shell's PATH. The external
  compiler can read system fonts and Typst's package cache outside the vault.
  Preview project paths are rooted at the vault; the plugin also reads local
  project templates needed for rendering.

## Limits

This release has no mobile support, dedicated find-references UI, outline panel,
or general PDF/SVG/PNG export commands. Automatic PDF export is an opt-in
same-stem build for saved `.typ` files; it does not watch all imported
dependencies. Builds are serialized and use an isolated Tinymist export process
so each build reads current saved source and dependency bytes. Use **Rebuild PDF**
after dependency-only changes. AI completion is optional and depends on the
installed YOLO version and your model service.
Agents can call `rebuildPdf(path, { interactive: false })` to request a bounded
non-interactive rebuild. The returned receipt reports whether the PDF was
published, conflicted, failed, superseded, cancelled, or was busy and should be
retried later. `superseded` means a newer request for the same source replaced
the agent job.
See [the roadmap](docs/roadmap.md) for work in progress.

## Feedback and contributions

[Report a bug or suggest a feature](https://github.com/qiulinfan/obsidian-tinymist/issues).
Include your operating system, Obsidian/plugin/Tinymist versions, a small
reproduction, and expected versus actual behavior. Remove private document
content and credentials from anything you share.

Contributions are welcome. Discuss substantial changes in an issue first.
Development and release conventions are in [AGENTS.md](AGENTS.md).

## Acknowledgments

Built on [Tinymist](https://github.com/Myriad-Dreamin/tinymist),
[Typst](https://github.com/typst/typst), and
[typst.ts](https://github.com/Myriad-Dreamin/typst.ts), with Obsidian's CodeMirror
and Lezer runtime. This is an independent integration, not an official product
of Obsidian, Typst, or Tinymist. The README layout follows the presentation style
of [YOLO](https://github.com/qiulinfan/obsidian-yolo).

## License

Author-owned source and documentation are [MIT](LICENSE), copyright 2026
Qiulin Fan: use, modify, and redistribute them while retaining the copyright and permission notices.
Upstream components and any upstream-derived fixture material retain their
original licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
