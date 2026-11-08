// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { onTestFinished } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs"),
  FIXTURES = join(join(import.meta.dir, ".."), "tests", "fixtures"),
  NOW = "2026-10-23T08:00:00Z";
function sessionDir() {
  const root = mkdtempSync(join(tmpdir(), "report-tools-cli-"));
  onTestFinished(() => rmSync(root, { recursive: !0, force: !0 }));
  const dir = join(root, "20260101-120000");
  mkdirSync(dir);
  return dir;
}
function nodeWithoutBun(args) {
  const nodePath = Bun.which("node");
  if (nodePath === null) throw Error("node not found on PATH");
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !entry.includes(".bun"))
    .join(delimiter);
  return Bun.spawnSync({ cmd: [nodePath, SCRIPT, ...args], env: { ...process.env, PATH: path } });
}
function defectsFile(dir, name, codes) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(codes.map((code) => ({ code, message: code }))));
  return file;
}
const FIDELITY = join(FIXTURES, "fidelity"),
  sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function nodeJson(args) {
  const proc = nodeWithoutBun(args),
    stdout = proc.stdout.toString();
  let json = {};
  try {
    json = JSON.parse(stdout);
  } catch {}
  return { code: proc.exitCode, json, stdout, stderr: proc.stderr.toString() };
}
function fidelitySession() {
  const dir = sessionDir();
  copyFileSync(join(FIXTURES, "fidelity-brief-locked.md"), join(dir, "brief.md"));
  const s = ["--session-dir", dir],
    snap = nodeJson(["source", "snapshot", "--id", "S4", "--html", join(FIDELITY, "sources", "S4.html"), ...s]),
    add = nodeJson(["fact", "add", "--source", "S4", "--find", "Span length", "--label", "span_len", "--json", ...s]),
    quote = nodeJson(["fact", "quote", "--source", "S4", "--match", "no earlier than 2027", "--label", "completion", "--json", ...s]),
    derive = nodeJson(["fact", "derive", "--op", "convert", "F1", "--to", "mm", "--label", "span_mm", "--now", NOW, "--json", ...s]),
    mm = derive.json.data?.row?.fact_id,
    source = [
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bridge</title></head><body><h1>Bridge</h1>',
      "<h2>Findings</h2>",
      "<p>The span length is {{F1:span_len}} [S4].</p>",
      `<p>In millimetres the span is {{${mm}:span_mm}} [S4].</p>`,
      "<p>The operator wrote {{Q1:completion}} [S4].</p>",
      "<h2>How this report was made</h2><p>Collected from one cited public page [S4].</p>",
      '<h2>Sources</h2><ol><li id="s4">[S4] Bridge page, retrieved 2026-10-01.</li></ol></body></html>',
    ].join(`
`);
  writeFileSync(join(dir, "report.src.html"), source);
  return { dir, s, snap, add, quote, derive, mm };
}
function verify(dir, report, extra = []) {
  return nodeJson([
    "fact",
    "verify",
    join(dir, report),
    "--sources",
    join(dir, "sources"),
    "--brief",
    join(dir, "brief.md"),
    "--session-dir",
    dir,
    ...extra,
  ]);
}
const codesOf = (json) => (json.defects ?? []).map((d) => d.code);
function pairedSession() {
  const session = fidelitySession(),
    { dir, s } = session;
  nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
  const pairs = nodeJson([
    "fact",
    "pairs",
    join(dir, "report.html"),
    "--ledger",
    join(dir, "fact-ledger.json"),
    "--out",
    join(dir, "pairs.json"),
    ...s,
  ]);
  return { ...session, pairs };
}
function verdicts(dir, name, tier, list) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ model_tier: tier, verdicts: list }));
  return file;
}
const calibrationRows = (dir) =>
    readFileSync(join(dir, "fidelity-calibration.jsonl"), "utf8")
      .trim()
      .split(`
`)
      .map((line) => JSON.parse(line))
      .filter((row) => row.header !== !0 && row.run !== !0),
  runLines = (dir) =>
    readFileSync(join(dir, "fidelity-calibration.jsonl"), "utf8")
      .trim()
      .split(`
`)
      .map((line) => JSON.parse(line))
      .filter((row) => row.run === !0);
function polishSession() {
  const session = fidelitySession(),
    { dir, s } = session,
    source = readFileSync(join(dir, "report.src.html"), "utf8").replace(
      "<p>The span length is",
      "<p>Acme acquired Bolt before the span length reached",
    );
  writeFileSync(join(dir, "report.src.html"), source);
  nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]);
  return session;
}
function polishApply(dir, edits) {
  const args = [
      "fact",
      "polish-apply",
      join(dir, "report.html"),
      "--edits",
      edits,
      "--ledger",
      join(dir, "fact-ledger.json"),
      "--out",
      join(dir, "report.polished.html"),
      "--session-dir",
      dir,
    ],
    proc = nodeJson(args);
  return { ...proc, json: proc.json };
}
function setField(dir, field, value, answeredBy = "user") {
  const path = join(dir, "brief.md"),
    line = new RegExp(`^${field}: .*$`, "mu");
  writeFileSync(path, readFileSync(path, "utf8").replace(line, `${field}: ${value} (answered_by: ${answeredBy})`));
}
function fillTemplate(dir, body, extra = []) {
  const source = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><h1>T</h1>',
    "<h2>Findings</h2>",
    body,
    "</body></html>",
  ].join(`
`);
  writeFileSync(join(dir, "t.src.html"), source);
  return nodeJson(["fact", "fill", join(dir, "t.src.html"), "--out", join(dir, "t.html"), "--session-dir", dir, ...extra]);
}
function textSource(dir, id, provenance) {
  writeFileSync(
    join(dir, `${id}.txt`),
    `Commentary: the span length is 320 m according to this review.
`,
  );
  const prov = provenance === void 0 ? [] : ["--provenance", provenance],
    snap = nodeJson([
      "source",
      "snapshot",
      "--id",
      id,
      "--raw",
      join(dir, `${id}.txt`),
      "--kind",
      "document",
      ...prov,
      "--session-dir",
      dir,
    ]),
    add = nodeJson([
      "fact",
      "add",
      "--source",
      id,
      "--find",
      "span length",
      "--label",
      `span_${id.toLowerCase()}`,
      "--json",
      "--session-dir",
      dir,
    ]);
  return { snap, row: add.json.data?.row };
}
const ledgerRow = (dir, id) => JSON.parse(readFileSync(join(dir, "fact-ledger.json"), "utf8")).rows.find((r) => r.fact_id === id);

export {
  calibrationRows,
  codesOf,
  defectsFile,
  FIDELITY,
  FIXTURES,
  fidelitySession,
  fillTemplate,
  ledgerRow,
  NOW,
  nodeJson,
  nodeWithoutBun,
  pairedSession,
  polishApply,
  polishSession,
  runLines,
  SCRIPT,
  sessionDir,
  setField,
  sha256,
  textSource,
  verdicts,
  verify,
};
