import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { cfgCycleOrder, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export const ATLAS_MODEL_ROLE = "atlas";

/** Lists the atlas role in `/models` even before it is assigned, without adding it to the Ctrl+P cycle. */
export function registerAtlasModelRole(settings: Settings): void {
  const tags = cfgModelTags.get(settings);
  if (Object.hasOwn(tags, ATLAS_MODEL_ROLE)) return;
  const runtimeTags = settings.getProvenance(cfgModelTags) === "runtime" ? tags : {};
  cfgModelTags.override(settings, { ...runtimeTags, [ATLAS_MODEL_ROLE]: { name: "Atlas" } });
}

/**
 * Native plan approval offers the roles in `cycleOrder` as execution tiers, and Ctrl+P cycles the same
 * order. The atlas role joins that order only while a Prometheus proposal awaits approval, and Ctrl+P
 * skips it meanwhile; `null` records that no runtime override existed.
 */
const exposedCycles = new WeakMap<AgentSession, readonly string[] | null>();

export function exposeAtlasApprovalTier(session: AgentSession): void {
  if (exposedCycles.has(session)) return;
  const { settings } = session;
  const order = cfgCycleOrder.get(settings);
  exposedCycles.set(session, settings.getProvenance(cfgCycleOrder) === "runtime" ? [...order] : null);
  cfgCycleOrder.override(settings, [ATLAS_MODEL_ROLE, ...order.filter((role) => role !== ATLAS_MODEL_ROLE)]);
  const cycleRoleModels = session.cycleRoleModels;
  // An own property shadows the prototype method until restoreApprovalTiers deletes it.
  session.cycleRoleModels = (roleOrder, direction) =>
    cycleRoleModels.call(
      session,
      roleOrder.filter((role) => role !== ATLAS_MODEL_ROLE),
      direction,
    );
}

export function restoreApprovalTiers(session: AgentSession): void {
  const previous = exposedCycles.get(session);
  if (previous === undefined) return;
  exposedCycles.delete(session);
  delete (session as Partial<Pick<AgentSession, "cycleRoleModels">>).cycleRoleModels;
  if (previous === null) cfgCycleOrder.clearOverride(session.settings);
  else cfgCycleOrder.override(session.settings, [...previous]);
}

/** Switches the session to the configured atlas role; returns undefined when the role is unassigned. */
export async function applyAtlasModel(session: AgentSession): Promise<string | undefined> {
  if (!session.settings.getModelRole(ATLAS_MODEL_ROLE)) return undefined;
  const resolved = session.resolveRoleModelWithThinking(ATLAS_MODEL_ROLE);
  if (!resolved.model) throw new Error(resolved.warning ?? "the atlas model role does not resolve to an available model");
  await session.applyRoleModel({
    role: ATLAS_MODEL_ROLE,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    explicitThinkingLevel: resolved.explicitThinkingLevel,
  });
  return `${resolved.model.provider}/${resolved.model.id}`;
}
