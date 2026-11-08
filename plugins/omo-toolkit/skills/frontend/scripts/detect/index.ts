// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
// The frontend detect SDK's public API, for callers outside this repository: an OMP eval cell, a skill script, a project's own lint step.
export { parseConfig } from "./config";
export { blend, colorsIn, contrastRatio, luminance, parseColor, type Rgba } from "./core/color";
export { DEFAULT_VIEWPORTS, type DetectPageOptions, detectFiles, detectPage, REFLOW_VIEWPORTS } from "./detect";
export { effectiveSeverity, hasBlockingFindings, type LintOptions, lintSnapshot, lintSources, sortFindings } from "./lint";
export { isBlocking, OBJECTIVE_DEFECT_RULES } from "./policy";
export {
  createNativeBrowserRenderer,
  MAX_ELEMENTS,
  type NativeBrowser,
  type NativeBrowserRendererOptions,
  type NativeTab,
  SETTLE_EXPRESSION,
  snapshotExpression,
} from "./render/native-browser";
export { RenderError, type Renderer, type RenderRequest, type RenderTarget } from "./render/renderer";
export {
  type DetectReport,
  formatReportText,
  type InspectedSurface,
  limitsOf,
  REPORT_SCOPE_NOTE,
  summarize,
  surfaceOf,
  toReportJson,
} from "./report";
export type { PageContext, PageHit, PageRule, Rule, SourceContext, SourceHit, SourceRule } from "./rule";
export { ALL_RULES } from "./rules";
export { collectPageSnapshot, SCRIPT_ERROR_PROBE } from "./snapshot/collect";
export { isPageSnapshot } from "./snapshot/validate";
export type * from "./types";
