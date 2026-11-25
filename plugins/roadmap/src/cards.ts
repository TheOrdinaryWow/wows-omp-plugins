import { basename, dirname } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";

import type { Diagnostics } from "#src/check.ts";
import { modelTextNodes } from "#src/model-text.ts";
import { type HeldPreview, receiptSummary, type StatusFocus, type StatusOverview, type ToolReceipt } from "#src/tools.ts";
import { h, kv, span } from "#src/tsp.ts";

export type RoadmapToolName =
  | "roadmap_status"
  | "roadmap_stage"
  | "roadmap_todo"
  | "roadmap_check"
  | "roadmap_overlap"
  | "roadmap_init"
  | "roadmap_round_open"
  | "roadmap_round_plan"
  | "roadmap_upgrade";

type Args = Record<string, unknown>;
type ToolResult = { content: readonly { type: string; text?: string }[]; details?: unknown; isError?: boolean };

/** The card's head line: the action it ran, short facts and status chips. */
interface Head {
  target: string;
  meta?: string[];
  badges?: { text: string; tone: TspTone }[];
}

/** One result card: its head, the tone of its outcome and its body, clamped to `preview` lines while collapsed. */
interface Card {
  head: Head;
  tone?: TspTone;
  body: (UiNode | undefined)[];
  preview?: number;
}

/** Lines a structured overview or diagnostics preview shows while the card is collapsed. */
const PREVIEW_LINES = 12;

function fields(value: unknown): Args {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

/** A non-empty trimmed string; streaming args may hold anything or nothing yet. */
function word(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function words(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function count(value: unknown, noun: string): string | undefined {
  return Array.isArray(value) && value.length ? `${value.length} ${noun}${value.length === 1 ? "" : "s"}` : undefined;
}

/** The call's target (`stage start S01`) and short facts, from possibly partial streaming args; the `i` intent is not shown. */
const CALL_TARGETS: Record<RoadmapToolName, (args: Args) => { target: string; meta?: (string | undefined)[] }> = {
  roadmap_status: (args) => ({ target: words("status", word(args.stage)) }),
  roadmap_stage: (args) => {
    const action = word(args.action);
    const id = word(args.id);
    const renamed = action === "renumber" && word(args.new_id) ? `→ ${word(args.new_id)}` : undefined;
    return { target: words("stage", action, id, renamed), meta: [id ? undefined : word(args.title)] };
  },
  roadmap_todo: (args) => ({ target: words("todo", word(args.action), word(args.id)), meta: [word(args.title)] }),
  roadmap_check: (args) => ({ target: args.fix === true ? "check fix" : "check" }),
  roadmap_overlap: (args) => ({ target: words("overlap", word(args.stage)), meta: [word(args.intent)] }),
  roadmap_init: (args) => ({
    target: words("init", word(fields(args.project).name)),
    meta: [count(args.stages, "stage"), count(args.adrs, "ADR")],
  }),
  roadmap_round_open: (args) => ({
    target: words("round open", word(args.activate)),
    meta: [word(fields(args.round).title), count(args.import_todos, "TODO")],
  }),
  roadmap_round_plan: (args) => ({ target: words("round plan", word(args.id)), meta: [word(fields(args.round).title), word(args.target)] }),
  roadmap_upgrade: () => ({ target: "upgrade" }),
};

function callHead(name: RoadmapToolName, args: unknown): Head {
  const { target, meta = [] } = CALL_TARGETS[name](fields(args));
  const facts = meta.filter((fact): fact is string => fact !== undefined);
  return { target, ...(facts.length ? { meta: facts } : {}) };
}

/**
 * `Roadmap <target> · facts [badges]`, the target in the outcome's tone. Tern's generic head already names the tool
 * and its args, so there the line keeps only the facts and badges, and is undefined without any.
 */
function headLine(head: Head, tone?: TspTone): UiNode | undefined {
  const native = nativeRendering();
  const spans: TspSpan[] = native
    ? []
    : [span("Roadmap ", "toolTitle strong"), span(head.target, tone === "error" || tone === "warning" ? tone : "accent")];
  for (const fact of head.meta ?? []) spans.push(...(spans.length ? [span(" · ", "dim")] : []), span(fact, "muted"));
  for (const badge of head.badges ?? []) spans.push(...(spans.length ? [span(" ")] : []), span(`[${badge.text}]`, badge.tone));
  return spans.length ? h("text", { key: "head", spans, wrap: "word" }) : undefined;
}

/** Span style and card tone of a round, stage or plan status. */
function statusStyle(status: string): { s: string; tone: TspTone } {
  switch (status) {
    case "active":
    case "unfinished":
      return { s: "accent", tone: "accent" };
    case "closed":
    case "complete":
      return { s: "success", tone: "success" };
    case "dropped":
      return { s: "dim", tone: "muted" };
    default:
      return { s: "muted", tone: "neutral" };
  }
}

function statusSpan(status: string): TspText {
  return [span(status, statusStyle(status).s)];
}

function section(head: string, children: readonly (UiNode | undefined)[], key: string): UiNode {
  return h("section", { key, head: [span(head, "toolTitle")] }, children);
}

function table(
  key: string,
  cols: readonly [string, string, number, number?][],
  rows: readonly { id: string; cells: Record<string, TspText> }[],
): UiNode {
  return h("table", {
    key,
    cols: cols.map(([id, head, priority, grow]) => ({ id, head, priority, truncate: "end" as const, ...(grow ? { grow } : {}) })),
    rows,
  });
}

function warningLines(warnings: readonly string[]): UiNode[] {
  return warnings.map((warning, index) =>
    h("text", { key: `warning-${index}`, spans: [span("Warning ", "warning strong"), span(warning)], wrap: "word", tone: "warning" }),
  );
}

function hintLines(hints: readonly string[]): UiNode[] {
  return hints.map((hint, index) => h("text", { key: `hint-${index}`, spans: [span(hint, "muted")], wrap: "word" }));
}

/** Changed files as one-line items: file name first, then its directory. */
function changedFiles(files: readonly string[] | undefined, head = "Changed files"): UiNode | undefined {
  if (!files?.length) return undefined;
  const items = files.map((path) => {
    const directory = dirname(path);
    return h("item", { key: path, label: [span(basename(path), "path")], ...(directory === "." ? {} : { detail: directory }) });
  });
  return section(head, [h("list", {}, items)], "changed");
}

/**
 * A rendered document without its YAML front matter, which the head and fields already show, and without the
 * managed-by and generated-block comments: Tern's Markdown shows HTML comments literally, and managed bodies refuse raw HTML.
 */
function documentBody(source: string): string {
  return source.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/^[ \t]*<!--[^\n]*-->[ \t]*(?:\n|$)/gm, "");
}

function receiptOf(details: unknown): ToolReceipt | undefined {
  const receipt = fields(details);
  if (receipt.ok === true && typeof receipt.summary === "string") return details as ToolReceipt;
  if (receipt.ok === false && typeof receipt.reason === "string") return details as ToolReceipt;
}

function diagnosticRows(diagnostics: readonly Diagnostics[]): UiNode[] {
  return diagnostics.map((diagnostic, index) => {
    const tone: TspTone = diagnostic.severity === "error" ? "error" : "warning";
    return h("text", {
      key: `diagnostic-${index}`,
      spans: [
        span(diagnostic.severity, `${tone} strong`),
        span(` ${diagnostic.message} `),
        span(diagnostic.rule, "dim"),
        span(" · ", "dim"),
        span(diagnostic.path, "path dim"),
      ],
      wrap: "word",
      tone,
    });
  });
}

function checkView(head: Head, receipt: ToolReceipt, diagnostics: readonly Diagnostics[]): Card {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const facts = [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ];
  const meta = facts.filter(Boolean);
  return {
    head: { ...head, meta: meta.length ? meta : ["passed"] },
    ...(errors ? { tone: "error" as const } : warnings ? { tone: "warning" as const } : {}),
    body: [
      receipt.ok ? h("md", { key: "summary", text: receipt.summary }) : undefined,
      ...diagnosticRows(diagnostics),
      ...(receipt.ok ? [] : hintLines(receipt.hints)),
      changedFiles(receipt.changedFiles, receipt.ok ? "Regenerated" : "Committed before the interruption"),
    ],
    preview: PREVIEW_LINES,
  };
}

function overviewView(head: Head, receipt: ToolReceipt & { ok: true }, overview: StatusOverview): Card {
  const activeRound = overview.rounds.find((round) => round.status === "active");
  const overdue = (entry: { overdue: boolean }): TspText => (entry.overdue ? [span("overdue", "warning")] : "");
  const stageNote = (stage: StatusOverview["stages"][number]): TspText => {
    if (stage.overdue) return [span("overdue", "warning")];
    if (stage.readiness?.startable) return [span("startable", "success")];
    if (stage.readiness) return [span(`blocked by ${stage.readiness.blockedBy.join(", ")}`, "warning")];
    return stage.dependsOn.length ? [span(`after ${stage.dependsOn.join(", ")}`, "dim")] : "";
  };
  const severity = (value: string): TspText => [span(value, value === "high" ? "warning strong" : value === "low" ? "dim" : "muted")];
  const todoCount = count(overview.todos, "open TODO");
  return {
    head: {
      ...head,
      meta: [
        overview.project,
        activeRound ? `${activeRound.id} ${activeRound.title}` : "no active round",
        ...(todoCount ? [todoCount] : []),
      ],
    },
    body: [
      ...warningLines(receipt.warnings),
      overview.rounds.length
        ? section(
            "Rounds",
            [
              table(
                "rounds",
                [
                  ["id", "Round", 3],
                  ["status", "Status", 3],
                  ["title", "Title", 3, 1],
                  ["target", "Target", 1],
                  ["stages", "Stages", 1],
                  ["note", "", 2],
                ],
                overview.rounds.map((round) => ({
                  id: round.id,
                  cells: {
                    id: [span(round.id, "strong")],
                    status: statusSpan(round.status),
                    title: round.title,
                    target: round.target ?? "",
                    stages: String(round.stages),
                    note: overdue(round),
                  },
                })),
              ),
            ],
            "rounds",
          )
        : undefined,
      overview.stages.length
        ? section(
            "Stages",
            [
              table(
                "stages",
                [
                  ["id", "Stage", 3],
                  ["status", "Status", 3],
                  ["title", "Title", 3, 1],
                  ["round", "Round", 1],
                  ["target", "Target", 1],
                  ["note", "", 2],
                ],
                overview.stages.map((stage) => ({
                  id: stage.id,
                  cells: {
                    id: [span(stage.id, "strong")],
                    status: statusSpan(stage.status),
                    title: stage.title,
                    round: stage.round,
                    target: stage.target ?? "",
                    note: stageNote(stage),
                  },
                })),
              ),
            ],
            "stages",
          )
        : undefined,
      overview.plans
        ? section(
            "Atlas plans",
            overview.plans.length
              ? [
                  table(
                    "plans",
                    [
                      ["stage", "Stage", 3],
                      ["label", "Plan", 3, 1],
                      ["status", "Status", 3],
                      ["rows", "Rows", 1],
                      ["note", "", 2],
                    ],
                    overview.plans.map((plan, index) => ({
                      id: `${plan.stage}-${index}`,
                      cells: {
                        stage: [span(plan.stage, "strong")],
                        label: plan.label,
                        status: statusSpan(plan.status),
                        rows: `${plan.done}/${plan.total}`,
                        note: plan.drifted ? [span("drift", "warning")] : "",
                      },
                    })),
                  ),
                ]
              : [h("text", { spans: [span("None.", "muted")] })],
            "plans",
          )
        : undefined,
      section(
        "Open TODOs",
        overview.todos.length
          ? [
              table(
                "todos",
                [
                  ["id", "TODO", 3],
                  ["severity", "Severity", 2],
                  ["target", "Target or trigger", 1],
                  ["title", "Title", 3, 1],
                ],
                overview.todos.map((todo) => ({
                  id: todo.id,
                  cells: { id: [span(todo.id, "strong")], severity: severity(todo.severity), target: todo.target, title: todo.title },
                })),
              ),
            ]
          : [h("text", { spans: [span("None.", "muted")] })],
        "todos",
      ),
    ],
    preview: PREVIEW_LINES,
  };
}

function focusView(head: Head, receipt: ToolReceipt & { ok: true }, focus: StatusFocus): Card {
  const style = statusStyle(focus.status);
  return {
    head: {
      ...head,
      meta: [focus.id, focus.title],
      badges: [
        { text: focus.status, tone: style.tone },
        ...(receipt.answer ? [{ text: receipt.answer, tone: "accent" as const }] : []),
        ...(focus.overdue ? [{ text: "overdue", tone: "warning" as const }] : []),
      ],
    },
    body: [
      !receipt.summary.startsWith("---\n") && receipt.summary.split("\n").length <= PREVIEW_LINES
        ? h("md", { key: "summary", text: receipt.summary })
        : undefined,
      kv([
        ["Round", focus.round],
        ["Target", focus.target ?? undefined],
        ["Started", focus.started ?? undefined],
        ["Opened", focus.opened ?? undefined],
        ["Closed", focus.closed ?? undefined],
        ["Depends on", focus.dependsOn?.length ? focus.dependsOn.join(", ") : undefined],
        ["Criteria", focus.criteria ? `${focus.criteria.length} (${focus.criteria.join(", ") || "none"})` : undefined],
        ["Open TODOs", focus.todos ? `${focus.todos.length} (${focus.todos.join(", ") || "none"})` : undefined],
        ["Cited ADRs", focus.adrIds?.join(", ") || (focus.adrIds ? "none" : undefined)],
        ["Stages", focus.stages === undefined ? undefined : String(focus.stages)],
      ]),
      ...warningLines(receipt.warnings),
      changedFiles(receipt.changedFiles),
    ],
  };
}

function heldView(head: Head, held: HeldPreview): Card {
  return {
    head: { ...head, badges: [{ text: "not written", tone: "warning" }] },
    tone: "warning",
    body: [
      h("md", { key: "summary", text: held.summary }),
      h("text", {
        key: "confirm",
        spans: [span("Awaiting confirmation: the user writes these files with ", "muted"), span(`/roadmap confirm ${held.token}`, "code")],
        wrap: "word",
      }),
      ...held.files.map((file) =>
        h(
          "section",
          { key: `file-${file.path}`, head: [span(file.path, "path")], collapsible: true, collapsed: true },
          h("md", { text: documentBody(file.content) }),
        ),
      ),
    ],
    preview: PREVIEW_LINES,
  };
}

function receiptView(name: RoadmapToolName, head: Head, receipt: ToolReceipt): Card {
  if (!receipt.ok) {
    if (receipt.held) return heldView(head, receipt.held);
    if (receipt.diagnostics?.length) return checkView(head, receipt, receipt.diagnostics);
    return {
      head,
      tone: "error",
      body: [h("text", { key: "reason", text: receipt.reason, wrap: "word" }), ...hintLines(receipt.hints)],
    };
  }
  if (receipt.overview) return overviewView(head, receipt, receipt.overview);
  if (receipt.focus) return focusView(head, receipt, receipt.focus);
  if (name === "roadmap_check") return checkView(head, receipt, receipt.diagnostics ?? []);
  const long = receipt.summary.split("\n").length > PREVIEW_LINES;
  return {
    head: { ...head, ...(receipt.answer ? { badges: [{ text: receipt.answer, tone: "accent" as const }] } : {}) },
    ...(receipt.warnings.length ? { tone: "warning" as const } : {}),
    body: [
      long ? h("text", { key: "summary", text: "Roadmap operation completed." }) : h("md", { key: "summary", text: receipt.summary }),
      ...warningLines(receipt.warnings),
      changedFiles(receipt.changedFiles),
    ],
    ...(long ? { preview: PREVIEW_LINES } : {}),
  };
}

/** The folded text the model read, shown on expansion beside the facts the card already draws. */
function modelTextSection(source: string): UiNode {
  return h(
    "section",
    { key: "model-text", head: [span("Model text", "muted")], collapsible: true, collapsed: true },
    modelTextNodes(source),
  );
}

/** A result card: its head line over the body, which a collapsed card clamps to its preview lines. */
function resultNode(name: RoadmapToolName, result: ToolResult, args: unknown, expanded: boolean): UiNode {
  const head = callHead(name, args);
  const receipt = receiptOf(result.details);
  const output = result.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
  const card: Card = receipt
    ? receiptView(name, head, receipt)
    : {
        head,
        ...(result.isError ? { tone: "error" as const } : {}),
        body: [
          h("text", { key: "summary", text: result.isError ? "Roadmap operation failed." : "Roadmap result available.", wrap: "word" }),
        ],
      };
  const body = [...card.body, expanded && output ? modelTextSection(output) : undefined];
  return h(
    "col",
    { gap: "sm", ...(card.tone ? { tone: card.tone } : {}) },
    headLine(card.head, card.tone),
    card.preview && !expanded
      ? h("card", { key: "body", variant: "bare", collapsed: true, preview: { lines: card.preview } }, h("col", { gap: "sm" }, body))
      : body,
  );
}

/** The render hooks of one roadmap tool: the call's head line, then the result card in its place. */
export function roadmapToolCard(name: RoadmapToolName) {
  return {
    renderCall: (args: unknown): UiNode | undefined => headLine(callHead(name, args)),
    renderResult: (result: ToolResult, options: { expanded: boolean }, _theme: unknown, args?: unknown): UiNode =>
      resultNode(name, result, args, options.expanded),
    mergeCallAndResult: true,
  };
}

/** Product titles of the session messages roadmap displays; the persisted custom types stay unchanged. */
export const MESSAGE_TITLES: Readonly<Record<string, string>> = {
  "wows-omp-roadmap.status": "Roadmap",
  "wows-omp-roadmap.notice": "Roadmap",
  "wows-omp-roadmap.check": "Roadmap check",
  "wows-omp-roadmap.overlap": "Roadmap overlap",
  "wows-omp-roadmap.confirm": "Roadmap confirm",
  "wows-omp-roadmap.round-close": "Roadmap round close",
  "wows-omp-roadmap.init": "Roadmap init",
  "wows-omp-roadmap.round": "Roadmap new round",
  "wows-omp-roadmap.plan": "Roadmap planned round",
  "wows-omp-roadmap.upgrade": "Roadmap upgrade",
  "wows-omp-roadmap.drop-round": "Roadmap drop round",
  "wows-omp-roadmap.retarget": "Roadmap retarget",
};

/** Draws each displayed roadmap message as a card like the host's, headed by its product title instead of the custom type. */
export function registerMessageTitles(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  for (const [customType, title] of Object.entries(MESSAGE_TITLES)) {
    pi.registerMessageRenderer(customType, (message, options) => {
      const receipt = receiptOf(message.details);
      const source = typeof message.content === "string" ? message.content : "";
      const legacyHandoff =
        source.split("\n").length > PREVIEW_LINES || source.includes("# Planning handoff:") || source.includes("Commit these files per");
      const summary = receipt
        ? [receiptSummary(receipt), word(fields(message.details).footer)].filter(Boolean).join("\n")
        : legacyHandoff
          ? "Roadmap result available."
          : source;
      const modelText = source !== summary ? source : "";
      return h(
        "card",
        { head: [span(title, "customMessageLabel strong")] },
        h("md", { key: "summary", text: summary }),
        options.expanded && modelText ? modelTextSection(modelText) : undefined,
      );
    });
  }
}
