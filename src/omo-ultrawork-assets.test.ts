import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as AssetModule from "../plugins/omo-ultrawork/src/assets.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/omo-ultrawork/", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(omit?: string) {
  const root = await mkdtemp(join(tmpdir(), "ulw-prompt-cache-"));
  roots.push(root);
  for (const file of [
    "src/assets.ts",
    "assets/ultrawork-directive.md",
    "assets/hyperplan.md",
    "assets/ulw-research.md",
    "skills/ulw-loop/SKILL.md",
    "skills/ulw-loop/references/define-goal.md",
    "skills/ulw-loop/references/full-workflow.md",
  ]) {
    if (file === omit) continue;
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(pluginRoot, file), destination);
  }
  // The fixture installation is runtime-selected and intentionally tests the module-loading lifetime boundary.
  const assets: typeof AssetModule = await import(pathToFileURL(join(root, "src/assets.ts")).href);
  return { root, assets };
}

describe("ultrawork prompt cache lifetime", () => {
  test("directive, private procedures and loop references remain usable after the installation is removed", async () => {
    const { root, assets } = await fixture();
    const paths = [
      assets.DIRECTIVE_ASSET,
      assets.HYPERPLAN_ASSET,
      assets.RESEARCH_ASSET,
      assets.LOOP_ASSET,
      assets.LOOP_DEFINE_ASSET,
      assets.LOOP_WORKFLOW_ASSET,
    ];
    const before = paths.map((file) => assets.loadPromptAsset(file));
    expect(before.every((body) => body.length > 0)).toBe(true);
    await rm(root, { recursive: true });
    expect(paths.map((file) => assets.loadPromptAsset(file))).toEqual(before);
  });

  test("missing module-load assets remain failed closed rather than rereading a different installed edition", async () => {
    const missing = "skills/ulw-loop/references/full-workflow.md";
    const { root, assets } = await fixture(missing);
    expect(() => assets.loadPromptAsset(assets.LOOP_WORKFLOW_ASSET)).toThrow();
    await writeFile(join(root, missing), "later replacement edition\n");
    expect(() => assets.loadPromptAsset(assets.LOOP_WORKFLOW_ASSET)).toThrow();
    expect(assets.stripFrontmatter("---\nname: fixture\n---\nbody\n\n---\nsecond section\n")).toBe("body\n\n---\nsecond section\n");
  });
});

type FrontierNode = { id: string; prompt: string; agent?: string; dependsOn?: string[] };
type FrontierResult = {
  files: Record<string, string>;
  passes: { spawned: string[]; writes: string[]; error?: string }[];
};
const runKey = "docs-refresh-a1";
const runPath = `local://mass-ulw/${runKey}.json`;
const definitionPath = `local://mass-ulw/${runKey}/definition.json`;

function graphFiles(nodes: FrontierNode[], status?: Record<string, Record<string, string>>): Record<string, string> {
  return {
    [definitionPath]: JSON.stringify({ key: runKey, name: "Test graph", nodes }),
    [runPath]: JSON.stringify({
      version: 2,
      key: runKey,
      definitionPath,
      status: status ?? Object.fromEntries(nodes.map((node) => [node.id, { state: "pending" }])),
    }),
  };
}

async function runFrontiers(files: Record<string, string>, passes = 1, failures: string[] = []): Promise<FrontierResult> {
  const skill = await Bun.file(join(pluginRoot, "skills/mass-ulw/SKILL.md")).text();
  const source = /```python\n([\s\S]*?)\n```/.exec(skill)?.[1];
  if (!source) throw new Error("The shipped mass-ulw skill has no executable frontier cell");
  const child = Bun.spawn(["python3", "-B", "-c", FRONTIER_HARNESS], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ source, files, passes, failures }));
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout);
}

const FRONTIER_HARNESS = `
import json
import sys
from types import SimpleNamespace

payload = json.load(sys.stdin)
files = payload["files"]
passes = []
for _ in range(payload["passes"]):
    current = {"spawned": [], "writes": []}
    passes.append(current)

    def read(path):
        if path not in files:
            raise FileNotFoundError(path)
        return files[path]

    def write(path, content):
        files[path] = content
        current["writes"].append(path)

    def agent(prompt, agent, label):
        current["spawned"].append(label)
        return SimpleNamespace(handle=f"agent://{label}", label=label)

    def wait(handles, raise_errors):
        assert raise_errors is False
        return [RuntimeError(f"failed:{handle.label}") if handle.label in payload["failures"]
                else f"report:{handle.label}" for handle in handles]

    try:
        exec(compile(payload["source"], "mass-ulw-frontier", "exec"),
             {"read": read, "write": write, "agent": agent, "wait": wait, "print": lambda *args: None})
    except Exception as error:
        current["error"] = str(error)
        break
print(json.dumps({"files": files, "passes": passes}))
`;

describe("mass-ulw executable frontier", () => {
  const producer = { id: "producer", prompt: "Produce the input", agent: "sonic" };
  const consumer = { id: "consumer", prompt: "Consume the input", dependsOn: ["producer"] };

  test("separates immutable inputs from status and stops after one settled frontier", async () => {
    const files = graphFiles([producer, consumer]);
    const first = await runFrontiers(files);
    expect(first.passes[0]?.error).toBeUndefined();
    expect(first.passes[0]?.spawned).toEqual(["producer"]);
    expect(first.files[definitionPath]).toBe(files[definitionPath]);
    const state = JSON.parse(first.files[runPath] as string);
    expect(state.nodes).toBeUndefined();
    expect(state.status.producer).toEqual({
      state: "done",
      handle: "agent://producer",
      resultPath: `local://mass-ulw/${runKey}/producer.md`,
    });
    expect(state.status.consumer).toEqual({ state: "pending" });
    expect(first.files[state.status.producer.resultPath]).toBe("report:producer");
    const second = await runFrontiers(first.files);
    expect(second.passes[0]?.spawned).toEqual(["consumer"]);
    expect(JSON.parse(second.files[runPath] as string).status.consumer.state).toBe("done");
  });

  test("upgrades combined legacy state without rerunning or replacing finished evidence", async () => {
    const reportPath = `local://mass-ulw/${runKey}/producer.md`;
    const status = { producer: { state: "done", handle: "agent://original", resultPath: reportPath } };
    const result = await runFrontiers({
      [runPath]: JSON.stringify({ key: runKey, name: "Previous run", nodes: [producer], status }),
      [reportPath]: "original evidence",
    });
    expect(result.passes[0]?.error).toBeUndefined();
    expect(result.passes[0]?.spawned).toEqual([]);
    expect(JSON.parse(result.files[runPath] as string)).toEqual({ version: 2, key: runKey, definitionPath, status });
    expect(JSON.parse(result.files[definitionPath] as string)).toEqual({ key: runKey, name: "Previous run", nodes: [producer] });
    expect(result.files[reportPath]).toBe("original evidence");
  });

  test("preflights the entire graph before dispatching even an otherwise ready node", async () => {
    for (const nodes of [
      [producer, { id: "bad", prompt: "Invalid dependency", dependsOn: ["missing"] }],
      [producer, { id: "cycle", prompt: "Cyclic dependency", dependsOn: ["cycle"] }],
    ]) {
      const result = await runFrontiers(graphFiles(nodes));
      expect(result.passes[0]?.error).toBeDefined();
      expect(result.passes[0]?.spawned).toEqual([]);
      expect(result.passes[0]?.writes).toEqual([]);
    }
  });

  test("refuses a mismatched definition, incomplete status, or missing recovered report before writes", async () => {
    const mismatched = graphFiles([producer]);
    mismatched[definitionPath] = JSON.stringify({ key: "other-run", nodes: [producer] });
    const incomplete = graphFiles([producer, consumer], { producer: { state: "pending" } });
    const missingReport = graphFiles([producer, consumer], {
      producer: { state: "done", resultPath: `local://mass-ulw/${runKey}/producer.md` },
      consumer: { state: "pending" },
    });
    for (const files of [mismatched, incomplete, missingReport]) {
      const result = await runFrontiers(files);
      expect(result.passes[0]?.error).toBeDefined();
      expect(result.passes[0]?.spawned).toEqual([]);
      expect(result.passes[0]?.writes).toEqual([]);
    }
  });

  test("refuses to replace a saved live writer even when an unrelated node is ready", async () => {
    const result = await runFrontiers(
      graphFiles([producer, { id: "independent", prompt: "Independent work" }], {
        producer: { state: "running", handle: "agent://original" },
        independent: { state: "pending" },
      }),
    );
    expect(result.passes[0]?.error).toContain("Resolve live child producer");
    expect(result.passes[0]?.spawned).toEqual([]);
    expect(result.passes[0]?.writes).toEqual([]);
  });

  test("isolates a failed producer while preserving a successful branch for the next inspected frontier", async () => {
    const result = await runFrontiers(
      graphFiles([
        producer,
        { id: "bad", prompt: "Fails independently" },
        consumer,
        { id: "blocked", prompt: "Consumes bad", dependsOn: ["bad"] },
      ]),
      2,
      ["bad"],
    );
    expect(result.passes.map((pass) => pass.spawned)).toEqual([["producer", "bad"], ["consumer"]]);
    expect(result.passes.every((pass) => !pass.error)).toBe(true);
    const status = JSON.parse(result.files[runPath] as string).status;
    expect(status.producer.state).toBe("done");
    expect(status.consumer.state).toBe("done");
    expect(status.bad).toEqual({ state: "failed", handle: "agent://bad", error: "failed:bad" });
    expect(status.blocked).toEqual({ state: "skipped", error: "dependency failed" });
  });
});
