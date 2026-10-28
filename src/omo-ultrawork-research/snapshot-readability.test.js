// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, onTestFinished, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Of } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/cli-support.mjs";
import { DEFECT_CODES } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { runFactVerify } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-verify.mjs";
import { unreadableSnapshots } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-snapshot-readability.mjs";
import { valueChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity"),
  BASE = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8")),
  check = (html, ledger = BASE, sources = join(FIX, "sources")) =>
    valueChecks(buildContext(parseHtml(`<h2>Findings</h2>${html}`), { baseDir: FIX }), ledger, null, sources),
  data = (id, shown) => `<p><data data-fact="${id}">${shown}</data></p>`,
  verified = '<p>The suite reported <data data-fact="F7" data-claim-kind="verified">42 passed</data> [S5].</p>',
  blocked = (defects) => defects.filter((d) => d.code === "snapshot_hash_mismatch");
function sourcesCopy() {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-readability-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(FIX, "sources"), dir, { recursive: true });
  return dir;
}
describe("an unreadable snapshot blocks only the rows it backs", () => {
  for (const damage of ["directory", "meta.json", "text.txt", "invalid metadata", "unreadable body", "raw.bin"])
    test(`#given S4 with a damaged ${damage} #when verified #then every S4-backed row is blocked`, () => {
      const dir = sourcesCopy(),
        ledger = structuredClone(BASE);
      if (damage === "directory") rmSync(dir, { recursive: true });
      else if (damage === "invalid metadata") writeFileSync(join(dir, "S4/meta.json"), "{");
      else if (damage === "unreadable body") {
        rmSync(join(dir, "S4/text.txt"));
        mkdirSync(join(dir, "S4/text.txt"));
      } else if (damage === "raw.bin")
        for (const row of ledger.rows.filter((r) => r.source_id === "S4"))
          row.locator = { ...row.locator, artifact: "raw.bin", unit: "utf8-bytes" };
      else rmSync(join(dir, "S4", damage));
      const defects = check(data("F1", "up to 320 m") + data("F2", "1,237"), ledger, dir);
      expect(
        blocked(defects)
          .map((d) => d.fact_id)
          .sort(),
      ).toEqual(["F1", "F2"]);
      expect(DEFECT_CODES.snapshot_hash_mismatch).toMatchObject({ severity: "blocker", integrity: true });
    });
  test("#given S4's meta.json deleted #when a verified fact on the healthy command snapshot S5 is checked #then it stays clean", () => {
    const dir = sourcesCopy();
    rmSync(join(dir, "S4", "meta.json"));
    const defects = check(data("F1", "up to 320 m") + verified, BASE, dir);
    expect(blocked(defects).map((d) => d.fact_id)).toEqual(["F1"]);
    expect(defects.filter((d) => d.code !== "snapshot_hash_mismatch")).toEqual([]);
  });
  test("#given a text edit and a deleted meta.json #when verified #then the same code names different causes", () => {
    const edited = sourcesCopy();
    writeFileSync(join(edited, "S4/text.txt"), `${readFileSync(join(edited, "S4/text.txt"), "utf8")}edited`);
    const missing = sourcesCopy();
    rmSync(join(missing, "S4", "meta.json"));
    const [a] = blocked(check(data("F1", "up to 320 m"), BASE, edited)),
      [b] = blocked(check(data("F1", "up to 320 m"), BASE, missing));
    expect(a?.message).toContain("text.txt changed after its snapshot was pinned");
    expect(b?.message).toContain("meta.json is missing");
    expect(a?.message).not.toBe(b?.message);
  });
  test("#given an edited snapshot behind a row and one named only in prose #when verified #then both carry one wording of the cause", () => {
    const dir = sourcesCopy();
    for (const id of ["S4", "S5"]) writeFileSync(join(dir, id, "text.txt"), `${readFileSync(join(dir, id, "text.txt"), "utf8")}edited`);
    const defects = blocked(check(`${data("F1", "up to 320 m")}<p>The suite ran [S5].</p>`, BASE, dir)),
      cause = (id) => defects.find((d) => d.message.includes(`snapshot ${id} `))?.message.split(`snapshot ${id} `)[1];
    expect(defects).toHaveLength(2);
    expect(cause("S5")).toBe(cause("S4"));
  });
  test("#given source-free assumptions and intact snapshots #when verified #then nothing is blocked", () => {
    expect(check(data("F2", "1,237"))).toEqual([]);
    const assumed = {
      ...BASE.rows.find((r) => r.fact_id === "F8"),
      fact_id: "F8",
      kind: "assumed",
      raw: "15%",
      value: "15",
      unit: "%",
      derived_from: [],
    };
    expect(check('<data data-fact="F8" data-claim-kind="assumed">15%</data>', { ...BASE, rows: [assumed] }, "nonexistent")).toEqual([]);
  });
  test("#given raw-body and explicit converted-only snapshots #when read #then both keep their source contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-raw-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "S1"));
    const ctx = buildContext(parseHtml(data("F1", "42")), { baseDir: FIX }),
      cited = new Map([["F1", ctx.body]]);
    for (const kind of ["command", "converted-only"]) {
      const body = kind === "command" ? "raw command body" : "converted quote",
        file = kind === "command" ? "raw.bin" : "text.txt";
      writeFileSync(join(dir, "S1", file), body);
      writeFileSync(join(dir, "S1/meta.json"), JSON.stringify({ kind, sha256: sha256Of(body) }));
      const rows = new Map([["F1", { fact_id: "F1", source_id: "S1", kind: "quote", locator: { unit: "utf8-bytes" } }]]),
        defects = [];
      expect([...unreadableSnapshots(ctx, rows, cited, dir, defects)]).toEqual([]);
      expect(defects).toEqual([]);
      rmSync(join(dir, "S1", file));
    }
  });
  test("#given a missing sources directory #when fact verify runs #then exit 1 with a blocker per source-backed row", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-verify-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify(BASE));
    cpSync(join(FIX, "..", "fidelity-brief-locked.md"), join(dir, "brief.md"));
    const report = join(dir, "report.html");
    writeFileSync(report, data("F1", "up to 320 m") + data("F2", "1,237"));
    const result = runFactVerify({ positionals: [report], flags: { "session-dir": dir, sources: join(dir, "nonexistent") } });
    expect(result.exitCode).toBe(1);
    const defects = "defects" in result.json ? result.json.defects : [];
    expect(
      blocked(defects)
        .map((d) => d.fact_id)
        .sort(),
    ).toEqual(["F1", "F2"]);
  });
});
