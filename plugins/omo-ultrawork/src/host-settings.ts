import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

type SettingLookup = (id: string) => { get(settings: Settings): unknown } | undefined;

interface LegacySettingsReader {
  get(path: string): unknown;
}

function hasLegacyGetter(settings: object): settings is LegacySettingsReader {
  return "get" in settings && typeof settings.get === "function";
}

let settingLookup: Promise<SettingLookup> | undefined;

/**
 * Read a host setting by its dotted id on every supported omp line.
 *
 * omp 18.3.x removed `Settings.get(path)` in favor of per-setting handles
 * resolved through `config/registry`. That module is absent on older hosts
 * (18.2.11–18.3.0), so it is imported only once the legacy getter is gone.
 */
export async function readHostSetting(settings: Settings, id: string): Promise<unknown> {
  // Widen first: on hosts that still type `Settings.get`, its path-literal overload would shadow the legacy reader.
  const host: object = settings;
  if (hasLegacyGetter(host)) return host.get(id);

  // A literal specifier keeps the omp extension loader able to resolve this import. The module exists only on
  // omp >= 18.3.1, and CI type-checks against 18.2.11 too, so neither @ts-expect-error nor a clean import fits both.
  // biome-ignore lint/suspicious/noTsIgnore: the error is present on one supported host line and absent on the other.
  // @ts-ignore
  settingLookup ??= import("@oh-my-pi/pi-coding-agent/config/registry").then((registry) => registry.lookup as SettingLookup);
  const setting = (await settingLookup)(id);
  if (!setting) throw new Error(`host setting ${JSON.stringify(id)} is not registered`);
  return setting.get(settings);
}
