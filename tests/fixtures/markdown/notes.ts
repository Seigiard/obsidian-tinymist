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
    "> | d6 | Result |",
    "> | --- | --- |",
    "> | 1 | Goblin |",
    "> - item",
    "",
    "> Quote",
    "[[X#H|Y]] [[#H]] [web](https://x.y/a)",
    "![[image.png|400]]",
    "![remote](https://x.y/a.png)",
    "before %%hidden%% after",
    "![[Note]]",
    "<u>text</u>",
    "$x^2$",
    "[^1]",
  ],
);

export const quoteFenceCompileSample = sourceNote(["typst: true"], ["> ```js", "> let x = 1;", "> ```"]);

export const calloutFenceCompileSample = sourceNote(["typst: true"], ["> [!note] Code", "> ```js", "> let x = 1;", "", "after"]);

export const terminatorAndRawContainerCompileSample = sourceNote(
  ["typst: true"],
  [
    "| Label | Value |",
    "| --- | --- |",
    "| Total<br>(approx.) | 1 |",
    "",
    "> [!note] N",
    "> /typst #figure(rect())[cap] // figure",
    "",
    "> Quote",
    '> /typst #text["http://x"] // trailing',
  ],
);
