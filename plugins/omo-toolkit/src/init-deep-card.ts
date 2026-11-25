import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type JSXNode, nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspCardStatus } from "@oh-my-pi/pi-wire";

import { modelTextNodes } from "./model-text.ts";
import { h, kv, span } from "./tsp.ts";

type Args = { action?: unknown; mode?: unknown };
interface Result {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function word(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function date(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "Not recorded";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : "Unknown";
}
/**
 * Tern frames the body under its tool card head (the tool's label); the terminal's custom-tool box draws no head,
 * so there the body sits under an inline head naming the action.
 */
function card(args: Args | undefined, status: TspCardStatus, body: readonly JSXNode[]): UiNode | undefined {
  if (nativeRendering()) return body.length > 0 ? h("col", {}, ...body) : undefined;
  const shown = [word(args?.action), word(args?.mode)].filter(Boolean).join(" ");
  return h(
    "tool",
    {
      name: "toolkit_init_deep",
      title: "Init Deep",
      frame: "inline",
      status,
      ...(shown ? { target: shown, targetKind: "text" as const } : {}),
    },
    ...body,
  );
}

function view(result: Result, expanded: boolean, args?: Args): UiNode | undefined {
  const source = result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n\n");
  let details = object(result.details);
  // Older saved calls may have only the same JSON in their text content.
  if (!details) {
    try {
      details = object(JSON.parse(source));
    } catch {}
  }
  const fields: [string, string][] = [];
  const status = details && "snapshot" in details;
  const snapshot = status ? object(details?.snapshot) : details;
  if (word(details?.root)) fields.push(["Repository", word(details?.root) ?? ""]);
  if (snapshot) {
    const sha = word(snapshot.commitSha);
    if (sha) fields.push(["HEAD", sha.slice(0, 12)]);
    if (typeof snapshot.fileCount === "number") fields.push(["Files", String(snapshot.fileCount)]);
    if (typeof snapshot.loc === "number") fields.push(["Lines", String(snapshot.loc)]);
    if (word(snapshot.mode)) fields.push(["Delivery", word(snapshot.mode) ?? ""]);
    if (snapshot.timestamp !== undefined) fields.push(["Recorded", date(snapshot.timestamp)]);
  }
  if (status) {
    const project = object(details?.project);
    const global = object(details?.global);
    const suppressed = global?.declined === true || project?.declined === true;
    const cooldown = typeof project?.cooldownUntil === "number" && project.cooldownUntil > 0;
    fields.push([
      "Snapshot",
      details?.snapshot === null ? "Not recorded" : details?.snapshot === "invalid" ? "Invalid" : snapshot ? "Recorded" : "Unknown",
    ]);
    fields.push([
      "Advisor",
      global?.declined === true
        ? "Disabled everywhere"
        : project?.declined === true
          ? "Disabled in this project"
          : project
            ? "Not suppressed"
            : "Unknown",
    ]);
    if (cooldown) fields.push(["Cooldown until", date(project?.cooldownUntil)]);
    if (word(project?.lastProposedHead)) fields.push(["Last proposed HEAD", (word(project?.lastProposedHead) ?? "").slice(0, 12)]);
    if (typeof project?.lastProposedAt === "number" && project.lastProposedAt > 0)
      fields.push(["Last proposed", date(project.lastProposedAt)]);
    fields.push([
      "Recommendation",
      suppressed
        ? "Automatic advice disabled; manual init-deep remains available"
        : details?.snapshot === null || details?.snapshot === "invalid"
          ? "Run init-deep to establish a verified snapshot"
          : "Snapshot available; drift is evaluated by the advisor",
    ]);
  }
  return card(args, result.isError ? "error" : "done", [
    result.isError
      ? h("text", { text: source.split("\n")[0]?.slice(0, 500) || "Init-deep failed", wrap: "word" })
      : fields.length
        ? kv(fields)
        : h("text", { text: "Snapshot details unavailable" }),
    // Tern folds the receipt; the terminal cannot unfold a section, so it shows it open once the card is expanded.
    expanded && source
      ? h(
          "section",
          { key: "model-text", head: [span("Model text", "muted")], collapsible: true, collapsed: nativeRendering() },
          ...modelTextNodes(source),
        )
      : undefined,
  ]);
}

export const initDeepCard = {
  renderCall(args?: Args): UiNode | undefined {
    return card(args, "running", []);
  },
  renderResult(result: Result, options: ToolRenderResultOptions, _theme: unknown, args?: Args): UiNode | undefined {
    return view(result, options.expanded, args);
  },
  mergeCallAndResult: true,
};
