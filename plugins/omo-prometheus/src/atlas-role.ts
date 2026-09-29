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
 * Native plan approval offers the roles in `cycleOrder` as execution tiers. The atlas role joins that
 * order only while a Prometheus proposal awaits approval; `null` records that no runtime override existed.
 */
const exposedCycles = new WeakMap<Settings, readonly string[] | null>();

export function exposeAtlasApprovalTier(settings: Settings): void {
  if (exposedCycles.has(settings)) return;
  const order = cfgCycleOrder.get(settings);
  exposedCycles.set(settings, settings.getProvenance(cfgCycleOrder) === "runtime" ? [...order] : null);
  cfgCycleOrder.override(settings, [ATLAS_MODEL_ROLE, ...order.filter((role) => role !== ATLAS_MODEL_ROLE)]);
}

export function restoreApprovalTiers(settings: Settings): void {
  const previous = exposedCycles.get(settings);
  if (previous === undefined) return;
  exposedCycles.delete(settings);
  if (previous === null) cfgCycleOrder.clearOverride(settings);
  else cfgCycleOrder.override(settings, [...previous]);
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
