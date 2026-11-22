import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { grepIndex } from "@oh-my-pi/pi-coding-agent/tools/jfind/lexical";
import { resolveSearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";

import { filteredFilesystem } from "../plugins/find-console/src/filters.ts";

const directory = "notes with spaces";
const filename = "my 100%20.md";
const url = "local://notes%20with%20spaces/my%20100%2520.md";
const glob = "notes with */my *%20.md";

test.each([
  { scope: "URL", scenario: "within results", within: true, matchGlob: false },
  { scope: "URL", scenario: "with a glob", within: false, matchGlob: true },
  { scope: "URL", scenario: "within results with a glob", within: true, matchGlob: true },
  { scope: "disk", scenario: "within results with a glob", within: true, matchGlob: true },
])("searches $scope filenames $scenario", async ({ scope, within, matchGlob }) => {
  const cwd = await mkdtemp(join(tmpdir(), "find-console-url-"));
  try {
    const diskRoot = join(cwd, "local");
    const dir = join(diskRoot, directory);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), "search needle\n");
    await writeFile(join(dir, "other.md"), "another search needle\n");

    const base = new InternalUrlFilesystem({ context: { cwd, localProtocolOptions: { getArtifactsDir: () => cwd } }, tier: "read" });
    const root = await resolveSearchRoot(base, scope === "URL" ? "local://" : diskRoot, cwd);
    const files = within ? [scope === "URL" ? url : join(dir, filename)] : undefined;
    const globs = matchGlob ? [glob] : [];
    const filesystem = filteredFilesystem(base, root, { globs, extensions: [], minScore: 0.2 }, files).shellFilesystem();
    const { perFileKw } = await grepIndex(root.path, ["needle"], { includeHidden: false, filesystem });

    expect([...perFileKw]).toEqual([[`${directory}/${filename}`, [1]]]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
