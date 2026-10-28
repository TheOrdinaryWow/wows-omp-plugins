import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OUTCOME_SCHEMA_VERSION, SCHEMA_VERSION } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { readManifest } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/outcome.mjs";
import { deserializeState, serializeState } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/repair-tracker.mjs";
import { run } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function legacyRun(finished: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "research-v1-resume-"));
  roots.push(dir);
  const path = join(dir, "report.md");
  writeFileSync(path, "# Historical report\nThe archived finding cites its original source [S1].\n");
  const stamp = "2026-01-01T12:00:00.000Z";
  const manifest = {
    schemaVersion: 1,
    sessionDir: dir,
    startedAt: stamp,
    finishedAt: finished ? "2026-01-01T12:10:00.000Z" : null,
    elapsedMinutes: finished ? 10 : null,
    lane: "no-format",
    interview: { destination: "historical" },
    deliverables: [{ format: "md", status: "delivered", promised: true, updatedAt: stamp, path, optionalNote: "preserve" }],
    renders: [{ path: join(dir, "page.png"), page: 1 }],
    gates: { static: "pass", layout: "not_run", visual: "pass", proofread: "fail" },
    residualDefects: [{ code: "heading_too_long", message: "Retained old residual" }],
    repair: { attempts: 2, action: "deliver", reason: "plateau" },
    sources: { total: 3, domains: 2 },
    optionalMetadata: { preserve: ["history"] },
  };
  const file = join(dir, "outcome.json");
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(file, bytes);
  return { dir, file, path, bytes, manifest };
}

describe("research outcome v1 to v2 resume", () => {
  test("loads a previous-release file without rewriting or blessing its historical deliveries", async () => {
    const old = legacyRun(true);
    const upgraded = readManifest(old.file);
    expect(upgraded.schemaVersion).toBe(OUTCOME_SCHEMA_VERSION);
    expect(upgraded.legacyFidelity).toEqual({ upgradedFrom: 1, status: "legacy_unverified" });
    expect(upgraded.gates).toEqual({ ...old.manifest.gates, fidelity: "not_run" });
    expect(upgraded.deliverables).toEqual([{ ...old.manifest.deliverables[0], fidelityStatus: "legacy_unverified" }]);
    for (const key of [
      "startedAt",
      "finishedAt",
      "elapsedMinutes",
      "renders",
      "repair",
      "sources",
      "residualDefects",
      "optionalMetadata",
    ]) {
      expect(upgraded[key]).toEqual(old.manifest[key as keyof typeof old.manifest]);
    }
    const briefing = await run(["outcome", "briefing", "--session-dir", old.dir]);
    expect(briefing.exitCode).toBe(0);
    if (!("text" in briefing)) throw new Error("Expected a readable historical briefing");
    expect(briefing.text).toContain("legacy_unverified");
    expect(readFileSync(old.file, "utf8")).toBe(old.bytes);
    expect(upgraded.deliverables[0].status).toBe("delivered");
  });

  test("resumes an unfinished v1 run and atomically writes v2 on its next manifest mutation", async () => {
    const old = legacyRun(false);
    const result = await run(["outcome", "gate", "static", "pass", "--session-dir", old.dir]);
    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(old.file, "utf8"));
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.startedAt).toBe(old.manifest.startedAt);
    expect(persisted.finishedAt).toBeNull();
    expect(persisted.repair).toEqual(old.manifest.repair);
    expect(persisted.optionalMetadata).toEqual(old.manifest.optionalMetadata);
    expect(persisted.gateHistory).toContainEqual(expect.objectContaining({ gate: "static", status: "pass" }));
    expect(readManifest(old.file).deliverables[0].fidelityStatus).toBe("legacy_unverified");
    for (const command of ["verify", "finish"]) {
      const checked = await run(["outcome", command, "--session-dir", old.dir]);
      expect(checked.exitCode).toBe(1);
      if (!("json" in checked) || !checked.json || !("problems" in checked.json)) throw new Error("Expected delivery-barrier diagnostics");
      expect(checked.json.problems).toContainEqual(expect.objectContaining({ code: "edition_unverified", format: "md" }));
    }
    expect(JSON.parse(readFileSync(old.file, "utf8")).finishedAt).toBeNull();
  });

  test("a re-delivered historical format cannot inherit legacy provenance or bypass its new proof", async () => {
    const old = legacyRun(true);
    writeFileSync(old.path, "# Edited report\nThe new value is 999 [S1].\n");
    await run(["outcome", "set", "md", "delivered", "--path", old.path, "--session-dir", old.dir]);
    const manifest = readManifest(old.file);
    expect(manifest.deliverables[0].fidelityStatus).toBeUndefined();
    expect(manifest.legacyFidelity.status).toBe("legacy_unverified");
    await run(["outcome", "gate", "fidelity", "not_run", "--reason", "Legacy run", "--session-dir", old.dir]);
    expect((await run(["outcome", "verify", "--session-dir", old.dir])).exitCode).toBe(1);
    expect((await run(["outcome", "finish", "--session-dir", old.dir])).exitCode).toBe(1);
  });

  test("does not normalize a corrupt current-version manifest or an unknown future version", () => {
    const old = legacyRun(false);
    writeFileSync(old.file, JSON.stringify({ ...old.manifest, schemaVersion: 2 }));
    expect(() => readManifest(old.file)).toThrow("gates.fidelity");
    writeFileSync(old.file, JSON.stringify({ ...old.manifest, schemaVersion: 99 }));
    expect(() => readManifest(old.file)).toThrow("schemaVersion must be 2");
  });

  test("keeps previous repair-state v1 attempts, plateau history, signatures, and budget readable", () => {
    const old = legacyRun(false);
    const state = {
      schemaVersion: 1,
      startedAt: "2026-01-01T12:00:00.000Z",
      budget: { maxAttempts: 3, plateauLimit: 2, wallClockMs: 900000 },
      integrityCodes: [
        "broken_asset_reference",
        "missing_citation_section",
        "missing_closing_section",
        "missing_promised_deliverable",
        "missing_required_section",
      ],
      attempts: [{ at: "2026-01-01T12:01:00.000Z", measure: [0, 1, 0], signature: "heading_too_long", action: "repair" }],
      consecutiveNonProgress: 1,
      seenSignatures: ["heading_too_long"],
    };
    const file = join(old.dir, "repair-state.json");
    writeFileSync(file, JSON.stringify(state));
    const resumed = deserializeState(readFileSync(file, "utf8"));
    expect(JSON.parse(serializeState(resumed))).toEqual(state);
    expect(SCHEMA_VERSION).toBe(1);
    expect(OUTCOME_SCHEMA_VERSION).toBe(2);
  });
});
