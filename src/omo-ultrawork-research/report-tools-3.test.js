// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { POLISH_MARKUP_REASON } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/polish-apply.mjs";
import { run } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";
import {
  codesOf,
  defectsFile,
  FIDELITY,
  fidelitySession,
  nodeJson,
  polishApply,
  polishSession,
  sessionDir,
  sha256,
  verify,
} from "./tests/report-tools-support.js";

describe("polish wiring under node", () => {
  test("#given the fixture edits #when fact polish-apply runs #then it exits 0, applies the wording edit, and rejects the numeral edit", () => {
    const { dir } = polishSession(),
      applied = polishApply(dir, join(FIDELITY, "polish-edits.json")),
      polished = readFileSync(join(dir, "report.polished.html"), "utf8");
    expect(applied.code).toBe(0);
    expect(applied.json.data).toMatchObject({ applied: 1, rejected: 1, unlocated: 0 });
    expect(applied.json.defects.map((d) => [d.code, d.index])).toEqual([["polish_edit_rejected", 1]]);
    expect(polished).toContain("Collected from a single cited public page");
    expect(polished).toContain("retrieved 2026-10-01");
    expect(polished).not.toContain("2026-10-02");
  });
  test("#given an edit that adds an attribute #when polish-apply and polish-diff run #then apply refuses it as markup changed and diff exits 1", () => {
    const { dir } = polishSession(),
      html = readFileSync(join(dir, "report.html"), "utf8"),
      edits = join(dir, "attribute.json");
    writeFileSync(edits, JSON.stringify([{ before: "<h2>Findings</h2>", after: '<h2 id="findings">Findings</h2>', reason: "anchor" }]));
    const applied = polishApply(dir, edits);
    expect(applied.code).toBe(0);
    expect(applied.json.data).toMatchObject({ applied: 0, rejected: 1, unlocated: 0 });
    expect(applied.json.defects.map((d) => [d.code, d.index])).toEqual([["polish_edit_rejected", 0]]);
    expect(applied.json.defects[0]?.reason).toContain("markup changed");
    expect(readFileSync(join(dir, "report.polished.html"), "utf8")).toBe(html);
    writeFileSync(join(dir, "attribute.html"), html.replace("<h2>Findings</h2>", '<h2 id="findings">Findings</h2>'));
    const diffed = nodeJson([
      "fact",
      "polish-diff",
      "--before",
      join(dir, "report.html"),
      "--after",
      join(dir, "attribute.html"),
      "--ledger",
      join(dir, "fact-ledger.json"),
      "--session-dir",
      dir,
    ]);
    expect(diffed.code).toBe(1);
    expect(codesOf(diffed.json)).toContain("polish_diff_fail");
    expect(JSON.stringify(diffed.json)).toContain("markup changed");
  });
  test("#given an edit whose before holds & #when fact polish-apply runs #then it prints polish-apply's own markup reason verbatim for that edit", () => {
    const { dir } = polishSession(),
      before = "Acme & Bolt",
      edits = join(dir, "ampersand.json");
    writeFileSync(edits, JSON.stringify([{ before, after: "Acme and Bolt", reason: "ampersand" }]));
    const applied = polishApply(dir, edits),
      line = `  rejected edit 0 ("${before}"): ${POLISH_MARKUP_REASON}`;
    expect(applied.code).toBe(0);
    expect(applied.json.data).toMatchObject({ applied: 0, rejected: 1, unlocated: 0 });
    expect(applied.json.defects.map((d) => [d.code, d.index, d.reason])).toEqual([["polish_edit_rejected", 0, POLISH_MARKUP_REASON]]);
    expect(
      applied.stderr.split(`
`),
    ).toContain(line);
  });
  test("#given a polished copy edited by hand #when fact polish-diff runs #then it exits 1 with polish_diff_fail", () => {
    const { dir } = polishSession(),
      html = readFileSync(join(dir, "report.html"), "utf8");
    writeFileSync(join(dir, "hand.html"), html.replace("320 m", "321 m"));
    const diffed = nodeJson([
      "fact",
      "polish-diff",
      "--before",
      join(dir, "report.html"),
      "--after",
      join(dir, "hand.html"),
      "--ledger",
      join(dir, "fact-ledger.json"),
      "--session-dir",
      dir,
    ]);
    expect(diffed.code).toBe(1);
    expect(codesOf(diffed.json)).toContain("polish_diff_fail");
  });
  test("#given an accepted subject and object swap #when fact pairs runs with --changed-since #then only that sentence's pair is emitted, with the new text", () => {
    const { dir, s } = polishSession(),
      edits = join(dir, "swap.json");
    writeFileSync(edits, JSON.stringify([{ before: "Acme acquired Bolt", after: "Bolt acquired Acme", reason: "word order" }]));
    const applied = polishApply(dir, edits),
      map = join(dir, "report.html.fill-map.json"),
      changed = nodeJson([
        "fact",
        "pairs",
        join(dir, "report.polished.html"),
        "--changed-since",
        map,
        "--out",
        join(dir, "pairs-changed.json"),
        ...s,
      ]),
      written = JSON.parse(readFileSync(join(dir, "pairs-changed.json"), "utf8"));
    expect(applied.json.data).toMatchObject({ applied: 1, rejected: 0 });
    expect(changed.code).toBe(0);
    expect(written.pairs.map((p) => [p.kind, p.fact_ids])).toEqual([["quote", ["F1"]]]);
    expect(written.pairs[0].sentence).toContain("Bolt acquired Acme");
  });
});
describe("markdown editions under node", () => {
  const MD = [
    "# Bridge",
    "",
    "## Findings",
    "",
    "The span length is {{F1:span_len}} [S4].",
    "",
    "The operator wrote {{Q1:completion}} [S4].",
    "",
    "## How this report was made",
    "",
    "Collected from one cited public page [S4].",
    "",
    "## Sources",
    "",
    "1. [S4] Bridge page, retrieved 2026-10-01.",
    "",
  ].join(`
`);
  function mdSession() {
    const session = fidelitySession();
    writeFileSync(join(session.dir, "report.src.md"), MD);
    const filled = nodeJson([
      "fact",
      "fill",
      join(session.dir, "report.src.md"),
      "--format",
      "md",
      "--out",
      join(session.dir, "report.md"),
      ...session.s,
    ]);
    return { ...session, filled };
  }
  test("#given a markdown source #when filled and verified as md #then verify passes and records the md bytes", () => {
    const { dir, filled } = mdSession(),
      checked = verify(dir, "report.md", ["--format", "md"]);
    expect(filled.code).toBe(0);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("The span length is 320 m [S4].");
    expect(checked.code).toBe(0);
    expect(checked.json.defects).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "fidelity-defects.json"), "utf8")).artifact_sha256).toBe(sha256(join(dir, "report.md")));
  });
  test("#given a filled markdown edition #when a value is hand-edited or a number typed #then md verify exits 1 with the code", () => {
    const { dir } = mdSession(),
      md = readFileSync(join(dir, "report.md"), "utf8");
    writeFileSync(
      join(dir, "typed.md"),
      md.replace(
        "## How",
        `Revenue grew 12% [S4].

## How`,
      ),
    );
    copyFileSync(join(dir, "report.md.fill-map.json"), join(dir, "typed.md.fill-map.json"));
    const typed = verify(dir, "typed.md", ["--format", "md"]);
    expect(typed.code).toBe(1);
    expect(codesOf(typed.json)).toContain("untraceable_number");
  });
  test("#given a filled markdown edition with an unterminated fence #when verified or paired #then both refuse with exit 2", () => {
    const { dir, s } = mdSession();
    writeFileSync(
      join(dir, "fence.md"),
      `${readFileSync(join(dir, "report.md"), "utf8")}
\`\`\`
unclosed code
`,
    );
    copyFileSync(join(dir, "report.md.fill-map.json"), join(dir, "fence.md.fill-map.json"));
    const checked = verify(dir, "fence.md", ["--format", "md"]);
    expect(checked.code).toBe(2);
    expect(checked.stderr).toContain("unterminated_fence");
    expect(nodeJson(["fact", "pairs", join(dir, "fence.md"), "--out", join(dir, "pairs.json"), ...s]).code).toBe(2);
  });
  test("#given a filled markdown edition #when fact pairs runs on it #then it pairs the same quotes as the html edition", () => {
    const { dir, s } = mdSession(),
      pairs = nodeJson(["fact", "pairs", join(dir, "report.md"), "--out", join(dir, "pairs.json"), ...s]);
    expect(pairs.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "pairs.json"), "utf8")).pairs.map((p) => p.fact_ids)).toEqual([["F1"], ["Q1"]]);
  });
});
describe("repair decide with several defect files", () => {
  test("#given two --defects files #when decided #then the attempt signature carries both codes", async () => {
    const dir = sessionDir(),
      state = join(dir, "repair-state.json");
    await run([
      "repair",
      "decide",
      "--state",
      state,
      "--defects",
      defectsFile(dir, "a.json", ["heading_generic"]),
      "--defects",
      defectsFile(dir, "b.json", ["untraceable_number"]),
    ]);
    const signature = JSON.parse(readFileSync(state, "utf8")).attempts[0].signature;
    expect(signature).toContain("heading_generic");
    expect(signature).toContain("untraceable_number");
  });
});
