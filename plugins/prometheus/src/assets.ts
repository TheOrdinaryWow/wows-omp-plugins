/**
 * Prompt-asset loading for the Prometheus plugin.
 *
 * The runtime injects two plugin-owned markdown assets: the shared planning
 * skill and the post-approval Atlas executor policy. Both are read from disk
 * relative to this module, stripped of their frontmatter, and cached. The
 * cache holds immutable file content only — never user or session state.
 *
 * A missing, unreadable, or empty asset is a hard failure: activation refuses
 * rather than silently degrading into an unguarded execution session.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Shared planning workflow, injected while Prometheus planning is active. */
export const SKILL_ASSET = "../skills/prometheus/SKILL.md";
/**
 * Standalone executor policy, injected on every post-approval execution turn.
 * Kept outside `agents/` so the host never registers Atlas as a spawnable
 * task agent: it only ever runs as the main session.
 */
export const ATLAS_ASSET = "../assets/atlas.md";

const bodies = new Map<string, string>();

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

/** Read, strip, and cache one prompt asset. Throws when it cannot be used. */
export async function loadPromptAsset(relativePath: string): Promise<string> {
  const cached = bodies.get(relativePath);
  if (cached !== undefined) return cached;

  const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
  const body = stripFrontmatter(await readFile(filePath, "utf8")).trim();
  if (!body) throw new Error(`prompt asset ${relativePath} has no body after its frontmatter`);
  bodies.set(relativePath, body);
  return body;
}

/** Load every asset the workflow needs, so activation fails closed. */
export async function loadRequiredPromptAssets(): Promise<void> {
  await loadPromptAsset(SKILL_ASSET);
  await loadPromptAsset(ATLAS_ASSET);
}
