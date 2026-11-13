import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  type AdrDirState,
  type AdrDoc,
  type AdrModel,
  type AdrStatus,
  adrRepo,
  dirState,
  loadModel,
  ordered,
  parseAdr,
  repoPath,
} from "#src/documents.ts";
import { parseFrontmatter } from "#src/host.ts";
import { datedNotes } from "#src/operations.ts";
import { buildHistory, type HistoryEvent } from "#src/visualize-history.ts";

export interface AdrNode {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  stage?: string;
  supersedes: string[];
  supersededBy?: string;
  decisionMakers: string[];
  consulted: string[];
  informed: string[];
  path: string;
  body: string;
  notes: Array<{ date: string; text: string }>;
  mentions: string[];
  workingTree: "clean" | "modified" | "untracked";
}

export interface StageInfo {
  id: string;
  title?: string;
  round?: string;
  status?: string;
}

export interface AdrGraph {
  version: 1;
  generatedAt: string;
  repo: { name: string; root: string; branch?: string; head?: string };
  state: AdrDirState;
  adrs: AdrNode[];
  stages: StageInfo[];
  history: { available: boolean; reason?: string; events: HistoryEvent[] };
  parseErrors: Array<{ path: string; message: string }>;
}

async function stageInfo(root: string, ids: string[]): Promise<StageInfo[]> {
  const stages = new Map(ids.map((id) => [id, { id } as StageInfo]));
  if (!ids.length) return [];
  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /^S\d{2,}.*\.md$/.test(entry.name)) {
        const { frontmatter: fm, body } = parseFrontmatter(await readFile(path, "utf8"), { repair: false });
        if (typeof fm.id !== "string" || !stages.has(fm.id)) continue;
        const info: StageInfo = { id: fm.id };
        for (const field of ["title", "round", "status"] as const) if (typeof fm[field] === "string") info[field] = fm[field];
        info.title ??= /^# (.+)$/m.exec(body)?.[1];
        stages.set(info.id, info);
      }
    }
  }
  await walk(join(root, "docs/roadmap"));
  return ordered([...stages.values()]);
}

export async function buildAdrGraph(path: string): Promise<AdrGraph> {
  const repo = adrRepo(path);
  const generatedAt = new Date().toISOString();
  const parseErrors: AdrGraph["parseErrors"] = [];
  let state: AdrDirState;
  try {
    state = await dirState(repo.adrDir);
  } catch (error) {
    state = "managed";
    parseErrors.push({ path: "docs/adr/README.md", message: error instanceof Error ? error.message : String(error) });
  }
  const model: Pick<AdrModel, "adrs" | "files" | "parseErrors"> =
    state === "managed" || state === "unmanaged" ? await loadModel(repo) : { adrs: [], files: {}, parseErrors: [] };
  parseErrors.push(...model.parseErrors.map((issue) => ({ path: repoPath(repo, issue.path), message: issue.message })));
  const history = await buildHistory(repo.repoRoot, model.files, generatedAt);
  const headAdrs = new Map<string, { path: string; content: string }>();
  for (const [path, content] of history.headFiles) {
    let doc: AdrDoc;
    try {
      doc = parseAdr(content);
    } catch {
      continue;
    }
    headAdrs.set(doc.id, { path, content });
  }
  const ids = new Set(model.adrs.map((doc) => doc.id));
  const adrs: AdrNode[] = ordered(model.adrs).map((doc) => {
    const path = repoPath(repo, doc.path);
    const head = headAdrs.get(doc.id);
    const excluded = new Set([doc.id, ...doc.supersedes, ...(doc.superseded_by ? [doc.superseded_by] : [])]);
    return {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      date: doc.date,
      ...(doc.stage ? { stage: doc.stage } : {}),
      supersedes: doc.supersedes,
      ...(doc.superseded_by ? { supersededBy: doc.superseded_by } : {}),
      decisionMakers: doc.decision_makers,
      consulted: doc.consulted,
      informed: doc.informed,
      path,
      body: doc.body,
      notes: datedNotes(doc.body).map((entry) => ({
        date: entry.heading.slice(4),
        text: doc.body.slice(entry.start + entry.heading.length, entry.end).trim(),
      })),
      mentions: ordered(
        [...new Set(doc.body.match(/\bADR-\d{4,}\b/g) ?? [])].filter((id) => ids.has(id) && !excluded.has(id)).map((id) => ({ id })),
      ).map(({ id }) => id),
      workingTree: !head ? "untracked" : head.path === path && head.content === model.files[doc.path] ? "clean" : "modified",
    };
  });
  return {
    version: 1,
    generatedAt,
    repo: {
      name: basename(repo.repoRoot),
      root: repo.repoRoot,
      ...(history.branch ? { branch: history.branch } : {}),
      ...(history.head ? { head: history.head } : {}),
    },
    state,
    adrs,
    stages: await stageInfo(repo.repoRoot, [...new Set(adrs.flatMap((doc) => (doc.stage ? [doc.stage] : [])))]),
    history: { available: history.available, ...(history.reason ? { reason: history.reason } : {}), events: history.events },
    parseErrors,
  };
}
