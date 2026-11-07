/** Builds a note with the frontmatter block first, its delimiters included, then the body. */
export function sourceNote(frontmatter: readonly string[], body: readonly string[] = []): string {
  return ["---", ...frontmatter, "---", ...body].join("\n");
}

export const compileSample = sourceNote(
  ["typst: true"],
  [
    "# Release notes",
    "- **safe** _conversion_",
    "Prose escapes # $ @ < ~ [ ] and // comments.",
    "/typst#block[",
    "/typstThis is deliberate Typst.",
    "/typst]",
    "```typ",
    "#let version = 1",
    "```",
  ],
);

export const constructCompileSample = sourceNote(
  ["typst: true"],
  [
    "| Die | Result |",
    "| --- | --- |",
    "| 1\\|2 | first<br>second |",
    "> [!info] Source",
    "> - item",
    "",
    "> Quote",
    "[[X#H|Y]] [[#H]] [web](https://x.y/a)",
    "![[image.png|400]]",
    "before %%hidden%% after",
    "![[Note]]",
    "<u>text</u>",
    "$x^2$",
    "[^1]",
  ],
);
