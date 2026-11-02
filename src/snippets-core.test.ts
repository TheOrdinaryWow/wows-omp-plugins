import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";

import { expandSnippets, triggerWord } from "../plugins/snippets/src/matching.ts";
import { readSnippetSettings, type SnippetSettings } from "../plugins/snippets/src/settings.ts";
import { formatSnippetSource, parseSnippetSource } from "../plugins/snippets/src/snippet.ts";
import { type SnippetEntry, SnippetStore } from "../plugins/snippets/src/store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; cwd: string; globalDir: string; statePath: string; store: SnippetStore }> {
  const root = await mkdtemp(join(tmpdir(), "snippets-core-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const globalDir = join(root, "global");
  const statePath = join(root, "personal", "state.json");
  await mkdir(cwd, { recursive: true });
  return { root, cwd, globalDir, statePath, store: new SnippetStore({ cwd, globalDir, statePath }) };
}

function entry(key = "kyc", extra: Partial<SnippetEntry> = {}): SnippetEntry {
  return {
    key,
    scope: "global",
    path: `/snippets/${key}.md`,
    description: "Know your customer",
    body: "Expanded body",
    id: `global:${key}`,
    enabled: true,
    pinned: false,
    uses: 0,
    shadowed: false,
    ...extra,
  };
}

const closed: SnippetSettings = { trigger: ".", matching: "closed" };

async function settingsFile(cwd: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(join(cwd, ".omp", "plugin-overrides.json"), JSON.stringify({ settings: { "wows-omp-plugin-snippets": settings } }));
}

describe("snippet shortcut matching", () => {
  for (const trigger of [".", "?", "SN"]) {
    for (const matching of ["closed", "open"] as const) {
      test(`${matching} strategy uses literal ${trigger} triggers and is case-sensitive`, () => {
        const settings = { trigger, matching };
        const word = `${trigger}kyc${matching === "closed" ? trigger : ""}`;
        const input = `/review ${word}, ${word}! ${trigger}KYC${matching === "closed" ? trigger : ""}`;
        const result = expandSnippets(input, [entry()], settings);
        expect(triggerWord(settings, "kyc")).toBe(word);
        expect(result.text).toBe(`/review Expanded body, Expanded body! ${trigger}KYC${matching === "closed" ? trigger : ""}`);
        expect(result.used.map((item) => item.id)).toEqual(["global:kyc", "global:kyc"]);
      });
    }
  }

  test("closed boundaries agree with the host's highlighted prose words", () => {
    const valid = [".kyc.", "(.kyc.)", '".kyc."', ".kyc.,", ".kyc.!", ".kyc.?", ".kyc..", "中文：.kyc."];
    const invalid = [
      "foo.kyc.",
      "e.g.",
      ".kycx",
      ".kyc.(",
      "x.kyc.",
      "中.kyc.",
      "_.kyc.",
      "-.kyc.",
      "/.kyc.",
      "::.kyc.",
      ".kyc./",
      ".kyc.\\",
      ".kyc.-",
      ".kyc._",
      ".kyc.x",
      ".kyc..txt",
    ];
    for (const input of valid) {
      expect(containsMagicKeyword(input, ".kyc.")).toBe(true);
      expect(expandSnippets(input, [entry()], closed).used).toHaveLength(1);
    }
    for (const input of invalid) {
      expect(containsMagicKeyword(input, ".kyc.")).toBe(false);
      expect(expandSnippets(input, [entry()], closed)).toEqual({ text: input, used: [] });
    }
    expect(expandSnippets("e.g.", [entry("g")], closed).text).toBe("e.g.");
  });

  test("open boundaries reject key prefixes, paths, identifiers and calls", () => {
    const settings: SnippetSettings = { trigger: ".", matching: "open" };
    for (const input of [".kycx", "foo.kyc", ".kyc(", ".kyc.txt", ".kyc/", ".kyc-", "::.kyc", "中.kyc"]) {
      expect(containsMagicKeyword(input, ".kyc")).toBe(false);
      expect(expandSnippets(input, [entry()], settings).text).toBe(input);
    }
    expect(expandSnippets(".kyc, .kyc! .kyc.", [entry()], settings).text).toBe("Expanded body, Expanded body! Expanded body.");
  });

  test("code spans, fenced blocks and XML/HTML sections remain literal", () => {
    const input = '`.kyc.`\n```ts\n.kyc.\n```\n~~~\n.kyc.\n~~~\n<note>.kyc.</note>\n<span title=".kyc.">.kyc.</span>\n.kyc.';
    const result = expandSnippets(input, [entry()], closed);
    expect(result.text).toBe(`${input.slice(0, -5)}Expanded body`);
    expect(result.used).toHaveLength(1);
  });

  test("escape removes one backslash only for an existing standalone prose shortcut", () => {
    const input = "\\.kyc. .kyc. \\.missing. \\.kyc.x `\\.kyc.`";
    const result = expandSnippets(input, [entry()], closed);
    expect(result.text).toBe(".kyc. Expanded body \\.missing. \\.kyc.x `\\.kyc.`");
    expect(result.used).toHaveLength(1);
    const escaped = expandSnippets("\\?kyc?", [entry()], { trigger: "?", matching: "closed" });
    expect(escaped).toEqual({ text: "?kyc?", used: [] });
  });

  test("unknown, disabled and shadowed snippets never expand", () => {
    const input = ".unknown. .disabled. .shadowed. .kyc.";
    const result = expandSnippets(input, [entry("disabled", { enabled: false }), entry("shadowed", { shadowed: true }), entry()], closed);
    expect(result.text).toBe(".unknown. .disabled. .shadowed. Expanded body");
    expect(result.used).toHaveLength(1);
  });

  test("bodies are inserted once without recursive expansion or replacement metacharacters", () => {
    const result = expandSnippets(".kyc. .other.", [entry("kyc", { body: ".other. $&" }), entry("other", { body: "Second" })], closed);
    expect(result.text).toBe(".other. $& Second");
    expect(result.used.map((item) => item.key)).toEqual(["kyc", "other"]);
  });

  test("shell and Python sigils skip expansion while slash commands do not", () => {
    for (const input of [" !echo .kyc.", "\n$print('.kyc.')"])
      expect(expandSnippets(input, [entry()], closed)).toEqual({ text: input, used: [] });
    expect(expandSnippets("/review .kyc.", [entry()], closed).text).toBe("/review Expanded body");
  });

  test("empty trigger disables matching and trigger words", () => {
    const settings: SnippetSettings = { trigger: "", matching: "closed" };
    expect(triggerWord(settings, "kyc")).toBeUndefined();
    expect(expandSnippets(".kyc. \\.kyc.", [entry()], settings)).toEqual({ text: ".kyc. \\.kyc.", used: [] });
  });
});

describe("snippet file format", () => {
  test("description and body round-trip without losing leading whitespace or special characters", () => {
    const description = 'Customer: "identity" \\ check';
    const body = "  Leading text\n\n---\ndescription: body, not metadata\n---\nTail\n\n";
    expect(parseSnippetSource(formatSnippetSource(description, body))).toEqual({ description, body: body.replace(/\n+$/, "") });
    expect(parseSnippetSource("Plain\r\nbody\r\n\r\n")).toEqual({ description: "", body: "Plain\nbody" });
    expect(parseSnippetSource("---\ndescription: 'Customer''s text'\n---\nBody\n")).toEqual({
      description: "Customer's text",
      body: "Body",
    });
    expect(parseSnippetSource("---\ndescription: plain: value\n---\nBody").description).toBe("plain: value");
    expect(parseSnippetSource(formatSnippetSource("", "---\nnot frontmatter"))).toEqual({ description: "", body: "---\nnot frontmatter" });
  });

  test("invalid frontmatter is rejected rather than sent as a snippet body", () => {
    for (const source of [
      "---\ndescription: Missing close",
      "---\nother: wrong\n---\nBody",
      "---\ndescription: one\ndescription: two\n---\nBody",
      "---\ndescription: |\n  multiline\n---\nBody",
      '---\ndescription: "broken\n---\nBody',
      '---\ndescription: "escaped\\nnewline"\n---\nBody',
    ])
      expect(() => parseSnippetSource(source)).toThrow();
    expect(() => formatSnippetSource("two\nlines", "Body")).toThrow("one line");
  });
});

describe("snippet settings", () => {
  test("defaults, empty trigger and literal multi-character trigger are read from the current workspace", async () => {
    const { cwd } = await fixture();
    await settingsFile(cwd, { trigger: ".", matching: "closed" });
    expect(await readSnippetSettings(cwd)).toEqual(closed);
    await settingsFile(cwd, { trigger: "", matching: "open" });
    expect(await readSnippetSettings(cwd)).toEqual({ trigger: "", matching: "open" });
    await settingsFile(cwd, { trigger: "SN", matching: "open" });
    expect(await readSnippetSettings(cwd)).toEqual({ trigger: "SN", matching: "open" });
  });

  test("invalid triggers and strategies disable expansion instead of falling back to a dot", async () => {
    const { cwd } = await fixture();
    for (const trigger of ["a b", "\n", "/", "!", "@", "^", "#", ":", "$", "`", "\\", 2, null]) {
      await settingsFile(cwd, { trigger, matching: "closed" });
      const settings = await readSnippetSettings(cwd);
      expect(settings.trigger).toBe("");
      expect(settings.problem).toBeTruthy();
      expect(expandSnippets(".kyc.", [entry()], settings)).toEqual({ text: ".kyc.", used: [] });
    }
    await settingsFile(cwd, { trigger: ".", matching: "inline" });
    expect((await readSnippetSettings(cwd)).problem).toContain("matching");
  });
});

test("headless input reports invalid settings once per session without expanding or notifying a missing UI", async () => {
  const { root, cwd } = await fixture();
  await settingsFile(cwd, { trigger: "!", matching: "closed" });
  const script = `
    import snippets from ${JSON.stringify(new URL("../plugins/snippets/src/index.ts", import.meta.url).href)};
    const hooks = new Map();
    const notices = [];
    snippets({
      setLabel() {}, registerCommand() {},
      on(name, handler) { hooks.set(name, handler); },
      sendMessage(message) { notices.push(message); }
    });
    let session = "first";
    const ctx = {
      cwd: ${JSON.stringify(cwd)}, hasUI: false, mode: "rpc",
      ui: { notify() { throw new Error("Headless notifications are not a visible channel"); } },
      sessionManager: { getSessionId: () => session }
    };
    const input = hooks.get("input");
    const extension = await input({ text: ".kyc.", source: "extension" }, ctx);
    const first = await input({ text: ".kyc.", source: "rpc" }, ctx);
    const repeated = await input({ text: ".kyc.", source: "interactive" }, ctx);
    session = "second";
    const second = await input({ text: ".kyc.", source: "rpc" }, ctx);
    console.log(JSON.stringify({ notices, unchanged: [extension, first, repeated, second].every(value => value === undefined) }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_PROFILE: "", OMP_PROFILE: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.unchanged).toBe(true);
  expect(result.notices).toHaveLength(2);
  for (const notice of result.notices) {
    expect(notice).toMatchObject({ customType: "wows-omp-snippets.notice", display: true, attribution: "agent" });
    expect(notice.content).toContain("trigger");
    expect(notice.content).toContain("disabled");
  }
});

describe("snippet storage", () => {
  test("workspace overrides global by key even when the local snippet is disabled", async () => {
    const { cwd, store } = await fixture();
    expect(await store.load()).toEqual([]);
    expect(store.problems).toEqual([]);
    await store.write("global", "kyc", "Global");
    await store.write("workspace", "kyc", "Local");
    expect(store.entries.find((item) => item.scope === "global")?.shadowed).toBe(true);
    expect(store.active().map((item) => item.body)).toEqual(["Local"]);
    const localId = `workspace:${resolve(cwd)}:kyc`;
    expect(expandSnippets(".kyc.", store.active(), closed).text).toBe("Local");
    await store.setEnabled(localId, false);
    expect(store.active()).toEqual([]);
    expect(expandSnippets(".kyc.", store.entries, closed).text).toBe(".kyc.");
    await store.remove("workspace", "kyc");
    expect(store.active().map((item) => item.body)).toEqual(["Global"]);
  });

  test("bad files are reported and skipped without hiding a valid global snippet", async () => {
    const { store } = await fixture();
    await store.write("global", "kyc", "Global");
    await mkdir(store.workspaceDir, { recursive: true });
    await writeFile(join(store.workspaceDir, "kyc.md"), "---\nunknown: x\n---\nInvalid");
    await writeFile(join(store.workspaceDir, "bad name.md"), "Invalid key");
    await store.load();
    expect(store.problems).toHaveLength(2);
    expect(store.problems.map((problem) => problem.path)).toContain(join(store.workspaceDir, "kyc.md"));
    expect(store.active().map((item) => item.body)).toEqual(["Global"]);
    await expect(store.write("workspace", "../escape", "Body")).rejects.toThrow("key");
    await expect(store.write("workspace", "invalid", "---\nbad: metadata\n---\nBody")).rejects.toThrow("frontmatter");
  });

  test("corrupt state becomes empty with a visible problem and is not overwritten on load", async () => {
    const { store, statePath } = await fixture();
    await store.write("global", "kyc", "Body");
    await mkdir(join(statePath, ".."), { recursive: true });
    for (const raw of ["broken json", '{"version":2,"entries":{}}', '{"version":1,"entries":{"global:kyc":{"uses":-1}}}']) {
      await writeFile(statePath, raw);
      await store.load();
      expect(store.active()[0]).toMatchObject({ enabled: true, pinned: false, uses: 0 });
      expect(store.problems).toHaveLength(1);
      expect(store.problems[0]?.path).toBe(statePath);
      expect(store.problems[0]?.message).toContain("empty state");
      expect(await readFile(statePath, "utf8")).toBe(raw);
    }
  });

  test("personal flags and each expansion use persist and sort without dropping other workspace state", async () => {
    const { root, cwd, store, globalDir, statePath } = await fixture();
    await store.write("global", "alpha", "A");
    await store.write("global", "beta", "B");
    await store.write("workspace", "zeta", "Z");
    await store.recordUse(["global:beta", "global:beta", "global:alpha"]);
    expect(store.entries.map((item) => item.key)).toEqual(["beta", "alpha", "zeta"]);
    const localId = `workspace:${resolve(cwd)}:zeta`;
    await store.setPinned(localId, true);
    expect(store.entries.map((item) => item.key)).toEqual(["zeta", "beta", "alpha"]);
    const second = new SnippetStore({ cwd: join(root, "other"), globalDir, statePath });
    await second.load();
    await second.setEnabled("global:alpha", false);
    await store.setPinned(localId, false);
    expect(store.entries.find((item) => item.key === "alpha")?.enabled).toBe(false);
    expect(store.entries.find((item) => item.key === "beta")?.uses).toBe(2);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.version).toBe(1);
    expect(state.entries["global:alpha"]).toEqual({ disabled: true, uses: 1 });
    expect(state.entries["global:beta"].uses).toBe(2);
    expect(state.entries[localId]).toBeUndefined();
  });

  test("rename refuses an existing target and successful rename moves flags and counts", async () => {
    const { store, statePath } = await fixture();
    await store.write("global", "source", "Original");
    await store.write("global", "target", "Existing target");
    await store.setPinned("global:source", true);
    await store.setEnabled("global:source", false);
    await store.recordUse(["global:source", "global:source"]);
    const previousState = await readFile(statePath, "utf8");
    await expect(store.rename("global", "source", "target")).rejects.toThrow("already exists");
    expect(await readFile(join(store.globalDir, "target.md"), "utf8")).toBe("Existing target");
    expect(await readFile(join(store.globalDir, "source.md"), "utf8")).toBe("Original");
    expect(await readFile(statePath, "utf8")).toBe(previousState);
    await store.rename("global", "source", "renamed");
    expect(store.entries.find((item) => item.key === "renamed")).toMatchObject({ enabled: false, pinned: true, uses: 2, body: "Original" });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.entries["global:source"]).toBeUndefined();
    expect(state.entries["global:renamed"]).toEqual({ disabled: true, pinned: true, uses: 2 });
    await store.remove("global", "renamed");
    expect(JSON.parse(await readFile(statePath, "utf8")).entries["global:renamed"]).toBeUndefined();
  });

  test("reload observes hand edits and does not share workspace snippets", async () => {
    const { root, store, globalDir, statePath } = await fixture();
    await store.write("workspace", "kyc", "Before");
    await writeFile(join(store.workspaceDir, "kyc.md"), "After\n");
    await store.load();
    expect(store.active()[0]?.body).toBe("After");
    const other = new SnippetStore({ cwd: join(root, "different"), globalDir, statePath });
    expect(await other.load()).toEqual([]);
  });
});
