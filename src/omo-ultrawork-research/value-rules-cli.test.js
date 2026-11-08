// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codesOf, fidelitySession, NOW, nodeJson, polishSession, sha256, verdicts, verify } from "./tests/report-tools-support.js";

const WORDING = [{ before: "The operator wrote", after: "The operator stated", reason: "wording" }];
function polish(dir, s, out) {
  const edits = join(dir, "wording.json");
  writeFileSync(edits, JSON.stringify(WORDING));
  return nodeJson(["fact", "polish-apply", join(dir, "report.html"), "--edits", edits, "--out", out, ...s]);
}
function editValue(path) {
  const html = readFileSync(path, "utf8");
  expect(html.split(">320 m</data>").length).toBe(2);
  writeFileSync(path, html.replace(">320 m</data>", ">321 m</data>"));
}
function pairs(dir, s, report, map) {
  const out = join(dir, "pairs-changed.json");
  rmSync(out, { force: !0 });
  const run = nodeJson(["fact", "pairs", report, "--changed-since", map, "--out", out, ...s]),
    written = run.code === 0 ? JSON.parse(readFileSync(out, "utf8")) : { pairs: [] };
  return { run, written, sentences: written.pairs.map((pair) => pair.sentence) };
}
describe("the pre-polish fill map stays authoritative for --changed-since", () => {
  test("#given a report polished in place #when a value is edited and fact pairs runs --changed-since on the fill map #then the reworded and the edited sentences are re-checked and meaning-check runs", () => {
    const { dir, s } = polishSession(),
      report = join(dir, "report.html"),
      fillMap = `${report}.fill-map.json`,
      before = readFileSync(fillMap, "utf8"),
      applied = polish(dir, s, report),
      reworded = pairs(dir, s, report, fillMap);
    editValue(report);
    const edited = pairs(dir, s, report, fillMap),
      ok = edited.written.pairs.map((pair) => ({ pair_id: pair.pair_id, verdict: "ok" })),
      readers = ["cheap", "strong"].flatMap((tier) => ["--verdicts", verdicts(dir, `${tier}.json`, tier, ok)]),
      checked = nodeJson(["fact", "meaning-check", "--pairs", join(dir, "pairs-changed.json"), ...readers, ...s]);
    expect([applied.code, applied.json.data.applied, applied.json.data.rejected]).toEqual([0, 1, 0]);
    expect(readFileSync(fillMap, "utf8")).toBe(before);
    expect(reworded.run.code).toBe(0);
    expect(reworded.sentences.some((text) => text.includes("The operator stated"))).toBe(!0);
    expect(edited.run.code).toBe(0);
    expect(edited.sentences.some((text) => text.includes("321 m"))).toBe(!0);
    expect(edited.sentences.some((text) => text.includes("The operator stated"))).toBe(!0);
    expect(edited.written.changed_since).toEqual({ fill_map: fillMap, narrowed: !1 });
    expect(checked.code).toBe(0);
    const record = JSON.parse(readFileSync(join(dir, "fidelity-meaning-defects.json"), "utf8"));
    expect(record).toMatchObject({ record_kind: "meaning", status: "pass", report, artifact_sha256: sha256(report) });
  });
  test("#given a report polished to a new file #when fact pairs runs --changed-since on either map #then only the reworded sentence, and after a value edit also the edited one", () => {
    const { dir, s } = polishSession(),
      fillMap = `${join(dir, "report.html")}.fill-map.json`,
      out = join(dir, "report.polished.html"),
      polishedMap = `${out}.polished.fill-map.json`,
      before = readFileSync(fillMap, "utf8"),
      applied = polish(dir, s, out),
      viaPolished = pairs(dir, s, out, polishedMap),
      viaFill = pairs(dir, s, out, fillMap);
    editValue(out);
    const edited = pairs(dir, s, out, polishedMap);
    expect(applied.code).toBe(0);
    expect(readFileSync(fillMap, "utf8")).toBe(before);
    expect(existsSync(`${out}.fill-map.json`)).toBe(!1);
    expect(JSON.parse(readFileSync(polishedMap, "utf8"))).toMatchObject({
      artifact: out,
      brief_sha256: JSON.parse(before).brief_sha256,
      polishedFrom: { map: fillMap, sha256: sha256(fillMap) },
    });
    for (const run of [viaPolished, viaFill]) {
      expect(run.run.code).toBe(0);
      expect(run.sentences).toEqual([expect.stringContaining("The operator stated")]);
      expect(run.written.changed_since).toEqual({ fill_map: fillMap, narrowed: !0 });
    }
    expect(edited.sentences).toEqual([expect.stringContaining("321 m"), expect.stringContaining("The operator stated")]);
  });
  test("#given a fill map that does not record the report's bytes #when fact polish-apply runs #then it exits 2 and writes nothing", () => {
    const { dir, s } = polishSession(),
      fillMap = join(dir, "report.html.fill-map.json"),
      out = join(dir, "report.polished.html");
    writeFileSync(fillMap, JSON.stringify({ ...JSON.parse(readFileSync(fillMap, "utf8")), artifact_sha256: "0".repeat(64) }));
    const tampered = polish(dir, s, out);
    expect(tampered.code).toBe(2);
    expect(tampered.stderr).toContain(fillMap);
    expect([out, `${out}.polished.fill-map.json`, `${out}.fill-map.json`].map(existsSync)).toEqual([!1, !1, !1]);
  });
  test("#given the pre-polish fill map rewritten after polish #when fact pairs follows the polished map #then it exits 2", () => {
    const { dir, s } = polishSession(),
      fillMap = join(dir, "report.html.fill-map.json"),
      out = join(dir, "report.polished.html");
    polish(dir, s, out);
    writeFileSync(fillMap, JSON.stringify({ ...JSON.parse(readFileSync(fillMap, "utf8")), entries: [] }));
    const followed = pairs(dir, s, out, `${out}.polished.fill-map.json`);
    expect(followed.run.code).toBe(2);
    expect(followed.run.stderr).toContain(fillMap);
  });
});
describe("fact derive takes its time from the caller", () => {
  test("#given no --now #when fact derive runs #then it exits 2 with missing_now and appends nothing; with --now the row carries that time", () => {
    const { dir, s } = fidelitySession(),
      rows = () => JSON.parse(readFileSync(join(dir, "fact-ledger.json"), "utf8")).rows.length,
      count = rows(),
      missing = nodeJson(["fact", "derive", "--op", "convert", "F1", "--to", "km", "--label", "span_km", "--json", ...s]),
      after = rows(),
      stamped = nodeJson(["fact", "derive", "--op", "convert", "F1", "--to", "km", "--label", "span_km", "--now", NOW, "--json", ...s]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing_now");
    expect(after).toBe(count);
    expect(stamped.code).toBe(0);
    expect(stamped.json.data.row).toMatchObject({ observed_at: "2026-10-23T08:00:00.000Z" });
  });
});
describe("fact verify names a missing fill map", () => {
  test("#given an HTML edition with no fill map #when fact verify runs #then brief_changed says no fill map at its path", () => {
    const { dir, s } = fidelitySession();
    nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
    const map = join(dir, "report.html.fill-map.json");
    rmSync(map);
    const checked = verify(dir, "report.html");
    expect([checked.code, codesOf(checked.json)]).toEqual([1, ["brief_changed"]]);
    expect(checked.json.defects[0].message).toContain(`no fill map at ${map}`);
  });
});
