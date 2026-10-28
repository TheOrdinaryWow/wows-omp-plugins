import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendGoal, createLoop, event, type LoopState } from "../plugins/omo-ultrawork/src/ulw-loop-state.ts";
import { LoopStore } from "../plugins/omo-ultrawork/src/ulw-loop-store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ulw-loop-store-"));
  roots.push(root);
  const store = new LoopStore(join(root, "sessions"), "v1-session", join(root, "project"));
  const value = createLoop(store.sessionId, store.cwd, "Preserve upload bytes across restart");
  value.status = "active";
  value.driver.goalId = "native-v1";
  appendGoal(value, {
    title: "Restart",
    objective: "Resume byte-identical upload",
    shape: "delivery",
    tier: "HEAVY",
    criteria: [{ scenario: "Restart before commit", expectedEvidence: "CLI transcript and byte hash match" }],
  });
  event(value, "goals_created");
  return { root, store, value };
}

describe("ulw-loop durable store", () => {
  test("a shipped v1 store resumes without reapproval or byte rewriting", async () => {
    const { store, value } = await fixture();
    await mkdir(store.root, { recursive: true });
    const previousFormatBytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(store.file, previousFormatBytes);
    const resumed = new LoopStore(join(store.root, "..", ".."), store.sessionId, store.cwd);
    expect(await resumed.load()).toEqual(value);
    expect(await readFile(store.file, "utf8")).toBe(previousFormatBytes);
    await resumed.update((state) => {
      if (!state) throw new Error("missing v1 state");
      event(state, "resumed_v1", { retainedGoal: state.goals[0]?.id });
      return { state, result: undefined };
    });
    expect(await resumed.load()).toMatchObject({
      version: 1,
      runId: value.runId,
      revision: 2,
      driver: { goalId: "native-v1" },
      goals: [{ id: "G001", tier: "HEAVY" }],
    });
  });

  test("mutation rollback, corrupt/unknown/missing-state refusal and explicit archive preserve proof", async () => {
    const { store, value } = await fixture();
    await store.update(() => ({ state: value, result: undefined }));
    const original = await readFile(store.file, "utf8");
    await expect(
      store.update((state) => {
        if (!state) throw new Error("missing");
        state.objective = "Not published";
        event(state, "bad_change");
        throw new Error("rejected transition");
      }),
    ).rejects.toThrow("rejected transition");
    expect(await readFile(store.file, "utf8")).toBe(original);
    await writeFile(store.file, "{corrupt");
    await expect(store.load()).rejects.toThrow("paused");
    await writeFile(store.file, JSON.stringify({ ...value, version: 2 }));
    await expect(store.load()).rejects.toThrow("version");
    await writeFile(store.file, original);
    const archived = await store.archive();
    expect(archived).toBeString();
    expect(JSON.parse(await readFile(join(archived as string, "state.json"), "utf8"))).toMatchObject({ runId: value.runId });
    expect(await store.load()).toBeUndefined();
    await store.update(() => ({ state: value, result: undefined }));
    await rm(store.file);
    await expect(store.load()).rejects.toThrow("lost");
    await expect(store.update(() => ({ state: value, result: undefined }))).rejects.toThrow("lost");
  });

  test("in-memory session root never writes into the project, and session ids isolate stores", async () => {
    expect(() => new LoopStore("", "no-session", process.cwd())).toThrow("persisted session");
    const { root, store, value } = await fixture();
    await store.update(() => ({ state: value, result: undefined }));
    const other = new LoopStore(join(root, "sessions"), "second-session", store.cwd);
    expect(await other.load()).toBeUndefined();
    const otherValue = createLoop(other.sessionId, other.cwd, "Independent objective");
    await other.update(() => ({ state: otherValue, result: undefined }));
    expect((await store.load())?.runId).toBe(value.runId);
    expect((await other.load())?.runId).not.toBe(value.runId);
  });

  test("same-process and cross-process updates serialize the full transaction", async () => {
    const { root, store, value } = await fixture();
    await store.update(() => ({ state: value, result: undefined }));
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.update(async (state) => {
          if (!state) throw new Error("missing");
          await readFile(store.file);
          event(state, "in_process", { index });
          return { state, result: undefined };
        }),
      ),
    );
    const modulePath = new URL("../plugins/omo-ultrawork/src/ulw-loop-store.ts", import.meta.url).pathname;
    const statePath = new URL("../plugins/omo-ultrawork/src/ulw-loop-state.ts", import.meta.url).pathname;
    const code = `import {LoopStore} from ${JSON.stringify(modulePath)}; import {event} from ${JSON.stringify(statePath)}; const store = new LoopStore(${JSON.stringify(join(root, "sessions"))}, "v1-session", ${JSON.stringify(store.cwd)}); await store.update(async state => { if (!state) throw Error('missing'); await Bun.file(store.file).text(); event(state,'cross_process'); return {state,result:null}; });`;
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" }));
    for (const child of children) {
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
    }
    const saved = (await store.load()) as LoopState;
    expect(saved.events.filter((item) => item.kind === "in_process")).toHaveLength(5);
    expect(saved.events.filter((item) => item.kind === "cross_process")).toHaveLength(3);
    expect(saved.revision).toBe(9);
  });
});
