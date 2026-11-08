// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../ATTRIBUTION.md section 7.
import { isRecord, isStringArray } from "../core/guards";
import type { PageSnapshot } from "../types";

const COVERAGE_COUNTS = ["elementCount", "elementCap", "shadowRoots", "frames", "stylesheets", "unreadableStylesheets"] as const;

/** True for the top-level shape `collectPageSnapshot` returns, coverage included; element records are trusted as collector output. @public */
export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (!isRecord(value) || !isRecord(value.viewport) || !isRecord(value.document) || !isRecord(value.coverage)) return false;
  const { viewport, document, coverage } = value;
  return (
    typeof viewport.width === "number" &&
    typeof viewport.height === "number" &&
    typeof document.scrollWidth === "number" &&
    typeof document.clientWidth === "number" &&
    typeof document.scrollHeight === "number" &&
    typeof value.url === "string" &&
    Array.isArray(value.elements) &&
    value.elements.every(isRecord) &&
    isStringArray(value.cssText) &&
    isStringArray(value.scriptErrors) &&
    typeof value.scriptErrorsCaptured === "boolean" &&
    COVERAGE_COUNTS.every((key) => Number.isInteger(coverage[key]) && Number(coverage[key]) >= 0) &&
    typeof coverage.truncated === "boolean" &&
    typeof coverage.contentStress === "boolean"
  );
}
