import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { compact, item, kv, list, md, type NativeChild, type NativeNode, node, span, text } from "@oh-my-pi/pi-tui";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeToolHead, NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";

import type { Diagnostic } from "#src/check.ts";
import { STATUS_TONE } from "#src/console.ts";
import { type AdrStatus, STATUSES } from "#src/documents.ts";
import type { AdrDetail, AdrListEntry, Receipt, ReceiptView } from "#src/tools.ts";

/**
 * Tern's native cards for the adr_* tools and the plugin's displayed messages. Plain terminals keep the host's default
 * text rendering: the tools define no renderCall/renderResult.
 */

type Tone = NonNullable<NativeToolView["tone"]>;
interface CardOptions {
  expanded: boolean;
}
interface CardResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}
type Args = Record<string, unknown> | undefined;

const TITLE = "ADR";

/** Streaming args arrive partial: only strings that are already there count. */
function str(args: Args, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function head(target: string | undefined, extra: Omit<NativeToolHead, "title" | "target"> = {}): NativeToolHead {
  return { title: TITLE, ...(target ? { target, targetKind: "text" as const } : {}), ...extra };
}

function prose(value: string, token?: string): NativeNode {
  return text([span(value, token)], { wrap: "word" });
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
function filesList(paths: readonly string[], key: string): NativeNode {
  return list(
    paths.map((path) => {
      const slash = path.lastIndexOf("/");
      return item(path, {
        label: slash >= 0 ? path.slice(slash + 1) : path,
        detail: slash > 0 ? path.slice(0, slash) : undefined,
        icon: /\.md$/i.test(path) ? "markdown" : "file",
        title: path,
      });
    }),
    { role: "omp.adr.files" },
    key,
  );
}

function warningsSection(warnings: readonly string[]): NativeNode | undefined {
  if (!warnings.length) return undefined;
  return node(
    "section",
    { head: [span(warnings.length === 1 ? "Warning" : plural(warnings.length, "warning"), "warning strong")] },
    warnings.map((warning) => prose(warning, "warning")),
    "warnings",
  );
}

/** Refusals and errors: the reason in the error tone, then the hints. */
function failureView(tool: NativeToolHead, receipt: Extract<Receipt, { ok: false }>): NativeToolView {
  return { tool, tone: "error", body: [prose(receipt.reason, "error"), ...receipt.hints.map((hint) => prose(hint, "muted"))] };
}

/** No receipt to read: the result text as markdown, in the error tone for failures. */
function textView(tool: NativeToolHead, result: CardResult): NativeToolView {
  const body = resultText(result);
  return {
    tool,
    ...(result.isError ? { tone: "error" as const } : {}),
    ...(body ? { body: [md(body)] } : {}),
  };
}

function statusSpan(status: AdrStatus) {
  return span(status, STATUS_TONE[status]);
}

function countsMeta(counts: Partial<Record<AdrStatus, number>>): string[] {
  const parts = STATUSES.filter((status) => (counts[status] ?? 0) > 0).map((status) => `${counts[status]} ${status}`);
  return parts.length ? [parts.join(" · ")] : [];
}

function adrTable(adrs: readonly AdrListEntry[]): NativeNode {
  const staged = adrs.some((adr) => adr.stage);
  return node(
    "table",
    {
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
    },
    undefined,
    "adrs",
  );
}

function listBody(view: Extract<ReceiptView, { kind: "list" }>, warnings: readonly string[]): NativeChild[] {
  return compact([
    view.legacy
      ? prose(`${plural(view.legacy, "file")} still in the legacy roadmap format; the next write of each converts it.`, "muted")
      : undefined,
    view.adrs.length ? adrTable(view.adrs) : prose(view.status ? `No ${view.status} ADRs.` : "No ADRs yet.", "muted"),
    warningsSection(warnings),
  ]);
}

function adrBody(adr: AdrDetail, warnings: readonly string[], expanded: boolean): NativeChild[] {
  const ids = (values: readonly string[]) => (values.length ? values.join(", ") : undefined);
  const people = (values: readonly string[]) => (values.length ? values.join("; ") : undefined);
  const chain = adr.chain.flatMap((link, index) => [
    ...(index ? [span(" → ", "muted")] : []),
    span(link.id, link.id === adr.id ? "strong" : undefined),
    span(` ${link.status}`, STATUS_TONE[link.status]),
  ]);
  return compact([
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
    node("section", { head: [span("Decision record", "toolTitle")], collapsible: true, collapsed: !expanded }, [md(adr.body)], "record"),
    warningsSection(warnings),
  ]);
}

function statusTarget(args: Args): string {
  const id = str(args, "id");
  if (id) return id;
  const status = str(args, "status");
  return status ? `list ${status}` : "list";
}

function describeStatus(result: CardResult, options: CardOptions, args: Args): NativeToolView {
  const target = statusTarget(args);
  const receipt = receiptOf(result.details);
  if (!receipt) return textView(head(target), result);
  if (!receipt.ok) return failureView(head(target), receipt);
  const adr = viewOf(receipt, "adr")?.adr;
  if (adr)
    return {
      tool: head(adr.id, { badges: [{ text: adr.status, tone: STATUS_TONE[adr.status] }] }),
      body: adrBody(adr, receipt.warnings, options.expanded),
      // The record folds on its own; the metadata above it always shows.
      preview: "children",
    };
  const listed = viewOf(receipt, "list");
  if (listed) {
    const shown = listed.status ? listed.adrs.length : undefined;
    return {
      tool: head(target, {
        meta: shown !== undefined ? [plural(shown, listed.status ?? "ADR")] : countsMeta(listed.counts),
      }),
      body: listBody(listed, receipt.warnings),
    };
  }
  return textView(head(target), result);
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

function describeManage(result: CardResult, args: Args): NativeToolView {
  const target = manageTarget(args);
  const receipt = receiptOf(result.details);
  if (!receipt) return textView(head(target), result);
  if (!receipt.ok) return failureView(head(target), receipt);
  const ids = viewOf(receipt, "write")?.ids ?? [];
  const unchanged = !receipt.changedFiles.length;
  const files = receipt.changedFiles;
  return {
    tool: head(target, {
      ...(ids.length ? { badges: ids.map((id) => ({ text: id, tone: "accent" as Tone })) } : {}),
      ...(unchanged ? { note: "unchanged" } : { meta: [plural(files.length, "file")] }),
    }),
    ...(unchanged ? { tone: "muted" as const } : {}),
    body: compact([
      prose(receipt.summary, unchanged ? "muted" : "strong"),
      files.length ? filesList(files, "changed") : undefined,
      files.length ? prose("Commit these files per the project's rules.", "muted") : undefined,
      warningsSection(receipt.warnings),
    ]),
  };
}

const SEVERITY_ICON: Record<Diagnostic["severity"], string> = { error: "x-circle", warning: "warn" };

function diagnosticsList(diagnostics: readonly Diagnostic[]): NativeNode {
  return list(
    diagnostics.map((diagnostic, index) =>
      item(`d${index}`, {
        label: diagnostic.message,
        detail: `${diagnostic.path} · ${diagnostic.rule}`,
        icon: SEVERITY_ICON[diagnostic.severity],
        tone: diagnostic.severity === "error" ? "error" : "warning",
        title: `${diagnostic.severity}: ${diagnostic.rule} — ${diagnostic.path}: ${diagnostic.message}${diagnostic.fixable ? " (fix: true repairs it)" : ""}`,
      }),
    ),
    { role: "omp.adr.diagnostics" },
    "diagnostics",
  );
}

function severityMeta(diagnostics: readonly Diagnostic[]): string[] {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return [errors ? plural(errors, "error") : undefined, warnings ? plural(warnings, "warning") : undefined].filter(
    (part): part is string => part !== undefined,
  );
}

function describeCheck(result: CardResult, args: Args): NativeToolView {
  const target = args?.fix === true ? "check, fix index" : "check";
  const receipt = receiptOf(result.details);
  if (!receipt) return textView(head(target), result);
  const diagnostics = viewOf(receipt, "check")?.diagnostics;
  if (!diagnostics) return receipt.ok ? textView(head(target), result) : failureView(head(target), receipt);
  const tool = head(target, { meta: severityMeta(diagnostics) });
  if (!receipt.ok)
    return { tool, tone: "error", body: [diagnosticsList(diagnostics), ...receipt.hints.map((hint) => prose(hint, "muted"))] };
  const regenerated = receipt.changedFiles;
  return {
    tool,
    tone: diagnostics.length ? "warning" : "success",
    body: compact([
      prose(regenerated.length ? "Regenerated the ADR index; ADR check passed." : "ADR check passed.", "success"),
      diagnostics.length ? diagnosticsList(diagnostics) : undefined,
      regenerated.length ? filesList(regenerated, "regenerated") : undefined,
    ]),
  };
}

/** Results are re-described every frame; the receipt object is stable while the call is. */
function memoized(
  describe: (result: CardResult, options: CardOptions, args: Args) => NativeToolView,
): (result: CardResult, options: CardOptions, args?: Args) => NativeToolView {
  const memo = new OwnerMemo<NativeToolView>();
  return (result, options, args) => {
    const owner = result.details && typeof result.details === "object" ? result.details : undefined;
    return memo.get(owner, [options.expanded, result.isError, args], () => describe(result, options, args));
  };
}

export const statusCard = {
  describeCall: (args: Args): NativeToolView => ({ tool: head(statusTarget(args)) }),
  describeResult: memoized(describeStatus),
  mergeCallAndResult: true,
};

export const manageCard = {
  describeCall: (args: Args): NativeToolView => ({ tool: head(manageTarget(args)) }),
  describeResult: memoized((result, _options, args) => describeManage(result, args)),
  mergeCallAndResult: true,
};

export const checkCard = {
  describeCall: (args: Args): NativeToolView => ({ tool: head(args?.fix === true ? "check, fix index" : "check") }),
  describeResult: memoized((result, _options, args) => describeCheck(result, args)),
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

/** The host's own message frame with a readable title in place of the customType, in Tern and plain terminals alike. */
export function registerMessageTitles(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  for (const [customType, title] of Object.entries(MESSAGE_TITLES)) {
    pi.registerMessageRenderer(customType, (message, options) => {
      const component = new CustomMessageComponent({ ...message, customType: title });
      component.setExpanded(options.expanded);
      return component;
    });
  }
}
