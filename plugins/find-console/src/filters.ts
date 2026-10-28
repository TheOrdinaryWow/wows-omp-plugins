import { readdir } from "node:fs/promises";
import { basename, relative } from "node:path";

import { type InternalUrlFilesystem, isUrlPath } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { CascadeResult } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import type { SearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { type ShellFilesystem, ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";

import type { ConsoleHit } from "#src/report.ts";

export interface FindFilters {
  globs: string[];
  extensions: string[];
  minScore: number;
  limit?: number;
}

export function fileMatcher(filters: Pick<FindFilters, "globs" | "extensions">): (path: string) => boolean {
  const globs = filters.globs.map((pattern) => ({ glob: new Bun.Glob(pattern), basename: !pattern.includes("/") }));
  const extensions = filters.extensions.map((ext) => `.${ext}`);
  return (path) => {
    const normalized = path.replace(/\\/g, "/");
    const globMatch = !globs.length || globs.some((entry) => entry.glob.match(entry.basename ? basename(normalized) : normalized));
    const extMatch = !extensions.length || extensions.some((ext) => normalized.toLowerCase().endsWith(ext));
    return globMatch && extMatch;
  };
}

export function filterHits(hits: readonly ConsoleHit[], filters: Pick<FindFilters, "minScore" | "limit">): ConsoleHit[] {
  return hits
    .filter((hit) => hit.contentScore >= filters.minScore)
    .map((hit) => ({ ...hit, refined: hit.refined.filter((range) => range.p >= filters.minScore) }))
    .filter((hit) => hit.scope === "whole-file" || hit.refined.length > 0)
    .slice(0, filters.limit);
}

function rootRelative(root: SearchRoot, path: string): string {
  if (root.type === "file") return basename(path);
  return isUrlPath(root.path) ? path.slice(root.path.replace(/\/+$/, "").length + 1) : relative(root.path, path).replace(/\\/g, "/");
}

/** Intercept directory entries before both native lexical scanning and cascade filename ranking. */
export function filteredFilesystem(base: InternalUrlFilesystem, root: SearchRoot, filters: FindFilters): InternalUrlFilesystem {
  if (!filters.globs.length && !filters.extensions.length) return base;
  const matches = fileMatcher(filters);
  const binding: ShellFilesystem = {
    nativeLocalPaths: false,
    async handler(error, request) {
      if (error) return { error: { code: "EIO", message: error.message } };
      const response = await base.handle(request);
      if (request.op !== ShellFsOp.ReadDir || !request.path || response.error) return response;
      try {
        const entries = response.local
          ? (await readdir(response.local, { withFileTypes: true })).map((entry) => ({
              name: entry.name,
              fileType: entry.isDirectory() ? ShellFsFileType.Dir : entry.isSymbolicLink() ? ShellFsFileType.Symlink : ShellFsFileType.File,
            }))
          : response.entries;
        if (!entries) return response;
        const directory = request.path;
        return {
          entries: entries.filter(
            (entry) =>
              entry.fileType === ShellFsFileType.Dir ||
              [".gitignore", ".ignore"].includes(entry.name) ||
              matches(rootRelative(root, resolveSearchResultPath(directory, entry.name))),
          ),
        };
      } catch (cause) {
        const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "EIO";
        return { error: { code, message: cause instanceof Error ? cause.message : String(cause) } };
      }
    },
  };
  return new Proxy(base, {
    get(target, key) {
      if (key === "shellFilesystem") return () => binding;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An excluded explicit file is an empty, fully covered scope and never reaches the judge. */
export function emptyCascade(): CascadeResult {
  return {
    hits: [],
    keywords: [],
    threshold: 0.2,
    coverage: "complete",
    stats: {
      listed: 0,
      judged: 0,
      requests: 0,
      failed: 0,
      unanswered: 0,
      filesRead: 0,
      fileBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      apiMs: 0,
      windowsJudged: 0,
      windowsPruned: 0,
      mapCards: 0,
      failures: [],
    },
  };
}
