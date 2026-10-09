/** Spawnable names come from the live task-tool description, not the plugin catalog. */
const AVAILABLE_AGENTS_HEADING = "# Available Agents";
const AGENT_BULLET_PATTERN = /^-\s+`([A-Za-z0-9_-]+)`(?:\s|:|$)/;

/**
 * The host renders this section after spawn policy and disabled-agent filtering, one backticked bullet name per agent.
 * An absent or unrecognized section is unknown, not an empty legal set.
 */
export function parseLegalAgentNames(taskDescription: string): string[] | undefined {
  const headingIndex = taskDescription.indexOf(AVAILABLE_AGENTS_HEADING);
  if (headingIndex < 0) return undefined;
  const names: string[] = [];
  const section = taskDescription.slice(headingIndex + AVAILABLE_AGENTS_HEADING.length);
  for (const line of section.split("\n")) {
    if (/^#{1,2}\s/.test(line)) break;
    const name = AGENT_BULLET_PATTERN.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length) return names;
  return section.includes("Agent spawning is currently disabled.") ? [] : undefined;
}

/** Ordered substitutions for names supplied by this plugin, the host, or omo-toolkit. */
export const KNOWN_AGENT_FALLBACKS: Record<string, readonly string[]> = {
  task: [],
  "deep-low": ["task"],
  "deep-high": ["task"],
  ultrabrain: ["task"],
  architect: ["task"],
  "visual-engineering": ["task"],
  artistry: ["task"],
  writing: ["task"],
  librarian: ["scout", "task"],
  metis: ["reviewer", "task"],
  momus: ["reviewer", "task"],
  oracle: ["reviewer", "task"],
  sonic: ["task"],
  scout: ["task"],
  reviewer: ["task"],
  "security-reviewer": ["task"],
};

export function isKnownAgent(name: string): boolean {
  return Object.hasOwn(KNOWN_AGENT_FALLBACKS, name);
}

export interface AgentResolution {
  dispatchAgent: string | undefined;
  fellBack: boolean;
}

/** An unknown live roster preserves the requested name; a known roster never invents availability. */
export function resolveAgent(requested: string, available: readonly string[] | undefined): AgentResolution {
  if (available === undefined) return { dispatchAgent: requested, fellBack: false };
  if (available.includes(requested)) return { dispatchAgent: requested, fellBack: false };
  for (const candidate of KNOWN_AGENT_FALLBACKS[requested] ?? []) {
    if (available.includes(candidate)) return { dispatchAgent: candidate, fellBack: true };
  }
  return { dispatchAgent: undefined, fellBack: false };
}
