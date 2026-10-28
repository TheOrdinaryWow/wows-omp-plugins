// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { expect, onTestFinished } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Of } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/cli-support.mjs";
import { DEFECT_CODES } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { writeFidelityRecord } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-records.mjs";
import { blocksDelivery } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-fidelity.mjs";
import { run } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";
export async function delivered(format = "html", codes = null) {
  const root = mkdtempSync(join(tmpdir(), "delivery-barrier-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "20260101-120000");
  mkdirSync(dir);
  const path = join(dir, `report.${format}`),
    record = join(dir, "fidelity-defects.json");
  writeFileSync(path, "<p>Report</p>");
  if (codes !== null)
    writeFidelityRecord(record, "fidelity", {
      artifact_sha256: sha256Of(readFileSync(path)),
      report: path,
      defects: codes.map((code) => ({ code, severity: "minor", message: code })),
    });
  const invoke = (args) => run(["outcome", ...args, "--session-dir", dir]);
  await invoke(["init", "--promised", format]);
  expect((await invoke(["set", format, "delivered", "--path", path, ...(codes === null ? [] : ["--verified-by", record])])).exitCode).toBe(
    0,
  );
  return { dir, path, record, invoke };
}
export const LOCKED_BRIEF = readFileSync(join(import.meta.dir, "fixtures", "fidelity-brief-locked.md"), "utf8"),
  BLOCKER = Object.keys(DEFECT_CODES).find((code) => blocksDelivery({ code })),
  meaningFile = (dir, format) => join(dir, `fidelity-meaning-defects.${format}.json`);
export async function fullyRecorded(brief = LOCKED_BRIEF) {
  const session = await delivered("html", []);
  writeFileSync(join(session.dir, "brief.md"), brief);
  const recordPath = { fidelity: session.record, meaning: meaningFile(session.dir, "html") },
    write = (kind, fields = {}) =>
      writeFidelityRecord(recordPath[kind], kind, {
        artifact_sha256: sha256Of(readFileSync(session.path)),
        report: session.path,
        defects: [],
        ...fields,
      });
  write("meaning");
  return {
    ...session,
    recordPath,
    write,
    outcomes: async () => Promise.all(["verify", "finish"].map((command) => session.invoke([command]))),
  };
}
export async function expectRefused(session, problem) {
  for (const result of await session.outcomes()) {
    expect(result.exitCode).toBe(1);
    expect(result.json.problems).toContainEqual(expect.objectContaining(problem));
  }
}
