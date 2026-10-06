import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_ENV = "ROADMAP_HOST_CHECK";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/roadmap/src/index.ts", import.meta.url));
const ASSETS = fileURLToPath(new URL("../plugins/roadmap/assets/madr/", import.meta.url));
const UPSTREAM = "https://raw.githubusercontent.com/adr/madr/2475fe1973f66a12aaf58a91d8fa7b42c0f5ea3d/template/adr-template.md";

interface ProbeDetails {
  git: { repoRoot: string; commonDir: string };
  discovered: { repoRoot: string; commonDir: string };
  lock: string;
  frontmatter: { frontmatter: Record<string, unknown>; body: string };
  edit: { paths: string[] };
}

async function hostCheck(root: string): Promise<void> {
  // Host paths are initialized at import time, after the child has its isolated HOME.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    toolNames: [],
    additionalExtensionPaths: [ENTRY],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw new Error(error.error);
      },
    });
    assert.deepEqual(extensionsResult.errors, []);
    const probe = session.getToolByName("roadmap_probe");
    assert(probe, "Explicit extension path must load roadmap_probe through the real loader.");
    const result = await probe.execute("roadmap-host-probe", {});
    assert(!result.isError);
    const details = result.details as ProbeDetails;
    assert.equal(details.git.repoRoot, root);
    assert.equal(details.git.commonDir, join(root, ".git"));
    assert.deepEqual(details.discovered, { repoRoot: root, commonDir: join(root, ".git") });
    assert.equal(details.lock, "roadmap host probe\n");
    assert.equal(await readFile(join(root, ".git", "roadmap", "probe-round-trip"), "utf8"), details.lock);
    assert.deepEqual(details.frontmatter, { frontmatter: { format: 1 }, body: "body" });
    assert.deepEqual(details.edit.paths, ["probe.md"]);
    console.log("ROADMAP_HOST_OK vcsGitRepoInfo withFileLock parseFrontmatter editInspect discoverRepo; no fallback");
  } finally {
    await session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await hostCheck(process.env.ROADMAP_HOST_ROOT as string);
} else {
  // This file also runs as a plain Bun child, where importing bun:test is invalid.
  const { expect, test } = await import("bun:test");

  test("real SDK extension loader resolves all roadmap host helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "roadmap-host-"));
    try {
      const cwd = join(root, "cwd");
      await mkdir(cwd);
      const git = Bun.spawn(["git", "init", "--quiet", cwd], { stdout: "pipe", stderr: "pipe" });
      const gitError = await new Response(git.stderr).text();
      expect(await git.exited, gitError).toBe(0);
      const child = Bun.spawn([process.execPath, THIS_FILE], {
        cwd,
        env: { ...process.env, [CHILD_ENV]: "1", ROADMAP_HOST_ROOT: cwd, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("ROADMAP_HOST_OK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("vendored MADR template matches its recorded digest and pinned upstream bytes", async () => {
    const template = await readFile(join(ASSETS, "adr-template.md"));
    const notice = await readFile(join(ASSETS, "NOTICE"), "utf8");
    const recorded = notice.match(/^Template SHA-256: ([a-f0-9]{64})$/m)?.[1];
    assert(recorded, "NOTICE must record the template SHA-256.");
    expect(createHash("sha256").update(template).digest("hex")).toBe(recorded);
    const response = await fetch(UPSTREAM);
    expect(response.ok).toBe(true);
    const upstream = Buffer.from(await response.arrayBuffer());
    expect(template.equals(upstream)).toBe(true);
    expect(createHash("sha256").update(upstream).digest("hex")).toBe(recorded);
  }, 30_000);
}
