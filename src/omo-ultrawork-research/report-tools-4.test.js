// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFidelityRecord } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-records.mjs";
import { run } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";
import { codesOf, fidelitySession, nodeJson, pairedSession, sha256, verdicts, verify } from "./tests/report-tools-support.js";

describe("fidelity delivery barrier", () => {
  const meaningRan = (dir, report = "report.html", format) =>
    writeFidelityRecord(
      join(dir, format === void 0 ? "fidelity-meaning-defects.json" : `fidelity-meaning-defects.${format}.json`),
      "meaning",
      { artifact_sha256: sha256(join(dir, report)), report: join(dir, report), defects: [] },
    );
  async function deliveredSession(codes) {
    const { dir, s } = fidelitySession();
    nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
    meaningRan(dir);
    const record = (list) =>
      writeFidelityRecord(join(dir, "fidelity-defects.json"), "fidelity", {
        artifact_sha256: sha256(join(dir, "report.html")),
        report: join(dir, "report.html"),
        defects: list.map((code) => ({ code, message: code })),
      });
    record(codes);
    await run(["outcome", "init", "--session-dir", dir, "--promised", "html"]);
    await run([
      "outcome",
      "set",
      "html",
      "delivered",
      "--path",
      join(dir, "report.html"),
      "--verified-by",
      join(dir, "fidelity-defects.json"),
      "--session-dir",
      dir,
    ]);
    const decide = [
      "repair",
      "decide",
      "--state",
      join(dir, "repair-state.json"),
      "--defects",
      join(dir, "fidelity-defects.json"),
      "--artifact-bytes",
      "4096",
      "--renders",
      "1",
      "--session-dir",
      dir,
    ];
    await run(decide);
    const decision = await run(decide);
    return { dir, record, decision };
  }
  test("#given a clean meaning record #when the report is edited and fact verify re-run #then the stale meaning record refuses, and a fresh one passes", async () => {
    const { dir, s } = pairedSession(),
      report = join(dir, "report.html"),
      clean = [
        { pair_id: "P1", verdict: "ok" },
        { pair_id: "P2", verdict: "ok" },
      ],
      readers = () =>
        nodeJson([
          "fact",
          "meaning-check",
          "--pairs",
          join(dir, "pairs.json"),
          "--verdicts",
          verdicts(dir, "cheap.json", "cheap", clean),
          "--verdicts",
          verdicts(dir, "strong.json", "strong", clean),
          ...s,
        ]);
    expect(readers().code).toBe(0);
    expect(verify(dir, "report.html").code).toBe(0);
    await run(["outcome", "init", "--session-dir", dir, "--promised", "html"]);
    await run([
      "outcome",
      "set",
      "html",
      "delivered",
      "--path",
      report,
      "--verified-by",
      join(dir, "fidelity-defects.json"),
      "--session-dir",
      dir,
    ]);
    const first = await run(["outcome", "verify", "--session-dir", dir]);
    writeFileSync(
      report,
      `${readFileSync(report, "utf8")}
<!-- draft 2 -->
`,
    );
    expect(verify(dir, "report.html").code).toBe(0);
    const stale = await run(["outcome", "verify", "--session-dir", dir]);
    expect(nodeJson(["fact", "pairs", report, "--out", join(dir, "pairs.json"), ...s]).code).toBe(0);
    expect(readers().code).toBe(0);
    const fresh = await run(["outcome", "verify", "--session-dir", dir]);
    expect(first.exitCode).toBe(0);
    expect(stale.exitCode).toBe(1);
    expect(stale.json.problems).toContainEqual(
      expect.objectContaining({
        code: "edition_unverified",
        path: join(dir, "fidelity-meaning-defects.json"),
        message: expect.stringContaining("meaning record"),
      }),
    );
    expect(fresh.exitCode).toBe(0);
  });
  test("#given an unregistered appendix value #when verified #then untraceable_number and outcome verify refuses", async () => {
    const { dir, s } = fidelitySession();
    nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
    const html = readFileSync(join(dir, "report.html"), "utf8").replace(
      "<h2>How",
      `<h2>Appendix</h2>
<p>Revenue grew 12% [S4].</p>
<h2>How`,
    );
    writeFileSync(join(dir, "report.html"), html);
    const checked = verify(dir, "report.html");
    await run(["outcome", "init", "--session-dir", dir, "--promised", "html"]);
    await run([
      "outcome",
      "set",
      "html",
      "delivered",
      "--path",
      join(dir, "report.html"),
      "--verified-by",
      join(dir, "fidelity-defects.json"),
      "--session-dir",
      dir,
    ]);
    const outcome = await run(["outcome", "verify", "--session-dir", dir]);
    expect(codesOf(checked.json)).toContain("untraceable_number");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.json.problems.map((p) => p.code)).toContain("fidelity_unresolved");
  });
  for (const code of ["untraceable_number", "unbound_sentence"])
    test(`#given ${code} left after repair delivers on exhaustion #when verified and finished #then both refuse, and an empty record passes`, async () => {
      const { dir, record, decision } = await deliveredSession([code]),
        refused = await run(["outcome", "verify", "--session-dir", dir]),
        finish = await run(["outcome", "finish", "--session-dir", dir]);
      record([]);
      const passed = await run(["outcome", "verify", "--session-dir", dir]),
        finished = await run(["outcome", "finish", "--session-dir", dir]);
      expect(decision.json.decision.action).toBe("deliver");
      expect(refused.exitCode).toBe(1);
      expect(JSON.stringify(refused.json.problems)).toContain(`fidelity_unresolved: ${code}`);
      expect(finish.exitCode).toBe(1);
      expect(passed.exitCode).toBe(0);
      expect(finished.exitCode).toBe(0);
    });
  test("#given a clean main report and an inline edition #when the edition lacks or mismatches its verify record #then edition_unverified, and its own record passes", async () => {
    const { dir, s } = fidelitySession();
    writeFileSync(join(dir, "report.css"), "body { margin: 0 auto; max-width: 42rem; }");
    writeFileSync(
      join(dir, "report.src.html"),
      readFileSync(join(dir, "report.src.html"), "utf8")
        .replace("</title>", '</title><link rel="stylesheet" href="report.css">')
        .replace(
          "<h2>Findings</h2>",
          `<h2>Findings</h2>
<img src="assets/bridge.png" alt="The bridge from the south bank">`,
        ),
    );
    nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
    expect(verify(dir, "report.html").code).toBe(0);
    meaningRan(dir);
    expect(nodeJson(["fact", "fill", join(dir, "report.src.html"), "--inline", "--out", join(dir, "report.inline.html"), ...s]).code).toBe(
      0,
    );
    const inline = readFileSync(join(dir, "report.inline.html"), "utf8");
    expect(inline).toContain("<style>body { margin: 0 auto; max-width: 42rem; }</style>");
    expect(inline).toContain(`src="${join(dir, "assets", "bridge.png")}"`);
    expect(sha256(join(dir, "report.inline.html"))).not.toBe(sha256(join(dir, "report.html")));
    meaningRan(dir, "report.inline.html", "pdf");
    await run(["outcome", "init", "--session-dir", dir, "--promised", "html,pdf"]);
    await run([
      "outcome",
      "set",
      "html",
      "delivered",
      "--path",
      join(dir, "report.html"),
      "--verified-by",
      join(dir, "fidelity-defects.json"),
      "--session-dir",
      dir,
    ]);
    const problems = async () => {
      const result = await run(["outcome", "verify", "--session-dir", dir]);
      return { exitCode: result.exitCode, codes: result.json.problems.map((p) => p.code) };
    };
    await run(["outcome", "set", "pdf", "delivered", "--path", join(dir, "report.inline.html"), "--session-dir", dir]);
    const missing = await problems();
    expect(verify(dir, "report.inline.html", ["--out", join(dir, "fidelity-inline.json")]).code).toBe(0);
    writeFileSync(join(dir, "report.inline.html"), inline.replace("320,000 mm", "330,000 mm"));
    await run([
      "outcome",
      "set",
      "pdf",
      "delivered",
      "--path",
      join(dir, "report.inline.html"),
      "--verified-by",
      join(dir, "fidelity-inline.json"),
      "--session-dir",
      dir,
    ]);
    const altered = await problems();
    writeFileSync(join(dir, "report.inline.html"), inline);
    const matched = await problems();
    expect({ missing, altered, matched }).toEqual({
      missing: { exitCode: 1, codes: ["edition_unverified"] },
      altered: { exitCode: 1, codes: ["edition_unverified", "edition_unverified"] },
      matched: { exitCode: 0, codes: [] },
    });
  });
});
