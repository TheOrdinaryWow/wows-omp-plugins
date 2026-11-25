import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type JSXNode, nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspCardStatus, TspText, TspTone } from "@oh-my-pi/pi-wire";

import { type AuditState, type ConclusionEvidence, limitLabel, type RoundRecord, remainingFindings } from "#src/ledger.ts";
import { modelTextNodes } from "#src/model-text.ts";
import { h, kv, span } from "#src/tsp.ts";

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

const TOOL = "audit_round";
const TITLE = "Audit Round";

function callTarget(args: RoundArgs | undefined): string | undefined {
  const op = typeof args?.op === "string" ? args.op : undefined;
  if (!op) return undefined;
  if (op === "record" && typeof args?.round === "number") return `record round ${args.round}`;
  if (op === "conclude" && typeof args?.conclusion === "string") return `conclude ${args.conclusion}`;
  return op;
}

interface CardHead {
  target?: string;
  note?: string;
  status: TspCardStatus;
  tone?: TspTone;
}

/**
 * Tern frames the body under its generic tool card head (the tool's label and an args summary); the terminal's
 * custom-tool box draws no head, so there the body sits under an inline head naming the operation and its state.
 * In Tern a first `facts` row keeps what that generic head lacks: the outcome note in its tone.
 */
function card(head: CardHead, body: readonly JSXNode[]): UiNode | undefined {
  if (nativeRendering()) {
    const facts = head.note
      ? h("row", { key: "facts", gap: "sm" }, h("badge", { text: head.note, tone: head.tone ?? VERDICT_TONE[head.note] ?? "accent" }))
      : undefined;
    return facts || body.length > 0 ? h("col", {}, facts, ...body) : undefined;
  }
  return h(
    "tool",
    {
      name: TOOL,
      title: TITLE,
      frame: "inline",
      status: head.status,
      ...(head.target ? { target: head.target, targetKind: "text" as const } : {}),
      ...(head.note ? { note: head.note } : {}),
      ...(head.tone ? { tone: head.tone } : {}),
    },
    ...body,
  );
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

const VERDICT_TONE: Record<string, TspTone> = { "threshold-ready": "success", "cap-reached": "warning" };

function stateValue(details: RoundCardDetails): TspText {
  if (details.conclusion) {
    const tone = details.conclusion.kind === "threshold-convergence" ? "success" : "warning";
    return [span(details.conclusion.kind, `${tone} strong`)];
  }
  if (details.capPending) return [span("round limit reached", "warning strong")];
  if (details.verdict) return [span(details.verdict, VERDICT_TONE[details.verdict] ?? "accent")];
  return [span(details.ended ? "ended" : "in progress", "muted")];
}

function factSection(label: string, source: string, key: string): UiNode {
  return h("section", { key, head: [span(label, "muted")] }, h("md", { text: source }));
}

/** Only facts belonging to this change; the full ledger stays in the folded receipt. */
function operationFacts(details: RoundCardDetails): JSXNode[] {
  const round = details.op === "record" ? details.round : undefined;
  const conclusion = details.op === "conclude" || details.op === "extend" ? details.conclusion : undefined;
  return [
    round?.coverage ? factSection("Coverage", round.coverage, "coverage") : undefined,
    round?.checks ? factSection("Checks", round.checks, "checks") : undefined,
    ...(round?.findings ?? []).map((finding) =>
      h(
        "section",
        { key: `finding-${finding.id}`, head: [span(finding.id, "strong"), span(` · ${finding.severity} · ${finding.status}`, "muted")] },
        h("md", { text: finding.summary }),
        kv([["Origin", finding.origin]]),
        factSection("Evidence", finding.evidence, "evidence"),
        finding.resolution ? factSection("Resolution", finding.resolution, "resolution") : undefined,
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
  ];
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

/** The full receipt, folded in Tern; the terminal cannot unfold a section, so it shows it open once the card is expanded. */
function receipt(body: string): UiNode {
  return h(
    "section",
    { key: "model-text", head: [span("Model text", "muted")], collapsible: true, collapsed: nativeRendering() },
    ...modelTextNodes(body),
  );
}

function renderResult(result: ResultLike, args: RoundArgs | undefined, expanded: boolean): UiNode | undefined {
  const body = resultText(result);
  const folded = expanded && body ? receipt(body) : undefined;
  if (result.isError || !isCardDetails(result.details)) {
    return card(
      {
        target: callTarget(args),
        status: result.isError ? "error" : "done",
        ...(result.isError ? { note: "refused", tone: "error" } : {}),
      },
      [
        h("text", { text: summary(body) || (result.isError ? "Audit operation refused." : "Audit operation completed."), wrap: "word" }),
        folded,
      ],
    );
  }
  const d = result.details;
  const open = d.open.critical + d.open.major + d.open.minor + d.open.picky;
  const round = d.op === "record" ? d.round : undefined;
  const tone: TspTone | undefined = d.capPending ? "warning" : d.conclusion?.kind === "threshold-convergence" ? "success" : undefined;
  const note = d.verdict ?? (d.capPending ? "round limit reached" : d.conclusion?.kind);
  return card({ target: callTarget(args ?? { op: d.op }), status: "done", ...(note ? { note } : {}), ...(tone ? { tone } : {}) }, [
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
    folded,
  ]);
}

/** `audit_round` render hooks: once a result exists only the result draws. */
export const roundCard = {
  renderCall: (args: RoundArgs | undefined) => card({ target: callTarget(args), status: "running" }, []),
  renderResult: (result: ResultLike, options: ToolRenderResultOptions, _theme: unknown, args?: RoundArgs) =>
    renderResult(result, args, options.expanded),
  mergeCallAndResult: true,
};
