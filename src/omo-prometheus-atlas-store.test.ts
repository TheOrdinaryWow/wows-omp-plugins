import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { type AtlasPlan, AtlasStore } from "../plugins/omo-prometheus/src/atlas-store.ts";
import {
  addFixRow,
  type ChildReceipt,
  type ExecutionLedger,
  ledgerRows,
  planDigest,
  reopenRow,
  startRow,
} from "../plugins/omo-prometheus/src/ledger.ts";

const content = `# Shared execution

## Tasks
- [ ] T1. Establish input
  - Agent: deep-low
  - Depends on: none
  - Acceptance: input is verified
- [ ] T2. Consume input
  - Agent: deep-low
  - Depends on: T1
  - Acceptance: dependent result is verified
- [ ] T3. Independent result
  - Agent: deep-low
  - Depends on: none
  - Acceptance: independent result is verified

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

interface Fixture {
  root: string;
  native: string;
  store: AtlasStore;
  plan: AtlasPlan;
}

async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "atlas-store-")));
  const native = path.join(root, "native-session-a");
  await fs.mkdir(native);
  await fs.writeFile(path.join(native, "PLAN.md"), content);
  const store = new AtlasStore(root);
  try {
    const plan = await store.create({
      name: "Shared plan",
      cwd: root,
      content,
      sourcePlanPath: "local://PLAN.md",
      sourceSessionId: "session-a",
      proposedByToolCallId: "native-proposal",
      availableAgents: ["deep-low", "task"],
    });
    await run({ root, native, store, plan });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function finish(
  fixture: Fixture,
  store: AtlasStore,
  sessionId: string,
  id: string,
  childAgentId = `Child${randomUUID().replaceAll("-", "")}`,
): Promise<ChildReceipt> {
  await store.transaction(fixture.plan.id, sessionId, (ledger) => startRow(ledger, id));
  return await store.transaction(fixture.plan.id, sessionId, async (ledger, plan) => {
    const row = ledgerRows(ledger).find((item) => item.id === id);
    if (!row?.attempt || row.startedAt === undefined) throw new Error("Missing started row");
    const output = id.startsWith("F")
      ? JSON.stringify({
          gateId: id,
          planSha256: ledger.planSha256,
          attempt: row.attempt,
          verdict: "PASS",
          summary: "Verified the acceptance criteria",
          evidence: ["Observed the real result"],
        })
      : `Verified ${id}: the actual result matches its acceptance criterion.`;
    const source = path.join(fixture.native, `${randomUUID()}.md`);
    await fs.mkdir(fixture.native, { recursive: true });
    await fs.writeFile(source, output);
    const receipt: ChildReceipt = {
      receiptId: randomUUID(),
      ledgerId: ledger.ledgerId,
      planSha256: ledger.planSha256,
      rowId: id,
      attempt: row.attempt,
      childAgentId,
      parentAgentId: "Main",
      sessionId,
      childCreatedAt: row.startedAt,
      outputSha256: planDigest(output),
      capturedAt: Date.now(),
      nativeFinal: true,
    };
    await store.saveReceipt(plan, receipt, source);
    row.status = "done";
    row.childAgentId = childAgentId;
    row.receipt = receipt;
    row.evidence = "The real result was verified";
    return receipt;
  });
}

const workerModule = fileURLToPath(new URL("../plugins/omo-prometheus/src/atlas-store.ts", import.meta.url));
function contender(root: string, planId: string, sessionId: string) {
  const code = `import { AtlasStore } from ${JSON.stringify(workerModule)};
    const store = new AtlasStore(${JSON.stringify(root)});
    try {
      await store.acquire(${JSON.stringify(planId)}, ${JSON.stringify(sessionId)});
      console.log(JSON.stringify({ acquired: true }));
      await new Promise(resolve => process.stdin.once('data', resolve));
      await store.release(${JSON.stringify(planId)}, ${JSON.stringify(sessionId)});
    } catch (error) { console.log(JSON.stringify({ acquired: false, error: String(error) })); }
  `;
  const child = Bun.spawn({ cmd: [process.execPath, "--eval", code], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    child,
    ready: async (): Promise<{ acquired: boolean; error?: string }> => {
      const reader = child.stdout.getReader();
      try {
        const decoder = new TextDecoder();
        let line = "";
        while (!line.includes("\n")) {
          const next = await reader.read();
          if (next.done) throw new Error(`Contender exited before reporting: ${await new Response(child.stderr).text()}`);
          line += decoder.decode(next.value, { stream: true });
        }
        return JSON.parse(line.split("\n")[0] as string);
      } finally {
        reader.releaseLock();
      }
    },
  };
}

describe("Atlas shared plan storage", () => {
  test("rename preserves approval and checkpoint proof and both names remain selectors", async () => {
    await fixture(async ({ store, plan }) => {
      const approvalBefore = await fs.readFile(path.join(plan.directory, "approval.json"));
      const checkpointBefore = await fs.readFile(path.join(plan.directory, "checkpoint.json"));
      await store.rename(plan.id, "New display");
      expect((await store.find("New display")).id).toBe(plan.id);
      expect((await store.find("New display-plan")).id).toBe(plan.id);
      expect((await store.find("Shared plan")).id).toBe(plan.id);
      expect((await store.find("Shared plan-plan")).id).toBe(plan.id);
      expect(await fs.readFile(path.join(plan.directory, "approval.json"))).toEqual(approvalBefore);
      expect(await fs.readFile(path.join(plan.directory, "checkpoint.json"))).toEqual(checkpointBefore);
      await store.acquire(plan.id, "session-a");
      expect(await store.transaction(plan.id, "session-a", (ledger) => ledger.items[0]?.status)).toBe("open");
      await store.release(plan.id, "session-a");
      await expect(store.rename(plan.id, " invalid ")).rejects.toThrow("Invalid Atlas plan name");
    });
  });

  test("delete refuses active or pending ownership then removes the entire released bundle", async () => {
    await fixture(async ({ root, store, plan }) => {
      await store.acquire(plan.id, "session-a");
      const other = new AtlasStore(root);
      await expect(other.delete(plan.id)).rejects.toThrow("live execution owner");
      await expect(store.delete(plan.id)).rejects.toThrow("holds Atlas plan ownership");
      expect((await store.list()).map((entry) => entry.id)).toContain(plan.id);
      await store.release(plan.id, "session-a");
      await expect(store.delete(plan.id, () => true)).rejects.toThrow("pending native");
      await fs.writeFile(path.join(plan.directory, "evidence", "sample.md"), "evidence");
      await store.delete(plan.id);
      expect(await store.list()).toEqual([]);
      await expect(fs.stat(plan.directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("list ignores deletion staging names while invalid plans remain discoverable", async () => {
    await fixture(async ({ root, store, plan }) => {
      await fs.mkdir(path.join(root, "atlas", `.deleting-${randomUUID()}`));
      await fs.writeFile(plan.ledgerPath, "{invalid");
      const [detail] = await store.details(root);
      expect(detail?.plan.id).toBe(plan.id);
      expect(detail?.status).toContain("Invalid:");
      expect(detail?.enterable).toBe(false);
      expect((await store.list()).map((entry) => entry.id)).toEqual([plan.id]);
    });
  });

  test("session B resumes copied receipts without source artifacts and only reopens unfinished attempts", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const receipt = await finish(f, f.store, "session-a", "T1");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T2"));
      await f.store.release(f.plan.id, "session-a");
      await fs.rm(f.native, { recursive: true });
      const b = new AtlasStore(f.root);
      const selected = await b.find("Shared plan");
      await b.acquire(selected.id, "session-b");
      const resumed = await b.transaction(selected.id, "session-b", (ledger) => ledger, { resume: true });
      expect(resumed.items[0]?.status).toBe("done");
      expect(resumed.items[0]?.receipt).toEqual(receipt);
      expect(resumed.items[0]?.receipt?.sessionId).toBe("session-a");
      expect(resumed.items[1]?.status).toBe("open");
      expect(resumed.items[1]?.attempt).toBeUndefined();
      const copied = await fs.readFile(path.join(selected.directory, "evidence", `${receipt.receiptId}.md`), "utf8");
      expect(planDigest(copied)).toBe(receipt.outputSha256);
      const next = await finish(f, b, "session-b", "T2");
      expect(next.sessionId).toBe("session-b");
      await b.release(selected.id, "session-b");
    });
  });

  test("missing copied output reopens only the row whose proof is gone, durably even when mutation is refused", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const source = await finish(f, f.store, "session-a", "T1");
      const dependent = await finish(f, f.store, "session-a", "T2");
      await finish(f, f.store, "session-a", "T3");
      const gate = await finish(f, f.store, "session-a", "F1");
      await fs.rm(path.join(f.plan.directory, "evidence", `${source.receiptId}.md`));
      await expect(
        f.store.transaction(f.plan.id, "session-a", () => {
          throw new Error("requested operation refused");
        }),
      ).rejects.toThrow("refused");
      const ledger: ExecutionLedger = JSON.parse(await fs.readFile(f.plan.ledgerPath, "utf8"));
      expect(ledger.items[0]?.status).toBe("open");
      expect(ledger.items[1]?.receipt).toEqual(dependent);
      expect(ledger.gates[0]?.receipt).toEqual(gate);
      const checkpoint = JSON.parse(await fs.readFile(path.join(f.plan.directory, "checkpoint.json"), "utf8"));
      expect(checkpoint.attempts.T1).toBeNull();
      expect(checkpoint.attempts.T2.receiptId).toBe(dependent.receiptId);
    });
  });

  test("a gate rejection persists its fix row and reruns only that gate, even after an interrupted write", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      for (const id of ["T1", "T2", "T3", "F1"]) await finish(f, f.store, "session-a", id);
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "F2"));
      const beforeFix = await fs.readFile(f.plan.ledgerPath, "utf8");
      const fix = {
        title: "Stabilize retention test",
        acceptance: "bun test passes twice",
        agent: "task",
        reason: "expected 8 keys, got 10",
      };
      await f.store.transaction(f.plan.id, "session-a", (ledger) => addFixRow(ledger, "F2", fix, ["deep-low", "task"]));
      // The checkpoint already names X1, but the ledger replacement that adds it was interrupted.
      await fs.writeFile(f.plan.ledgerPath, beforeFix);
      const interrupted = await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger);
      expect(interrupted.fixes).toEqual([]);
      expect(interrupted.gates[1]?.status).toBe("open");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => addFixRow(ledger, "F2", fix, ["deep-low", "task"]));
      await finish(f, f.store, "session-a", "X1");
      await finish(f, f.store, "session-a", "F2");
      const ledger = await f.store.transaction(f.plan.id, "session-a", (value) => value);
      expect(ledgerRows(ledger).map((row) => [row.id, row.status])).toEqual([
        ["T1", "done"],
        ["T2", "done"],
        ["T3", "done"],
        ["X1", "done"],
        ["F1", "done"],
        ["F2", "done"],
        ["F3", "open"],
        ["F4", "open"],
      ]);
      expect(ledger.gates[1]?.dependsOn).toEqual(["T1", "T2", "T3", "X1"]);
    });
  });

  test("a bundle written by the previous ledger version keeps its progress and continues after upgrade", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      for (const id of ["T1", "T3"]) await finish(f, f.store, "session-a", id);
      await f.store.release(f.plan.id, "session-a");
      const { fixes: _fixes, ...current } = JSON.parse(await fs.readFile(f.plan.ledgerPath, "utf8")) as ExecutionLedger;
      const f4 = current.gates[3];
      if (!f4) throw new Error("Missing F4");
      f4.dependsOn.push("F1", "F2", "F3");
      await fs.writeFile(f.plan.ledgerPath, JSON.stringify({ ...current, version: 2 }));
      const upgraded = new AtlasStore(f.root);
      expect((await upgraded.details(f.root)).find((detail) => detail.plan.id === f.plan.id)?.done).toBe(2);
      await upgraded.acquire(f.plan.id, "session-b");
      const resumed = await upgraded.transaction(f.plan.id, "session-b", (ledger) => ledger, { resume: true });
      expect(ledgerRows(resumed).map((row) => row.status)).toEqual(["done", "open", "done", "open", "open", "open", "open"]);
      await finish(f, upgraded, "session-b", "T2");
      await finish(f, upgraded, "session-b", "F4");
      const saved = JSON.parse(await fs.readFile(f.plan.ledgerPath, "utf8")) as ExecutionLedger;
      expect(saved.version).toBe(3);
      expect(saved.fixes).toEqual([]);
      expect(saved.gates[3]?.dependsOn).toEqual(["T1", "T2", "T3"]);
      expect(saved.items[0]?.receipt?.sessionId).toBe("session-a");
    });
  });

  test("checkpoint-leading interrupted writes cannot resurrect an old ledger receipt", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      await finish(f, f.store, "session-a", "T1");
      const completed = await fs.readFile(f.plan.ledgerPath, "utf8");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => reopenRow(ledger, "T1"));
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T1"));
      // A checkpoint write succeeded, but the following ledger replacement was interrupted.
      await fs.writeFile(f.plan.ledgerPath, completed);
      const restored = await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger);
      expect(restored.items[0]?.status).toBe("open");
      expect(restored.items[0]?.receipt).toBeUndefined();
      const old = JSON.parse(completed) as ExecutionLedger;
      const oldRow = old.items[0];
      if (!oldRow) throw new Error("Missing original row");
      await expect(
        f.store.transaction(f.plan.id, "session-a", (ledger) => {
          ledger.items[0] = oldRow;
        }),
      ).rejects.toThrow("unverified completion");
      expect(await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger.items[0]?.status)).toBe("open");
    });
  });

  test("receipt metadata cannot be replaced by an invented origin or a changed output", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const receipt = await finish(f, f.store, "session-a", "T1");
      const ledger = JSON.parse(await fs.readFile(f.plan.ledgerPath, "utf8")) as ExecutionLedger;
      const row = ledger.items[0];
      if (!row) throw new Error("Missing completed row");
      row.receipt = { ...receipt, sessionId: "invented-origin" };
      await fs.writeFile(f.plan.ledgerPath, JSON.stringify(ledger));
      expect(await f.store.transaction(f.plan.id, "session-a", (value) => value.items[0]?.status)).toBe("open");
      const replacement = await finish(f, f.store, "session-a", "T1");
      await fs.writeFile(path.join(f.plan.directory, "evidence", `${replacement.receiptId}.md`), "changed result");
      expect(await f.store.transaction(f.plan.id, "session-a", (value) => value.items[0]?.status)).toBe("open");
    });
  });

  test.each(["ledger.json", "checkpoint.json", "approval.json", "plan.md"])(
    "missing or corrupt %s pauses without recreation",
    async (file) => {
      await fixture(async (f) => {
        await f.store.acquire(f.plan.id, "session-a");
        const target = path.join(f.plan.directory, file);
        const original = await fs.readFile(target);
        for (const kind of ["missing", "corrupt"] as const) {
          if (kind === "missing") await fs.rm(target);
          else await fs.writeFile(target, "{invalid");
          await expect(f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T1"))).rejects.toThrow();
          if (kind === "missing") await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
          else expect(await fs.readFile(target, "utf8")).toBe("{invalid");
          await fs.writeFile(target, original);
        }
        expect(await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger.items[0]?.status)).toBe("open");
      });
    },
  );

  test("an altered but well-shaped approval cannot change native provenance", async () => {
    await fixture(async (f) => {
      const file = path.join(f.plan.directory, "approval.json");
      const approval = JSON.parse(await fs.readFile(file, "utf8"));
      approval.proposedByToolCallId = "different-proposal";
      await fs.writeFile(file, JSON.stringify(approval));
      await expect(f.store.acquire(f.plan.id, "session-a")).rejects.toThrow("checkpoint");
    });
  });

  test("duplicate names require explicit ids and listing never acquires ownership", async () => {
    await fixture(async (f) => {
      const second = await f.store.create({
        name: f.plan.name,
        cwd: f.root,
        content,
        sourcePlanPath: "local://other.md",
        sourceSessionId: "session-a",
        proposedByToolCallId: "other-proposal",
        availableAgents: ["deep-low", "task"],
      });
      const listed = await f.store.list();
      expect(listed.map((plan) => plan.id).sort()).toEqual([f.plan.id, second.id].sort());
      await expect(f.store.find(f.plan.name)).rejects.toThrow(f.plan.id);
      await expect(f.store.find(f.plan.name)).rejects.toThrow(second.id);
      expect((await f.store.find(second.id)).sourcePlanPath).toBe("local://other.md");
      const b = new AtlasStore(f.root);
      await b.acquire(f.plan.id, "session-b");
      await f.store.acquire(second.id, "session-a");
      await b.release(f.plan.id, "session-b");
      await f.store.release(second.id, "session-a");
    });
  });

  test("traversal and symlink-backed shared artifacts are refused", async () => {
    await fixture(async (f) => {
      await expect(f.store.find("../Shared plan")).rejects.toThrow("selector");
      await expect(f.store.acquire("../outside", "session-a")).rejects.toThrow("id");
      await expect(
        f.store.create({
          name: "../outside",
          cwd: f.root,
          content,
          sourcePlanPath: "local://PLAN.md",
          sourceSessionId: "session-a",
          proposedByToolCallId: "proposal",
        }),
      ).rejects.toThrow("name");
      await fs.rm(f.plan.planFilePath);
      await fs.symlink(path.join(f.native, "PLAN.md"), f.plan.planFilePath);
      await expect(f.store.find(f.plan.id)).rejects.toThrow();
      await fs.rm(f.plan.planFilePath);
      await fs.writeFile(f.plan.planFilePath, content);
      const alias = path.join(f.root, "alias");
      await fs.symlink(f.root, alias);
      await expect(new AtlasStore(alias).list()).rejects.toThrow("symlink");
    });
  });

  test("only the owning store/session can release, even if the approval is damaged", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      await f.store.acquire(f.plan.id, "session-a");
      const b = new AtlasStore(f.root);
      await expect(b.acquire(f.plan.id, "session-a")).rejects.toThrow("live execution owner");
      await expect(b.release(f.plan.id, "session-a")).rejects.toThrow("does not own");
      await expect(f.store.release(f.plan.id, "session-b")).rejects.toThrow("does not own");
      const approval = path.join(f.plan.directory, "approval.json");
      const saved = await fs.readFile(approval);
      await fs.rm(approval);
      await f.store.release(f.plan.id, "session-a");
      await fs.writeFile(approval, saved);
      await b.acquire(f.plan.id, "session-b");
      await expect(f.store.release(f.plan.id, "session-a")).rejects.toThrow("does not own");
      await b.transaction(f.plan.id, "session-b", (ledger) => startRow(ledger, "T1"));
      await b.release(f.plan.id, "session-b");
    });
  });

  test("foreign or malformed process ownership is never reclaimed", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const claimPath = path.join(f.plan.directory, "ownership", "0.json");
      const claim = JSON.parse(await fs.readFile(claimPath, "utf8"));
      const b = new AtlasStore(f.root);
      await fs.writeFile(claimPath, JSON.stringify({ ...claim, host: "a-foreign-host" }));
      await expect(b.acquire(f.plan.id, "session-b")).rejects.toThrow("different host");
      await fs.writeFile(claimPath, JSON.stringify({ ...claim, pid: "unknown" }));
      await expect(b.acquire(f.plan.id, "session-b")).rejects.toThrow("Malformed");
    });
  });

  test("real processes contend exclusively and dead-owner recovery has only one winner", async () => {
    await fixture(async (f) => {
      const first = contender(f.root, f.plan.id, "process-a");
      const second = contender(f.root, f.plan.id, "process-b");
      const children = [first, second];
      try {
        const outcomes = await Promise.all(children.map((candidate) => candidate.ready()));
        expect(outcomes.filter((result) => result.acquired).length).toBe(1);
        const winner = outcomes[0]?.acquired ? first : second;
        await expect(f.store.acquire(f.plan.id, "session-a")).rejects.toThrow("live execution owner");
        winner.child.kill("SIGKILL");
        await winner.child.exited;
        const recoveryA = contender(f.root, f.plan.id, "recovery-a");
        const recoveryB = contender(f.root, f.plan.id, "recovery-b");
        children.push(recoveryA, recoveryB);
        const recovered = await Promise.all([recoveryA.ready(), recoveryB.ready()]);
        expect(recovered.filter((result) => result.acquired).length).toBe(1);
        const successor = recovered[0]?.acquired ? recoveryA : recoveryB;
        successor.child.stdin.write("release\n");
        successor.child.stdin.end();
        expect(await successor.child.exited).toBe(0);
        await f.store.acquire(f.plan.id, "session-a");
        await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T1"));
        await f.store.release(f.plan.id, "session-a");
      } finally {
        for (const candidate of children) candidate.child.kill("SIGKILL");
        await Promise.all(children.map((candidate) => candidate.child.exited));
      }
    });
  }, 20_000);

  test("serialized transactions preserve independent concurrent updates", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const [first, third] = await Promise.all([finish(f, f.store, "session-a", "T1"), finish(f, f.store, "session-a", "T3")]);
      const ledger = await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger);
      expect(ledger.items[0]?.receipt).toEqual(first);
      expect(ledger.items[2]?.receipt).toEqual(third);
      expect(ledger.items[1]?.status).toBe("open");
    });
  });

  test("fresh gate identity includes origin session and archived invalidated receipts", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      for (const row of ["T1", "T2", "T3"]) await finish(f, f.store, "session-a", row);
      await finish(f, f.store, "session-a", "F1", "RepeatedName");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => reopenRow(ledger, "F1"));
      await expect(finish(f, f.store, "session-a", "F1", "RepeatedName")).rejects.toThrow("fresh native child");
      await f.store.release(f.plan.id, "session-a");
      const b = new AtlasStore(f.root);
      await b.acquire(f.plan.id, "session-b");
      await b.transaction(f.plan.id, "session-b", () => undefined, { resume: true });
      const receipt = await finish(f, b, "session-b", "F1", "RepeatedName");
      expect(receipt.sessionId).toBe("session-b");
      await expect(finish(f, b, "session-b", "F2", "RepeatedName")).rejects.toThrow("fresh native child");
    });
  });
  test("a failing ledger rename leaves the new checkpoint authoritative", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      await finish(f, f.store, "session-a", "T1");
      const previous = `${f.plan.ledgerPath}.previous`;
      await expect(
        f.store.transaction(f.plan.id, "session-a", async (ledger) => {
          reopenRow(ledger, "T1");
          await fs.rename(f.plan.ledgerPath, previous);
          await fs.mkdir(f.plan.ledgerPath);
        }),
      ).rejects.toThrow();
      const checkpoint = JSON.parse(await fs.readFile(path.join(f.plan.directory, "checkpoint.json"), "utf8"));
      expect(checkpoint.attempts.T1).toBeNull();
      await fs.rm(f.plan.ledgerPath, { recursive: true });
      await fs.rename(previous, f.plan.ledgerPath);
      const resumed = await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger);
      expect(resumed.items[0]?.status).toBe("open");
      expect(resumed.items[0]?.receipt).toBeUndefined();
      expect((await fs.readdir(f.plan.directory)).some((entry) => entry.startsWith("ledger.json.") && entry.endsWith(".tmp"))).toBe(false);
    });
  });

  test("exit before the publication guard refuses mutations while retaining recovery invalidation", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const receipt = await finish(f, f.store, "session-a", "T1");
      await fs.rm(path.join(f.plan.directory, "evidence", `${receipt.receiptId}.md`));
      let active = true;
      const assertActive = () => {
        if (!active) throw new Error("Atlas exited");
      };
      await expect(
        f.store.transaction(
          f.plan.id,
          "session-a",
          (ledger) => {
            startRow(ledger, "T3");
            active = false;
          },
          { assertActive },
        ),
      ).rejects.toThrow("Atlas exited");
      const ledger = await f.store.transaction(f.plan.id, "session-a", (value) => value);
      expect(ledger.items[0]?.status).toBe("open");
      expect(ledger.items[2]?.status).toBe("open");
      expect(ledger.items[2]?.attempt).toBeUndefined();
    });
  });

  test("session B completes the last gate while copied gate receipts keep their original identities", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      for (const id of ["T1", "T2", "T3", "F1", "F2", "F3"]) await finish(f, f.store, "session-a", id);
      const before = await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger);
      await f.store.release(f.plan.id, "session-a");
      await fs.rm(f.native, { recursive: true });
      const b = new AtlasStore(f.root);
      await b.acquire(f.plan.id, "session-b");
      await b.transaction(f.plan.id, "session-b", () => undefined, { resume: true });
      const synthesis = await finish(f, b, "session-b", "F4");
      const after = await b.transaction(f.plan.id, "session-b", (ledger) => ledger);
      expect(after.gates.slice(0, 3)).toEqual(before.gates.slice(0, 3));
      expect(after.gates.every((row) => row.status === "done")).toBe(true);
      expect(synthesis.sessionId).toBe("session-b");
    });
  });

  test("unpublished partial plans and claim staging files never become executable state", async () => {
    await fixture(async (f) => {
      const pending = path.join(f.root, "atlas", ".pending-interrupted");
      await fs.mkdir(pending);
      await fs.writeFile(path.join(pending, "approval.json"), "{partial");
      await fs.writeFile(path.join(f.plan.directory, "ownership", "0.json.interrupted.tmp"), "{partial");
      expect((await f.store.list()).map((plan) => plan.id)).toEqual([f.plan.id]);
      await f.store.acquire(f.plan.id, "session-a");
      expect(await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger.items[0]?.status)).toBe("open");
      await f.store.release(f.plan.id, "session-a");
      await fs.writeFile(path.join(f.plan.directory, "ownership", "1.json"), "{partial");
      await expect(new AtlasStore(f.root).acquire(f.plan.id, "session-b")).rejects.toThrow();
    });
  });
  test("receipt capture requires an owned transaction, a regular matching output, and exact origin", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const ledger = await f.store.transaction(f.plan.id, "session-a", (value) => {
        startRow(value, "T1");
        return value;
      });
      const row = ledger.items[0];
      if (!row?.attempt || row.startedAt === undefined) throw new Error("Missing started row");
      const output = "Authenticated native output";
      const file = path.join(f.native, "captured.md");
      const link = path.join(f.native, "linked.md");
      await fs.writeFile(file, output);
      await fs.symlink(file, link);
      const receipt: ChildReceipt = {
        receiptId: randomUUID(),
        ledgerId: ledger.ledgerId,
        planSha256: ledger.planSha256,
        rowId: row.id,
        attempt: row.attempt,
        childAgentId: "Captured",
        parentAgentId: "Main",
        sessionId: "session-a",
        childCreatedAt: row.startedAt,
        capturedAt: Date.now(),
        outputSha256: planDigest(output),
        nativeFinal: true,
      };
      await expect(f.store.saveReceipt(f.plan, receipt, file)).rejects.toThrow("inside");
      await expect(
        f.store.transaction(f.plan.id, "session-a", async (_, plan) => {
          await f.store.saveReceipt(plan, { ...receipt, sessionId: "session-b" }, file);
        }),
      ).rejects.toThrow("assignment");
      await expect(
        f.store.transaction(f.plan.id, "session-a", async (_, plan) => {
          await f.store.saveReceipt(plan, receipt, link);
        }),
      ).rejects.toThrow();
      await fs.writeFile(file, "changed after capture");
      await expect(
        f.store.transaction(f.plan.id, "session-a", async (_, plan) => {
          await f.store.saveReceipt(plan, receipt, file);
        }),
      ).rejects.toThrow("digest");
      expect(await fs.readdir(path.join(f.plan.directory, "evidence"))).toEqual([]);
    });
  });

  test("copied gate proof must satisfy the existing strict verdict and attempt binding", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      for (const id of ["T1", "T2", "T3"]) await finish(f, f.store, "session-a", id);
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "F1"));
      await expect(
        f.store.transaction(f.plan.id, "session-a", async (ledger, plan) => {
          const row = ledger.gates[0];
          if (!row?.attempt || row.startedAt === undefined) throw new Error("Missing gate attempt");
          const output = JSON.stringify({
            gateId: "F1",
            planSha256: ledger.planSha256,
            attempt: row.attempt,
            verdict: "FAIL",
            summary: "A real blocker remains",
            evidence: ["Observed the failing result"],
            reviewedGates: {},
          });
          const file = path.join(f.native, "failed-gate.md");
          await fs.writeFile(file, output);
          const receipt: ChildReceipt = {
            receiptId: randomUUID(),
            ledgerId: ledger.ledgerId,
            planSha256: ledger.planSha256,
            rowId: "F1",
            attempt: row.attempt,
            childAgentId: "FailedGate",
            parentAgentId: "Main",
            sessionId: "session-a",
            childCreatedAt: row.startedAt,
            capturedAt: Date.now(),
            outputSha256: planDigest(output),
            nativeFinal: true,
          };
          await f.store.saveReceipt(plan, receipt, file);
        }),
      ).rejects.toThrow("did not pass");
      expect(await f.store.transaction(f.plan.id, "session-a", (ledger) => ledger.gates[0]?.status)).toBe("in_progress");
    });
  });

  test("published transitions append an ordered timeline without recording refused mutations", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const attempt = await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T3").attempt);
      await expect(
        f.store.transaction(f.plan.id, "session-a", (ledger) => {
          reopenRow(ledger, "T3", "not published");
          throw new Error("refused");
        }),
      ).rejects.toThrow("refused");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => {
        const row = ledger.items[2];
        if (!row) throw new Error("Missing T3");
        row.status = "blocked";
        row.evidence = "Input unavailable";
        row.updatedAt += 1;
      });
      await f.store.transaction(f.plan.id, "session-a", (ledger) => reopenRow(ledger, "T3", "Input restored"));
      for (const id of ["T1", "T2", "T3"]) await finish(f, f.store, "session-a", id);
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "F2"));
      await f.store.transaction(f.plan.id, "session-a", (ledger) =>
        addFixRow(
          ledger,
          "F2",
          {
            title: "Repair observed defect",
            acceptance: "The original reproduction succeeds",
            agent: "deep-low",
            reason: "the real output is incorrect",
          },
          ["deep-low", "task"],
        ),
      );
      await finish(f, f.store, "session-a", "X1");
      await finish(f, f.store, "session-a", "F2");
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "F3"));
      await f.store.transaction(f.plan.id, "session-a", (ledger) => reopenRow(ledger, "F3", "Review rejected the real surface"));
      await f.store.release(f.plan.id, "session-a");
      const timeline = (await f.store.details(f.root))[0]?.timeline;
      expect(timeline?.filter((event) => event.row === "T3").map((event) => [event.kind, event.attempt])).toEqual([
        ["started", attempt],
        ["blocked", attempt],
        ["reopened", attempt],
        ["started", timeline?.find((event) => event.kind === "done" && event.row === "T3")?.attempt],
        ["done", timeline?.find((event) => event.kind === "done" && event.row === "T3")?.attempt],
      ]);
      expect(
        timeline
          ?.filter((event) => ["fix_added", "gate_failed", "gate_passed"].includes(event.kind))
          .map((event) => [event.kind, event.row]),
      ).toEqual([
        ["fix_added", "X1"],
        ["gate_failed", "F2"],
        ["gate_passed", "F2"],
        ["gate_failed", "F3"],
      ]);
      expect(timeline?.find((event) => event.kind === "fix_added")?.detail).toBe("F2 rejected: the real output is incorrect");
      expect(timeline?.[0]?.kind).toBe("attached");
      expect(timeline?.at(-1)?.kind).toBe("released");
      expect(timeline?.some((event) => event.detail === "not published")).toBe(false);
      expect(timeline?.every((event) => event.sessionId === "session-a" && !event.derived)).toBe(true);
    });
  });

  test("a previous-format bundle without a timeline resumes with derived history and then appends real events", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const receipt = await finish(f, f.store, "session-a", "T1");
      await f.store.release(f.plan.id, "session-a");
      const file = path.join(f.plan.directory, "timeline.jsonl");
      await fs.rm(file);
      const upgraded = new AtlasStore(f.root);
      const before = (await upgraded.details(f.root))[0];
      expect(before?.timeline.map((event) => [event.kind, event.row, event.derived])).toEqual([
        ["started", "T1", true],
        ["done", "T1", true],
      ]);
      expect(before?.timeline[1]?.at).toBe(receipt.capturedAt);
      await expect(fs.stat(file)).rejects.toHaveProperty("code", "ENOENT");
      await upgraded.acquire(f.plan.id, "session-b");
      await upgraded.transaction(
        f.plan.id,
        "session-b",
        (ledger) => {
          expect(ledger.items[0]?.receipt?.receiptId).toBe(receipt.receiptId);
          startRow(ledger, "T2");
        },
        { resume: true },
      );
      expect((await upgraded.details(f.root))[0]?.timeline.map((event) => [event.kind, event.row, event.sessionId, event.derived])).toEqual(
        [
          ["started", "T1", "session-a", true],
          ["done", "T1", "session-a", true],
          ["attached", undefined, "session-b", undefined],
          ["started", "T2", "session-b", undefined],
        ],
      );
    });
  });

  test("a partial trailing line and future event versions never block resume or later appends", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const file = path.join(f.plan.directory, "timeline.jsonl");
      await fs.appendFile(file, `${JSON.stringify({ version: 2, at: 1, kind: "future", sessionId: "session-a" })}\n{"version":1,`);
      expect((await f.store.details(f.root))[0]?.enterable).toBe(false);
      await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T1"));
      expect((await f.store.details(f.root))[0]?.timeline.map((event) => event.kind)).toEqual(["attached", "started"]);
      await f.store.release(f.plan.id, "session-a");
      const resumed = new AtlasStore(f.root);
      await resumed.acquire(f.plan.id, "session-b");
      await resumed.transaction(
        f.plan.id,
        "session-b",
        (ledger) => {
          expect(ledger.items[0]?.status).toBe("open");
        },
        { resume: true },
      );
    });
  });

  test("timeline append failure does not roll back a ledger commit or ownership release", async () => {
    await fixture(async (f) => {
      await f.store.acquire(f.plan.id, "session-a");
      const file = path.join(f.plan.directory, "timeline.jsonl");
      await fs.rm(file);
      await fs.mkdir(file);
      const attempt = await f.store.transaction(f.plan.id, "session-a", (ledger) => startRow(ledger, "T1").attempt);
      expect(JSON.parse(await fs.readFile(f.plan.ledgerPath, "utf8")).items[0].attempt).toBe(attempt);
      await f.store.release(f.plan.id, "session-a");
      await new AtlasStore(f.root).acquire(f.plan.id, "session-b");
    });
  });
});
