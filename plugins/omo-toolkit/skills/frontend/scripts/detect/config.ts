// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
import { isRecord, isStringArray } from "./core/guards";
import type { DesignTokens, DetectConfig, RuleSetting } from "./types";

const SETTINGS: readonly RuleSetting[] = ["error", "warning", "advisory", "off"];

const isNumberArray = (v: unknown): v is readonly number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));

function parseTokens(v: unknown): DesignTokens | string {
  if (!isRecord(v)) return "designTokens must be an object";
  const { fonts, colors, radii, fontSizes, ...rest } = v;
  const extra = Object.keys(rest)[0];
  if (extra) return `unknown designTokens key '${extra}'`;
  if (fonts !== undefined && !isStringArray(fonts)) return "designTokens.fonts must be an array of family names";
  if (colors !== undefined && !isStringArray(colors)) return "designTokens.colors must be an array of CSS colors";
  if (radii !== undefined && !isNumberArray(radii)) return "designTokens.radii must be an array of px numbers";
  if (fontSizes !== undefined && !isNumberArray(fontSizes)) return "designTokens.fontSizes must be an array of px numbers";
  return {
    ...(fonts !== undefined ? { fonts } : {}),
    ...(colors !== undefined ? { colors } : {}),
    ...(radii !== undefined ? { radii } : {}),
    ...(fontSizes !== undefined ? { fontSizes } : {}),
  };
}

const isSetting = (v: unknown): v is RuleSetting => SETTINGS.some((s) => s === v);

/** Parses a detect config from untrusted JSON; returns the config or a message naming the first bad field. */
export function parseConfig(input: unknown): DetectConfig | string {
  if (!isRecord(input)) return "config must be a JSON object";
  const known = new Set(["rules", "allowFonts", "allowEasings", "designTokens"]);
  const unknownKey = Object.keys(input).find((k) => !known.has(k));
  if (unknownKey) return `unknown config key '${unknownKey}'`;
  const { rules, allowFonts, allowEasings, designTokens } = input;
  const tokens = designTokens === undefined ? undefined : parseTokens(designTokens);
  if (typeof tokens === "string") return tokens;
  const parsedRules: Record<string, RuleSetting> = {};
  if (rules !== undefined) {
    if (!isRecord(rules)) return "rules must be an object of rule id -> error|warning|advisory|off";
    for (const [id, setting] of Object.entries(rules)) {
      if (!isSetting(setting)) return `rules.${id} must be one of ${SETTINGS.join(", ")}`;
      parsedRules[id] = setting;
    }
  }
  if (allowFonts !== undefined && !isStringArray(allowFonts)) return "allowFonts must be an array of family names";
  if (allowEasings !== undefined && !isStringArray(allowEasings)) return "allowEasings must be an array of timing functions";
  return {
    ...(rules !== undefined ? { rules: parsedRules } : {}),
    ...(allowFonts !== undefined ? { allowFonts } : {}),
    ...(allowEasings !== undefined ? { allowEasings } : {}),
    ...(tokens !== undefined ? { designTokens: tokens } : {}),
  };
}
