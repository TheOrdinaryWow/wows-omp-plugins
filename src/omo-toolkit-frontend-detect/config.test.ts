// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { describe, expect, test } from "bun:test";

import { parseConfig } from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/config";
import type { DetectConfig } from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/types";

describe("parseConfig (the CLI's --config trust boundary)", () => {
  test("#given a full valid config #then every field is kept", () => {
    const input: DetectConfig = {
      rules: { "low-contrast": "warning", "bounce-easing": "off" },
      allowFonts: ["Inter"],
      allowEasings: ["cubic-bezier(0.34, 1.56, 0.64, 1)"],
      designTokens: { fonts: ["Inter"], colors: ["#111"], radii: [8, 12], fontSizes: [12, 16, 24] },
    };
    expect(parseConfig(input)).toEqual(input);
  });

  test.each([
    ["a non-object", [], "config must be a JSON object"],
    ["an unknown key", { severity: "error" }, "unknown config key 'severity'"],
    ["a bad rule setting", { rules: { "low-contrast": "fatal" } }, "rules.low-contrast must be one of error, warning, advisory, off"],
    ["a non-string font", { allowFonts: [12] }, "allowFonts must be an array of family names"],
    ["an unknown token key", { designTokens: { shadows: [] } }, "unknown designTokens key 'shadows'"],
    ["a non-numeric radius", { designTokens: { radii: ["8px"] } }, "designTokens.radii must be an array of px numbers"],
  ])("#given %s #then it is refused with a message naming the field", (_name, input, message) => {
    expect(parseConfig(input)).toBe(message);
  });
});
