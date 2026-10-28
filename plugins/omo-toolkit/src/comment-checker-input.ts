/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/comment-checker/hook-input.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: use native final-path metadata and label pruned snapshots as file-wide checks.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import type { CheckerInput } from "#src/comment-checker-runner.ts";

export interface CheckerTarget {
  path: string;
  scope: "exact edit snapshot" | "file-wide write" | "file-wide fallback; exact edit snapshot unavailable, findings may predate this edit";
  input: CheckerInput;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** No rendered diffs or success prose are interpreted as mutation metadata. */
export async function checkerTargets(event: ToolResultEvent, ctx: ExtensionContext): Promise<CheckerTarget[]> {
  if (event.isError) return [];
  let tool = event.toolName;
  let details = record(event.details);
  // A device dispatch is not itself a file write. Only unwrap known mutation result contracts.
  if (tool === "write" && details.xdev) {
    const dispatch = record(details.xdev);
    if (dispatch.mode !== "execute") return [];
    tool = text(dispatch.tool) ?? "";
    details = record(dispatch.inner);
  }
  if (tool === "resolve") {
    if (details.action !== "apply") return [];
    tool = text(details.sourceToolName) ?? "";
    details = record(details.sourceResultDetails);
  }
  let files: Record<string, unknown>[];
  if (tool === "write") {
    const rawPath = text(event.input.path);
    if (!rawPath || /^[a-z][\w+.-]*:\/\//i.test(rawPath)) return [];
    const path = text(details.resolvedPath);
    if (!path) return [];
    // Archive members and SQLite rows report the container as resolvedPath, not a source-file mutation.
    if (rawPath.includes(":") && resolve(ctx.cwd, rawPath) !== resolve(ctx.cwd, path)) return [];
    files = [{ path }];
  } else if (tool === "edit" || tool === "apply_patch") {
    files = Array.isArray(details.perFileResults) ? details.perFileResults.map(record) : [details];
  } else if (tool === "ast_edit" && details.applied === true && Array.isArray(details.files)) {
    files = details.files.filter((path): path is string => typeof path === "string").map((path) => ({ path }));
  } else return [];

  const root = await realpath(ctx.cwd);
  const targets: CheckerTarget[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.op === "delete" || file.op === "remove") continue;
    const rawPath = text(file.move) ?? text(file.path);
    if (!rawPath || /^[a-z][\w+.-]*:\/\//i.test(rawPath)) continue;
    let path: string;
    let content: string;
    try {
      path = await realpath(resolve(ctx.cwd, rawPath));
      const fromRoot = relative(root, path);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || seen.has(path)) continue;
      if (!(await lstat(path)).isFile()) continue;
      content = await readFile(path, "utf8");
      if (content.includes("\0")) continue;
    } catch {
      // Deleted, non-regular, and inaccessible targets are not claimed to have been checked.
      continue;
    }
    seen.add(path);
    const oldText = text(file.oldText);
    const newText = text(file.newText);
    const exact = tool !== "write" && !file.snapshotsPruned && oldText !== undefined && newText !== undefined;
    if (exact && oldText === newText) continue;
    targets.push({
      path,
      scope: exact
        ? "exact edit snapshot"
        : tool === "write"
          ? "file-wide write"
          : "file-wide fallback; exact edit snapshot unavailable, findings may predate this edit",
      input: {
        session_id: ctx.sessionManager.getSessionId(),
        transcript_path: ctx.sessionManager.getSessionFile() ?? "",
        cwd: ctx.cwd,
        hook_event_name: "PostToolUse",
        tool_name: exact ? "edit" : "write",
        tool_input: exact ? { file_path: path, old_string: oldText, new_string: newText } : { file_path: path, content },
      },
    });
  }
  return targets;
}
