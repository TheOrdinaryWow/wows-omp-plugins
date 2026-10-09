/**
 * Plugin-owned prompt assets, read once at module load because upgrading the plugin deletes this
 * install's cache directory under running sessions. Missing or empty assets fail closed at use.
 * The table holds immutable file content, never user or session state.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DIRECTIVE_ASSET = "../assets/ultrawork-directive.md";
export const HYPERPLAN_ASSET = "../assets/hyperplan.md";
export const RESEARCH_ASSET = "../assets/ulw-research.md";

type Asset = { body: string } | { error: Error };

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

function readAsset(relativePath: string): Asset {
  try {
    const body = stripFrontmatter(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")).trim();
    return body ? { body } : { error: new Error(`prompt asset ${relativePath} has no body after its frontmatter`) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

const ASSETS: Record<string, Asset | undefined> = {
  [DIRECTIVE_ASSET]: readAsset(DIRECTIVE_ASSET),
  [HYPERPLAN_ASSET]: readAsset(HYPERPLAN_ASSET),
  [RESEARCH_ASSET]: readAsset(RESEARCH_ASSET),
};

export function loadPromptAsset(relativePath: string): string {
  const asset = ASSETS[relativePath];
  if (!asset) throw new Error(`unknown prompt asset ${relativePath}`);
  if ("error" in asset) throw asset.error;
  return asset.body;
}
