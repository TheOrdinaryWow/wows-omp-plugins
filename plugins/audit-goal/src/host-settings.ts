import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/** Read a host setting by its dotted id through the host's setting registry. */
export function readHostSetting(settings: Settings, id: string): unknown {
  const setting = lookup(id);
  if (!setting) throw new Error(`host setting ${JSON.stringify(id)} is not registered`);
  return setting.get(settings);
}
