<h1 align="center">Typst Live</h1>
<p align="center">在 Obsidian 中编写 Typst、阅读公式，并预览完整项目。</p>

<p align="center">
  <a href="https://github.com/qiulinfan/obsidian-tinymist/releases/latest"><img src="https://img.shields.io/github/v/release/qiulinfan/obsidian-tinymist?style=flat-square&color=00b894" alt="Latest release"></a>
  <a href="https://github.com/qiulinfan/obsidian-tinymist/actions/workflows/ci.yml"><img src="https://github.com/qiulinfan/obsidian-tinymist/actions/workflows/ci.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/qiulinfan/obsidian-tinymist/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-636e72?style=flat-square" alt="MIT"></a>
  <img src="https://img.shields.io/badge/Obsidian-1.13.7%2B-7c3aed?style=flat-square" alt="Obsidian 1.13.7 or newer">
  <img src="https://img.shields.io/badge/platform-desktop-6c5ce7?style=flat-square" alt="Desktop only">
</p>

<p align="center"><a href="./README.md">English</a> | <b>简体中文</b></p>

Typst Live 是 [Tinymist](https://github.com/Myriad-Dreamin/tinymist) 语言服务器的独立
Obsidian 前端。把 `.typ` 文件放在笔记旁，使用语言服务编辑，并由 Tinymist 的真实编译器
提供增量预览。

## Highlights

| 在同一编辑器中写作与阅读 | 保留项目上下文 |
|:--|:--|
| 切换源码与实时阅读模式。公式、标题、强调、列表和引用保持可读，编辑时仍能直接接触源码。 | 预览未保存的修改，沿用项目模板，并在源码和渲染页面之间双向定位。 |

## Features

| 功能 | 说明 |
| --- | --- |
| Typst 编辑器 | 用 CodeMirror 6 打开 `.typ`，提供基础语法高亮和语言服务器语义高亮。 |
| 语言服务 | 诊断、带参数模板的补全、悬浮文档、跳转定义、重命名和 typstyle 格式化。 |
| 实时阅读模式 | 渲染公式和文本结构；编辑时显示对应源码。 |
| 公式与页面悬浮预览 | 结合项目定义渲染公式，也能预览图形、定理框等内容调用。 |
| 增量预览 | 在侧栏显示 Tinymist 的 SVG 页面，包含未保存的修改。 |
| 自动生成同目录 PDF | 可按 `.typ` 文件开启，在保存后生成同名 PDF；替换已有或被外部修改的内容前会请求确认。 |
| 源码定位 | 编辑器光标带动预览定位；点击预览返回对应源码。 |
| 多文件书稿 | 章节可使用主文档的导入、引用和项目自有预览模板。 |
| 可选 YOLO 桥接 | 在 `.typ` 中显示已配置 YOLO 的 AI 候选；默认关闭。 |

## Quick Start

1. 按下方方法安装并启用 Typst Live。
2. 单独安装 [Tinymist](https://github.com/Myriad-Dreamin/tinymist/releases)。
   macOS 使用 Homebrew 时可运行 `brew install tinymist`。
3. 打开 `.typ` 文件。若找不到服务器，在 **设置 → Typst Live** 中填写可执行文件的绝对路径。
4. 点击编辑器的预览按钮，或运行 **Typst Live: Open preview**。
5. 用书本/代码按钮切换阅读模式。悬停公式查看渲染，也可启用 **Cursor preview**，
   在输入时查看光标附近的公式。
6. 在 Typst 窗格菜单中为文件开启 **Automatic PDF export**。导入的主题、组件或图片只变更
   时，使用 **Rebuild PDF** 手动重建。

可先试一个小文档：

```typst
#set heading(numbering: "1.")

= A small example

A right triangle satisfies $ x^2 + y^2 = z^2 $.
```

需要 **Obsidian 1.13.7+**、桌面文件系统 vault，以及本机 Tinymist 可执行文件。
开发和集成测试使用 Tinymist 0.15.2。本版不支持移动端。

## Installation

### 社区目录

打开 [Typst Live 社区页面](https://community.obsidian.md/plugins/typst-live)，点击 **Add to Obsidian**，然后启用 **Typst Live**。

### GitHub Release

从 [Releases](https://github.com/qiulinfan/obsidian-tinymist/releases/latest)
下载 `main.js`、`manifest.json` 和 `styles.css`。
在 `<vault>/.obsidian/plugins/typst-live/` 建立目录，放入三个文件，再重新加载
Obsidian 并在社区插件设置中启用 **Typst Live**。

首个公开版本为 **0.1.0**。

同一个 vault 应只启用一个接管 `.typ` 编辑器的插件。早期个人开发安装使用
`obsidian-tinymist` ID；启用本版前先停用旧副本。本插件不会复制或迁移旧设置。

### 开发安装

```sh
npm ci
npm test
npm run build
scripts/install-dev.sh /absolute/path/to/vault
```

开发安装脚本读取 `manifest.json` 的 ID，不会覆盖现有的非符号链接目录。

## 带模板的章节预览

章节若只导入排版函数、没有应用整份文档布局，可在所在目录或 vault 内的祖先目录放置
`.tinymist-preview.typ`。最近的模板通过 `sys.inputs.at("preview-source")` 接收
所选源码的 Typst 根相对路径：

```typst
#import "template.typ": chapter-layout
#show: chapter-layout
#include sys.inputs.at("preview-source")
```

排版由你的模板决定。没有包装模板时直接预览当前文件。包含该章节的 `main.typ`
可以提供书稿范围的导入和标签。添加或删除模板后，请重新打开预览。

## 可选 AI 补全

先安装和配置 [YOLO](https://github.com/qiulinfan/obsidian-yolo)，再开启 Typst Live 的
**YOLO tab completion (experimental)**。桥接复用 YOLO 的模型、触发方式和启用开关，
不提供独立的 AI 服务。

- **Tab** 接受可见候选；**Shift-Tab** 或 **Escape** 拒绝。
- **Enter** 换行，不会接受 AI 文本。
- 普通补全列表优先于 AI 候选。

桥接检查使用 YOLO **1.6.9.7**，其他版本可能需要重新检查接口。
详见 [设置与格式约束](docs/yolo-bridge.md)。

## 隐私与网络使用

插件没有遥测、分析统计、账户要求或托管后端，也不会安装或更新自身或 Tinymist。
Tinymist 由用户单独安装，插件启动它来提供语言服务和预览。

- **本机预览：** Tinymist 在 `127.0.0.1` 的临时端口提供 HTTP/WebSocket 预览数据，
  这是本机通信，不是远程预览服务。
- **Typst 包：** 文档导入未缓存的 `@preview` 包时，Tinymist/Typst 可能下载它。
  [Typst 包仓库](https://github.com/typst/packages) 说明了下载和缓存位置。
  已缓存的包可离线使用。
- **可选 AI：** 开启 YOLO 桥接后，源码上下文会交给 YOLO 及其配置的本地或远程模型。
  账户、费用和数据处理遵循所选服务及 YOLO 配置。桥接默认关闭，普通编辑和预览不需要它。
- **vault 外文件：** 二进制查找会检查配置路径、Homebrew/Cargo/WinGet 位置和登录 shell 的 PATH。
  外部编译器可能读取 vault 外的系统字体和 Typst 包缓存。预览以 vault 为项目根；
  插件还会读取渲染所需的本地项目模板。

## 当前边界

本版没有移动端支持、专门的查找引用界面、大纲面板或通用的 PDF/SVG/PNG 导出命令。
自动 PDF 是按文件开启的同名 PDF 构建功能，不会自动监听所有导入依赖；依赖只变更时请使用
**Rebuild PDF**。AI 补全是可选项，取决于安装的 YOLO 版本和模型服务。开发计划见
[roadmap](docs/roadmap.md)。

## 反馈与贡献

欢迎 [报告问题或提出建议](https://github.com/qiulinfan/obsidian-tinymist/issues)。
请附上操作系统、Obsidian/插件/Tinymist 版本、最小复现，以及预期和实际结果。
分享材料前移除私人文档内容和凭据。

欢迎贡献。较大的改动请先在 issue 中讨论，开发和发布约定见 [AGENTS.md](AGENTS.md)。

## 致谢

基于 [Tinymist](https://github.com/Myriad-Dreamin/tinymist)、
[Typst](https://github.com/typst/typst) 和 [typst.ts](https://github.com/Myriad-Dreamin/typst.ts)，
并使用 Obsidian 提供的 CodeMirror 与 Lezer。这是独立集成，并非 Obsidian、Typst 或
Tinymist 官方产品。README 的呈现方式参考 [YOLO](https://github.com/qiulinfan/obsidian-yolo)。

## License

作者自有源码和文档采用 [MIT](LICENSE)，版权所有 2026 Qiulin Fan，
允许使用、修改和再分发，须保留版权与许可声明。上游组件和测试响应中上游内容的原有许可证保持不变，
详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
