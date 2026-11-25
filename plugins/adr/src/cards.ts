import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspText, TspTone } from "@oh-my-pi/pi-wire";

import type { Diagnostic } from "#src/check.ts";
import { STATUS_TONE } from "#src/console.ts";
import { type AdrStatus, STATUSES } from "#src/documents.ts";
import type { AdrDetail, AdrListEntry, Receipt, ReceiptView } from "#src/tools.ts";
import { h, kv, span } from "#src/tsp.ts";

/**
 * Cards for the adr_* tools and the plugin's displayed messages, drawn by the terminal and by Tern. The terminal's
 * custom-tool box has no head of its own, so there a card starts with its head line; Tern draws the host's tool head
 * and gets the body alone. The hooks run inside a reactive computation, so a card redraws when Tern attaches.
 */

interface CardOptions {
  expanded: boolean;
}
interface CardResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}
type Args = Record<string, unknown> | undefined;

/** The head line: the ADR title, the call's target, then badges, facts and a state note. */
interface Head {
  target?: string;
  badges?: readonly { text: string; tone: TspTone }[];
  meta?: readonly string[];
  note?: string;
}

const TITLE = "ADR";

/** Streaming args arrive partial: only strings that are already there count. */
function str(args: Args, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Outcome tones a card's facts carry: the terminal also colors its title with them. */
function outcome(tone: TspTone | undefined): "error" | "warning" | "success" | undefined {
  return tone === "error" || tone === "warning" || tone === "success" ? tone : undefined;
}

/**
 * The head's facts (badges, counts, note) in the card's outcome tone. Tern's generic tool head already shows the
 * title and the call's target but none of these, so there they lead the body; a failure without facts gets an error badge.
 */
function facts(head: Head, tone: TspTone | undefined, native: boolean): UiNode[] {
  const toned = outcome(tone);
  const badges = [...(head.badges ?? [])];
  if (native && toned === "error" && !badges.length && !head.meta?.length && !head.note) badges.push({ text: "error", tone: "error" });
  return [
    ...badges.map((badge, index) => h("badge", { key: `badge-${index}`, text: badge.text, tone: badge.tone })),
    ...(head.meta?.length ? [h("text", { key: "meta", spans: [span(head.meta.join(" · "), toned ?? "dim")] })] : []),
    ...(head.note ? [h("text", { key: "note", spans: [span(head.note, toned ?? "muted")] })] : []),
  ];
}

function card(head: Head, tone: TspTone | undefined, body: readonly (UiNode | undefined)[] = []): UiNode | undefined {
  const shown = body.filter((child): child is UiNode => child !== undefined);
  const native = nativeRendering();
  const row = facts(head, tone, native);
  if (native) {
    const children = [...(row.length ? [h("row", { key: "facts", gap: "sm", align: "center", wrap: true }, ...row)] : []), ...shown];
    return children.length ? h("col", { key: "card", gap: "sm" }, ...children) : undefined;
  }
  const toned = outcome(tone);
  return h(
    "col",
    { key: "card", gap: "sm" },
    h(
      "row",
      { key: "head", gap: "sm", align: "center" },
      h("text", {
        key: "target",
        spans: [span(TITLE, toned ? `${toned} strong` : "toolTitle strong"), ...(head.target ? [span(` ${head.target}`)] : [])],
        truncate: "end",
      }),
      ...row,
    ),
    ...shown,
  );
}

function prose(value: string, token?: string): UiNode {
  return h("text", { spans: [span(value, token)], wrap: "word" });
}

function resultText(result: CardResult): string {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Receipts from older sessions may predate `view`; anything that is not a receipt falls back to the text. */
function receiptOf(details: unknown): Receipt | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  if (value.ok === true)
    return typeof value.summary === "string" && Array.isArray(value.changedFiles) && Array.isArray(value.warnings)
      ? (value as Receipt)
      : undefined;
  if (value.ok === false) return typeof value.reason === "string" && Array.isArray(value.hints) ? (value as Receipt) : undefined;
  return undefined;
}

function viewOf<K extends ReceiptView["kind"]>(receipt: Receipt, kind: K): Extract<ReceiptView, { kind: K }> | undefined {
  return receipt.view?.kind === kind ? (receipt.view as Extract<ReceiptView, { kind: K }>) : undefined;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** File name first, its directory as the dim detail that gives way first; the full path in the tooltip. */
function filesList(paths: readonly string[], key: string): UiNode {
  return h(
    "list",
    { key, role: "omp.adr.files" },
    paths.map((path) => {
      const slash = path.lastIndexOf("/");
      return h("item", {
        key: path,
        label: slash >= 0 ? path.slice(slash + 1) : path,
        ...(slash > 0 ? { detail: path.slice(0, slash) } : {}),
        icon: "file",
        title: path,
      });
    }),
  );
}

function warningsSection(warnings: readonly string[]): UiNode | undefined {
  if (!warnings.length) return undefined;
  return h(
    "section",
    { key: "warnings", head: [span(warnings.length === 1 ? "Warning" : plural(warnings.length, "warning"), "warning strong")] },
    warnings.map((warning) => prose(warning, "warning")),
  );
}

/** Refusals and errors: the reason in the error tone, then the hints. */
function failureCard(head: Head, receipt: Extract<Receipt, { ok: false }>): UiNode | undefined {
  return card(head, "error", [prose(receipt.reason, "error"), ...receipt.hints.map((hint) => prose(hint, "muted"))]);
}

/** No receipt to read: the result text as markdown, in the error tone for failures. */
function textCard(head: Head, result: CardResult): UiNode | undefined {
  const body = resultText(result);
  return card(head, result.isError ? "error" : undefined, body ? [h("md", { text: body })] : []);
}

function statusSpan(status: AdrStatus) {
  return span(status, STATUS_TONE[status]);
}

function countsMeta(counts: Partial<Record<AdrStatus, number>>): string[] {
  const parts = STATUSES.filter((status) => (counts[status] ?? 0) > 0).map((status) => `${counts[status]} ${status}`);
  return parts.length ? [parts.join(" · ")] : [];
}

function adrTable(adrs: readonly AdrListEntry[]): UiNode {
  const staged = adrs.some((adr) => adr.stage);
  return h("table", {
    key: "adrs",
    role: "omp.adr.list",
    cols: [
      { id: "id", head: "ADR" },
      { id: "title", head: "Title", grow: 1, truncate: "end" },
      { id: "status", head: "Status" },
      { id: "date", head: "Date", priority: 1 },
      ...(staged ? [{ id: "stage", head: "Stage", priority: 0 }] : []),
    ],
    rows: adrs.map((adr) => ({
      id: adr.id,
      cells: {
        id: [span(adr.id, "strong")],
        title: adr.superseded_by ? [span(adr.title), span(` → ${adr.superseded_by}`, "muted")] : adr.title,
        status: [statusSpan(adr.status)],
        date: [span(adr.date, "muted")],
        ...(staged ? { stage: adr.stage ?? "" } : {}),
      },
    })),
  });
}

function listBody(view: Extract<ReceiptView, { kind: "list" }>, warnings: readonly string[]): Array<UiNode | undefined> {
  return [
    view.legacy
      ? prose(`${plural(view.legacy, "file")} still in the legacy roadmap format; the next write of each converts it.`, "muted")
      : undefined,
    view.adrs.length ? adrTable(view.adrs) : prose(view.status ? `No ${view.status} ADRs.` : "No ADRs yet.", "muted"),
    warningsSection(warnings),
  ];
}

function adrBody(adr: AdrDetail, warnings: readonly string[], expanded: boolean): Array<UiNode | undefined> {
  const ids = (values: readonly string[]) => (values.length ? values.join(", ") : undefined);
  const people = (values: readonly string[]) => (values.length ? values.join("; ") : undefined);
  const chain: TspText = adr.chain.flatMap((link, index) => [
    ...(index ? [span(" → ", "muted")] : []),
    span(link.id, link.id === adr.id ? "strong" : undefined),
    span(` ${link.status}`, STATUS_TONE[link.status]),
  ]);
  return [
    kv([
      ["Title", adr.title],
      ["Status", [statusSpan(adr.status)]],
      ["Date", adr.date],
      ["Stage", adr.stage],
      ["File", [span(adr.path, "path"), ...(adr.legacy ? [span(" legacy roadmap format", "muted")] : [])]],
      ["Supersedes", ids(adr.supersedes)],
      ["Superseded by", adr.superseded_by],
      ["Chain", chain],
      ["Decision-makers", people(adr.decision_makers)],
      ["Consulted", people(adr.consulted)],
      ["Informed", people(adr.informed)],
    ]),
    h(
      "section",
      { key: "record", head: [span("Decision record", "toolTitle")], collapsible: true, collapsed: !expanded },
      h("md", { text: adr.body }),
    ),
    warningsSection(warnings),
  ];
}

function statusTarget(args: Args): string {
  const id = str(args, "id");
  if (id) return id;
  const status = str(args, "status");
  return status ? `list ${status}` : "list";
}

function statusResult(result: CardResult, options: CardOptions, args: Args): UiNode | undefined {
  const target = statusTarget(args);
  const receipt = receiptOf(result.details);
  if (!receipt) return textCard({ target }, result);
  if (!receipt.ok) return failureCard({ target }, receipt);
  const adr = viewOf(receipt, "adr")?.adr;
  if (adr)
    return card({ target: adr.id, badges: [{ text: adr.status, tone: STATUS_TONE[adr.status] }] }, undefined, [
      ...adrBody(adr, receipt.warnings, options.expanded),
    ]);
  const listed = viewOf(receipt, "list");
  if (listed) {
    const shown = listed.status ? listed.adrs.length : undefined;
    return card(
      { target, meta: shown !== undefined ? [plural(shown, listed.status ?? "ADR")] : countsMeta(listed.counts) },
      undefined,
      listBody(listed, receipt.warnings),
    );
  }
  return textCard({ target }, result);
}

const STATUS_VERBS: Record<string, string> = {
  proposed: "propose",
  accepted: "accept",
  rejected: "reject",
  deprecated: "deprecate",
};

function manageTarget(args: Args): string {
  const action = str(args, "action");
  const id = str(args, "id");
  const title = str(args, "title");
  switch (action) {
    case "create":
      return title ? `create “${title}”` : "create";
    case "set_status": {
      const status = str(args, "status");
      return [(status && STATUS_VERBS[status]) ?? "set status", id].filter(Boolean).join(" ");
    }
    case "link": {
      const stage = str(args, "stage");
      return [`link${id ? ` ${id}` : ""}`, stage ? `→ ${stage}` : undefined].filter(Boolean).join(" ");
    }
    case "revise":
    case "supersede":
    case "note":
      return id ? `${action} ${id}` : action;
    default:
      return action ?? "manage";
  }
}

function manageResult(result: CardResult, args: Args): UiNode | undefined {
  const target = manageTarget(args);
  const receipt = receiptOf(result.details);
  if (!receipt) return textCard({ target }, result);
  if (!receipt.ok) return failureCard({ target }, receipt);
  const ids = viewOf(receipt, "write")?.ids ?? [];
  const files = receipt.changedFiles;
  const unchanged = !files.length;
  return card(
    {
      target,
      badges: ids.map((id) => ({ text: id, tone: "accent" })),
      ...(unchanged ? { note: "unchanged" } : { meta: [plural(files.length, "file")] }),
    },
    unchanged ? "muted" : undefined,
    [
      prose(receipt.summary, unchanged ? "muted" : "strong"),
      files.length ? filesList(files, "changed") : undefined,
      files.length ? prose("Commit these files per the project's rules.", "muted") : undefined,
      warningsSection(receipt.warnings),
    ],
  );
}

const SEVERITY_ICON: Record<Diagnostic["severity"], string> = { error: "x-circle", warning: "warn" };

function diagnosticsList(diagnostics: readonly Diagnostic[]): UiNode {
  return h(
    "list",
    { key: "diagnostics", role: "omp.adr.diagnostics" },
    diagnostics.map((diagnostic, index) =>
      h("item", {
        key: `d${index}`,
        label: diagnostic.message,
        detail: `${diagnostic.path} · ${diagnostic.rule}`,
        icon: SEVERITY_ICON[diagnostic.severity],
        tone: diagnostic.severity === "error" ? "error" : "warning",
        title: `${diagnostic.severity}: ${diagnostic.rule} — ${diagnostic.path}: ${diagnostic.message}${diagnostic.fixable ? " (fix: true repairs it)" : ""}`,
      }),
    ),
  );
}

function severityMeta(diagnostics: readonly Diagnostic[]): string[] {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return [errors ? plural(errors, "error") : undefined, warnings ? plural(warnings, "warning") : undefined].filter(
    (part): part is string => part !== undefined,
  );
}

function checkTarget(args: Args): string {
  return args?.fix === true ? "check, fix index" : "check";
}

function checkResult(result: CardResult, args: Args): UiNode | undefined {
  const target = checkTarget(args);
  const receipt = receiptOf(result.details);
  if (!receipt) return textCard({ target }, result);
  const diagnostics = viewOf(receipt, "check")?.diagnostics;
  if (!diagnostics) return receipt.ok ? textCard({ target }, result) : failureCard({ target }, receipt);
  const head = { target, meta: severityMeta(diagnostics) };
  if (!receipt.ok) return card(head, "error", [diagnosticsList(diagnostics), ...receipt.hints.map((hint) => prose(hint, "muted"))]);
  const regenerated = receipt.changedFiles;
  return card(head, diagnostics.length ? "warning" : "success", [
    prose(regenerated.length ? "Regenerated the ADR index; ADR check passed." : "ADR check passed.", "success"),
    diagnostics.length ? diagnosticsList(diagnostics) : undefined,
    regenerated.length ? filesList(regenerated, "regenerated") : undefined,
  ]);
}

export const statusCard = {
  renderCall: (args: Args) => card({ target: statusTarget(args) }, undefined),
  renderResult: (result: CardResult, options: CardOptions, _theme: unknown, args?: Args) => statusResult(result, options, args),
  mergeCallAndResult: true,
};

export const manageCard = {
  renderCall: (args: Args) => card({ target: manageTarget(args) }, undefined),
  renderResult: (result: CardResult, _options: CardOptions, _theme: unknown, args?: Args) => manageResult(result, args),
  mergeCallAndResult: true,
};

export const checkCard = {
  renderCall: (args: Args) => card({ target: checkTarget(args) }, undefined),
  renderResult: (result: CardResult, _options: CardOptions, _theme: unknown, args?: Args) => checkResult(result, args),
  mergeCallAndResult: true,
};

/** Titles for the displayed messages; the customType values themselves are persisted and stay as they are. */
export const MESSAGE_TITLES: Readonly<Record<string, string>> = {
  "wows-omp-adr.init": "ADR init",
  "wows-omp-adr.confirm": "ADR init",
  "wows-omp-adr.list": "ADRs",
  "wows-omp-adr.show": "ADR",
  "wows-omp-adr.status": "ADR status",
  "wows-omp-adr.note": "ADR note",
  "wows-omp-adr.check": "ADR check",
  "wows-omp-adr.notice": "ADR",
};

/** The host's message card with a readable title in place of the customType, in Tern and plain terminals alike. */
export function registerMessageTitles(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  for (const [customType, title] of Object.entries(MESSAGE_TITLES)) {
    pi.registerMessageRenderer(customType, (message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      return h("card", { head: [span(title, "customMessageLabel strong")] }, h("md", { text }));
    });
  }
}
