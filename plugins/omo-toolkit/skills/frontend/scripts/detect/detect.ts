// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
// The reflow matrix and its unbroken stress string follow changeroa/StyleGallery (MIT, Copyright (c) 2026 IYEN); same section.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { extensionOf } from "./core/source";
import { type LintOptions, lintSnapshot, lintSources, sortFindings } from "./lint";
import type { Renderer, RenderTarget } from "./render/renderer";
import { type DetectReport, type InspectedSurface, surfaceOf } from "./report";
import type { DetectConfig, Finding, Viewport } from "./types";

/** @public */
export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

/** StyleGallery's reflow matrix: every width, with an unbroken stress token added at the narrowest one. @public */
export const REFLOW_VIEWPORTS: readonly Viewport[] = [320, 375, 768, 1024, 1440].map((width) => ({ width, height: 800 }));

export type DetectPageOptions = LintOptions & {
  /** Renders every pass, usually `createNativeBrowserRenderer(browser)` from an OMP eval cell; the caller closes it. */
  readonly renderer: Renderer;
  readonly viewports?: readonly Viewport[];
  /** Also render at REFLOW_VIEWPORTS with content stress at 320 px, feeding the viewport-reflow rule. */
  readonly reflow?: boolean;
};

const PAGE_EXTENSIONS = new Set(["html", "htm"]);

/** Renders a page at each viewport and lints every snapshot; the report names each capture and its limits. */
export async function detectPage(target: RenderTarget, options: DetectPageOptions): Promise<DetectReport> {
  const findings: Finding[] = [];
  const surfaces: InspectedSurface[] = [];
  const passes = [
    ...(options.viewports ?? DEFAULT_VIEWPORTS).map((viewport) => ({ viewport, contentStress: false })),
    ...(options.reflow ? REFLOW_VIEWPORTS.map((viewport) => ({ viewport, contentStress: viewport.width === 320 })) : []),
  ];
  for (const pass of passes) {
    const snapshot = await options.renderer.render({ target, ...pass });
    findings.push(...lintSnapshot(snapshot, options));
    surfaces.push(surfaceOf(snapshot, options.file));
  }
  return { findings: sortFindings(dedupe(findings)), surfaces, sourceFiles: [], notRendered: [] };
}

/** Lints files: HTML is rendered and checked as a page, everything else is checked as source text. */
export async function detectFiles(paths: readonly string[], options: DetectPageOptions): Promise<DetectReport> {
  const pages = paths.filter((p) => PAGE_EXTENSIONS.has(extensionOf(p)));
  const sourceFiles = paths.filter((p) => !PAGE_EXTENSIONS.has(extensionOf(p)));
  const findings: Finding[] = [
    ...lintSources(
      sourceFiles.map((path) => ({ path, text: readFileSync(path, "utf8") })),
      options,
    ),
  ];
  const surfaces: InspectedSurface[] = [];
  for (const page of pages) {
    const report = await detectPage({ kind: "url", url: pathToFileURL(resolve(page)).href }, { ...options, file: page });
    findings.push(...report.findings);
    surfaces.push(...report.surfaces);
  }
  return { findings: sortFindings(findings), surfaces, sourceFiles, notRendered: [] };
}

/** The same rule on the same element at two viewports is one finding; the first viewport's location is kept. */
function dedupe(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const where =
      f.location.kind === "element"
        ? f.location.selector
        : f.location.kind === "source"
          ? `${f.location.line}:${f.location.column}`
          : "page";
    const key = `${f.ruleId}|${where}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type { DetectConfig };
