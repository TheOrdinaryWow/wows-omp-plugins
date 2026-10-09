import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { cfgTaskIsolationMerge } from "@oh-my-pi/pi-coding-agent/task/settings";

/**
 * Host patch merges apply each isolated child's delta to the parent checkout uncommitted, dropping the child's
 * commits. While Atlas executes, a runtime override switches merges to branch so per-slice commits land. The
 * value records whether a runtime `patch` override existed before, so restoring puts back exactly that layer.
 */
const forcedMerges = new WeakMap<AgentSession, boolean>();

/** Switches `task.isolation.merge` from patch to branch for this session; returns whether it changed now. */
export function forceBranchMerge(session: AgentSession): boolean {
  const { settings } = session;
  if (forcedMerges.has(session) || cfgTaskIsolationMerge.get(settings) !== "patch") return false;
  forcedMerges.set(session, settings.getProvenance(cfgTaskIsolationMerge) === "runtime");
  cfgTaskIsolationMerge.override(settings, "branch");
  return true;
}

export function restoreIsolationMerge(session: AgentSession): void {
  const hadRuntimePatch = forcedMerges.get(session);
  if (hadRuntimePatch === undefined) return;
  forcedMerges.delete(session);
  if (hadRuntimePatch) cfgTaskIsolationMerge.override(session.settings, "patch");
  else cfgTaskIsolationMerge.clearOverride(session.settings);
}
