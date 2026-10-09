import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { allocate, type IdKind, withRepoLock } from "../plugins/roadmap/src/numbering.ts";
import { cleanupFixtures, diskFixture } from "./roadmap-fixtures.ts";

afterEach(cleanupFixtures);

test("two separate Bun processes allocate unique ids under one repository lock", async () => {
  const { repo } = await diskFixture();
  const worker = new URL("./roadmap-numbering-worker.ts", import.meta.url).pathname;
  const children = [
    Bun.spawn([process.execPath, worker, repo.commonDir], { stdout: "pipe", stderr: "pipe" }),
    Bun.spawn([process.execPath, worker, repo.commonDir], { stdout: "pipe", stderr: "pipe" }),
  ];
  const results = await Promise.all(
    children.map(async (child) => {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return JSON.parse(stdout) as { ids: number[] };
    }),
  );
  const ids = results.flatMap((result) => result.ids).sort((a, b) => a - b);
  expect(new Set(ids).size).toBe(20);
  expect(ids).toEqual(Array.from({ length: 20 }, (_, index) => index + 41));
  expect(JSON.parse(await readFile(join(repo.commonDir, "roadmap/counters.json"), "utf8"))).toEqual({
    v: 1,
    round: 0,
    stage: 60,
    todo: 0,
    adr: 0,
  });
}, 20_000);

test("each counter is independent, honours disk maxima, never reuses reserved numbers and keeps the adr value untouched", async () => {
  const { repo } = await diskFixture();
  // Roadmap stopped allocating ADR ids; the key stays for older releases and the adr plugin's legacy seeding.
  await mkdir(join(repo.commonDir, "roadmap"), { recursive: true });
  await writeFile(join(repo.commonDir, "roadmap/counters.json"), `${JSON.stringify({ v: 1, round: 0, stage: 0, todo: 0, adr: 7 })}\n`);
  for (const kind of ["round", "stage", "todo"] as const) {
    expect(await withRepoLock(repo, () => allocate(repo, kind, 12))).toBe(13);
    expect(await withRepoLock(repo, () => allocate(repo, kind, 4))).toBe(14);
    expect(await withRepoLock(repo, () => allocate(repo, kind, 21))).toBe(22);
    expect(await withRepoLock(repo, () => allocate(repo, kind, 0))).toBe(23);
  }
  await expect(withRepoLock(repo, () => allocate(repo, "adr" as IdKind, 0))).rejects.toThrow("Unknown");
  expect(JSON.parse(await readFile(join(repo.commonDir, "roadmap/counters.json"), "utf8"))).toEqual({
    v: 1,
    round: 23,
    stage: 23,
    todo: 23,
    adr: 7,
  });
});

test("linked worktree callers share the common-directory counters", async () => {
  const { repo } = await diskFixture();
  const worktree = { ...repo, repoRoot: `${repo.repoRoot}-worktree`, roadmapDir: `${repo.repoRoot}-worktree/docs/roadmap` };
  expect(await withRepoLock(repo, () => allocate(repo, "todo", 0))).toBe(1);
  expect(await withRepoLock(worktree, () => allocate(worktree, "todo", 0))).toBe(2);
});

test("allocate does not nest the caller's lock and the lock releases on an exception", async () => {
  const { repo } = await diskFixture();
  await expect(
    withRepoLock(repo, async () => {
      expect(await allocate(repo, "todo", 0)).toBe(1);
      throw new Error("operation failed after allocation");
    }),
  ).rejects.toThrow("operation failed");
  expect(await withRepoLock(repo, () => allocate(repo, "todo", 0))).toBe(2);
});

test("invalid or unsupported counters pause instead of resetting and preserve bytes", async () => {
  const { repo } = await diskFixture();
  const directory = join(repo.commonDir, "roadmap");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "counters.json");
  for (const raw of [
    "{",
    "null",
    JSON.stringify({ v: 2, round: 0, stage: 0, todo: 0, adr: 0 }),
    JSON.stringify({ v: 1, round: 0, stage: -1, todo: 0, adr: 0 }),
    JSON.stringify({ v: 1, round: 0, todo: 0, adr: 0 }),
  ]) {
    await writeFile(file, raw);
    await expect(withRepoLock(repo, () => allocate(repo, "stage", 0))).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(raw);
  }
});

test("invalid disk maxima, unknown kind and counter overflow cannot persist an allocation", async () => {
  const { repo } = await diskFixture();
  for (const highest of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    await expect(withRepoLock(repo, () => allocate(repo, "stage", highest))).rejects.toThrow();
  }
  await expect(withRepoLock(repo, () => allocate(repo, "unknown" as IdKind, 0))).rejects.toThrow("Unknown");
  expect(await withRepoLock(repo, () => allocate(repo, "stage", 0))).toBe(1);
});
