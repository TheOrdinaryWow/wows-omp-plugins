import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { magicEditPaths } from "@oh-my-pi/pi-coding-agent/edit/magic";

import { ADR_DIR, dirState } from "#src/documents.ts";
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

const COMMAND_PREFIXES = ["!", "{", "if", "then", "elif", "else", "do", "while", "until"];
const COMMAND_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  builtin: [],
  command: [],
  env: ["-C", "-u", "--chdir", "--unset"],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  nohup: [],
  sudo: ["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "--user", "--group"],
  time: [],
  xargs: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--replace", "--max-args"],
};

/** Includes the managed directory itself, since removing it also mutates its files. */
export function isManaged(path: string, repoRoot: string): boolean {
  const name = relative(join(repoRoot, ADR_DIR), path);
  return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
}

function shellWord(raw: string): string {
  return raw.replace(
    /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])/g,
    (_, doubleQuoted, singleQuoted, escaped) => doubleQuoted ?? singleQuoted ?? (escaped === "\n" ? "" : escaped),
  );
}

function bashTargets(command: string): string[] {
  // Deliberately a static shell projection, not a shell evaluator or sandbox.
  const tokens =
    command.match(/#[^\n]*|&>>?|\d*(?:>>?[&|]?|<<[-<]?|<[&>]?)|[\n|;&()]|(?:\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\s|;&()<>"'\\])+/g) ??
    [];
  const paths: string[] = [];
  let commandStart = true;
  let wrapper: string | undefined;
  let skipWrapperValue = false;
  let collecting = false;
  let sed = false;
  for (let index = 0; index < tokens.length; index++) {
    const raw = tokens[index] as string;
    if (/^[\n|;&()]$/.test(raw)) {
      commandStart = true;
      wrapper = undefined;
      skipWrapperValue = false;
      collecting = false;
      sed = false;
      continue;
    }
    if (raw.startsWith("#")) continue;
    if (/^(?:&?>|\d*[<>])/.test(raw)) {
      const next = tokens[++index];
      if (next && raw.includes(">")) {
        const target = shellWord(next);
        if (!raw.endsWith("&") || !/^(?:\d+|-)$/.test(target)) paths.push(target);
      }
      continue;
    }
    const token = shellWord(raw);
    if (!token) continue;
    if (commandStart) {
      if (skipWrapperValue) {
        skipWrapperValue = false;
        continue;
      }
      if (wrapper && token.startsWith("-")) {
        if (wrapper === "command" && /^-[p]*[vV]/.test(token)) commandStart = false;
        skipWrapperValue = COMMAND_WRAPPERS[wrapper]?.includes(token) ?? false;
        continue;
      }
      if (/^[A-Za-z_]\w*\+?=/.test(raw) || COMMAND_PREFIXES.includes(raw)) continue;
      if (Object.hasOwn(COMMAND_WRAPPERS, token)) {
        wrapper = token;
        continue;
      }
      commandStart = false;
      collecting = ["tee", "mv", "cp", "rm", "truncate"].includes(token);
      sed = token === "sed";
      continue;
    }
    if (sed && /^-(?:[A-Za-z]*i|-[A-Za-z]*in-place)/.test(token)) collecting = true;
    if (collecting && !token.startsWith("-")) paths.push(token);
  }
  return paths;
}

async function managedTargets(toolName: string, input: Record<string, unknown>, cwd: string, magic: boolean): Promise<string[]> {
  const paths: string[] = [];
  if (toolName === "write" && typeof input.path === "string") paths.push(input.path);
  if (toolName === "edit" || toolName === "apply_patch") {
    if (toolName === "edit" && magic) {
      if (typeof input.input === "string") paths.push(...magicEditPaths(input.input));
    } else {
      // The active native grammar can depend on the model and use the same wire fields as other grammars.
      const modes = toolName === "apply_patch" ? (["apply_patch"] as const) : EDIT_MODES;
      const payload = JSON.stringify(input);
      for (const mode of modes) {
        const projection = editInspect(mode, payload);
        paths.push(...projection.paths, ...projection.entries.map((entry) => entry.path));
        for (const op of projection.fileOps) {
          paths.push(op.path);
          if (op.to) paths.push(op.to);
        }
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
    if (typeof input.file === "string") paths.push(input.file);
    if (input.action === "rename_file" && typeof input.new_name === "string") paths.push(input.new_name);
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
  visit(join(repoRoot, ADR_DIR));
  return files;
}

/** Blocks native mutations of docs/adr/** once its marker (this plugin's or a legacy roadmap ADR index) is present. */
export async function interceptionReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  magic: boolean,
): Promise<string | undefined> {
  if (!["write", "edit", "apply_patch", "ast_edit", "lsp", "bash"].includes(toolName)) return;
  const candidates = await managedTargets(toolName, input, cwd, magic);
  if (!candidates.length) return;
  const currentRepo = targetRepo(cwd);
  const marked = new Map<string, boolean>();
  const identities = new Map<string, Set<string>>();
  const broad = toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch";
  const reason =
    "Managed ADR files must change through adr_manage (adr_check with fix: true regenerates the index). Read them with adr_status.";
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
        const name = relative(path, join(repoRoot, ADR_DIR));
        const ancestor = broad && (name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name)));
        if (!managed && !ancestor && !identity) continue;
        // A malformed marker throws, so the hook refuses rather than treating the repository as unmanaged.
        if (!marked.has(repoRoot)) marked.set(repoRoot, (await dirState(join(repoRoot, ADR_DIR))) === "managed");
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
