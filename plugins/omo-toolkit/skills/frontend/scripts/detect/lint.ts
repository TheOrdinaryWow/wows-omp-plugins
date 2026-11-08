// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
import { isIgnored } from "./core/page";
import { extensionOf } from "./core/source";
import { isBlocking } from "./policy";
import type { PageRule, Rule, SourceRule } from "./rule";
import { ALL_RULES } from "./rules";
import type { DetectConfig, Finding, PageSnapshot, RuleMeta, Severity, SourceFile } from "./types";

export type LintOptions = {
  readonly config?: DetectConfig;
  /** Rules to run; defaults to every built-in rule. */
  readonly rules?: readonly Rule[];
  /** File the snapshot was rendered from, carried into element locations. */
  readonly file?: string;
};

/** Severity after the project's override, or null when the rule is switched off. @public */
export function effectiveSeverity(meta: RuleMeta, config: DetectConfig | undefined): Severity | null {
  const setting = config?.rules?.[meta.id];
  if (setting === "off") return null;
  return setting ?? meta.severity;
}

const isPageRule = (r: Rule): r is PageRule => r.meta.engine === "page";
const isSourceRule = (r: Rule): r is SourceRule => r.meta.engine === "source";

export function lintSnapshot(snapshot: PageSnapshot, options: LintOptions = {}): readonly Finding[] {
  const config = options.config ?? {};
  const findings: Finding[] = [];
  for (const rule of (options.rules ?? ALL_RULES).filter(isPageRule)) {
    const severity = effectiveSeverity(rule.meta, config);
    if (severity === null) continue;
    const overridden = config.rules?.[rule.meta.id] !== undefined;
    for (const hit of rule.check({ snapshot, config })) {
      if (hit.element && isIgnored(snapshot, hit.element, rule.meta.id)) continue;
      const hitSeverity = hit.severityFixed && hit.severity ? hit.severity : overridden ? severity : (hit.severity ?? severity);
      findings.push({
        ruleId: rule.meta.id,
        name: rule.meta.name,
        category: rule.meta.category,
        severity: hitSeverity,
        message: hit.message,
        fixHint: rule.meta.fixHint,
        snippet: hit.snippet,
        blocking: isBlocking("page", rule.meta.id, hitSeverity),
        location: hit.element
          ? {
              kind: "element",
              selector: hit.element.selector,
              rect: hit.element.rect,
              viewport: snapshot.viewport,
              ...(options.file ? { file: options.file } : {}),
            }
          : { kind: "page", viewport: snapshot.viewport, ...(options.file ? { file: options.file } : {}) },
      });
    }
  }
  return findings;
}

export function lintSources(files: readonly SourceFile[], options: LintOptions = {}): readonly Finding[] {
  const config = options.config ?? {};
  const findings: Finding[] = [];
  const rules = (options.rules ?? ALL_RULES).filter(isSourceRule);
  for (const file of files) {
    const ext = extensionOf(file.path);
    for (const rule of rules) {
      if (!rule.extensions.includes(ext)) continue;
      const severity = effectiveSeverity(rule.meta, config);
      if (severity === null) continue;
      for (const hit of rule.check({ file, config })) {
        findings.push({
          ruleId: rule.meta.id,
          name: rule.meta.name,
          category: rule.meta.category,
          severity,
          message: hit.message,
          fixHint: rule.meta.fixHint,
          snippet: hit.snippet,
          blocking: isBlocking("source", rule.meta.id, severity),
          location: { kind: "source", file: file.path, line: hit.line, column: hit.column },
        });
      }
    }
  }
  return findings;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { error: 0, warning: 1, advisory: 2 };

export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  const key = (f: Finding): string => {
    const l = f.location;
    switch (l.kind) {
      case "source":
        return `${l.file}:${String(l.line).padStart(8, "0")}:${String(l.column).padStart(6, "0")}`;
      case "element":
        return `${l.file ?? ""}@${l.viewport.width}:${String(Math.round(l.rect.y)).padStart(8, "0")}:${l.selector}`;
      case "page":
        return `${l.file ?? ""}@${l.viewport.width}`;
    }
  };
  return [...findings].sort(
    (a, b) => key(a).localeCompare(key(b)) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId),
  );
}

/** True when any finding is blocking (`policy.ts`); warnings and advisories from taste or craft-default rules never fail a gate. */
export const hasBlockingFindings = (findings: readonly Finding[]): boolean => findings.some((f) => f.blocking);
