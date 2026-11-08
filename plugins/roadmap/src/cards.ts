import { basename, dirname } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { compact, item, kv, list, md, type NativeChild, type NativeNode, node, span, text } from "@oh-my-pi/pi-tui";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeToolHead, NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import type { TspText, TspTone } from "@oh-my-pi/pi-wire";

import type { Diagnostics } from "#src/check.ts";
import { modelTextNodes } from "#src/model-text.ts";
import { type HeldPreview, receiptSummary, type StatusFocus, type StatusOverview, type ToolReceipt } from "#src/tools.ts";

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

function callHead(name: RoadmapToolName, args: unknown): NativeToolHead {
  const { target, meta = [] } = CALL_TARGETS[name](fields(args));
  const facts = meta.filter((fact): fact is string => fact !== undefined);
  return { title: "Roadmap", target, targetKind: "text", ...(facts.length ? { meta: facts } : {}) };
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

function section(head: string, children: readonly NativeChild[], key: string, tone?: TspTone): NativeNode {
  return node("section", { head: [span(head, "toolTitle")], ...(tone ? { tone } : {}) }, children, key);
}

function table(
  key: string,
  cols: readonly [string, string][],
  rows: readonly { id: string; cells: Record<string, TspText> }[],
): NativeNode {
  return node("table", { cols: cols.map(([id, head]) => ({ id, head })), rows }, undefined, key);
}

function warningLines(warnings: readonly string[]): NativeNode[] {
  return warnings.map((warning, index) =>
    node(
      "text",
      { spans: [span("Warning ", "warning strong"), span(warning)], wrap: "word", tone: "warning" },
      undefined,
      `warning-${index}`,
    ),
  );
}

function hintLines(hints: readonly string[]): NativeNode[] {
  return hints.map((hint, index) => node("text", { spans: [span(hint, "muted")], wrap: "word" }, undefined, `hint-${index}`));
}

/** Changed files as one-line items: file name first, then its directory. */
function changedFiles(files: readonly string[] | undefined, head = "Changed files"): NativeNode | undefined {
  if (!files?.length) return undefined;
  const items = files.map((path) => {
    const directory = dirname(path);
    return item(path, { label: [span(basename(path), "path")], ...(directory === "." ? {} : { detail: directory }) });
  });
  return section(head, [list(items)], "changed");
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

function diagnosticRows(diagnostics: readonly Diagnostics[]): NativeNode[] {
  return diagnostics.map((diagnostic, index) => {
    const tone: TspTone = diagnostic.severity === "error" ? "error" : "warning";
    return node(
      "text",
      {
        spans: [
          span(diagnostic.severity, `${tone} strong`),
          span(` ${diagnostic.message} `),
          span(diagnostic.rule, "dim"),
          span(" · ", "dim"),
          span(diagnostic.path, "path dim"),
        ],
        wrap: "word",
        tone,
      },
      undefined,
      `diagnostic-${index}`,
    );
  });
}

function checkView(head: NativeToolHead, receipt: ToolReceipt, diagnostics: readonly Diagnostics[]): NativeToolView {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const facts = [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ];
  const meta = facts.filter(Boolean);
  return {
    tool: { ...head, meta: meta.length ? meta : ["passed"] },
    tone: errors ? "error" : warnings ? "warning" : undefined,
    body: compact<NativeChild>([
      receipt.ok ? md(receipt.summary) : undefined,
      ...diagnosticRows(diagnostics),
      ...(receipt.ok ? [] : hintLines(receipt.hints)),
      changedFiles(receipt.changedFiles, receipt.ok ? "Regenerated" : "Committed before the interruption"),
    ]),
    preview: { lines: PREVIEW_LINES },
  };
}

function overviewView(head: NativeToolHead, receipt: ToolReceipt & { ok: true }, overview: StatusOverview): NativeToolView {
  const activeRound = overview.rounds.find((round) => round.status === "active");
  const overdue = (entry: { overdue: boolean }): TspText => (entry.overdue ? [span("overdue", "warning")] : "");
  const stageNote = (stage: StatusOverview["stages"][number]): TspText => {
    if (stage.overdue) return [span("overdue", "warning")];
    if (stage.readiness?.startable) return [span("startable", "success")];
    if (stage.readiness) return [span(`blocked by ${stage.readiness.blockedBy.join(", ")}`, "warning")];
    return stage.dependsOn.length ? [span(`after ${stage.dependsOn.join(", ")}`, "dim")] : "";
  };
  const severity = (value: string): TspText => [span(value, value === "high" ? "warning strong" : value === "low" ? "dim" : "muted")];
  return {
    tool: {
      ...head,
      meta: compact([
        overview.project,
        activeRound ? `${activeRound.id} ${activeRound.title}` : "no active round",
        count(overview.todos, "open TODO"),
      ]),
    },
    body: compact<NativeChild>([
      ...warningLines(receipt.warnings),
      overview.rounds.length
        ? section(
            "Rounds",
            [
              table(
                "rounds",
                [
                  ["id", "Round"],
                  ["status", "Status"],
                  ["title", "Title"],
                  ["target", "Target"],
                  ["stages", "Stages"],
                  ["note", ""],
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
                  ["id", "Stage"],
                  ["status", "Status"],
                  ["title", "Title"],
                  ["round", "Round"],
                  ["target", "Target"],
                  ["note", ""],
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
                      ["stage", "Stage"],
                      ["label", "Plan"],
                      ["status", "Status"],
                      ["rows", "Rows"],
                      ["note", ""],
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
              : [text([span("None.", "muted")])],
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
                  ["id", "TODO"],
                  ["severity", "Severity"],
                  ["target", "Target or trigger"],
                  ["title", "Title"],
                ],
                overview.todos.map((todo) => ({
                  id: todo.id,
                  cells: { id: [span(todo.id, "strong")], severity: severity(todo.severity), target: todo.target, title: todo.title },
                })),
              ),
            ]
          : [text([span("None.", "muted")])],
        "todos",
      ),
    ]),
    preview: { lines: PREVIEW_LINES },
  };
}

function focusView(head: NativeToolHead, receipt: ToolReceipt & { ok: true }, focus: StatusFocus): NativeToolView {
  const style = statusStyle(focus.status);
  return {
    tool: {
      ...head,
      meta: [focus.id, focus.title],
      badges: compact([
        { text: focus.status, tone: style.tone },
        receipt.answer ? { text: receipt.answer, tone: "accent" as const } : undefined,
        focus.overdue ? { text: "overdue", tone: "warning" as const } : undefined,
      ]),
    },
    body: compact<NativeChild>([
      !receipt.summary.startsWith("---\n") && receipt.summary.split("\n").length <= PREVIEW_LINES ? md(receipt.summary) : undefined,
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
    ]),
  };
}

function heldView(head: NativeToolHead, held: HeldPreview): NativeToolView {
  return {
    tool: { ...head, badges: [{ text: "not written", tone: "warning" }] },
    tone: "warning",
    body: compact<NativeChild>([
      md(held.summary),
      text([span("Awaiting confirmation: the user writes these files with ", "muted"), span(`/roadmap confirm ${held.token}`, "code")], {
        wrap: "word",
      }),
      ...held.files.map((file) =>
        node(
          "section",
          { head: [span(file.path, "path")], collapsible: true, collapsed: true },
          [md(documentBody(file.content))],
          `file-${file.path}`,
        ),
      ),
    ]),
    preview: { lines: PREVIEW_LINES },
  };
}

function receiptView(name: RoadmapToolName, head: NativeToolHead, receipt: ToolReceipt): NativeToolView {
  if (!receipt.ok) {
    if (receipt.held) return heldView(head, receipt.held);
    if (receipt.diagnostics?.length) return checkView(head, receipt, receipt.diagnostics);
    return {
      tool: head,
      tone: "error",
      body: [text(receipt.reason, { wrap: "word" }), ...hintLines(receipt.hints)],
    };
  }
  if (receipt.overview) return overviewView(head, receipt, receipt.overview);
  if (receipt.focus) return focusView(head, receipt, receipt.focus);
  if (name === "roadmap_check") return checkView(head, receipt, receipt.diagnostics ?? []);
  const long = receipt.summary.split("\n").length > PREVIEW_LINES;
  return {
    tool: { ...head, ...(receipt.answer ? { badges: [{ text: receipt.answer, tone: "accent" as const }] } : {}) },
    tone: receipt.warnings.length ? "warning" : undefined,
    body: compact<NativeChild>([
      long ? text("Roadmap operation completed.") : md(receipt.summary),
      ...warningLines(receipt.warnings),
      changedFiles(receipt.changedFiles),
    ]),
    ...(long ? { preview: { lines: PREVIEW_LINES } } : {}),
  };
}

const views = new OwnerMemo<NativeToolView>();

function describeResult(name: RoadmapToolName, result: ToolResult, args: unknown, expanded: boolean): NativeToolView {
  const head = callHead(name, args);
  const receipt = receiptOf(result.details);
  const output = result.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
  return views.get(result, [name, head.target, head.meta?.join("\n"), expanded], () => {
    const view: NativeToolView = receipt
      ? receiptView(name, head, receipt)
      : {
          tool: head,
          ...(result.isError ? { tone: "error" as const } : {}),
          body: [text(result.isError ? "Roadmap operation failed." : "Roadmap result available.", { wrap: "word" })],
        };
    return {
      ...view,
      body: compact<NativeChild>([
        ...(view.body ?? []),
        expanded && output
          ? node(
              "section",
              { head: [span("Model text", "muted")], collapsible: true, collapsed: true },
              modelTextNodes(output),
              "model-text",
            )
          : undefined,
      ]),
    };
  });
}

/** Tern's native card hooks for one roadmap tool; plain terminals keep the host's default rendering. */
export function roadmapToolCard(name: RoadmapToolName) {
  return {
    describeCall: (args: unknown): NativeToolView => ({ tool: callHead(name, args) }),
    describeResult: (result: ToolResult, options: { expanded: boolean }, args?: unknown): NativeToolView =>
      describeResult(name, result, args, options.expanded),
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

/** Draws each displayed roadmap message in the host's own frame, headed by its product title instead of the custom type. */
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
      const component = new CustomMessageComponent({ ...message, content: summary, customType: title });
      const describe = component.describe.bind(component);
      component.describe = () => {
        const frame = describe();
        return {
          ...frame,
          c: compact<NativeChild>([
            ...(frame.c ?? []),
            options.expanded && modelText
              ? node(
                  "section",
                  {
                    head: [span("Model text", "muted")],
                    collapsible: true,
                    collapsed: true,
                  },
                  modelTextNodes(modelText),
                  "model-text",
                )
              : undefined,
          ]),
        };
      };
      component.setExpanded(options.expanded);
      return component;
    });
  }
}
