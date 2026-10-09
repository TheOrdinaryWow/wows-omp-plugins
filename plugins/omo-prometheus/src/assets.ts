/**
 * Prompt-asset loading for the Prometheus plugin.
 *
 * The runtime injects two plugin-owned markdown assets: the shared planning
 * skill and the post-approval Atlas executor policy. Both are read once when
 * the module loads, because upgrading the plugin deletes this install's cache
 * directory under running sessions. The table holds immutable file content
 * only — never user or session state.
 *
 * A missing, unreadable, or empty asset is a hard failure: activation refuses
 * rather than silently degrading into an unguarded execution session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Shared planning workflow, injected while Prometheus planning is active. */
export const SKILL_ASSET = "../skills/prometheus/SKILL.md";
/**
 * Standalone executor policy, injected on every post-approval execution turn.
 * Kept outside `agents/` so the host never registers Atlas as a spawnable
 * task agent: it only ever runs as the main session.
 */
export const ATLAS_ASSET = "../assets/atlas.md";

type Asset = { body: string } | { error: Error };

/**
 * Drop a leading YAML frontmatter block. Everything else — including a
 * horizontal rule later in the document — is body text and is preserved.
 */
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
  [SKILL_ASSET]: readAsset(SKILL_ASSET),
  [ATLAS_ASSET]: readAsset(ATLAS_ASSET),
};

export function loadPromptAsset(relativePath: string): string {
  const asset = ASSETS[relativePath];
  if (!asset) throw new Error(`unknown prompt asset ${relativePath}`);
  if ("error" in asset) throw asset.error;
  return asset.body;
}

/** Require every asset the workflow needs, so activation fails closed. */
export function loadRequiredPromptAssets(): void {
  loadPromptAsset(SKILL_ASSET);
  loadPromptAsset(ATLAS_ASSET);
}
