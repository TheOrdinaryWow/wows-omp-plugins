import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadRepo } from "#src/documents.ts";
import { discoverRepo, type GitRepo } from "#src/git.ts";
import {
  editInspect,
  expandDelimitedPathEntries,
  normalizePathLikeInput,
  parseSearchPath,
  resolveToCwd,
  unwrapHashlineHeaderPath,
} from "#src/host.ts";

const EDIT_MODES = ["hashline", "replace", "patch", "apply_patch", "sloppy"] as const;

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
export async function managedTargets(
  toolName: string,
  input: Record<string, unknown>,
  editMode: string | undefined,
  cwd: string,
): Promise<string[]> {
  const paths: string[] = [];
  if (toolName === "write" && typeof input.path === "string") paths.push(input.path);
  if (toolName === "edit" || toolName === "apply_patch") {
    // The active host mode can depend on the model; inspect every grammar rather than guessing from wire fields.
    const modes = toolName === "apply_patch" ? ["apply_patch"] : editMode === undefined ? EDIT_MODES : [editMode];
    const payload = JSON.stringify(input);
    for (const mode of modes) {
      if (!EDIT_MODES.some((supported) => supported === mode)) throw new Error(`Unknown native edit mode: ${mode}`);
      const projection = editInspect(mode, payload);
      paths.push(...projection.paths, ...projection.entries.map((entry) => entry.path));
      for (const op of projection.fileOps) {
        paths.push(op.path);
        if (op.to) paths.push(op.to);
      }
    }
    if (!paths.length) throw new Error("Unrecognized native edit grammar; its mutation targets cannot be validated");
  }
  if (toolName === "ast_edit") {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some((path) => typeof path !== "string")) {
      throw new Error("AST edit scopes must be non-empty paths or globs");
    }
    const entries = input.paths.map(normalizePathLikeInput);
    if (entries.some((path) => !path)) throw new Error("AST edit scopes must be non-empty paths or globs");
    const scopes = await expandDelimitedPathEntries(entries, cwd);
    if (scopes.some((path) => !path)) throw new Error("AST edit scopes must be non-empty paths or globs");
    paths.push(...scopes.map((path) => parseSearchPath(path).basePath));
  }
  if (
    toolName === "lsp" &&
    (input.action === "rename" || input.action === "rename_file" || (input.action === "code_actions" && input.apply))
  ) {
    for (const field of ["file", "new_name"]) if (typeof input[field] === "string") paths.push(input[field]);
  }
  if (toolName === "bash" && typeof input.command === "string") {
    paths.push(...bashTargets(input.command));
    if (typeof input.cwd === "string") cwd = resolveToCwd(input.cwd, cwd);
  }
  return [
    ...new Set(
      paths
        .map((path) => (toolName === "write" ? unwrapHashlineHeaderPath(path) : path))
        .filter((path) => path && (!/^@?[a-z][a-z\d+.-]*:\/\//i.test(path) || /^@?file:\/\//i.test(path)))
        .map((path) => {
          const absolute = resolveToCwd(path, cwd);
          if (toolName !== "ast_edit" && toolName !== "bash") return absolute;
          const pattern = absolute.search(/[*?[\]{}]/);
          return pattern < 0 ? absolute : absolute.slice(0, absolute.lastIndexOf(sep, pattern) + 1);
        }),
    ),
  ];
}

function resolvedPath(path: string, links?: Set<string>): string {
  let ancestor = path;
  for (;;) {
    let isLink: boolean;
    try {
      isLink = lstatSync(ancestor).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    if (isLink) {
      links ??= new Set<string>();
      if (links.has(ancestor)) throw new Error(`Symlink cycle while resolving ${path}`);
      links.add(ancestor);
      const target = resolve(dirname(ancestor), readlinkSync(ancestor));
      return resolve(resolvedPath(target, links), relative(ancestor, path));
    }
    return resolve(realpathSync(ancestor), relative(ancestor, path));
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

function hardlinkIdentity(path: string): string | undefined {
  try {
    const info = statSync(path, { bigint: true });
    return info.isFile() && info.nlink > 1n ? `${info.dev}:${info.ino}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function managedFileIdentities(repoRoot: string): Set<string> {
  const files = new Set<string>();
  const directories = new Set<string>();
  function visit(path: string): void {
    const info = statSync(path, { bigint: true });
    const identity = `${info.dev}:${info.ino}`;
    if (info.isDirectory()) {
      if (directories.has(identity)) return;
      directories.add(identity);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (info.isFile() && info.nlink > 1n) files.add(identity);
  }
  for (const directory of ["docs/roadmap", "docs/adr"]) visit(join(repoRoot, directory));
  return files;
}

export async function interceptionReason(toolName: string, input: Record<string, unknown>, cwd: string): Promise<string | undefined> {
  if (!["write", "edit", "apply_patch", "ast_edit", "lsp", "bash"].includes(toolName)) return;
  const candidates = await managedTargets(toolName, input, undefined, cwd);
  if (!candidates.length) return;
  const currentRepo = targetRepo(cwd);
  const marked = new Map<string, boolean>();
  const identities = new Map<string, Set<string>>();
  const broad = toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch";
  const reason =
    "Managed Roadmap files must change through roadmap_stage, roadmap_todo or roadmap_adr (roadmap_check with fix for generated indexes).";
  for (const candidate of candidates) {
    // Check both spellings: a symlink inside a managed directory must not grant an escape.
    for (const path of new Set([candidate, resolvedPath(candidate)])) {
      const git = targetRepo(path);
      const roots = new Set<string>();
      if (git) roots.add(git.repoRoot);
      if (currentRepo) roots.add(currentRepo.repoRoot);
      const identity = hardlinkIdentity(path);
      for (const repoRoot of roots) {
        const managed = isManaged(path, repoRoot);
        const ancestor =
          broad &&
          ["docs/roadmap", "docs/adr"].some((directory) => {
            const name = relative(path, join(repoRoot, directory));
            return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
          });
        if (!managed && !ancestor && !identity) continue;
        if (!marked.has(repoRoot)) marked.set(repoRoot, Boolean(await loadRepo(repoRoot)));
        if (!marked.get(repoRoot)) continue;
        if (managed || ancestor) return reason;
        if (identity) {
          let files = identities.get(repoRoot);
          if (!files) {
            files = managedFileIdentities(repoRoot);
            identities.set(repoRoot, files);
          }
          if (files.has(identity)) return reason;
        }
      }
    }
  }
}
