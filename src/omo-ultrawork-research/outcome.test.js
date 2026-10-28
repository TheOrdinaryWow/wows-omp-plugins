// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DELIVERABLE_FORMATS,
  GATE_NAMES,
  validateOutcomeManifest,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import {
  addRender,
  briefingFacts,
  buildBriefing,
  deliverableState,
  initManifest,
  MANIFEST_FILENAME,
  OutcomeError,
  readManifest,
  setDeliverable,
  setGate,
  verifyManifest,
  writeManifest,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/outcome.mjs";

const STAMP = "20260101-120000",
  START_LOCAL = new Date(2026, 0, 1, 12, 0, 0);
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "ulw-outcome-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function sessionDir() {
  const dir = join(tempRoot(), STAMP);
  mkdirSync(dir);
  return dir;
}
function oneByteFile(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, "x");
  return file;
}
function codes(problems) {
  return problems.map((problem) => problem.code);
}
describe("initManifest", () => {
  test("#given promised pdf and docx #when initialised #then there is one pending row per format and the schema validates", () => {
    const dir = sessionDir(),
      manifest = initManifest({ sessionDir: dir, promised: ["pdf", "docx"], lane: "no-format" });
    expect(manifest.deliverables.map((row) => [row.format, row.status, row.promised])).toEqual([
      ["pdf", "pending", true],
      ["docx", "pending", true],
    ]);
    expect(manifest.startedAt).toBe(START_LOCAL.toISOString());
    expect(Object.keys(manifest.gates)).toEqual([...GATE_NAMES]);
    expect(Object.values(manifest.gates).every((status) => status === "not_run")).toBe(true);
    expect(validateOutcomeManifest(manifest)).toEqual({ ok: true, errors: [] });
  });
  test("#given a session dir without a YYYYMMDD-HHMMSS basename #when initialised #then it throws a typed error", () => {
    const dir = tempRoot();
    expect(() => initManifest({ sessionDir: dir, promised: ["pdf"], lane: null })).toThrow(OutcomeError);
  });
});
describe("setDeliverable and verifyManifest", () => {
  test("#given a fresh pdf+docx manifest #when verified #then both pending rows are missing_promised_deliverable", () => {
    const manifest = initManifest({ sessionDir: sessionDir(), promised: ["pdf", "docx"], lane: "no-format" }),
      result = verifyManifest(manifest);
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["missing_promised_deliverable", "missing_promised_deliverable"]);
  });
  test("#given pdf delivered as a 1-byte file and docx blocked with a reason #when verified #then it passes", () => {
    const dir = sessionDir(),
      initial = initManifest({ sessionDir: dir, promised: ["pdf", "docx"], lane: "no-format" }),
      afterPdf = setDeliverable(initial, "pdf", "delivered", { path: oneByteFile(dir, "report.pdf") }),
      afterDocx = setDeliverable(afterPdf, "docx", "blocked_capability", { reason: "no docx renderer" });
    expect(afterPdf.deliverables.find((row) => row.format === "docx")?.status).toBe("pending");
    expect(codes(verifyManifest(afterPdf).problems)).toEqual(["missing_promised_deliverable"]);
    expect(verifyManifest(afterDocx)).toEqual({ ok: true, problems: [] });
    expect(initial.deliverables.every((row) => row.status === "pending")).toBe(true);
  });
  test("#given a delivered row whose file is missing or empty #when verified #then each path is named in problems", () => {
    const dir = sessionDir(),
      missing = join(dir, "gone.pdf"),
      empty = join(dir, "empty.html");
    writeFileSync(empty, "");
    let manifest = initManifest({ sessionDir: dir, promised: ["pdf", "html"], lane: "no-format" });
    manifest = setDeliverable(manifest, "pdf", "delivered", { path: missing });
    manifest = setDeliverable(manifest, "html", "delivered", { path: empty });
    const result = verifyManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.path)).toEqual([missing, empty]);
  });
  test("#given a skipped row without a reason #when verified #then it is a problem", () => {
    const base = initManifest({ sessionDir: sessionDir(), promised: ["md"], lane: null }),
      result = verifyManifest(setDeliverable(base, "md", "skipped", {}));
    expect(codes(result.problems)).toEqual(["missing_promised_deliverable"]);
  });
  test("#given an unpromised format #when set #then a non-promised row is appended and the promised rows survive", () => {
    const dir = sessionDir(),
      base = initManifest({ sessionDir: dir, promised: ["pdf"], lane: null }),
      next = setDeliverable(base, "html", "delivered", { path: oneByteFile(dir, "r.html"), bytes: 1, pages: 1 });
    expect(next.deliverables.map((row) => [row.format, row.status, row.promised])).toEqual([
      ["pdf", "pending", true],
      ["html", "delivered", false],
    ]);
    expect(validateOutcomeManifest(next).ok).toBe(true);
  });
  test("#given an unknown format #when set #then it throws a typed error naming the allowed list", () => {
    const base = initManifest({ sessionDir: sessionDir(), promised: ["pdf"], lane: null });
    let caught;
    try {
      setDeliverable(base, "epub", "delivered", { path: "x" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OutcomeError);
    const error = caught;
    expect(error.code).toBe("unknown_format");
    expect(error.allowed).toEqual([...DELIVERABLE_FORMATS]);
    for (const format of DELIVERABLE_FORMATS) expect(error.message).toContain(format);
  });
});
describe("setGate and addRender", () => {
  test("#given a manifest #when a gate and renders are recorded #then they land without mutating the input", () => {
    const base = initManifest({ sessionDir: sessionDir(), promised: ["pdf"], lane: null }),
      gated = setGate(base, "static", "pass"),
      rendered = addRender(addRender(addRender(gated, "p1.png", 1), "p2.png", 2), "p1.png", 1);
    expect(base.gates.static).toBe("not_run");
    expect(rendered.gates.static).toBe("pass");
    expect(rendered.renders).toEqual([
      { path: "p1.png", page: 1 },
      { path: "p2.png", page: 2 },
    ]);
    expect(() => setGate(base, "spelling", "pass")).toThrow(OutcomeError);
    expect(() => setGate(base, "static", "ok")).toThrow(OutcomeError);
    expect(() => addRender(base, "p0.png", 0)).toThrow(OutcomeError);
  });
});
describe("deliverableState", () => {
  test("#given the draft marker, no marker, and a sibling manifest #when read #then state follows the file and the manifest", () => {
    const dir = sessionDir(),
      report = join(dir, "report.md");
    expect(deliverableState(report, null)).toBe("none");
    writeFileSync(report, "");
    expect(deliverableState(report, null)).toBe("none");
    writeFileSync(
      report,
      `# Report
STATUS: draft \u2014 3 sections open

body
`,
    );
    expect(deliverableState(report, null)).toBe("partial");
    writeFileSync(
      report,
      `# Report

body
`,
    );
    expect(deliverableState(report, null)).toBe("complete");
    const pending = initManifest({ sessionDir: dir, promised: ["md"], lane: null });
    writeManifest(join(dir, MANIFEST_FILENAME), pending);
    expect(deliverableState(report, null)).toBe("partial");
    const done = setDeliverable(pending, "md", "delivered", { path: report });
    expect(deliverableState(report, done)).toBe("complete");
    writeManifest(join(dir, MANIFEST_FILENAME), done);
    expect(deliverableState(report, null)).toBe("complete");
  });
});
describe("briefingFacts and buildBriefing", () => {
  test("#given 2 [S<n>] lines and 1 [Source 3] line on 2 hosts and now = start + 61 min #when briefed #then sources 3, domains 2, minutes 61", () => {
    const dir = sessionDir(),
      manifest = setDeliverable(initManifest({ sessionDir: dir, promised: ["pdf", "docx"], lane: "no-format" }), "docx", "skipped", {
        reason: "chat delivery",
      }),
      ledger = [
        "# Sources ledger",
        "[S1] https://alpha.example/one - primary",
        "[S2] https://www.beta.example/two",
        "[Source 3] https://alpha.example/three",
        "note: https://gamma.example/not-a-source",
        "",
      ].join(`
`),
      now = new Date(2026, 0, 1, 13, 1, 0),
      facts = briefingFacts(manifest, ledger, now),
      text = buildBriefing(manifest, ledger, now);
    expect(facts.sources).toBe(3);
    expect(facts.domains).toBe(2);
    expect(facts.minutes).toBe(61);
    expect(facts.deliverables).toEqual([
      { format: "pdf", status: "pending", reason: null, path: null },
      { format: "docx", status: "skipped", reason: "chat delivery", path: null },
    ]);
    expect(facts.gates).toEqual(manifest.gates);
    expect(facts.residualDefects).toBe(0);
    expect(facts.repair).toBeNull();
    expect(typeof text).toBe("string");
    for (const token of ["pdf", "docx", "chat delivery"]) expect(text).toContain(token);
  });
});
describe("readManifest and writeManifest", () => {
  test("#given an existing manifest file #when overwritten #then it round-trips and leaves no temp file", () => {
    const dir = sessionDir(),
      file = join(dir, MANIFEST_FILENAME),
      first = initManifest({ sessionDir: dir, promised: ["pdf"], lane: null });
    writeManifest(file, first);
    const second = setGate(first, "visual", "fail");
    writeManifest(file, second);
    expect(readManifest(file)).toEqual(second);
    expect(readdirSync(dir)).toEqual([MANIFEST_FILENAME]);
  });
  test("#given an invalid manifest #when written or read #then it throws a typed error and writes nothing", () => {
    const dir = sessionDir(),
      file = join(dir, MANIFEST_FILENAME);
    expect(() => writeManifest(file, { schemaVersion: 99 })).toThrow(OutcomeError);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "{not json");
    expect(() => readManifest(file)).toThrow(OutcomeError);
  });
  test("#given a manifest file written before the fidelity gate (four gates) #when read and written back #then it loads and the file gains fidelity not_run", () => {
    const dir = sessionDir(),
      file = join(dir, MANIFEST_FILENAME),
      old = {
        schemaVersion: 1,
        sessionDir: dir,
        startedAt: START_LOCAL.toISOString(),
        finishedAt: null,
        elapsedMinutes: null,
        lane: "no-format",
        interview: null,
        deliverables: [{ format: "pdf", status: "pending", promised: true, updatedAt: START_LOCAL.toISOString() }],
        renders: [],
        gates: { static: "pass", layout: "not_run", visual: "fail", proofread: "not_run" },
        residualDefects: [],
        repair: null,
        sources: null,
      };
    writeFileSync(file, JSON.stringify(old));
    const manifest = readManifest(file);
    writeManifest(file, manifest);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.gates).toEqual({ static: "pass", fidelity: "not_run", layout: "not_run", visual: "fail", proofread: "not_run" });
    expect(written.schemaVersion).toBe(2);
  });
});
describe("round trip in a stamped session dir", () => {
  test("#given session dir 20260101-120000 #when init, set, gate, render, verify, brief through the file #then verify passes and the briefing is computed", () => {
    const dir = sessionDir(),
      file = join(dir, MANIFEST_FILENAME);
    writeManifest(file, initManifest({ sessionDir: dir, promised: ["html", "post"], lane: "no-format" }));
    expect(verifyManifest(readManifest(file)).ok).toBe(false);
    let manifest = readManifest(file);
    manifest = setDeliverable(manifest, "html", "delivered", { path: oneByteFile(dir, "report.html"), bytes: 1 });
    manifest = setDeliverable(manifest, "post", "skipped", { reason: "chat delivery" });
    manifest = addRender(setGate(manifest, "static", "pass"), join(dir, "page-1.png"), 1);
    writeManifest(file, manifest);
    const reread = readManifest(file),
      ledger = join(dir, "sources-ledger.md");
    writeFileSync(
      ledger,
      `[S1] https://a.example/
`,
    );
    const facts = briefingFacts(reread, readFileSync(ledger, "utf8"), new Date(2026, 0, 1, 12, 30, 0));
    expect(verifyManifest(reread)).toEqual({ ok: true, problems: [] });
    expect(facts.sources).toBe(1);
    expect(facts.minutes).toBe(30);
    expect(facts.gates.static).toBe("pass");
    expect(deliverableState(join(dir, "report.html"), null)).toBe("complete");
  });
});
