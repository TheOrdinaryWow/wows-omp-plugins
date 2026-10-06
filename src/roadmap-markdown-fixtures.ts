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

export const closedMarkdownBodies = [
  ...closedContainerFences.map(({ body }) => body),
  ...htmlBlankLineBlocks.map((opener) => `${opener}\n\`\`\`\n## Hidden\n</div>\n\nCompleted HTML example.`),
  ...markdownContainers.map(({ first, next }) => `${first}<custom-element>\n${next}~~~\n${next}## Hidden\n\nCompleted HTML example.`),
];
