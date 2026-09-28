/**
 * Plugin-owned prompt assets, read relative to this module. Missing or empty assets fail closed.
 * The cache holds immutable file content, never user or session state.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DIRECTIVE_ASSET = "../assets/ultrawork-directive.md";
export const HYPERPLAN_ASSET = "../assets/hyperplan.md";
export const RESEARCH_ASSET = "../assets/ulw-research.md";

const bodies = new Map<string, string>();

/** Drop only the leading YAML frontmatter; preserve later horizontal rules. */
export function stripFrontmatter(raw: string): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return text;
  const rest = text.slice(opening[0].length);
  const closing = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!closing) return text;
  return rest.slice(closing.index + closing[0].length);
}

export async function loadPromptAsset(relativePath: string): Promise<string> {
  const cached = bodies.get(relativePath);
  if (cached !== undefined) return cached;

  const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
  const body = stripFrontmatter(await readFile(filePath, "utf8")).trim();
  if (!body) throw new Error(`prompt asset ${relativePath} has no body after its frontmatter`);
  bodies.set(relativePath, body);
  return body;
}
