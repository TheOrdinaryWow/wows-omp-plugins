import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRepo } from "#src/documents.ts";
import { discoverRepo, type GitRepo } from "#src/git.ts";
import { editInspect } from "#src/host.ts";

/** Includes the managed directory itself, since removing it also mutates its files. */
export function isManaged(path: string, repoRoot: string): boolean {
  return ["docs/roadmap", "docs/adr"].some((directory) => {
    const name = relative(join(repoRoot, directory), path);
    return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
  });
}

function bashTargets(command: string): string[] {
  // Deliberately a static shell projection, not a shell evaluator or sandbox.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[12]?>>?|[|;&]|[^\s|;&<>]+/g) ?? [];
  const paths: string[] = [];
  let collecting = false;
  let sed = false;
  for (let index = 0; index < tokens.length; index++) {
    const raw = tokens[index] as string;
    const token = raw.replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (/^[|;&]$/.test(token)) {
      collecting = false;
      sed = false;
      continue;
    }
    if (/^[12]?>>?$/.test(token)) {
      const next = tokens[++index];
      if (next) paths.push(next.replace(/^(["'])([\s\S]*)\1$/, "$2"));
      continue;
    }
    if (["tee", "mv", "cp", "rm", "truncate"].includes(token)) {
      collecting = true;
      continue;
    }
    if (token === "sed") {
      sed = true;
      continue;
    }
    if (sed && /^-(?:[A-Za-z]*i|-[A-Za-z]*in-place)/.test(token)) collecting = true;
    if (collecting && !token.startsWith("-")) paths.push(token);
  }
  return paths;
}

/** Native editInspect projects every supported edit grammar, including move/delete intents. */
export function managedTargets(toolName: string, input: Record<string, unknown>, editMode: string, cwd: string): string[] {
  const paths: string[] = [];
  if (toolName === "write" && typeof input.path === "string") paths.push(input.path);
  if (toolName === "edit" || toolName === "apply_patch") {
    const mode = toolName === "apply_patch" ? "apply_patch" : editMode;
    const projection = editInspect(mode, JSON.stringify(input));
    paths.push(...projection.paths, ...projection.entries.map((entry) => entry.path));
    for (const op of projection.fileOps) {
      paths.push(op.path);
      if (op.to) paths.push(op.to);
    }
    if (typeof input.path === "string") paths.push(input.path);
  }
  if (toolName === "ast_edit" && Array.isArray(input.paths)) {
    for (const path of input.paths) if (typeof path === "string") paths.push(path);
  }
  if (
    toolName === "lsp" &&
    (input.action === "rename" || input.action === "rename_file" || (input.action === "code_actions" && input.apply))
  ) {
    for (const field of ["file", "new_name"]) if (typeof input[field] === "string") paths.push(input[field]);
  }
  if (toolName === "bash" && typeof input.command === "string") {
    paths.push(...bashTargets(input.command));
    if (typeof input.cwd === "string") cwd = resolve(cwd, input.cwd);
  }
  return [
    ...new Set(
      paths
        .filter((path) => path && (!/^[a-z][a-z\d+.-]*:\/\//i.test(path) || path.startsWith("file://")))
        .map((path) => {
          if (path.startsWith("file://")) return fileURLToPath(path);
          // Only glob-aware tools project a pattern to its directory ancestor.
          const base = toolName === "ast_edit" || toolName === "bash" ? path.split(/[*?[\]{}]/, 1)[0] || "." : path;
          return resolve(cwd, base);
        }),
    ),
  ];
}

function resolvedPath(path: string): string {
  let ancestor = path;
  for (;;) {
    try {
      statSync(ancestor);
      return resolve(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function targetRepo(path: string): GitRepo | null {
  let location = path;
  for (;;) {
    try {
      const info = statSync(location);
      return discoverRepo(info.isDirectory() ? location : dirname(location));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(location);
      if (parent === location) return null;
      location = parent;
    }
  }
}

export async function interceptionReason(toolName: string, input: Record<string, unknown>, cwd: string): Promise<string | undefined> {
  if (!["write", "edit", "apply_patch", "ast_edit", "lsp", "bash"].includes(toolName)) return;
  const mode =
    typeof input.input === "string"
      ? input.input.trimStart().startsWith("*** Begin Patch")
        ? "apply_patch"
        : "hashline"
      : typeof input.old_text === "string"
        ? "replace"
        : "patch";
  const candidates = managedTargets(toolName, input, mode, cwd);
  for (const candidate of candidates) {
    // Check both spellings: a symlink inside a managed directory must not grant an escape.
    for (const path of new Set([candidate, resolvedPath(candidate)])) {
      const git = targetRepo(path);
      if (!git) continue;
      const broad = toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch";
      const ancestor =
        broad &&
        ["docs/roadmap", "docs/adr"].some((directory) => {
          const name = relative(path, join(git.repoRoot, directory));
          return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
        });
      if (!isManaged(path, git.repoRoot) && !ancestor) continue;
      if (!(await loadRepo(git.repoRoot))) continue;
      return "Managed Roadmap files must change through roadmap_stage, roadmap_todo or roadmap_adr (roadmap_check with fix for generated indexes).";
    }
  }
}
