import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type JSXNode, nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspCardStatus, TspTone } from "@oh-my-pi/pi-wire";

import { modelTextNodes } from "#src/model-text.ts";
import { h, span } from "#src/tsp.ts";

interface CardResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}
type Fields = Record<string, unknown>;
const LIMIT = 6;

// Persisted results and streaming arguments can predate the current schema.
function fields(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function short(value: unknown, limit = 180): string {
  const line = (str(value) ?? "").replace(/\s+/g, " ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
function rows(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter((row) => row !== null && typeof row === "object" && !Array.isArray(row)) : [];
}
function tone(state: string): TspTone {
  if (["complete", "pass"].includes(state)) return "success";
  if (["failed", "fail"].includes(state)) return "error";
  if (["blocked", "paused", "stopped", "stale"].includes(state)) return "warning";
  return state === "in_progress" || state === "active" ? "accent" : "muted";
}
function line(value: string, style?: TspTone): UiNode {
  return h("text", { spans: [span(value, style)], wrap: "word" });
}
interface Head {
  target?: string;
  state?: string;
}
function head(op?: string, goal?: string, state?: string): Head {
  const target = [short(op, 48), short(goal, 120)].filter(Boolean).join(" ");
  return { ...(target ? { target } : {}), ...(state ? { state } : {}) };
}

/**
 * Tern frames the body under its generic tool card head (the tool's label and an args summary); the terminal's
 * custom-tool box draws no head, so there the body sits under an inline head naming the operation, its goal and its
 * state. In Tern a first `facts` row keeps what that generic head lacks: the state badge in its tone.
 */
function card(tool: Head, status: TspCardStatus, body: readonly JSXNode[]): UiNode | undefined {
  if (nativeRendering()) {
    const facts = tool.state
      ? h("row", { key: "facts", gap: "sm" }, h("badge", { text: short(tool.state), tone: tone(tool.state) }))
      : undefined;
    return facts || body.length > 0 ? h("col", {}, facts, ...body) : undefined;
  }
  return h(
    "tool",
    {
      name: "ulw_loop",
      title: "Ultrawork loop",
      frame: "inline",
      status,
      ...(tool.target ? { target: tool.target, targetKind: "text" as const } : {}),
      ...(tool.state ? { badges: [{ text: short(tool.state), tone: tone(tool.state) }] } : {}),
      ...(status === "error" ? { tone: "error" as const } : {}),
    },
    ...body,
  );
}

/** A passing capture is not necessarily fresh: status lacks per-criterion tree freshness. */
function criterionState(criterion: Fields, goal: Fields): string {
  const capture = rows(criterion.evidenceHistory).findLast(
    (capture) => capture.criterionRevision === criterion.revision && capture.goalAttempt === goal.attempt,
  );
  if (!capture) return "pending";
  if (criterion.fresh === false) return "stale";
  const state = str(capture.status) ?? "pending";
  return state === "pass" && criterion.fresh !== true ? "pass recorded" : state;
}
function goalNodes(goal: Fields, criteria = rows(goal.criteria)): UiNode[] {
  const id = short(goal.id, 48);
  const state = str(goal.status) ?? "unknown";
  const result: UiNode[] = [h("list", {}, h("item", { key: id, label: `${id} ${short(goal.title)}`, detail: [span(state, tone(state))] }))];
  if (str(goal.blockedReason)) result.push(line(short(goal.blockedReason), "warning"));
  if (criteria.length) {
    result.push(
      h(
        "list",
        {},
        ...criteria.slice(0, LIMIT).map((criterion, index) => {
          const state = criterionState(criterion, goal);
          return h("item", {
            key: short(criterion.id, 48) || String(index),
            label: `${short(criterion.id, 48)} ${short(criterion.scenario)}`,
            detail: [span(state, tone(state === "pass recorded" ? "pass" : state))],
          });
        }),
      ),
    );
    if (criteria.length > LIMIT) result.push(line(`${criteria.length - LIMIT} more criteria in Model text`, "muted"));
  }
  return result;
}

function view(result: CardResult, expanded: boolean, args: Fields): UiNode | undefined {
  const details = fields(result.details);
  const op = str(details.op) ?? str(args.op);
  const data = fields(details.result);
  const state = fields(data.state);
  const goals = rows(state.goals);
  const selectedId = str(args.goalId) ?? str(args.targetGoalId) ?? str(state.activeGoalId);
  const direct = fields(data.goal);
  const goal = str(direct.id)
    ? direct
    : str(data.id) && str(data.title)
      ? data
      : (goals.find((goal) => goal.id === selectedId) ??
        goals.find((goal) => goal.status === "in_progress") ??
        goals.find((goal) => goal.status === "pending") ??
        goals[goals.length - 1]);
  const goalId = str(goal?.id) ?? str(data.goalId) ?? selectedId;
  const failed = result.isError || details.ok === false;
  const status = failed ? "failed" : (str(goal?.status) ?? str(state.status) ?? str(data.status));
  let tool = head(op, goalId, status);
  const body: UiNode[] = [];
  if (failed) {
    const error = fields(details.error);
    const reason = short(error.message) || "Operation failed; expand Model text for details.";
    body.push(line(reason, "error"));
  } else if (op === "help" && Object.keys(fields(data.operations)).length) {
    const operations = Object.entries(fields(data.operations));
    body.push(
      h(
        "list",
        {},
        ...operations.slice(0, LIMIT).map(([name, description]) => h("item", { key: name, label: name, detail: short(description, 120) })),
      ),
      line(`${operations.length} operations · full contracts and references in Model text`, "muted"),
    );
  } else if (op === "record_evidence" && str(data.id)) {
    const evidenceState = str(data.status) ?? "recorded";
    tool = head(op, [goalId, str(args.criterionId)].filter(Boolean).join(" "), evidenceState);
    body.push(line(`Evidence ${evidenceState} · ${rows(data.artifacts).length} artifacts`, tone(evidenceState)));
    if (str(data.evidence)) body.push(line(short(data.evidence)));
  } else if (op === "checkpoint" && typeof data.aggregateComplete === "boolean") {
    const checkpointState = str(args.status);
    tool = head(op, goalId, data.aggregateComplete ? "complete" : checkpointState);
    body.push(
      line(
        data.aggregateComplete
          ? "Goal complete · loop accepted"
          : checkpointState === "complete"
            ? "Goal complete · loop not yet accepted"
            : `Checkpoint ${checkpointState ?? "recorded"} · loop not accepted`,
        data.aggregateComplete || checkpointState === "complete" ? "success" : "warning",
      ),
    );
  } else if (op === "complete_goals" && typeof data.noEligibleWork === "boolean") {
    body.push(
      line(
        data.aggregateComplete === true
          ? "Loop already accepted"
          : data.noEligibleWork
            ? "No eligible work · loop not accepted"
            : "Acquired/resumed goal · not acceptance",
        data.aggregateComplete === true ? "success" : data.noEligibleWork ? "warning" : "accent",
      ),
    );
    if (goal) body.push(...goalNodes(goal));
  } else if (goal) {
    if (goals.length)
      body.push(line(`${goals.filter((goal) => goal.status === "complete").length}/${goals.length} goals complete`, "muted"));
    body.push(...goalNodes(goal, op === "criteria" && Array.isArray(data.criteria) ? rows(data.criteria) : rows(goal.criteria)));
    const summary = fields(data.summary);
    if (typeof summary.fresh === "number" && typeof summary.stale === "number") {
      body.push(line(`${summary.fresh} fresh · ${summary.stale} stale criteria`, summary.stale ? "warning" : "muted"));
    }
  } else if (op === "status" && data.state === null) {
    body.push(line("No authorized loop"));
  } else if (op === "status" && str(state.status)) {
    body.push(line(`Loop ${short(state.status)} · no goals`, tone(str(state.status) ?? "")));
  } else if (op === "create_goals" && Array.isArray(details.result)) {
    body.push(line(`${details.result.length} goals created`, "success"));
    const first = rows(details.result)[0];
    if (first) {
      tool = head(op, str(first.id), str(first.status));
      body.push(...goalNodes(first));
    }
  } else if (op === "record_review_blockers" && str(data.blockedGoal)) {
    const repair = fields(data.repairGoal);
    tool = head(op, str(data.blockedGoal), "blocked");
    body.push(line(`Blocked ${short(data.blockedGoal)} · repair ${short(repair.id)} ${short(repair.title)}`, "warning"));
  } else if (op === "steer" && typeof data.revision === "number") {
    body.push(line(`${short(args.kind) || "Steering recorded"} · revision ${data.revision}`));
  } else if (["pause", "resume", "stop"].includes(op ?? "") && str(data.status)) {
    body.push(line(`Loop ${short(data.status)}`, tone(str(data.status) ?? "")));
  } else if (op === "checkpoint" && args.printTemplate === true && data.version === 1) {
    body.push(line("Quality-gate template · full JSON in Model text"));
  } else {
    body.push(line("Result available · expand Model text for details", "muted"));
  }
  const warnings = [...(Array.isArray(details.warnings) ? details.warnings : []), ...(Array.isArray(data.warnings) ? data.warnings : [])];
  if (!failed && warnings.length) body.push(line(short(warnings[0]), "warning"));
  if (expanded) {
    const source = result.content
      .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join("\n\n");
    if (source.trim()) {
      // Tern folds the receipt; the terminal cannot unfold a section, so it shows it open once the card is expanded.
      body.push(
        h(
          "section",
          { key: "model-text", head: [span("Model text", "muted")], collapsible: true, collapsed: nativeRendering() },
          ...modelTextNodes(source),
        ),
      );
    }
  }
  return card(tool, failed ? "error" : "done", body);
}

/** `ulw_loop` render hooks; the model receives unchanged receipts. */
export const loopCard = {
  renderCall(args?: unknown): UiNode | undefined {
    const input = fields(args);
    return card(head(str(input.op), str(input.goalId) ?? str(input.targetGoalId)), "running", []);
  },
  renderResult(result: CardResult, options: ToolRenderResultOptions, _theme: unknown, args?: unknown): UiNode | undefined {
    return view(result, options.expanded, fields(args));
  },
  mergeCallAndResult: true,
};
