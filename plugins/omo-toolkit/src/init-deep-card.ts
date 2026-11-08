import { compact, kv, node, span, text } from "@oh-my-pi/pi-tui";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import type { NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";

import { modelTextNodes } from "./model-text.ts";

type Args = { action?: unknown; mode?: unknown };
interface Result {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}
const memo = new OwnerMemo<NativeToolView>();
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
function head(args?: Args): NonNullable<NativeToolView["tool"]> {
  const target = compact([word(args?.action), word(args?.mode)]).join(" ");
  return { title: "Init Deep", ...(target ? { target, targetKind: "text" } : {}) };
}
function describe(result: Result, expanded: boolean, args?: Args): NativeToolView {
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
  return {
    tool: head(args),
    tone: result.isError ? "error" : undefined,
    body: compact<NativeChild>([
      result.isError
        ? text(source.split("\n")[0]?.slice(0, 500) || "Init-deep failed")
        : fields.length
          ? kv(fields)
          : text("Snapshot details unavailable"),
      expanded && source
        ? node("section", { head: [span("Model text", "muted")], collapsible: true, collapsed: true }, modelTextNodes(source), "model-text")
        : undefined,
    ]),
  };
}

export const initDeepCard = {
  describeCall(args?: Args): NativeToolView {
    return { tool: head(args) };
  },
  describeResult(result: Result, options: RenderResultOptions, args?: Args): NativeToolView {
    return memo.get(result.content, [result.details, result.isError, options.expanded, args?.action, args?.mode], () =>
      describe(result, options.expanded, args),
    );
  },
  mergeCallAndResult: true,
};
