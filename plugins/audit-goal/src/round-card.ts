import type { NativeChild } from "@oh-my-pi/pi-tui";
import { compact, kv, md, span, text } from "@oh-my-pi/pi-tui";
import type { NativeToolHead, NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";

import { type AuditState, limitLabel, remainingFindings } from "#src/ledger.ts";

/** Structured `audit_round` result details; the text content stays the model-facing receipt. */
export interface RoundCardDetails {
  op: string;
  intensity: string;
  rounds: number;
  roundLimit: string;
  /** The round this call recorded, or the latest one. */
  round?: { round: number; auditorModels: string[]; critical: number; major: number; minor: number; picky: number };
  open: { critical: number; major: number; minor: number; picky: number };
  verdict?: string;
  capPending: boolean;
  conclusion?: { kind: string; reason: string };
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
          },
        }
      : {}),
    open: remainingFindings(state.rounds).counts,
    ...(verdict ? { verdict } : {}),
    capPending: state.capPending,
    ...(state.conclusion ? { conclusion: { kind: state.conclusion.kind, reason: state.conclusion.reason } } : {}),
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

const memo = new WeakMap<object, NativeToolView>();

export function describeRoundResult(result: ResultLike, args: RoundArgs | undefined): NativeToolView {
  const cached = memo.get(result);
  if (cached) return cached;
  const body = resultText(result);
  let view: NativeToolView;
  if (result.isError) {
    view = { tool: head(args, "refused"), tone: "error", body: body ? [md(body)] : [] };
  } else if (!isCardDetails(result.details)) {
    view = { tool: head(args), body: body ? [md(body)] : [], preview: { lines: 12 } };
  } else {
    const d = result.details;
    const open = d.open.critical + d.open.major + d.open.minor + d.open.picky;
    const children: (NativeChild | undefined)[] = [
      kv([
        ["Round", d.round ? `${d.round.round} of ${d.roundLimit}` : `0 of ${d.roundLimit}`],
        ["Auditors", d.round?.auditorModels.join(", ")],
        ["Found", d.round ? counts(d.round) : undefined],
        ["Open", open > 0 ? [span(counts(d.open), "warning")] : [span("none", "success")]],
        ["State", stateValue(d)],
        ["Reason", d.conclusion?.reason],
        ["Intensity", d.intensity],
      ]),
      body ? text([span("Receipt", "dim")]) : undefined,
      body ? md(body) : undefined,
    ];
    view = {
      tool: head(args ?? { op: d.op }, d.verdict),
      tone: d.capPending ? "warning" : d.conclusion?.kind === "threshold-convergence" ? "success" : undefined,
      body: compact(children),
      preview: { lines: 14 },
    };
  }
  memo.set(result, view);
  return view;
}
