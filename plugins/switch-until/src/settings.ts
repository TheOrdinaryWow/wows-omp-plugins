export interface UntilSettings {
  minimumConfidence: number;
  maxTurns: number;
  maxHours: number;
  contextMessages: number;
}

export const DEFAULT_SETTINGS: Readonly<UntilSettings> = { minimumConfidence: 0.8, maxTurns: 0, maxHours: 6, contextMessages: 6 };

export function parseSettings(raw: Record<string, unknown>, warn: (message: string) => void): UntilSettings {
  const read = (key: keyof UntilSettings, valid: (value: number) => boolean) => {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && valid(value)) return value;
    if (value !== undefined) warn(`Invalid switch-until setting ${key}. Using ${DEFAULT_SETTINGS[key]}.`);
    return DEFAULT_SETTINGS[key];
  };
  return {
    minimumConfidence: read("minimumConfidence", (value) => value >= 0.5 && value <= 1),
    maxTurns: read("maxTurns", (value) => Number.isInteger(value) && value >= 0),
    maxHours: read("maxHours", (value) => value > 0),
    contextMessages: read("contextMessages", (value) => Number.isInteger(value) && value >= 1),
  };
}
