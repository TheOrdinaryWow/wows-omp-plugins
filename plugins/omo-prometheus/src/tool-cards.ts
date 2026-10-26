/**
 * Native Tern cards for the plugin's tools and titles for its displayed messages. Plain terminals keep the host's
 * default tool rendering: these tools define no renderCall/renderResult, so only the TSP describe hooks change.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { code, compact, item, list, md, node, span, text } from "@oh-my-pi/pi-tui";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { NativeToolHead, NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";

import {
  type ExecutionLedger,
  type ItemStatus,
  type LedgerItem,
  type Tier,
  type VerificationStatus,
  verificationStatus,
} from "./ledger.ts";

type Tone = NonNullable<NativeToolView["tone"]>;

/** The result shape the describe hooks receive; text blocks carry what the model reads. */
interface CardResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

/** One ledger row as a result card shows it. */
export interface LedgerCardRow {
  id: string;
  title: string;
  status: ItemStatus;
  agent: string;
  tier?: Tier;
  verification?: VerificationStatus;
}

/** Finished rows of the whole plan. */
export interface LedgerCardProgress {
  done: number;
  total: number;
}

/** Card fields an `atlas_ledger` result adds to its details. */
export interface LedgerCardDetails {
  row?: LedgerCardRow;
  finding?: { id: string; title: string; disposition?: string };
  progress: LedgerCardProgress;
}

/** Card fields an `atlas_git` result adds to its details. */
export interface GitCardDetails {
  action: string;
  /** A successful commit. */
  commit?: { sha: string; subject: string };
}

/**
 * Persisted details as the cards read them. Older sessions stored fewer fields, so every field the cards use is
 * checked before use; a missing one falls back to the result text.
 */
type StoredDetails = Partial<LedgerCardDetails & GitCardDetails & { ledger: Partial<ExecutionLedger>; untriaged: unknown[] }>;

/** Streaming arguments: any field may be missing or still incomplete. */
type PartialArgs = Partial<Record<"action" | "id" | "scope" | "disposition" | "revision" | "message" | "reason", unknown>> & {
  paths?: unknown;
  staged?: unknown;
  stat?: unknown;
};

/** Every row, tolerating a persisted ledger from a version without some row groups. */
function cardRows(ledger: Partial<ExecutionLedger>): LedgerItem[] {
  return [ledger.items, ledger.discoveries, ledger.fixes, ledger.gates, ledger.deliveries].flatMap((rows) =>
    Array.isArray(rows) ? rows : [],
  );
}

export function ledgerCardRow(row: LedgerItem): LedgerCardRow {
  const verification = verificationStatus(row);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    // A running verifier is the child working the row now.
    agent: (verification === "running" ? row.verification?.dispatchAgent : undefined) ?? row.dispatchAgent ?? row.agent,
    ...(row.tier ? { tier: row.tier } : {}),
    ...(verification ? { verification } : {}),
  };
}

export function ledgerProgress(ledger: Partial<ExecutionLedger>): LedgerCardProgress {
  const rows = cardRows(ledger);
  return { done: rows.filter((row) => row.status === "done").length, total: rows.length };
}

/** A non-empty trimmed string, or undefined for anything else (partial streaming args, older details). */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resultText(result: CardResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n\n")
    .trim();
}

function head(title: string, target?: string, extra: Omit<NativeToolHead, "title" | "target" | "targetKind"> = {}): NativeToolHead {
  return { title, ...(target ? { target, targetKind: "text" as const } : {}), ...extra };
}

/** The text as Markdown, in the error tone for a failed call; for results without card details. */
function textView(title: string, target: string | undefined, result: CardResult, fallback: string): NativeToolView {
  return { tool: head(title, target), tone: result.isError ? "error" : undefined, body: [md(resultText(result) || fallback)] };
}

const memo = new OwnerMemo<NativeToolView>();

/** One view per result content, rebuilt only when its inputs change. */
function memoized(result: CardResult, deps: readonly unknown[], build: () => NativeToolView): NativeToolView {
  return memo.get(result.content, [result.details, result.isError, ...deps], build);
}

// ── atlas_ledger ──────────────────────────────────────────────────────────

const LEDGER_TITLE = "Atlas Ledger";

const STATUS: Record<ItemStatus, { word: string; tone: Tone }> = {
  open: { word: "open", tone: "muted" },
  in_progress: { word: "in progress", tone: "accent" },
  done: { word: "done", tone: "success" },
  blocked: { word: "blocked", tone: "warning" },
};

function rowState(row: LedgerCardRow): { word: string; tone: Tone } {
  if (row.status === "in_progress" && row.verification === "running") return { word: "verifying", tone: "accent" };
  if (row.status === "open" && row.verification === "failed") return { word: "verification failed", tone: "warning" };
  return STATUS[row.status] ?? { word: String(row.status), tone: "muted" };
}

/** `start T3`, `discover in T2`, `triage O1 todo`; undefined until the action has streamed in. */
function ledgerTarget(args: PartialArgs | undefined): string | undefined {
  const action = str(args?.action);
  if (!action) return undefined;
  const scope = action === "discover" ? str(args?.scope) : undefined;
  const disposition = action === "triage" ? str(args?.disposition) : undefined;
  return compact([action, scope, str(args?.id), disposition]).join(" ");
}

function rowItem(row: LedgerCardRow): NativeNode {
  const state = rowState(row);
  const facts = compact([row.agent, row.tier === "heavy" ? "HEAVY" : undefined]).join(" · ");
  return item(row.id, {
    label: [span(row.id, "strong"), span(" "), span(row.title)],
    detail: [span(state.word, state.tone), ...(facts ? [span(` · ${facts}`, "muted")] : [])],
  });
}

function progressBar(progress: LedgerCardProgress): NativeNode {
  return node("progress", {
    value: progress.total ? progress.done / progress.total : 0,
    label: `${progress.done}/${progress.total} rows done`,
  });
}

function describeLedgerResult(result: CardResult, expanded: boolean, args: PartialArgs | undefined): NativeToolView {
  const target = ledgerTarget(args);
  if (result.isError) return textView(LEDGER_TITLE, target, result, "Ledger operation refused.");
  const details = result.details as StoredDetails | undefined;
  if (typeof details?.ledger === "object" && details.ledger !== null) {
    // status: the whole plan; its text repeats the same table with proofs.
    const progress = ledgerProgress(details.ledger);
    return {
      tool: head(LEDGER_TITLE, target ?? "status", { meta: [`${progress.done}/${progress.total} done`] }),
      body: [progressBar(progress), list(cardRows(details.ledger).map((row) => rowItem(ledgerCardRow(row))))],
    };
  }
  const progress = details?.progress;
  const changed = typeof details?.row?.id === "string" ? details.row : undefined;
  const finding = typeof details?.finding?.id === "string" ? details.finding : undefined;
  if (typeof progress?.done !== "number" || typeof progress.total !== "number" || (!changed && !finding)) {
    return textView(LEDGER_TITLE, target, result, "(no output)");
  }
  const state = changed ? rowState(changed) : undefined;
  const guidance = resultText(result);
  return {
    tool: head(LEDGER_TITLE, target, {
      meta: [`${progress.done}/${progress.total} done`],
      ...(state ? { badges: [{ text: state.word, tone: state.tone }] } : {}),
    }),
    tone: state?.tone === "warning" ? "warning" : undefined,
    body: compact<NativeChild>([
      list([
        changed
          ? rowItem(changed)
          : item(finding?.id ?? "", {
              label: [span(finding?.id ?? "", "strong"), span(" "), span(finding?.title ?? "")],
              detail: finding?.disposition
                ? [span(`triaged: ${finding.disposition}`, "success")]
                : [span("deferred, needs triage", "warning")],
            }),
      ]),
      progressBar(progress),
      // The model's guidance repeats on every call during a run: folded until the user expands the card.
      guidance
        ? node("section", { head: [span("Guidance", "muted")], collapsible: true, collapsed: !expanded }, [md(guidance)], "guidance")
        : undefined,
    ]),
    preview: "none",
  };
}

export const ledgerCard = {
  describeCall(args: PartialArgs | undefined): NativeToolView {
    return { tool: head(LEDGER_TITLE, ledgerTarget(args)) };
  },
  describeResult(result: CardResult, options: RenderResultOptions, args?: PartialArgs): NativeToolView {
    return memoized(result, [options.expanded, ledgerTarget(args)], () => describeLedgerResult(result, options.expanded, args));
  },
  mergeCallAndResult: true,
};

// ── atlas_git ─────────────────────────────────────────────────────────────

const GIT_TITLE = "Atlas Git";

function gitPaths(args: PartialArgs | undefined): string[] {
  return Array.isArray(args?.paths) ? args.paths.flatMap((path) => str(path) ?? []) : [];
}

function gitHead(args: PartialArgs | undefined, commit?: GitCardDetails["commit"]): NativeToolHead {
  const action = str(args?.action);
  const paths = gitPaths(args);
  if (action === "commit") {
    return head(GIT_TITLE, commit ? `commit ${commit.sha.slice(0, 7)}` : "commit", {
      meta: paths.length ? [paths.length === 1 ? "1 file" : `${paths.length} files`] : undefined,
    });
  }
  const target = compact([action, str(args?.revision), args?.staged === true && "staged", args?.stat === true && "stat"]).join(" ");
  return head(GIT_TITLE, target || undefined, { meta: paths.length ? [`in ${paths.join(", ")}`] : undefined });
}

function describeGitResult(result: CardResult, args: PartialArgs | undefined): NativeToolView {
  const output = resultText(result);
  if (result.isError)
    return { tool: gitHead(args), tone: "error", body: [text([span(output || "Git refused.", "error")], { wrap: "word" })] };
  const commit = (result.details as StoredDetails | undefined)?.commit;
  if (typeof commit?.sha === "string" && typeof commit.subject === "string") {
    const paths = gitPaths(args);
    return {
      tool: gitHead(args, commit),
      tone: "success",
      body: compact([
        text([span(commit.subject, "strong")], { wrap: "word" }),
        paths.length ? list(paths.map((path) => item(path, { label: path }))) : undefined,
      ]),
    };
  }
  const action = str(args?.action);
  const patch = (action === "diff" || action === "show") && args?.stat !== true;
  return { tool: gitHead(args), body: [code(output || "(no output)", patch ? { lang: "diff" } : {})] };
}

export const gitCard = {
  describeCall(args: PartialArgs | undefined): NativeToolView {
    const message = str(args?.action) === "commit" ? str(args?.message)?.split("\n")[0] : undefined;
    return { tool: gitHead(args), body: message ? [text([span(message, "muted")], { wrap: "word" })] : undefined };
  },
  describeResult(result: CardResult, _options: RenderResultOptions, args?: PartialArgs): NativeToolView {
    return memoized(result, [args], () => describeGitResult(result, args));
  },
  mergeCallAndResult: true,
};

// ── atlas_release / prometheus_activate ───────────────────────────────────

const RELEASE_TITLE = "Atlas Release";

export const releaseCard = {
  describeCall(args: PartialArgs | undefined): NativeToolView {
    const reason = str(args?.reason);
    return { tool: head(RELEASE_TITLE), body: reason ? [text([span(reason, "muted")], { wrap: "word" })] : undefined };
  },
  describeResult(result: CardResult, _options: RenderResultOptions): NativeToolView {
    return memoized(result, [], () => {
      if (!result.isError) return { ...textView(RELEASE_TITLE, "released", result, "Atlas released."), tone: "success" };
      const untriaged = (result.details as StoredDetails | undefined)?.untriaged;
      const count = Array.isArray(untriaged) ? untriaged.length : 0;
      return {
        ...textView(RELEASE_TITLE, "refused", result, "Release refused."),
        tool: head(RELEASE_TITLE, "refused", { meta: count ? [`${count} untriaged`] : undefined }),
      };
    });
  },
  mergeCallAndResult: true,
};

const ACTIVATE_TITLE = "Prometheus Activate";

export const activateCard = {
  describeCall(): NativeToolView {
    return { tool: head(ACTIVATE_TITLE) };
  },
  describeResult(result: CardResult, _options: RenderResultOptions): NativeToolView {
    return memoized(result, [], () =>
      result.isError
        ? textView(ACTIVATE_TITLE, "refused", result, "Activation refused.")
        : { ...textView(ACTIVATE_TITLE, "activated", result, "Prometheus activated."), tone: "success" },
    );
  },
  mergeCallAndResult: true,
};

// ── message titles ────────────────────────────────────────────────────────

/** Shows a displayed message in the host's own frame, labelled with a product title instead of its persisted customType. */
export function registerMessageTitle(pi: ExtensionAPI, customType: string, title: string): void {
  pi.registerMessageRenderer(customType, (message, options) => {
    const component = new CustomMessageComponent({ ...message, customType: title });
    component.setExpanded(options.expanded);
    return component;
  });
}
