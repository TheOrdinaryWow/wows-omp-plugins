import {
  type AdrModel,
  type AdrRepo,
  DocumentError,
  indexFresh,
  loadModel,
  parseAdr,
  parseIndex,
  renderAdr,
  renderIndex,
  repoPath,
} from "#src/documents.ts";
import { atomicWrite, Cancelled, withAdrLock } from "#src/store.ts";

export interface Diagnostic {
  severity: "error" | "warning";
  rule: string;
  /** Repository-relative path. */
  path: string;
  message: string;
  fixable: boolean;
}

/** ADR-internal consistency only; stage references belong to the roadmap plugin's check. */
export function diagnostics(model: AdrModel): Diagnostic[] {
  const result: Diagnostic[] = [];
  const report = (rule: string, path: string, message: string, fixable = false): void => {
    result.push({ severity: "error", rule, path: repoPath(model.repo, path), message, fixable });
  };
  for (const issue of model.parseErrors) report(issue.rule, issue.path, issue.message);
  // A legacy file must stay expressible in this plugin's format, since the next write converts it.
  for (const doc of model.adrs) {
    try {
      parseAdr(renderAdr(doc), doc.path);
    } catch (error) {
      report(error instanceof DocumentError ? error.rule : "structure", doc.path, error instanceof Error ? error.message : String(error));
    }
  }
  const byId = new Map<string, string>();
  for (const doc of model.adrs) {
    const previous = byId.get(doc.id);
    if (previous === undefined) byId.set(doc.id, doc.path);
    else
      report(
        "duplicate-id",
        doc.path,
        `Duplicate ${doc.id}; also present in ${repoPath(model.repo, previous)}. Cross-branch or cross-clone collisions require a manual decision; ids are never reused.`,
      );
  }
  const adrs = new Map(model.adrs.map((doc) => [doc.id, doc]));
  for (const doc of model.adrs) {
    for (const reference of [...doc.supersedes, ...(doc.superseded_by ? [doc.superseded_by] : [])]) {
      if (!adrs.has(reference)) report("dangling-reference", doc.path, `${doc.id} refers to missing ADR ${reference}.`);
    }
    if (doc.superseded_by && adrs.get(doc.superseded_by)?.supersedes.includes(doc.id) === false)
      report("supersession", doc.path, `${doc.id} names successor ${doc.superseded_by}, which does not list it in supersedes.`);
    for (const predecessor of doc.supersedes) {
      const previous = adrs.get(predecessor);
      if (previous && previous.superseded_by !== doc.id)
        report(
          "supersession",
          doc.path,
          `${doc.id} supersedes ${predecessor}, whose superseded_by is ${previous.superseded_by ?? "absent"}.`,
        );
    }
    if ((doc.status === "superseded") !== Boolean(doc.superseded_by))
      report(
        "supersession",
        doc.path,
        doc.superseded_by
          ? `${doc.id} has successor ${doc.superseded_by} but status ${doc.status}; a superseded ADR has status superseded.`
          : `${doc.id} has status superseded but no superseded_by successor.`,
      );
  }
  if (model.index) {
    try {
      parseIndex(renderIndex(model.index, model.adrs), model.index.path);
      if (!indexFresh(model.index, model.adrs)) report("generated", model.index.path, "Stale generated ADR index. Run check --fix.", true);
    } catch (error) {
      report(
        error instanceof DocumentError ? error.rule : "structure",
        model.index.path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return result;
}

/**
 * With `fix`, regenerates a stale index under the ADR lock (a legacy index is rewritten in this plugin's format, like any
 * other write). Nothing else is ever repaired. `changedFiles` receives the repository-relative paths actually written.
 */
export async function check(
  repo: AdrRepo,
  options: { fix?: boolean; signal?: AbortSignal; changedFiles?: string[] } = {},
): Promise<Diagnostic[]> {
  if (!options.fix) return diagnostics(await loadModel(repo));
  return withAdrLock(repo.commonDir, async () => {
    if (options.signal?.aborted) throw new Cancelled();
    const model = await loadModel(repo);
    const found = diagnostics(model);
    const blocked = found.some((item) => item.rule === "structure" || item.rule === "format");
    if (!model.index || blocked || !found.some((item) => item.fixable)) return found;
    await atomicWrite(model.index.path, renderIndex(model.index, model.adrs), options.signal);
    options.changedFiles?.push(repoPath(repo, model.index.path));
    return diagnostics(await loadModel(repo));
  });
}
