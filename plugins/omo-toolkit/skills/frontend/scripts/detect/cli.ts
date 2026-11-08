#!/usr/bin/env bun
// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
// CLI over the detect SDK (index.ts). It never renders: pages are captured in the OMP native browser
// (references/perfection/detect.md) and passed here as snapshot JSON.
//   bun cli.ts [--json] [--config <file.json>] <snapshot.json | source file or dir>...
// Exit 0 no blocking finding, 1 at least one blocking finding,
// 2 usage error, unreadable target, invalid snapshot, an explicit URL or HTML target, or nothing inspected.
import { readFileSync } from "node:fs";

import { collectFiles } from "../perfection/collect-files";
import {
  type DetectConfig,
  type DetectReport,
  type Finding,
  formatReportText,
  hasBlockingFindings,
  isPageSnapshot,
  lintSnapshot,
  lintSources,
  type PageSnapshot,
  parseConfig,
  type SourceFile,
  sortFindings,
  surfaceOf,
  toReportJson,
} from "./index";

type Args = { readonly json: boolean; readonly config: DetectConfig; readonly targets: readonly string[] };

const PAGE_FILE = /\.html?$/i;
const SNAPSHOT_FILE = /\.json$/i;
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

class UsageError extends Error {}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // CLI boundary: an unreadable or malformed file is a usage error reported as exit 2.
    throw new UsageError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv: readonly string[]): Args {
  let json = false;
  let config: DetectConfig = {};
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") json = true;
    else if (a === "--config") {
      const path = argv[++i];
      if (!path) throw new UsageError("--config needs a file");
      const parsed = parseConfig(readJson(path));
      if (typeof parsed === "string") throw new UsageError(`${path}: ${parsed}`);
      config = parsed;
    } else targets.push(a);
  }
  if (targets.length === 0) throw new UsageError("no targets");
  return { json, config, targets };
}

function readSnapshots(path: string): readonly PageSnapshot[] {
  const value = readJson(path);
  const snapshots = Array.isArray(value) ? value : [value];
  if (snapshots.length === 0 || !snapshots.every(isPageSnapshot)) {
    throw new UsageError(
      `${path}: not a frontend-detect page snapshot (capture it with snapshotExpression() or the native-browser renderer)`,
    );
  }
  return snapshots;
}

function inspect(args: Args): DetectReport {
  const unrenderable = args.targets.filter((t) => URL_TARGET.test(t) || PAGE_FILE.test(t));
  if (unrenderable.length > 0) {
    throw new UsageError(
      `cannot render ${unrenderable.join(", ")}; capture each page in the OMP native browser and pass its snapshot JSON (references/perfection/detect.md)`,
    );
  }
  const snapshotPaths = args.targets.filter((t) => SNAPSHOT_FILE.test(t));
  const { paths, missing } = collectFiles(args.targets.filter((t) => !SNAPSHOT_FILE.test(t)));
  if (missing.length > 0) throw new UsageError(`cannot read ${missing.join(", ")}`);
  const notRendered = paths.filter((p) => PAGE_FILE.test(p));
  const sources: SourceFile[] = paths.filter((p) => !PAGE_FILE.test(p)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const findings: Finding[] = [...lintSources(sources, { config: args.config })];
  const surfaces = [];
  for (const path of snapshotPaths) {
    for (const snapshot of readSnapshots(path)) {
      findings.push(...lintSnapshot(snapshot, { config: args.config, file: path }));
      surfaces.push(surfaceOf(snapshot, path));
    }
  }
  if (surfaces.length === 0 && sources.length === 0) {
    const pages = notRendered.length > 0 ? `; capture ${notRendered.join(", ")} in the OMP native browser` : "";
    throw new UsageError(`nothing inspected${pages}`);
  }
  return { findings: sortFindings(findings), surfaces, sourceFiles: sources.map((s) => s.path), notRendered };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = inspect(args);
  process.stdout.write(args.json ? `${JSON.stringify(toReportJson(report), null, 2)}\n` : formatReportText(report));
  process.exitCode = hasBlockingFindings(report.findings) ? 1 : 0;
} catch (error) {
  // CLI boundary: a usage error or a crash is exit 2, never a clean result or a finding count.
  const usage = error instanceof UsageError;
  process.stderr.write(
    `frontend-detect: ${error instanceof Error ? error.message : String(error)}\n${usage ? "usage: cli.ts [--json] [--config <file.json>] <snapshot.json | source file or dir>...\n" : ""}`,
  );
  process.exitCode = 2;
}
