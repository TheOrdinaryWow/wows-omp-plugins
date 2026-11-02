import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

import { parseSnippetSource, SNIPPET_KEY, type Snippet, type SnippetScope } from "#src/snippet.ts";

export interface SnippetEntry extends Snippet {
  id: string;
  enabled: boolean;
  pinned: boolean;
  uses: number;
  shadowed: boolean;
}

export interface SnippetProblem {
  path: string;
  message: string;
}

interface EntryState {
  disabled?: true;
  pinned?: true;
  uses?: number;
}

type StateEntries = Record<string, EntryState>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseState(raw: unknown): StateEntries {
  if (!record(raw) || raw.version !== 1 || !record(raw.entries))
    throw new Error("Expected snippet state version 1 with an entries object.");
  const entries: StateEntries = Object.create(null);
  for (const [id, value] of Object.entries(raw.entries)) {
    if (
      !record(value) ||
      (value.disabled !== undefined && value.disabled !== true) ||
      (value.pinned !== undefined && value.pinned !== true) ||
      (value.uses !== undefined && (typeof value.uses !== "number" || !Number.isSafeInteger(value.uses) || value.uses < 0))
    )
      throw new Error(`Invalid snippet state for ${id}.`);
    entries[id] = {
      ...(value.disabled === true ? { disabled: true } : {}),
      ...(value.pinned === true ? { pinned: true } : {}),
      ...(typeof value.uses === "number" ? { uses: value.uses } : {}),
    };
  }
  return entries;
}

function compare(a: SnippetEntry, b: SnippetEntry): number {
  return Number(b.pinned) - Number(a.pinned) || b.uses - a.uses || a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope);
}

export class SnippetStore {
  readonly globalDir: string;
  readonly workspaceDir: string;
  readonly #cwd: string;
  readonly #statePath: string;
  #entries: SnippetEntry[] = [];
  #problems: SnippetProblem[] = [];

  constructor(options: { cwd: string; globalDir?: string; statePath?: string }) {
    this.#cwd = resolve(options.cwd);
    this.globalDir = options.globalDir ?? join(getAgentDir(), "snippets");
    this.workspaceDir = join(this.#cwd, ".omp", "snippets");
    this.#statePath = options.statePath ?? join(getAgentDir(), "wows-omp-plugins", "snippets", "state.json");
  }

  get entries(): readonly SnippetEntry[] {
    return this.#entries;
  }

  get problems(): readonly SnippetProblem[] {
    return this.#problems;
  }

  active(): SnippetEntry[] {
    return this.#entries.filter((entry) => entry.enabled && !entry.shadowed);
  }

  async load(): Promise<SnippetEntry[]> {
    this.#problems = [];
    const state = await this.#readState();
    const global = await this.#readScope("global", state);
    const workspace = await this.#readScope("workspace", state);
    const localKeys = new Set(workspace.map((entry) => entry.key));
    for (const entry of global) entry.shadowed = localKeys.has(entry.key);
    this.#entries = [...global, ...workspace].sort(compare);
    return this.#entries;
  }

  async write(scope: SnippetScope, key: string, source: string): Promise<void> {
    const path = this.#path(scope, key);
    parseSnippetSource(source);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
    await this.load();
  }

  async rename(scope: SnippetScope, from: string, to: string): Promise<void> {
    const source = this.#path(scope, from);
    const target = this.#path(scope, to);
    if (from === to) return;
    const state = await this.#readState();
    // link() creates the destination exclusively, unlike rename() which replaces it.
    try {
      await link(source, target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new Error(`Snippet ${to} already exists in ${scope}.`);
      throw error;
    }
    await unlink(source);
    const previous = this.#id(scope, from);
    const next = this.#id(scope, to);
    if (state[previous]) state[next] = state[previous];
    else delete state[next];
    delete state[previous];
    await this.#saveState(state);
    await this.load();
  }

  async remove(scope: SnippetScope, key: string): Promise<void> {
    const path = this.#path(scope, key);
    const state = await this.#readState();
    await unlink(path);
    delete state[this.#id(scope, key)];
    await this.#saveState(state);
    await this.load();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.#requireEntry(id);
    const state = await this.#readState();
    const value = state[id] ?? {};
    if (enabled) delete value.disabled;
    else value.disabled = true;
    state[id] = value;
    await this.#saveState(state);
    await this.load();
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.#requireEntry(id);
    const state = await this.#readState();
    const value = state[id] ?? {};
    if (pinned) value.pinned = true;
    else delete value.pinned;
    state[id] = value;
    await this.#saveState(state);
    await this.load();
  }

  async recordUse(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) this.#requireEntry(id);
    const state = await this.#readState();
    for (const id of ids) {
      const value = state[id] ?? {};
      value.uses = (value.uses ?? 0) + 1;
      state[id] = value;
    }
    await this.#saveState(state);
    await this.load();
  }

  #id(scope: SnippetScope, key: string): string {
    return scope === "global" ? `global:${key}` : `workspace:${this.#cwd}:${key}`;
  }

  #path(scope: SnippetScope, key: string): string {
    if (!SNIPPET_KEY.test(key)) throw new Error("Snippet key must contain 1–64 ASCII letters, digits, underscores, or hyphens.");
    return join(scope === "global" ? this.globalDir : this.workspaceDir, `${key}.md`);
  }

  #requireEntry(id: string): void {
    if (!this.#entries.some((entry) => entry.id === id)) throw new Error(`Unknown snippet: ${id}`);
  }

  async #readScope(scope: SnippetScope, state: StateEntries): Promise<SnippetEntry[]> {
    const dir = scope === "global" ? this.globalDir : this.workspaceDir;
    const entries: SnippetEntry[] = [];
    try {
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".md")) continue;
        const path = join(dir, file.name);
        const key = file.name.slice(0, -3);
        try {
          if (!SNIPPET_KEY.test(key)) throw new Error("Invalid snippet filename: use 1–64 ASCII letters, digits, underscores, or hyphens.");
          const snippet = parseSnippetSource(await readFile(path, "utf8"));
          const id = this.#id(scope, key);
          entries.push({
            key,
            scope,
            path,
            ...snippet,
            id,
            enabled: state[id]?.disabled !== true,
            pinned: state[id]?.pinned === true,
            uses: state[id]?.uses ?? 0,
            shadowed: false,
          });
        } catch (error) {
          this.#problem(path, message(error));
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.#problem(dir, message(error));
    }
    return entries;
  }

  #problem(path: string, text: string): void {
    if (!this.#problems.some((problem) => problem.path === path && problem.message === text)) this.#problems.push({ path, message: text });
  }

  async #readState(): Promise<StateEntries> {
    try {
      return parseState(JSON.parse(await readFile(this.#statePath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        this.#problem(this.#statePath, `Snippet state could not be loaded; using empty state: ${message(error)}`);
      return Object.create(null);
    }
  }

  async #saveState(entries: StateEntries): Promise<void> {
    for (const [id, value] of Object.entries(entries)) if (!Object.keys(value).length) delete entries[id];
    await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#statePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
