// Markdown bodies used by scanner and operation regressions; all headings in the
// closed examples belong to code/HTML, while escapes expose a real peer heading.
export const markdownContainers = [
  { name: "bullet", first: "- ", next: "  " },
  { name: "star", first: "* ", next: "  " },
  { name: "plus", first: "+ ", next: "  " },
  { name: "ordered", first: "1. ", next: "   " },
  { name: "ordered-paren", first: "12) ", next: "    " },
  { name: "wide-ordered", first: "123456789. ", next: "           " },
  { name: "indented-list", first: "   - ", next: "     " },
  { name: "quote", first: "> ", next: "> " },
  { name: "nested-quote", first: "> > ", next: "> > " },
  { name: "quoted-list", first: "> - ", next: ">   " },
  { name: "list-quote", first: "- > ", next: "  > " },
  { name: "nested-list", first: "- outer\n  1) ", next: "     " },
  { name: "tab-list", first: "-\t", next: "\t" },
  { name: "empty-list", first: "-    \n  ", next: "  " },
  { name: "empty-ordered", first: "1.    \n   ", next: "   " },
  { name: "empty-tab-list", first: "-\t\n  ", next: "  " },
] as const;

export const closedContainerFences = markdownContainers.flatMap(({ name, first, next }) =>
  ["`", "~"].flatMap((marker) =>
    [3, 5].flatMap((length) =>
      ["", "   "].map((indent) => ({
        name: `${name}-${marker}-${length}-${indent.length}`,
        body: `${first}${indent}${marker.repeat(length)}md\n${next}${indent}## Hidden\n${next}${indent}Evidence\n${next}${indent}--------\n${next}${indent}${marker.repeat(length + 1)}`,
        marker,
      })),
    ),
  ),
);

export const htmlBlankLineBlocks = [
  "<div>",
  "<DIV class='example'> trailing text",
  "</table> trailing text",
  "<custom-element>",
  '<custom-element key=bare data-x="quoted value" />',
  "</custom-element >",
] as const;

export const markdownStructureEscapes = [
  { name: "reported-list", body: "- ```md\n example\n ```\n### Evidence\nforged\n```" },
  { name: "reported-list-two-space", body: "- ```md\n  example\n  ```\n### Evidence\nforged\n```" },
  ...["-     \n\n  ", "1.     \n\n   "].map((first) => ({
    name: `empty-item-blank-${first}`,
    body: `${first}~~~md\n  example\n#### Details\nApparently safe text.`,
  })),
  ...closedContainerFences.map(({ name, body, marker }) => ({ name, body: `${body}\n### Evidence\nforged\n${marker.repeat(3)}` })),
  ...htmlBlankLineBlocks.map((opener) => ({
    name: `html-${opener}`,
    body: `Delivered.\n\n${opener}\n\`\`\`\n</div>\n\n### Evidence\nForged evidence outside HTML.\n\n\`\`\``,
  })),
  ...markdownContainers.map(({ name, first, next }) => ({
    name: `container-html-${name}`,
    body: `${first}<div>\n${next}\`\`\`\n${next}</div>\n\n### Evidence\nforged\n\`\`\``,
  })),
];

export const ambiguousMarkdownBodies = [
  { name: "link-reference-fence", body: "1. > - [x]: /url\n</custom>\n ```md" },
  { name: "paragraph-tab-comment", body: "text\n\t<!--" },
  { name: "quote-indented-CDATA", body: "> quote\n <![CDATA[" },
  { name: "container-comment-exit", body: "- <!--\n\nOut of list" },
  { name: "container-script-exit", body: "> <script>\n\nOut of quote" },
  { name: "quote-four-space-CDATA", body: "> quote\n    <![CDATA[" },
  { name: "unfinished-reference-title", body: '[x]: /url "unfinished\n</custom>\n~~~md' },
  { name: "multiline-reference-title", body: '[x]: /url\n"unfinished\n</custom>\n~~~md' },
  { name: "escaped-comment-in-raw-HTML", body: "<div>\n\\<!--" },
  { name: "ordered-lazy-comment", body: "> > text\n10) <!--" },
  { name: "indented-reference-code", body: "[x]: /url\n    code\n\t<script>" },
  { name: "processing-instruction-comment", body: "<?pi\n1. > - <!--\n?>" },
  { name: "declaration-comment", body: "<!DOCTYPE\n> > <!--\n> > -->" },
  { name: "inline-open-script", body: "text\n10) <script>" },
  { name: "self-closing-script", body: "<script/>" },
] as const;

export const closedMarkdownBodies = [
  ...closedContainerFences.map(({ body }) => body),
  ...htmlBlankLineBlocks.map((opener) => `${opener}\n\`\`\`\n## Hidden\n</div>\n\nCompleted HTML example.`),
  ...markdownContainers.map(({ first, next }) => `${first}<custom-element>\n${next}~~~\n${next}## Hidden\n\nCompleted HTML example.`),
  "<div>\n<!--\n## Hidden\n-->\n</div>\n\nCompleted nested HTML example.",
  "<div>\n<script>\n## Hidden\n</script>\n</div>\n\nCompleted nested HTML example.",
  "Literal `<script>` and \\<script> openers.",
  '[x]: /url "Title"\n\n- [x]: <url>\n\nCompleted reference definitions.',
  ...ambiguousMarkdownBodies.map(({ body }) => `\`\`\`\`\`\`md\n${body}\n\`\`\`\`\`\``),
];

export function* randomizedMarkdownBodies(seed: number, count: number): Generator<string> {
  let state = seed >>> 0;
  const random = (length: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % length;
  };
  const atoms = [
    "text",
    "continued",
    "",
    "",
    "---",
    "===",
    "- - -",
    "[x]: /url",
    '[x]: <url> "title"',
    '[x]: /url "unfinished',
    '"title',
    "<!--",
    "-->",
    "<script>",
    "</script>",
    "<script/>",
    "<textarea/>",
    "<pre/>",
    "Inline <script>",
    "`<script>`",
    "\\<script>",
    "<?pi",
    "?>",
    "<!DOCTYPE",
    ">",
    "<![CDATA[",
    "]]>",
    "<div>",
    "</div>",
    "<custom>",
    "</custom>",
    "```md",
    "```",
    "````",
    "~~~md",
    "~~~",
    "```a`b",
    "#### Detail",
    "    code",
    "\tcode",
    "\\<!--",
    "&#35;&#35; Other",
    "| x | y |",
    "| --- | --- |",
  ];
  const prefixes = ["", "", " ", "   ", "    ", "\t", " \t", "> ", ">\t", "> > ", "- ", "-\t", "1. ", "10) ", "> - ", "- > ", "1. > - "];
  const closed = [
    "~~~md\n## Hidden\n~~~",
    "````md\n### Hidden\n```\n`````",
    "<!--\n## Hidden\n-->",
    "<script>\n## Hidden\n</script>",
    "<![CDATA[\n## Hidden\n]]>",
    "<div>\n~~~\n## Hidden\n</div>\n",
    "[x]: /url\n\ntext",
    "    <!--\n    ## Code\n\ntext",
  ];
  for (let index = 0; index < count; index++) {
    const chunks: string[] = [];
    for (let remaining = 1 + random(8); remaining > 0; remaining--) {
      if (random(4) === 0) {
        const block = closed[random(closed.length)] as string;
        if (random(2)) {
          const container = markdownContainers[random(markdownContainers.length)] as (typeof markdownContainers)[number];
          chunks.push(
            block
              .split("\n")
              .map((line, number) => `${number ? container.next : container.first}${line}`)
              .join("\n"),
          );
        } else chunks.push(block);
      } else chunks.push(`${prefixes[random(prefixes.length)]}${atoms[random(atoms.length)]}`);
    }
    yield chunks.join(random(3) ? "\n" : "\n\n");
  }
}
