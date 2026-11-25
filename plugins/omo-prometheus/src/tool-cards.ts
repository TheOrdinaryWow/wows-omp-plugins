/**
 * Cards for the plugin's tools and titles for its displayed messages. The terminal's tool box draws no head, so there
 * the render hooks draw a head row above the body; Tern draws the host's own tool head, so there they return the body.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type JSXNode, nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspTone } from "@oh-my-pi/pi-wire";

import { h, kv, span } from "#src/tsp.ts";

import {
  countedFailures,
  type ExecutionLedger,
  effectiveAcceptance,
  effectiveTimeLimitHours,
  type ItemStatus,
  isPrerequisiteSatisfied,
  type LedgerItem,
  type OwnerRuling,
  type RetryWindow,
  retryWindow,
  type Tier,
  type VerificationStatus,
  verificationStatus,
} from "./ledger.ts";
import { modelTextNodes } from "./model-text.ts";

type Tone = TspTone;

/** The result shape the render hooks receive; text blocks carry what the model reads. */
interface CardResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface CardOptions {
  expanded: boolean;
}

/** What a card's head row names: the tool, what the call acts on, short facts and state badges. */
interface CardHead {
  title: string;
  target?: string;
  meta?: readonly string[];
  badges?: readonly { text: string; tone?: Tone }[];
}

interface CardView {
  head: CardHead;
  tone?: Tone;
  body?: readonly JSXNode[];
}

/** One ledger row as a result card shows it. Fields after `verification` are absent in results from older versions. */
export interface LedgerCardRow {
  id: string;
  title: string;
  status: ItemStatus;
  agent: string;
  tier?: Tier;
  verification?: VerificationStatus;
  /** The acceptance in force; `amendedBy` names the owner ruling that set it. */
  acceptance?: string;
  amendedBy?: string;
  evidence?: string;
  timeLimitHours?: number;
  /** The current retry window, once it has recorded a failure or a later window was granted. */
  retry?: { window: number; counted: number; diagnostics: number; stop?: NonNullable<RetryWindow["stop"]>["reason"] };
}

/** Finished rows of the whole plan. */
export interface LedgerCardProgress {
  done: number;
  total: number;
  /** Open rows whose prerequisites permit dispatch; absent in results from older versions. */
  next?: string[];
}

/** Card fields an `atlas_ledger` result adds to its details. */
export interface LedgerCardDetails {
  row?: LedgerCardRow;
  finding?: { id: string; title: string; disposition?: string };
  /** `amend`: the owner ruling just recorded for `row`. */
  ruling?: OwnerRuling;
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

/** The fields every row list shows. */
export function rowSummary(row: LedgerItem): LedgerCardRow {
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

/** A changed row with the facts its expanded card shows. */
export function ledgerCardRow(ledger: ExecutionLedger, row: LedgerItem): LedgerCardRow {
  const accepted = effectiveAcceptance(ledger, row);
  const window = retryWindow(row);
  const windows = row.retry?.windows.length ?? 0;
  const evidence = row.evidence?.trim();
  return {
    ...rowSummary(row),
    acceptance: accepted.text,
    ...(accepted.ruling ? { amendedBy: accepted.ruling.id } : {}),
    ...(evidence ? { evidence } : {}),
    timeLimitHours: effectiveTimeLimitHours(row),
    ...(window && (window.failures.length > 0 || window.stop || windows > 1)
      ? {
          retry: {
            window: windows,
            counted: countedFailures(window).length,
            diagnostics: window.failures.length,
            ...(window.stop ? { stop: window.stop.reason } : {}),
          },
        }
      : {}),
  };
}

export function ledgerProgress(ledger: Partial<ExecutionLedger>): LedgerCardProgress {
  const rows = cardRows(ledger);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const done = rows.filter((row) => row.status === "done").length;
  const next = rows
    .filter((row) => row.status === "open" && (row.dependsOn ?? []).every((id) => isPrerequisiteSatisfied(row, byId.get(id))))
    .map((row) => row.id);
  return { done, total: rows.length, next };
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

/** Values that are set, for joining optional facts. */
function present<T>(values: readonly (T | undefined | false | null | "")[]): T[] {
  return values.filter((value): value is T => value !== undefined && value !== false && value !== null && value !== "");
}

function head(title: string, target?: string, extra: Omit<CardHead, "title" | "target"> = {}): CardHead {
  return { title, ...(target ? { target } : {}), ...extra };
}

/** The text as Markdown, in the error tone for a failed call; for results without card details. */
function textView(title: string, target: string | undefined, result: CardResult, fallback: string): CardView {
  return {
    head: head(title, target),
    tone: result.isError ? "error" : undefined,
    body: [h("md", { text: resultText(result) || fallback })],
  };
}

/**
 * The card's node: a head row, then the body. In a terminal the head row names the tool and its target; in Tern the
 * host's own tool head already does, so the row keeps only the badges and facts, and a card with neither and no body
 * draws nothing. Read on every hook call, so the card follows Tern attaching or detaching. A failed call reads in the
 * error tone.
 */
function card(view: CardView): UiNode | undefined {
  const body = view.body ?? [];
  const { title, target, meta, badges } = view.head;
  const native = nativeRendering();
  const facts = [
    ...(badges ?? []).map((badge) => h("badge", { text: badge.text, tone: badge.tone })),
    meta?.length ? h("text", { spans: [span(meta.join(" · "), "muted")] }) : undefined,
  ].filter((node) => node !== undefined);
  if (native && !facts.length && !body.length) return undefined;
  const titleStyle = view.tone === "error" ? "error strong" : "toolTitle strong";
  const name = native ? undefined : h("text", { spans: [span(title, titleStyle), ...(target ? [span(` ${target}`, "accent")] : [])] });
  const row = name || facts.length ? h("row", { key: "head", gap: "sm", align: "center", wrap: true }, name, ...facts) : undefined;
  return h("col", { gap: "sm", tone: view.tone }, row, ...body);
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

/** `start T3`, `discover in T2`, `triage O1 todo`, `amend T1`; undefined until the action has streamed in. */
function ledgerTarget(args: PartialArgs | undefined): string | undefined {
  const action = str(args?.action);
  if (!action) return undefined;
  const scope = action === "discover" ? str(args?.scope) : undefined;
  const disposition = action === "triage" ? str(args?.disposition) : undefined;
  return present([action, scope, str(args?.id), disposition]).join(" ");
}

function rowItem(row: LedgerCardRow): UiNode {
  const state = rowState(row);
  const facts = present([row.agent, row.tier === "heavy" ? "HEAVY" : undefined]).join(" · ");
  return h("item", {
    key: row.id,
    label: [span(row.id, "strong"), span(" "), span(row.title)],
    detail: [span(state.word, state.tone), ...(facts ? [span(` · ${facts}`, "muted")] : [])],
  });
}

function progressBar(progress: LedgerCardProgress): UiNode {
  return h("progress", {
    value: progress.total ? progress.done / progress.total : 0,
    label: `${progress.done}/${progress.total} rows done`,
  });
}

/** A recorded owner ruling: the acceptance now in force for its row and the user's reason, marked as a plan deviation. */
function rulingSection(ruling: OwnerRuling): UiNode {
  return h(
    "section",
    { key: "ruling", head: [span(ruling.id, "strong"), span(` amends ${ruling.rowId} acceptance`, "warning")] },
    h("md", { text: ruling.acceptance }),
    str(ruling.note) ? h("text", { spans: [span("Note ", "muted"), span(ruling.note)], wrap: "word" }) : undefined,
  );
}

const RETRY_STOP: Record<NonNullable<NonNullable<LedgerCardRow["retry"]>["stop"]>, string> = {
  signature: "same failure twice",
  attempts: "three counted failures",
  elapsed: "time limit reached",
  harness: "harness failed again",
  diverging: "repairs keep surfacing new defects",
};

function retryLine(retry: NonNullable<LedgerCardRow["retry"]>): string {
  return present([
    `window ${retry.window}`,
    `${retry.counted}/3 counted failures`,
    `${retry.diagnostics} ${retry.diagnostics === 1 ? "diagnostic" : "diagnostics"}`,
    retry.stop ? `stopped: ${RETRY_STOP[retry.stop] ?? retry.stop}` : undefined,
  ]).join(" · ");
}

function factSection(label: string, source: string, key: string): UiNode {
  return h("section", { key, head: [span(label, "muted")] }, h("md", { text: source }));
}

/** What an expanded row change adds: that row's acceptance and evidence, its clock and retries, and what can run next. */
function rowFacts(row: LedgerCardRow | undefined, progress: LedgerCardProgress, ruling: OwnerRuling | undefined): JSXNode[] {
  return [
    // An amend card already shows the ruled acceptance in its ruling section.
    row?.acceptance && !ruling
      ? factSection(row.amendedBy ? `Acceptance (amended by ${row.amendedBy})` : "Acceptance", row.acceptance, "acceptance")
      : undefined,
    row?.evidence ? factSection("Evidence", row.evidence, "evidence") : undefined,
    kv([
      ["Time limit", row?.timeLimitHours !== undefined ? `${row.timeLimitHours}h` : undefined],
      ["Retry", row?.retry ? retryLine(row.retry) : undefined],
      ["Next", progress.next ? progress.next.join(", ") || "none" : undefined],
    ]),
  ];
}

function modelTextSection(source: string): UiNode {
  return h(
    "section",
    { key: "model-text", head: [span("Model text", "muted")], collapsible: true, collapsed: true },
    ...modelTextNodes(source),
  );
}

function ledgerResult(result: CardResult, expanded: boolean, args: PartialArgs | undefined): CardView {
  const target = ledgerTarget(args);
  if (result.isError) return textView(LEDGER_TITLE, target, result, "Ledger operation refused.");
  const details = result.details as StoredDetails | undefined;
  if (typeof details?.ledger === "object" && details.ledger !== null) {
    // status: the whole plan; its text repeats the same table with proofs.
    const progress = ledgerProgress(details.ledger);
    return {
      head: head(LEDGER_TITLE, target ?? "status", { meta: [`${progress.done}/${progress.total} done`] }),
      body: [
        progressBar(progress),
        h(
          "list",
          {},
          cardRows(details.ledger).map((row) => rowItem(rowSummary(row))),
        ),
      ],
    };
  }
  const progress = details?.progress;
  const changed = typeof details?.row?.id === "string" ? details.row : undefined;
  const finding = typeof details?.finding?.id === "string" ? details.finding : undefined;
  const ruling = typeof details?.ruling?.id === "string" && typeof details.ruling.acceptance === "string" ? details.ruling : undefined;
  if (typeof progress?.done !== "number" || typeof progress.total !== "number" || (!changed && !finding)) {
    return textView(LEDGER_TITLE, target, result, "(no output)");
  }
  const state = changed ? rowState(changed) : undefined;
  const guidance = resultText(result);
  return {
    head: head(LEDGER_TITLE, target, {
      meta: [`${progress.done}/${progress.total} done`],
      badges: present([
        ruling ? { text: ruling.id, tone: "warning" as const } : undefined,
        state ? { text: state.word, tone: state.tone } : undefined,
      ]),
    }),
    tone: state?.tone === "warning" ? "warning" : undefined,
    body: [
      h(
        "list",
        {},
        changed
          ? rowItem(changed)
          : h("item", {
              key: finding?.id ?? "",
              label: [span(finding?.id ?? "", "strong"), span(" "), span(finding?.title ?? "")],
              detail: finding?.disposition
                ? [span(`triaged: ${finding.disposition}`, "success")]
                : [span("deferred, needs triage", "warning")],
            }),
      ),
      ruling ? rulingSection(ruling) : undefined,
      progressBar(progress),
      ...(expanded ? rowFacts(changed, progress, ruling) : []),
      // The text the model reads repeats the whole plan on every call: folded, for checking what it was told.
      expanded && guidance ? modelTextSection(guidance) : undefined,
    ],
  };
}

export const ledgerCard = {
  renderCall(args: PartialArgs | undefined): UiNode | undefined {
    return card({ head: head(LEDGER_TITLE, ledgerTarget(args)) });
  },
  renderResult(result: CardResult, options: CardOptions, _theme?: unknown, args?: PartialArgs): UiNode | undefined {
    return card(ledgerResult(result, options.expanded, args));
  },
  mergeCallAndResult: true,
};

// ── atlas_git ─────────────────────────────────────────────────────────────

const GIT_TITLE = "Atlas Git";

function gitPaths(args: PartialArgs | undefined): string[] {
  return Array.isArray(args?.paths) ? args.paths.flatMap((path) => str(path) ?? []) : [];
}

function gitHead(args: PartialArgs | undefined, commit?: GitCardDetails["commit"]): CardHead {
  const action = str(args?.action);
  const paths = gitPaths(args);
  if (action === "commit") {
    return head(GIT_TITLE, commit ? `commit ${commit.sha.slice(0, 7)}` : "commit", {
      meta: paths.length ? [paths.length === 1 ? "1 file" : `${paths.length} files`] : undefined,
    });
  }
  const target = present([action, str(args?.revision), args?.staged === true && "staged", args?.stat === true && "stat"]).join(" ");
  return head(GIT_TITLE, target || undefined, { meta: paths.length ? [`in ${paths.join(", ")}`] : undefined });
}

function gitResult(result: CardResult, args: PartialArgs | undefined): CardView {
  // Git aligns columns with leading spaces (`--stat`), so only line ends are trimmed.
  const output = result.content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n\n")
    .replace(/^\n+|\s+$/g, "");
  if (result.isError)
    return { head: gitHead(args), tone: "error", body: [h("text", { spans: [span(output || "Git refused.", "error")], wrap: "word" })] };
  const commit = (result.details as StoredDetails | undefined)?.commit;
  if (typeof commit?.sha === "string" && typeof commit.subject === "string") {
    const paths = gitPaths(args);
    return {
      head: gitHead(args, commit),
      tone: "success",
      body: [
        h("text", { spans: [span(commit.subject, "strong")], wrap: "word" }),
        paths.length
          ? h(
              "list",
              {},
              paths.map((path) => h("item", { key: path, label: path })),
            )
          : undefined,
      ],
    };
  }
  const action = str(args?.action);
  const patch = (action === "diff" || action === "show") && args?.stat !== true;
  return { head: gitHead(args), body: [h("code", { text: output || "(no output)", ...(patch ? { lang: "diff" } : {}) })] };
}

export const gitCard = {
  renderCall(args: PartialArgs | undefined): UiNode | undefined {
    const message = str(args?.action) === "commit" ? str(args?.message)?.split("\n")[0] : undefined;
    return card({
      head: gitHead(args),
      body: message ? [h("text", { spans: [span(message, "muted")], wrap: "word" })] : undefined,
    });
  },
  renderResult(result: CardResult, _options: CardOptions, _theme?: unknown, args?: PartialArgs): UiNode | undefined {
    return card(gitResult(result, args));
  },
  mergeCallAndResult: true,
};

// ── atlas_release / prometheus_activate ───────────────────────────────────

const RELEASE_TITLE = "Atlas Release";

/** Card fields a refused `atlas_release` adds to its details; absent in results from older versions. */
export interface ReleaseCardDetails {
  unfinished?: LedgerCardRow[];
  findings?: { id: string; title: string }[];
  progress?: LedgerCardProgress;
}

/** The refusal's own sentence: the text before the ledger and the instructions that follow it. */
function refusalReason(result: CardResult): string {
  const first =
    resultText(result)
      .split(/\n\s*\n/)[0]
      ?.trim() ?? "";
  return first.replace(/\s*\(.*$/s, "").replace(/\.$/, "") || "Release refused";
}

function releaseRefusal(result: CardResult, expanded: boolean): CardView {
  const details = result.details as (StoredDetails & ReleaseCardDetails) | undefined;
  const unfinished = Array.isArray(details?.unfinished) ? details.unfinished.filter((row) => typeof row?.id === "string") : [];
  const findings = Array.isArray(details?.findings) ? details.findings.filter((finding) => typeof finding?.id === "string") : [];
  // Older results recorded only the untriaged ids.
  const untriaged = findings.length ? findings.length : Array.isArray(details?.untriaged) ? details.untriaged.length : 0;
  const progress = typeof details?.progress?.done === "number" && typeof details.progress.total === "number" ? details.progress : undefined;
  const full = resultText(result);
  const reason = refusalReason(result);
  return {
    head: head(RELEASE_TITLE, "refused", {
      meta: present([progress ? `${progress.done}/${progress.total} done` : undefined, untriaged ? `${untriaged} untriaged` : undefined]),
    }),
    tone: "error",
    body: [
      h("text", { key: "reason", spans: [span(reason, "error")], wrap: "word" }),
      unfinished.length ? h("list", {}, unfinished.map(rowItem)) : undefined,
      findings.length
        ? h(
            "list",
            {},
            findings.map((finding) =>
              h("item", {
                key: finding.id,
                label: [span(finding.id, "strong"), span(" "), span(finding.title)],
                detail: [span("needs triage", "warning")],
              }),
            ),
          )
        : undefined,
      progress ? progressBar(progress) : undefined,
      // The text the model reads also carries the whole ledger: folded, for checking what it was told.
      expanded && full && full !== reason ? modelTextSection(full) : undefined,
    ],
  };
}

export const releaseCard = {
  renderCall(args: PartialArgs | undefined): UiNode | undefined {
    const reason = str(args?.reason);
    return card({ head: head(RELEASE_TITLE), body: reason ? [h("text", { spans: [span(reason, "muted")], wrap: "word" })] : undefined });
  },
  renderResult(result: CardResult, options: CardOptions): UiNode | undefined {
    return card(
      result.isError
        ? releaseRefusal(result, options.expanded)
        : { ...textView(RELEASE_TITLE, "released", result, "Atlas released."), tone: "success" },
    );
  },
  mergeCallAndResult: true,
};

const ACTIVATE_TITLE = "Prometheus Activate";

function activateResult(result: CardResult): CardView {
  if (result.isError) return textView(ACTIVATE_TITLE, "refused", result, "Activation refused.");
  if ((result.details as { activated?: unknown } | undefined)?.activated === false)
    return textView(ACTIVATE_TITLE, "standard planning", result, "Standard planning kept.");
  return { ...textView(ACTIVATE_TITLE, "activated", result, "Prometheus activated."), tone: "success" };
}

export const activateCard = {
  renderCall(): UiNode | undefined {
    return card({ head: head(ACTIVATE_TITLE) });
  },
  renderResult(result: CardResult): UiNode | undefined {
    return card(activateResult(result));
  },
  mergeCallAndResult: true,
};

// ── message titles ────────────────────────────────────────────────────────

/** The text a displayed message carries: its string content, or its text blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n\n");
}

/** Shows a displayed message as a card labelled with a product title instead of its persisted customType. */
export function registerMessageTitle(pi: ExtensionAPI, customType: string, title: string): void {
  pi.registerMessageRenderer(customType, (message) =>
    h("card", { head: [span(title, "strong accent")] }, h("md", { text: messageText(message.content) })),
  );
}
