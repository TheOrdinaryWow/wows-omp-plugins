import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

type SettingLookup = (id: string) => { get(settings: Settings): unknown } | undefined;

let settingLookup: Promise<SettingLookup> | undefined;

/**
 * Read a host setting by its dotted id on every supported omp line.
 *
 * omp 18.3.x removed `Settings.get(path)` in favor of per-setting handles
 * resolved through `config/registry`. That module is absent on older hosts
 * (18.2.7–18.3.0), so it is imported only once the legacy getter is gone.
 */
export async function readHostSetting(settings: Settings, id: string): Promise<unknown> {
  if ("get" in settings && typeof settings.get === "function") return settings.get(id);

  settingLookup ??= import("@oh-my-pi/pi-coding-agent/config/registry").then((registry) => registry.lookup);
  const setting = (await settingLookup)(id);
  if (!setting) throw new Error(`host setting ${JSON.stringify(id)} is not registered`);
  return setting.get(settings);
}
