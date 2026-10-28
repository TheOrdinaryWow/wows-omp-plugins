import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const skills = resolve(import.meta.dir, "../plugins/omo-toolkit/skills");
const finder = join(skills, "coding-agent-sessions/scripts/find-agent-sessions.py");
const savings = join(skills, "onboarding/scripts/summarize-cache-usage.mjs");
const python = Bun.which("python3");
if (!python) throw new Error("Session-skill tests require Python 3.11+");
const node = Bun.which("node");
if (!node) throw new Error("Session-skill tests require Node.js");
const roots: string[] = [];
const stamp = "2026-07-01T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home() {
  const root = mkdtempSync(join(tmpdir(), "session-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, data: string | object) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}
function jsonl(path: string, entries: object[]) {
  put(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
function native(path: string, id: string, parentSession?: string, prompts = ["first", "middle query needle", "last"]) {
  jsonl(path, [
    { type: "title", title: "later title", timestamp: "2026-08-01T00:00:00Z" },
    { type: "session", version: 3, id, timestamp: stamp, cwd: "/work/project", parentSession },
    { type: "session_init", agent: parentSession ? "scout" : undefined },
    { type: "model_change", provider: "test", modelId: "model", timestamp: stamp },
    ...prompts.map((content) => ({ type: "message", timestamp: stamp, message: { role: "user", content } })),
  ]);
}
function runFinder(root: string, args: string[], script = finder) {
  return Bun.spawnSync([python as string, "-B", script, ...args], {
    cwd: root,
    // Do not inherit real HOME, provider stores, XDG roots or optional product CLIs.
    env: { HOME: root, USERPROFILE: root, PATH: join(root, "empty-bin"), PYTHONDONTWRITEBYTECODE: "1", XDG_DATA_HOME: join(root, "xdg") },
  });
}
interface SessionRow {
  id: string;
  platform: string;
  path: string;
  cwd: string | null;
  created_at: string;
  first_user_message: string;
  parent_id: string | null;
  parent_reference: string | null;
  agent: string | null;
  subagent_count: number;
  match_reasons?: { field: string; query: string }[];
}
function find(root: string, args: string[], script = finder): { count: number; results: SessionRow[] } {
  const result = runFinder(root, args, script);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function tree(path: string): string[] {
  return readdirSync(path, { recursive: true }).map(String).sort();
}

describe("coding-agent-sessions: synthetic homes only", () => {
  test("discovers default/profile/XDG/custom roots while preserving foreign stores", () => {
    const root = home();
    native(join(root, ".omp/agent/sessions/bucket/default.jsonl"), "default");
    native(join(root, ".omp/profiles/work/agent/sessions/bucket/profile.jsonl"), "profile");
    native(join(root, "xdg/omp/sessions/bucket/xdg.jsonl"), "xdg");
    native(join(root, "custom agent/sessions/bucket/custom.jsonl"), "custom");
    native(join(root, ".omo/agent/sessions/bucket/foreign.jsonl"), "foreign");
    const result = find(root, ["list", "--platform", "omp", "--root", join(root, "custom agent")]);
    expect(result.results.map((row) => row.id).sort()).toEqual(["custom", "default", "profile", "xdg"]);
    expect(find(root, ["list", "--platform", "senpi"]).results.map((row) => row.id)).toEqual(["foreign"]);
  });

  test("exact directories bypass defaults, ignore artifact JSONL and preserve middle-message evidence", () => {
    const root = home();
    const selected = join(root, "selected sessions");
    native(join(selected, "selected.jsonl"), "selected");
    native(join(root, ".omp/agent/sessions/unselected.jsonl"), "unselected");
    jsonl(join(selected, "selected/timeline.jsonl"), [{ type: "timeline", timestamp: stamp }]);
    const result = find(root, ["find", "--query", "needle", "--query", "not-present", "--platform", "omp", "--session-dir", selected]);
    expect(result.count).toBe(1);
    expect(result.results[0]?.id).toBe("selected");
    expect(result.results[0]?.created_at).toBe(stamp);
    expect(result.results[0]?.match_reasons).toEqual([expect.objectContaining({ field: "user_message", query: "needle" })]);
    expect(runFinder(root, ["list", "--session-dir", selected]).exitCode).not.toBe(0);
    expect(runFinder(root, ["list", "--platform", "omp", "--session-dir", selected, "--root", root]).exitCode).not.toBe(0);
  });

  test("links actual OMP children by header plus artifact containment, not forks or dotted prefixes", () => {
    const root = home();
    const bucket = join(root, ".omp/agent/sessions/project");
    const parent = join(bucket, "2026_parent.jsonl");
    native(parent, "parent-uuid");
    native(join(bucket, "2026_parent/Worker.jsonl"), "child-uuid", parent);
    native(join(bucket, "2026_parent/Worker/Worker.Nested.jsonl"), "nested-uuid", "child-uuid");
    native(join(bucket, "fork.jsonl"), "fork-uuid", "parent-uuid");
    native(join(bucket, "2026_parent/Worker.Unrelated.jsonl"), "unrelated-uuid");
    const main = find(root, ["list", "--platform", "omp"]);
    expect(main.results.map((row) => row.id).sort()).toEqual(["fork-uuid", "parent-uuid", "unrelated-uuid"]);
    expect(main.results.find((row) => row.id === "parent-uuid")?.subagent_count).toBe(1);
    const all = find(root, ["list", "--platform", "omp", "--include-subagents"]);
    expect(all.results.find((row) => row.id === "child-uuid")).toMatchObject({
      parent_id: "parent-uuid",
      parent_reference: parent,
      agent: "scout",
    });
    expect(all.results.find((row) => row.id === "nested-uuid")?.parent_id).toBe("child-uuid");
    const detail = runFinder(root, ["read", "parent-uuid", "--platform", "omp"]);
    const payload = JSON.parse(detail.stdout.toString());
    expect(payload.results[0].subagents[0].id).toBe("child-uuid");
    expect(payload.results[0].events.some((row: { type: string }) => row.type === "session")).toBe(true);
  });

  test("keeps missing parent references unresolved and honors filters", () => {
    const root = home();
    native(join(root, ".omp/agent/sessions/p/unknown.jsonl"), "unknown", "/unscanned/parent.jsonl");
    const row = find(root, ["list", "--platform", "omp", "--cwd", "/work", "--model", "model", "--from", "2026-07", "--to", "2026-08"])
      .results[0];
    expect(row).toMatchObject({ parent_reference: "/unscanned/parent.jsonl", parent_id: null });
    expect(find(root, ["list", "--platform", "omp", "--from", "2027"]).count).toBe(0);
  });

  test("reconstructs Claude and Codex children and raw source paths", () => {
    const root = home();
    const claude = join(root, ".claude/projects/project");
    const message = (sessionId: string, content: string) => ({
      sessionId,
      type: "user",
      timestamp: stamp,
      cwd: "/work/project",
      message: { role: "user", content },
    });
    jsonl(join(claude, "main.jsonl"), [message("main", "main request")]);
    jsonl(join(claude, "main/subagents/agent-child.jsonl"), [message("main", "delegated audit")]);
    put(join(claude, "main/subagents/agent-child.meta.json"), { agentType: "Explore", description: "security review" });
    jsonl(join(claude, "main/subagents/workflows/wf_1/journal.jsonl"), [{ type: "journal" }]);
    const codexPath = join(root, ".codex/sessions/2026/rollout-child.jsonl");
    jsonl(codexPath, [
      {
        type: "session_meta",
        timestamp: stamp,
        payload: {
          id: "codex-child",
          cwd: "/work/project",
          model_provider: "openai",
          source: { subagent: { thread_spawn: { parent_thread_id: "codex-main", agent_nickname: "Reader", agent_role: "worker" } } },
        },
      },
      { type: "response_item", timestamp: stamp, payload: { role: "user", content: [{ type: "input_text", text: "delegated audit" }] } },
    ]);
    const result = find(root, ["find", "audit", "--platform", "claude", "--platform", "codex", "--include-subagents"]);
    expect(result.count).toBe(2);
    expect(result.results.find((row) => row.platform === "claude")).toMatchObject({ id: "child", parent_id: "main", agent: "Explore" });
    expect(result.results.find((row) => row.platform === "codex")).toMatchObject({
      id: "codex-child",
      parent_id: "codex-main",
      path: codexPath,
      agent: "Reader (worker)",
    });
  });

  test("reads OpenCode file-store children and read-only Codex SQLite", () => {
    const root = home();
    const store = join(root, "opencode/storage/session/project");
    put(join(store, "ses_main.json"), { id: "oc-main", title: "main", directory: "/work/project", time: { created: 1000, updated: 2000 } });
    put(join(store, "ses_child.json"), {
      id: "oc-child",
      parentID: "oc-main",
      title: "child",
      directory: "/work/project",
      time: { created: 1000, updated: 2000 },
    });
    const oc = find(root, ["list", "--platform", "opencode", "--root", join(root, "opencode"), "--include-subagents"]);
    expect(oc.results.find((row) => row.id === "oc-child")?.parent_id).toBe("oc-main");
    const dbPath = join(root, ".codex/state_9.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, model_provider TEXT, cwd TEXT, model TEXT, first_user_message TEXT, tokens_used INTEGER)",
    );
    db.run(
      "INSERT INTO threads VALUES ('db-session', '/fixture/raw.jsonl', 100, 200, 'openai', '/work/project', 'model', 'database request', 9)",
    );
    db.close();
    chmodSync(dbPath, 0o444);
    const before = readFileSync(dbPath);
    expect(find(root, ["list", "--platform", "codex"]).results[0]?.id).toBe("db-session");
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  test("runs from a copied read-only skill with spaces and leaves no bytecode or helper files", () => {
    const root = home();
    native(join(root, ".omp/agent/sessions/p/main.jsonl"), "main");
    const copy = join(root, "copied skill");
    cpSync(join(skills, "coding-agent-sessions"), copy, { recursive: true });
    const before = tree(copy);
    for (const entry of before) chmodSync(join(copy, entry), 0o555);
    chmodSync(copy, 0o555);
    expect(find(root, ["list", "--platform", "omp"], join(copy, "scripts/find-agent-sessions.py")).count).toBe(1);
    expect(tree(copy)).toEqual(before);
  });
});

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
function usage(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return { input, output, cacheRead, cacheWrite };
}
function entry(tokens: TokenUsage, provider?: string, model?: string, timestamp = stamp) {
  return { type: "message", timestamp, message: { role: "assistant", usage: tokens, provider, model } };
}
function estimate(root: string, files: string[], prices: object | null) {
  const manifest = join(root, "files.json");
  const catalog = join(root, "prices.json");
  put(manifest, files);
  put(catalog, JSON.stringify(prices));
  const result = Bun.spawnSync([node as string, savings, "--sessions", manifest, "--prices", catalog], { cwd: root });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
const price = (input: number, output: number, cache_read: number, cache_write?: number) => ({
  cost: { input, output, cache_read, cache_write },
});
function session(root: string, name: string, entries: object[], version = 3) {
  const file = join(root, name);
  jsonl(file, [{ type: "session", version, id: name, timestamp: stamp }, ...entries]);
  return file;
}

describe("onboarding cache estimate: explicit fixtures only", () => {
  test("matches upstream arithmetic with early usage, exact identity, deterministic fallback, malformed time and insufficient pricing", () => {
    const root = home();
    const files = [
      session(root, "2026-07-01.jsonl", [
        entry(usage(100000, 20000, 400000, 50000)),
        { type: "model_change", provider: "anthropic", modelId: "a", timestamp: stamp },
        entry(usage(200000, 30000, 0, 100000), "openai", "b"),
        { type: "model_change", provider: "openai", modelId: "b", timestamp: stamp },
        entry(usage(0, 100000, 0, 0)),
        entry(usage(9000000, 9000000, 9000000, 9000000), "anthropic", "a", "bad-date"),
      ]),
      session(root, "2026-07-02.jsonl", [entry(usage(50000, 10000, 50000, 0), "missing", "only")]),
      session(root, "2026-07-03.jsonl", [entry(usage(100000, 10000, 100000, 10000), "openai", "c")]),
      session(root, "2026-07-04.jsonl", [entry(usage(0, 100000, 0, 0), "openai", "b")]),
    ];
    const catalog = {
      zeta: { models: { only: price(9, 90, 0.9, 11) } },
      anthropic: { models: { a: price(3, 15, 0.3, 3.75) } },
      alpha: { models: { only: price(4, 20, 0.4, 5) } },
      openai: { models: { b: price(2, 10, 0.2, 2.5), c: price(1, 5, 0.1) } },
    };
    const result = estimate(root, files.reverse(), catalog);
    expect(result).toMatchObject({
      usage: usage(350000, 160000, 450000, 150000),
      actualUsd: 3.28,
      cacheDiscountUsd: 1.26,
      cacheHitRate: 47.37,
      scanned: 4,
      used: 2,
      status: "partial",
    });
    expect(result.models).toHaveLength(3);
    expect(result.priceFallbacks).toEqual([expect.objectContaining({ provider: "missing", priceProvider: "alpha", model: "only" })]);
    expect(result.skipped.map((row: { reason: string }) => row.reason)).toEqual(
      expect.arrayContaining(["missing or malformed timestamp", "insufficient pricing; entire session excluded", "zero input tokens"]),
    );
    expect(estimate(root, files, null)).toMatchObject({ actualUsd: null, cacheDiscountUsd: null, used: 0, status: "insufficient-data" });
  });

  test("requires native v3 and complete exact prices, skips malformed entries and never falls back from an incomplete exact price", () => {
    const root = home();
    const old = session(root, "old.jsonl", [entry(usage(1, 1, 1, 1), "p", "m")], 2);
    const incomplete = session(root, "incomplete.jsonl", [entry(usage(1, 1, 1, 0), "p", "m")]);
    const malformed = session(root, "malformed.jsonl", [entry(usage(-1, 0, 0, 0), "p", "m"), entry(usage(1, 0, 0, 0))]);
    put(malformed, `${readFileSync(malformed, "utf8")}bad-json\nnull\n`);
    const result = estimate(root, [old, incomplete, malformed], {
      p: { models: { m: price(1, 1, 1) } },
      other: { models: { m: price(1, 1, 1, 1) } },
    });
    expect(result.used).toBe(0);
    expect(result.priceFallbacks).toEqual([]);
    expect(result.actualUsd).toBeNull();
    expect(result.skipped.map((row: { reason: string }) => row.reason)).toEqual(
      expect.arrayContaining([
        "requires an explicitly selected native v3 session",
        "invalid or incomplete message usage",
        "no provider/model attribution",
        "malformed JSON entry",
        "non-object entry",
      ]),
    );
  });

  test("rounds only after aggregation, deduplicates paths, and leaves all inputs untouched", () => {
    const root = home();
    const file = session(
      root,
      "sum.jsonl",
      Array.from({ length: 3 }, () => entry(usage(1000, 0, 1000, 0), "p", "m")),
    );
    const before = readFileSync(file);
    const result = estimate(root, [file, file], { p: { models: { m: price(4, 0, 0, 0) } } });
    expect(result).toMatchObject({ scanned: 1, actualUsd: 0.01, cacheDiscountUsd: 0.01, cacheHitRate: 50 });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("reports parameter and IO errors as failures, and empty explicit lists as insufficient", () => {
    const root = home();
    expect(estimate(root, [], {}).status).toBe("insufficient-data");
    const result = Bun.spawnSync([node as string, savings, "--sessions", join(root, "absent"), "--prices", join(root, "absent")]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(Bun.spawnSync([node as string, savings]).exitCode).toBe(2);
  });
});
