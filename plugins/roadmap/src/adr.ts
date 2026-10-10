import { randomUUID } from "node:crypto";

import { loadAll, loadRepo } from "./documents.ts";

/** The `adr` service contract v1, as the adr plugin's REFERENCE.md "Service contract" defines it. */
export type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
export type AdrActor = "main" | "sub";
export type AdrDirState = "absent" | "empty" | "managed" | "unmanaged";

export interface AdrSections {
  context: string;
  drivers?: string;
  options: string[];
  outcome: string;
  consequences?: string;
  confirmation?: string;
  pros_cons?: string;
  more_info?: string;
}

export interface AdrCreateInput {
  title: string;
  sections: AdrSections;
  status?: Exclude<AdrStatus, "superseded">;
  stage?: string;
  decision_makers?: string[];
  consulted?: string[];
  informed?: string[];
}

export interface AdrRecord {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  stage?: string;
  supersedes: string[];
  superseded_by?: string;
  decision_makers: string[];
  consulted: string[];
  informed: string[];
  /** Repository-relative, e.g. docs/adr/0001-use-madr.md. */
  path: string;
  /** MADR body after the "# title" line. */
  body: string;
  legacy: boolean;
}

export interface AdrSnapshot {
  repoRoot: string;
  records: AdrRecord[];
  parseErrors: Array<{ path: string; message: string }>;
}

export interface AdrWriteOptions {
  signal?: AbortSignal;
  dryRun?: boolean;
}

export interface AdrWriteResult {
  /** Repository-relative paths, ADR files first and the index last. */
  files: Array<{ path: string; content: string }>;
  ids: string[];
  warnings: string[];
}

/** Undefined accepts the stage; a string is the refusal reason. */
export type StageResolver = (repoRoot: string, stageId: string) => Promise<string | undefined>;

export interface AdrApi {
  version: 1;
  dirState(repoRoot: string): Promise<AdrDirState>;
  load(repoRoot: string): Promise<AdrSnapshot | null>;
  initialize(repoRoot: string, actor: AdrActor, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  create(repoRoot: string, actor: AdrActor, input: AdrCreateInput, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  createMany(
    repoRoot: string,
    actor: AdrActor,
    inputs: AdrCreateInput[],
    options?: AdrWriteOptions & { initialize?: boolean },
  ): Promise<AdrWriteResult>;
  link(repoRoot: string, actor: AdrActor, id: string, stage: string | undefined, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  relinkStage(repoRoot: string, actor: AdrActor, from: string, to: string, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  registerStageResolver(resolver: StageResolver): () => void;
}

/** What one roadmap read saw of docs/adr through the service. */
export interface AdrView {
  /** False when docs/adr is absent, empty or unmanaged; there are no records then. */
  managed: boolean;
  records: AdrRecord[];
  /** Files the adr plugin could not parse; their ADRs are missing from `records`. */
  parseErrors: Array<{ path: string; message: string }>;
  /** Set when the adr plugin could not read docs/adr at all, such as a malformed marker. */
  error?: string;
}

export const ADR_INSTALL_HINT =
  "Install or update the adr plugin with `omp plugin install adr@wows-omp-plugins`, enable it, and restart the session.";

const API_METHODS = ["dirState", "load", "initialize", "create", "createMany", "link", "relinkStage", "registerStageResolver"] as const;

export interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Asks the session's adr plugin for its v1 service; the plugin answers synchronously or not at all. */
export function requestAdr(events: ContractEvents, sessionId: string): { api: AdrApi } | { reason: string } {
  const requestId = randomUUID();
  let reply: Record<string, unknown> | undefined;
  const unsubscribe = events.on("adr:binding", (payload) => {
    if (object(payload) && payload.sessionId === sessionId && payload.requestId === requestId) reply ??= payload;
  });
  try {
    events.emit("adr:binding-request", { v: 1, sessionId, requestId });
  } finally {
    unsubscribe();
  }
  if (!reply) return { reason: "Roadmap needs the adr plugin, which is not loaded in this session." };
  const api = reply.api;
  if (reply.v !== 1 || !object(api) || api.version !== 1 || API_METHODS.some((method) => typeof api[method] !== "function"))
    return { reason: "The loaded adr plugin does not provide the ADR service contract v1 that roadmap needs." };
  return { api: api as unknown as AdrApi };
}

const pendingStages = new Map<string, ReadonlySet<string>>();

/** Lets the adr plugin link initial ADRs to the stages an /init-project write is about to create. */
export async function withPendingStages<T>(repoRoot: string, ids: readonly string[], run: () => Promise<T>): Promise<T> {
  pendingStages.set(repoRoot, new Set(ids));
  try {
    return await run();
  } finally {
    pendingStages.delete(repoRoot);
  }
}

/** Accepts any stage of the repository's roadmap, whatever its status. Reads without the roadmap lock, which callers may hold. */
export async function resolveStage(repoRoot: string, stageId: string): Promise<string | undefined> {
  if (pendingStages.get(repoRoot)?.has(stageId)) return undefined;
  try {
    const repo = await loadRepo(repoRoot);
    if (!repo) return "this repository has no roadmap; the user initializes one with /init-project.";
    const model = await loadAll(repo);
    if (model.stages.some((stage) => stage.id === stageId)) return undefined;
    return `it is not a stage of this repository's roadmap. Call roadmap_status for stage ids.`;
  } catch (error) {
    return `the roadmap could not be read (${errorMessage(error)}). Run roadmap_check.`;
  }
}

/** One extension instance's binding to the adr plugin of its current session, with roadmap's stage resolver registered. */
export class AdrConnection {
  #sessionId?: string;
  #api?: AdrApi;
  #unregister?: () => void;

  constructor(private readonly events: ContractEvents) {}

  connect(sessionId: string): { api: AdrApi } | { reason: string } {
    if (this.#api && this.#sessionId === sessionId) return { api: this.#api };
    this.release();
    const result = requestAdr(this.events, sessionId);
    if (!("api" in result)) return result;
    try {
      this.#unregister = result.api.registerStageResolver(resolveStage);
    } catch (error) {
      return { reason: `The adr plugin refused roadmap's stage resolver: ${errorMessage(error)}` };
    }
    this.#sessionId = sessionId;
    this.#api = result.api;
    return result;
  }

  /** The service, or an Error whose message carries the install hint. */
  require(sessionId: string): AdrApi {
    const result = this.connect(sessionId);
    if ("api" in result) return result.api;
    throw new Error(`${result.reason} ${ADR_INSTALL_HINT}`);
  }

  release(): void {
    const unregister = this.#unregister;
    this.#sessionId = undefined;
    this.#api = undefined;
    this.#unregister = undefined;
    unregister?.();
  }
}
