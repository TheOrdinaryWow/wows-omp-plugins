export type SnippetScope = "global" | "workspace";

export const SNIPPET_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export interface Snippet {
  key: string;
  scope: SnippetScope;
  path: string;
  description: string;
  body: string;
}

function descriptionScalar(value: string): string {
  if (value.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Snippet description has invalid double quotes.");
    }
    if (typeof parsed !== "string" || /[\r\n]/.test(parsed)) throw new Error("Snippet description must be one line of text.");
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("Snippet description has invalid single quotes.");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[|>[{]/.test(value)) throw new Error("Snippet description must be a one-line scalar.");
  return value;
}

export function parseSnippetSource(source: string): { description: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return { description: "", body: normalized.replace(/\n+$/, "") };
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("Snippet frontmatter is missing its closing --- line.");
  let description = "";
  let found = false;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const match = /^description:[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error("Snippet frontmatter supports only description: <one line>.");
    if (found) throw new Error("Snippet frontmatter contains more than one description.");
    description = descriptionScalar((match[1] ?? "").trim());
    found = true;
  }
  return {
    description,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/\n+$/, ""),
  };
}

export function formatSnippetSource(description: string, body: string): string {
  if (/[\r\n]/.test(description)) throw new Error("Snippet description must be one line of text.");
  return `---\ndescription: ${JSON.stringify(description)}\n---\n${body.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
}
