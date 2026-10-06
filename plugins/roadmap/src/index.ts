import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { discoverRepo } from "#src/git.ts";
import { editInspect, parseFrontmatter, vcsGitRepoInfo, withFileLock } from "#src/host.ts";

export default function roadmap(pi: ExtensionAPI): void {
  const parameters = pi.zod.object({});
  pi.registerTool({
    name: "roadmap_probe",
    label: "Roadmap host probe",
    description: "Check roadmap host helper resolution through the extension loader.",
    parameters,
    approval: "write",
    async execute(_id, _params: typeof parameters.infer, _signal, _onUpdate, ctx) {
      const git = vcsGitRepoInfo(ctx.cwd);
      if (!git) throw new Error("Roadmap probe requires a Git work tree.");
      const probeDir = join(git.commonDir, "roadmap");
      await mkdir(probeDir, { recursive: true });
      const lockFile = join(probeDir, "probe-lock");
      const roundTripFile = join(probeDir, "probe-round-trip");
      const lock = await withFileLock(lockFile, async () => {
        await writeFile(roundTripFile, "roadmap host probe\n");
        return readFile(roundTripFile, "utf8");
      });
      const frontmatter = parseFrontmatter("---\nformat: 1\n---\nbody", { rawKeys: true, repair: false, level: "off" });
      const edit = editInspect("hashline", JSON.stringify({ input: "[probe.md#ABCD]\nPUT <1:\n+probe" }));
      const details = { git, discovered: discoverRepo(ctx.cwd), lock, frontmatter, edit };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
