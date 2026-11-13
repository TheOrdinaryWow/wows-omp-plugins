import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

import { registerCommands } from "../plugins/adr/src/commands.ts";
import { adrRepo, loadModel, renderAdr, today } from "../plugins/adr/src/documents.ts";
import { createMany, initialize, link, note, setStatus, supersede } from "../plugins/adr/src/operations.ts";
import { AdrSession } from "../plugins/adr/src/ses.ts";
import { HeadlessUi } from "../plugins/adr/src/ui.ts";
import { type AdrGraph, buildAdrGraph } from "../plugins/adr/src/visualize-data.ts";
import { AdrVisualizer, startVisualizeServer, type VisualizeServer } from "../plugins/adr/src/visualize-server.ts";
import { cleanupFixtures, decision, git, repoFixture } from "./adr-fixtures.ts";

const servers: VisualizeServer[] = [];
const visualizers: AdrVisualizer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const visualizer of visualizers.splice(0)) visualizer.stop();
  await cleanupFixtures();
});

async function commit(root: string, subject: string): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, [
    "-c",
    "user.name=ADR Tester",
    "-c",
    "user.email=adr@example.test",
    "commit",
    "-q",
    "--date=2026-10-01T12:00:00Z",
    "-m",
    subject,
  ]);
}

async function managedRepo(): Promise<string> {
  const root = await repoFixture();
  await initialize(root, "main");
  return root;
}

test("graph reconstructs committed lifecycle and notes, preserves identity through renames, and appends working edits", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision]);
  await commit(root, "Create the decision");
  await setStatus(root, "main", "ADR-0001", "accepted");
  await commit(root, "Accept the decision");
  await supersede(root, "main", "ADR-0001", { ...decision, title: "Use snapshots" });
  await commit(root, "Replace the decision");
  await note(root, "main", "ADR-0002", "The migration is complete.");
  await commit(root, "Record the migration");
  const model = await loadModel(adrRepo(root));
  const successor = model.adrs.find((doc) => doc.id === "ADR-0002");
  if (!successor) throw new Error("Missing successor fixture.");
  const renamed = join(root, "docs/adr/0002-renamed-decision.md");
  await rename(successor.path, renamed);
  await commit(root, "Rename the decision file");
  await writeFile(renamed, (await readFile(renamed, "utf8")).replace("The migration is complete.", "The migration is verified."));

  const graph = await buildAdrGraph(root);
  expect(graph.history.available).toBe(true);
  expect(graph.history.events.map(({ adr, kind, subject, to, uncommitted }) => ({ adr, kind, subject, to, uncommitted }))).toEqual([
    { adr: "ADR-0001", kind: "created", subject: "Create the decision", to: "proposed", uncommitted: undefined },
    { adr: "ADR-0001", kind: "status", subject: "Accept the decision", to: "accepted", uncommitted: undefined },
    { adr: "ADR-0001", kind: "superseded", subject: "Replace the decision", to: "ADR-0002", uncommitted: undefined },
    { adr: "ADR-0002", kind: "created", subject: "Replace the decision", to: "accepted", uncommitted: undefined },
    { adr: "ADR-0002", kind: "note", subject: "Record the migration", to: today(), uncommitted: undefined },
    { adr: "ADR-0002", kind: "edited", subject: "Uncommitted changes", to: undefined, uncommitted: true },
  ]);
  expect(graph.history.events[0]?.author).toBe("ADR Tester");
  expect(new Date(graph.history.events[0]?.date ?? "").toISOString()).toBe("2026-10-01T12:00:00.000Z");
  expect(graph.adrs[0]).toMatchObject({ id: "ADR-0001", supersededBy: "ADR-0002", workingTree: "clean" });
  expect(graph.adrs[1]).toMatchObject({
    id: "ADR-0002",
    supersedes: ["ADR-0001"],
    path: "docs/adr/0002-renamed-decision.md",
    workingTree: "modified",
    notes: [{ date: today(), text: "The migration is verified." }],
  });
});

test("history records a side-branch change once across a merge commit", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision]);
  await commit(root, "Create the decision");
  await git(root, ["checkout", "-q", "-b", "side"]);
  await setStatus(root, "main", "ADR-0001", "accepted");
  await commit(root, "Accept on a branch");
  await git(root, ["checkout", "-q", "-"]);
  await writeFile(join(root, "unrelated.txt"), "x\n");
  await commit(root, "Unrelated work");
  await git(root, [
    "-c",
    "user.name=ADR Tester",
    "-c",
    "user.email=adr@example.test",
    "merge",
    "-q",
    "--no-ff",
    "side",
    "-m",
    "Merge side",
  ]);

  const graph = await buildAdrGraph(root);
  expect(graph.history.events.map(({ kind, subject }) => ({ kind, subject }))).toEqual([
    { kind: "created", subject: "Create the decision" },
    { kind: "status", subject: "Accept on a branch" },
  ]);
});

test("graph separates mentions from supersession and enriches referenced roadmap stages read-only", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision, { ...decision, title: "Second decision" }, { ...decision, title: "Third decision" }]);
  await setStatus(root, "main", "ADR-0001", "accepted");
  await supersede(root, "main", "ADR-0001", { ...decision, title: "Replacement" });
  await link(root, "main", "ADR-0004", "S03", { resolver: async () => undefined });
  await mkdir(join(root, "docs/roadmap/R01"), { recursive: true });
  const stage = "---\nid: S03\ntitle: Storage migration\nround: R01\nstatus: active\n---\n# Storage migration\n";
  const stagePath = join(root, "docs/roadmap/R01/S03-storage.md");
  await writeFile(stagePath, stage);
  await note(root, "main", "ADR-0004", "Relates to ADR-0001, ADR-0002, ADR-0002, ADR-0003, ADR-0004 and ADR-9999.");
  await commit(root, "Create related decisions");

  const graph = await buildAdrGraph(root);
  expect(graph.adrs.find((doc) => doc.id === "ADR-0004")).toMatchObject({
    mentions: ["ADR-0002", "ADR-0003"],
    supersedes: ["ADR-0001"],
    stage: "S03",
    workingTree: "clean",
  });
  expect(graph.stages).toEqual([{ id: "S03", title: "Storage migration", round: "R01", status: "active" }]);
  expect(await readFile(stagePath, "utf8")).toBe(stage);
});

test("history records stage changes and deletions but ignores index-only commits", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision]);
  await commit(root, "Create");
  await link(root, "main", "ADR-0001", "S02", { resolver: async () => undefined });
  await commit(root, "Link stage");
  await git(root, ["rm", "docs/adr/0001-adopt-event-sourcing.md"]);
  await commit(root, "Delete");
  await writeFile(join(root, "docs/adr/README.md"), `${await readFile(join(root, "docs/adr/README.md"), "utf8")}\n`);
  await commit(root, "Index only");

  const graph = await buildAdrGraph(root);
  expect(graph.history.events.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual([
    { kind: "created", from: undefined, to: "proposed" },
    { kind: "stage", from: undefined, to: "S02" },
    { kind: "deleted", from: "proposed", to: undefined },
  ]);
});

test("unborn HEAD shows current ADRs and missing roadmap stages without inventing committed history", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision]);
  await link(root, "main", "ADR-0001", "S09", { resolver: async () => undefined });

  const graph = await buildAdrGraph(root);
  expect(graph.history.available).toBe(false);
  expect(graph.history.reason).toContain("Git history is unavailable");
  expect(graph.history.events).toEqual([expect.objectContaining({ adr: "ADR-0001", kind: "created", commit: "", uncommitted: true })]);
  expect(graph.adrs[0]?.workingTree).toBe("untracked");
  expect(graph.stages).toEqual([{ id: "S09" }]);
  expect(graph.repo.head).toBeUndefined();
});

test("HTTP server requires its token, serves graph JSON, and streams revisions after disk writes", async () => {
  const root = await managedRepo();
  await createMany(root, "main", [decision]);
  await commit(root, "Create");
  const server = startVisualizeServer(root);
  servers.push(server);
  expect((await fetch(new URL("/api/graph", server.url))).status).toBe(404);
  expect((await fetch(new URL("/wrong/api/graph", server.url))).status).toBe(404);
  const response = await fetch(`${server.url}api/graph`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const graph = (await response.json()) as AdrGraph;
  expect(graph.adrs.map((doc) => doc.id)).toEqual(["ADR-0001"]);
  expect(graph.history.events.map((event) => event.kind)).toEqual(["created"]);
  const abort = new AbortController();
  const events = await fetch(`${server.url}api/events`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  const reader = events.body?.getReader();
  if (!reader) throw new Error("Missing SSE body.");
  const initial = new TextDecoder().decode((await reader.read()).value);
  expect(initial).toContain('data: {"revision":0}');
  const pending = reader.read();
  const doc = (await loadModel(adrRepo(root))).adrs[0];
  if (!doc) throw new Error("Missing decision fixture.");
  await writeFile(doc.path, renderAdr({ ...doc, body: doc.body.replace("Audits need the full history.", "Audits need durable history.") }));
  const update = new TextDecoder().decode((await pending).value);
  expect(update).toContain('data: {"revision":1}');
  const refreshed = (await (await fetch(`${server.url}api/graph`)).json()) as AdrGraph;
  expect(refreshed.adrs[0]?.body).toContain("Audits need durable history.");
  const gitRevision = reader.read();
  await commit(root, "Persist the edited decision");
  expect(new TextDecoder().decode((await gitRevision).value)).toContain('data: {"revision":2}');
  const explicitRevision = reader.read();
  server.notify();
  expect(new TextDecoder().decode((await explicitRevision).value)).toContain('data: {"revision":3}');
  const committed = (await (await fetch(`${server.url}api/graph`)).json()) as AdrGraph;
  expect(committed.adrs[0]?.workingTree).toBe("clean");
  expect(committed.history.events.at(-1)).toMatchObject({ kind: "edited", subject: "Persist the edited decision" });
  await reader.cancel();
  abort.abort();
});

test("HTTP server serves the shipped visualization page assets from the installed plugin directory", async () => {
  const root = await managedRepo();
  const server = startVisualizeServer(root);
  servers.push(server);
  for (const [asset, contentType] of [
    ["", "text/html"],
    ["app.js", "text/javascript"],
    ["app.css", "text/css"],
  ] as const) {
    const response = await fetch(`${server.url}${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(contentType);
  }
});

test("headless visualize command opens empty states, posts a reusable URL, rejects subagents, and stops on repository switches", async () => {
  const root = await repoFixture();
  const otherRoot = await repoFixture();
  const visualizer = new AdrVisualizer();
  visualizers.push(visualizer);
  const messages: Array<{ customType?: string; content: unknown; display?: boolean }> = [];
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
  const pi = {
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
    sendMessage(message: { customType?: string; content: unknown; display?: boolean }) {
      messages.push(message);
    },
  } as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: false,
    mode: "rpc",
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => "visualize-test" },
  } as ExtensionCommandContext;
  registerCommands(
    pi,
    new AdrSession(),
    async () => new HeadlessUi(pi),
    () => {},
    visualizer,
  );
  if (!handler) throw new Error("Command was not registered.");
  await handler("visualize", ctx);
  const message = messages[0];
  expect(message).toMatchObject({ customType: "wows-omp-adr.visualize", display: true });
  const url = /http:\/\/\S+/.exec(String(message?.content))?.[0];
  if (!url) throw new Error("Command did not display a URL.");
  expect(((await (await fetch(`${url}api/graph`)).json()) as AdrGraph).state).toBe("absent");
  await handler("visualize", ctx);
  expect(messages[1]?.content).toBe(message?.content);
  await mkdir(join(root, "docs/adr"), { recursive: true });
  expect(((await (await fetch(`${url}api/graph`)).json()) as AdrGraph).state).toBe("empty");
  await writeFile(join(root, "docs/adr/README.md"), "Unmanaged decisions\n");
  expect(((await (await fetch(`${url}api/graph`)).json()) as AdrGraph).state).toBe("unmanaged");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  await handler(`visualize --port ${port}`, ctx);
  const pinned = /http:\/\/\S+/.exec(String(messages.at(-1)?.content))?.[0] ?? "";
  expect(new URL(pinned).port).toBe(String(port));
  await expect(fetch(`${url}api/graph`)).rejects.toThrow();
  await handler("visualize", ctx);
  expect(messages.at(-1)?.content).toBe(`ADR visualization: ${pinned}`);
  await handler("visualize --host 0.0.0.0", ctx);
  const wildcard = String(messages.at(-1)?.content);
  expect(wildcard).toMatch(/^ADR visualization: http:\/\/127\.0\.0\.1:\d+\/\w+\/ \(listening on 0\.0\.0\.0:\d+\)$/);
  expect((await fetch(`${/http:\/\/\S+/.exec(wildcard)?.[0]}api/graph`)).status).toBe(200);
  await handler("visualize --port 70000", ctx);
  expect(messages.at(-1)).toMatchObject({ customType: "wows-omp-adr.notice" });
  expect(String(messages.at(-1)?.content)).toContain("--port must be an integer");
  await handler("visualize", { ...ctx, agent: { ...ctx.agent, kind: "sub" } });
  expect(messages.at(-1)?.customType).toBe("wows-omp-adr.notice");
  visualizer.sync({ ...ctx, cwd: otherRoot });
  await expect(fetch(`${url}api/graph`)).rejects.toThrow();
});
