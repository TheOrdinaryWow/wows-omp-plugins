import type { NativeChild } from "@oh-my-pi/pi-tui";
import { compact, kv, md, node, span, text } from "@oh-my-pi/pi-tui";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeToolHead, NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";

import { type AuditState, type ConclusionEvidence, limitLabel, type RoundRecord, remainingFindings } from "#src/ledger.ts";
import { modelTextNodes } from "#src/model-text.ts";

/** Structured `audit_round` result details; the text content stays the model-facing receipt. */
export interface RoundCardDetails {
  op: string;
  intensity: string;
  rounds: number;
  roundLimit: string;
  /** The round this call recorded, or the latest one. */
  round?: Pick<RoundRecord, "round" | "auditorModels" | "critical" | "major" | "minor" | "picky"> &
    Partial<Pick<RoundRecord, "coverage" | "checks" | "findings" | "resolutions" | "rejectedEvidence" | "rejected" | "loopInduced">>;
  open: { critical: number; major: number; minor: number; picky: number };
  verdict?: string;
  capPending: boolean;
  conclusion?: { kind: string; reason: string; evidence?: ConclusionEvidence[] };
  ended: boolean;
}

export function roundCardDetails(op: string, state: AuditState, verdict?: string): RoundCardDetails {
  const last = state.rounds.at(-1);
  return {
    op,
    intensity: state.intensity,
    rounds: state.rounds.length,
    roundLimit: limitLabel(state.maxRounds),
    ...(last
      ? {
          round: {
            round: last.round,
            auditorModels: last.auditorModels,
            critical: last.critical,
            major: last.major,
            minor: last.minor,
            picky: last.picky,
            ...(op === "record"
              ? {
                  coverage: last.coverage,
                  checks: last.checks,
                  findings: last.findings,
                  resolutions: last.resolutions,
                  rejectedEvidence: last.rejectedEvidence,
                  rejected: last.rejected,
                  loopInduced: last.loopInduced,
                }
              : {}),
          },
        }
      : {}),
    open: remainingFindings(state.rounds).counts,
    ...(verdict ? { verdict } : {}),
    capPending: state.capPending,
    ...(state.conclusion
      ? { conclusion: { kind: state.conclusion.kind, reason: state.conclusion.reason, evidence: state.conclusion.evidence } }
      : {}),
    ended: state.status === "ended",
  };
}

interface RoundArgs {
  op?: unknown;
  round?: unknown;
  conclusion?: unknown;
}

const TITLE = "Audit Round";

function callTarget(args: RoundArgs | undefined): string | undefined {
  const op = typeof args?.op === "string" ? args.op : undefined;
  if (!op) return undefined;
  if (op === "record" && typeof args?.round === "number") return `record round ${args.round}`;
  if (op === "conclude" && typeof args?.conclusion === "string") return `conclude ${args.conclusion}`;
  return op;
}

function head(args: RoundArgs | undefined, note?: string): NativeToolHead {
  const target = callTarget(args);
  return { title: TITLE, ...(target ? { target } : {}), ...(note ? { note } : {}) };
}

export function describeRoundCall(args: RoundArgs | undefined): NativeToolView {
  return { tool: head(args) };
}

type ResultLike = { content?: readonly { type: string; text?: string }[]; details?: unknown; isError?: boolean };

function resultText(result: ResultLike): string {
  return (result.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

function isCardDetails(details: unknown): details is RoundCardDetails {
  return typeof details === "object" && details !== null && typeof (details as RoundCardDetails).rounds === "number";
}

function counts(c: { critical: number; major: number; minor: number; picky: number }): string {
  return `critical ${c.critical} · major ${c.major} · minor ${c.minor} · picky ${c.picky}`;
}

const VERDICT_TONE: Record<string, string> = { "threshold-ready": "success", "cap-reached": "warning" };

function stateValue(details: RoundCardDetails) {
  if (details.conclusion) {
    const tone = details.conclusion.kind === "threshold-convergence" ? "success" : "warning";
    return [span(details.conclusion.kind, `${tone} strong`)];
  }
  if (details.capPending) return [span("round limit reached", "warning strong")];
  if (details.verdict) return [span(details.verdict, VERDICT_TONE[details.verdict] ?? "accent")];
  return [span(details.ended ? "ended" : "in progress", "muted")];
}

function factSection(label: string, source: string, key: string): NativeChild {
  return node("section", { head: [span(label, "muted")] }, [md(source)], key);
}

/** Only facts belonging to this change; the full ledger stays in the folded receipt. */
function operationFacts(details: RoundCardDetails): NativeChild[] {
  const round = details.op === "record" ? details.round : undefined;
  const conclusion = details.op === "conclude" || details.op === "extend" ? details.conclusion : undefined;
  return compact<NativeChild>([
    round?.coverage ? factSection("Coverage", round.coverage, "coverage") : undefined,
    round?.checks ? factSection("Checks", round.checks, "checks") : undefined,
    ...(round?.findings ?? []).map((finding) =>
      node(
        "section",
        { head: [span(finding.id, "strong"), span(` · ${finding.severity} · ${finding.status}`, "muted")] },
        compact([
          md(finding.summary),
          kv([["Origin", finding.origin]]),
          factSection("Evidence", finding.evidence, "evidence"),
          finding.resolution ? factSection("Resolution", finding.resolution, "resolution") : undefined,
        ]),
        `finding-${finding.id}`,
      ),
    ),
    ...(round?.resolutions ?? []).map((resolution, index) =>
      factSection(`Resolved ${resolution.findingId}`, resolution.evidence, `resolution-${index}`),
    ),
    ...(round?.rejectedEvidence ?? []).map((reason, index) => factSection(`Rejected claim ${index + 1}`, reason, `rejected-${index}`)),
    conclusion?.reason ? factSection("Reason", conclusion.reason, "reason") : undefined,
    ...(conclusion?.evidence ?? []).map((evidence, index) =>
      factSection(`Round ${evidence.round} observation`, evidence.observation, `observation-${index}`),
    ),
  ]);
}

/** A refusal's reason, not its subsequent instructions or multi-round ledger. */
function summary(source: string): string {
  const line =
    source
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  return line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
}

const memo = new OwnerMemo<NativeToolView>();

export function describeRoundResult(result: ResultLike, args: RoundArgs | undefined, expanded: boolean): NativeToolView {
  return memo.get(result, [result.details, result.isError, expanded, callTarget(args)], () => {
    const body = resultText(result);
    const receipt =
      expanded && body
        ? node("section", { head: [span("Model text", "muted")], collapsible: true, collapsed: true }, modelTextNodes(body), "model-text")
        : undefined;
    if (result.isError || !isCardDetails(result.details)) {
      return {
        tool: head(args, result.isError ? "refused" : undefined),
        tone: result.isError ? "error" : undefined,
        body: compact([text(summary(body) || (result.isError ? "Audit operation refused." : "Audit operation completed.")), receipt]),
        preview: "none",
      };
    }
    const d = result.details;
    const open = d.open.critical + d.open.major + d.open.minor + d.open.picky;
    const round = d.op === "record" ? d.round : undefined;
    return {
      tool: head(args ?? { op: d.op }, d.verdict),
      tone: d.capPending ? "warning" : d.conclusion?.kind === "threshold-convergence" ? "success" : undefined,
      body: compact<NativeChild>([
        kv([
          ["Round", `${d.round?.round ?? d.rounds} of ${d.roundLimit}`],
          ["Auditors", round?.auditorModels.join(", ")],
          ["Found", round ? counts(round) : undefined],
          ["Rejected", round?.rejected !== undefined ? String(round.rejected) : undefined],
          ["Loop-induced", round?.loopInduced !== undefined ? String(round.loopInduced) : undefined],
          ["Resolved earlier findings", round?.resolutions ? String(round.resolutions.length) : undefined],
          ["Open", open > 0 ? [span(counts(d.open), "warning")] : [span("none", "success")]],
          ["State", stateValue(d)],
          ["Intensity", d.intensity],
        ]),
        ...(expanded ? operationFacts(d) : []),
        receipt,
      ]),
      preview: "none",
    };
  });
}
