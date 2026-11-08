// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
import type { Finding, PageSnapshot, Severity, SnapshotCoverage, Viewport } from "./types";

/** One rendered capture that was linted: which page, at which size, and what the collector could not see. @public */
export type InspectedSurface = {
  readonly url: string;
  readonly file?: string;
  readonly viewport: Viewport;
  readonly scriptErrorsCaptured: boolean;
  readonly coverage: SnapshotCoverage;
};

/** Findings plus everything a reader needs to know about what was and was not inspected. @public */
export type DetectReport = {
  readonly findings: readonly Finding[];
  readonly surfaces: readonly InspectedSurface[];
  /** Files linted as source text only; no rendered evidence. */
  readonly sourceFiles: readonly string[];
  /** Pages found under a target directory that the CLI cannot render; capture them in the native browser. */
  readonly notRendered: readonly string[];
};

/** @public */
export const REPORT_SCOPE_NOTE =
  "Findings cover only the listed captures and rules, each page at rest in one state; zero findings is not a complete visual or accessibility verification.";

/** @public */
export const surfaceOf = (snapshot: PageSnapshot, file?: string): InspectedSurface => ({
  url: snapshot.url,
  ...(file ? { file } : {}),
  viewport: snapshot.viewport,
  scriptErrorsCaptured: snapshot.scriptErrorsCaptured,
  coverage: snapshot.coverage,
});

/** The parts of a capture the collector could not inspect, as sentences for the report. @public */
export function limitsOf(surface: InspectedSurface): readonly string[] {
  const c = surface.coverage;
  return [
    c.truncated
      ? `element cap reached: ${c.elementCap} of ${c.elementCount} elements inspected`
      : `all ${c.elementCount} elements inspected (cap ${c.elementCap})`,
    `shadow DOM not inspected (${c.shadowRoots} open shadow root(s); closed roots are not detectable)`,
    `frame documents not inspected (${c.frames} iframe/frame element(s))`,
    `${c.unreadableStylesheets} of ${c.stylesheets} stylesheet(s) unreadable; their rules are missing from keyframe and declaration checks`,
    ...(surface.scriptErrorsCaptured ? [] : ["script errors not captured: the error probe did not run before page scripts"]),
  ];
}

/** @public */
export function summarize(findings: readonly Finding[]): Readonly<Record<Severity | "blocking", number>> {
  const counts: Record<Severity | "blocking", number> = { error: 0, warning: 0, advisory: 0, blocking: 0 };
  for (const f of findings) {
    counts[f.severity]++;
    if (f.blocking) counts.blocking++;
  }
  return counts;
}

function where(f: Finding): string {
  const l = f.location;
  switch (l.kind) {
    case "source":
      return `${l.file}:${l.line}:${l.column}`;
    case "element":
      return `${l.file ?? "page"} @${l.viewport.width}px ${l.selector}`;
    case "page":
      return `${l.file ?? "page"} @${l.viewport.width}px`;
  }
}

export function formatReportText(report: DetectReport): string {
  const lines = report.findings.map(
    (f) =>
      `${where(f)}  ${f.severity}${f.blocking ? " blocking" : ""}  ${f.ruleId}  ${f.message}\n    > ${f.snippet}\n    fix: ${f.fixHint}`,
  );
  const c = summarize(report.findings);
  lines.push(
    `frontend-detect: ${report.findings.length} finding(s): ${c.error} error, ${c.warning} warning, ${c.advisory} advisory; ${c.blocking} blocking`,
  );
  for (const s of report.surfaces) {
    const stress = s.coverage.contentStress ? ", content stress" : "";
    lines.push(`inspected ${s.url} @${s.viewport.width}x${s.viewport.height}${stress}${s.file ? ` (${s.file})` : ""}`);
    for (const limit of limitsOf(s)) lines.push(`    limit: ${limit}`);
  }
  if (report.sourceFiles.length > 0) lines.push(`source text only: ${report.sourceFiles.length} file(s)`);
  if (report.notRendered.length > 0) lines.push(`not rendered (capture in the native browser): ${report.notRendered.join(", ")}`);
  lines.push(`scope: ${REPORT_SCOPE_NOTE}`);
  return `${lines.join("\n")}\n`;
}

/** The report as JSON for reviewers: each surface carries its limits, and the scope note travels with the findings. @public */
export function toReportJson(report: DetectReport) {
  return {
    summary: summarize(report.findings),
    findings: report.findings,
    surfaces: report.surfaces.map((s) => ({ ...s, limits: limitsOf(s) })),
    sourceFiles: report.sourceFiles,
    notRendered: report.notRendered,
    scope: REPORT_SCOPE_NOTE,
  };
}
