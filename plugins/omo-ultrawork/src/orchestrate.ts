import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

import { containsHostKeyword } from "#src/keywords.ts";

const ORCHESTRATE = MAGIC_KEYWORDS.find((keyword) => keyword.id === "orchestrate");

/** Whether the host will attach its orchestrate notice to this prompt, mirroring the host's own trigger rules. */
export async function triggersOrchestrate(
  text: string,
  enabledTools: readonly string[],
  readSetting: (id: string) => Promise<unknown>,
): Promise<boolean> {
  if (!ORCHESTRATE || !containsHostKeyword(text, ORCHESTRATE.word)) return false;
  if (!ORCHESTRATE.requires.every((tool) => enabledTools.includes(tool))) return false;
  return (await readSetting("magicKeywords.enabled")) !== false && (await readSetting(`magicKeywords.${ORCHESTRATE.id}`)) !== false;
}
