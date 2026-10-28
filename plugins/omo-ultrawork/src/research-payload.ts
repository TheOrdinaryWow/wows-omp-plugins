import { tmpdir } from "node:os";
import * as path from "node:path";

import { loadPromptAsset, RESEARCH_ASSET } from "#src/assets.ts";
import { materializeResearchAssets } from "#src/research-assets.ts";

export const RESEARCH_COMPANIONS =
  "<omo-ulw-research-companions>Use native read/search for static sources and immutable snapshots. Read xd://eval/browser and use the native browser when rendering, authentication or visual evidence matters; name that requirement in child assignments. skill://ultimate-browsing is optional blocked-host/platform/archive routing only, not a second browser engine. Reuse only an explicitly active compatible loop; otherwise keep the research journal and do not create a native goal.</omo-ulw-research-companions>";

export interface ResearchPayloadOptions {
  sessionDir: string;
  cwd: string;
  scratchDir: string;
  loopContext: string;
}
/** Both the explicit command and binding input use the same cached procedure and pinned bundle. */
export async function buildResearchPayload(request: string, options: ResearchPayloadOptions): Promise<string> {
  const body = loadPromptAsset(RESEARCH_ASSET);
  const assets = await materializeResearchAssets(options.sessionDir);
  const scratchRoot = options.scratchDir.trim() ? path.resolve(options.cwd, options.scratchDir) : path.join(tmpdir(), "ulw-research");
  return `<ulw-research-request>\n${request}\n</ulw-research-request>\n\n<omo-ulw-research-mode>\n${body}\n</omo-ulw-research-mode>\n\nResearch assets directory: ${assets.directory}\nResearch assets pin: ${assets.pin}\nResearch assets digest: ${assets.digest}\nResearch assets lifetime: ${assets.durable ? "durable session snapshot" : "ephemeral no-session snapshot (not durable)"}\nResearch scratch root: ${scratchRoot}\n\n${options.loopContext}\n\n${RESEARCH_COMPANIONS}`;
}
