import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { type AdrDirState, type AdrSnapshot, adrRepo, DocumentError, dirState, loadInitialized, snapshot } from "#src/documents.ts";
import {
  type AdrActor,
  type CreateInput,
  createMany,
  initialize,
  link,
  Refusal,
  relinkStage,
  type StageResolver,
  type WriteOptions,
  type WriteResult,
} from "#src/operations.ts";
import { TOOL_SOURCE_PATH } from "#src/tools.ts";

export interface AdrWriteOptions {
  signal?: AbortSignal;
  dryRun?: boolean;
}

/** Version 1 of the `adr` service contract; see REFERENCE.md "Service contract". */
export interface AdrApiV1 {
  version: 1;
  dirState(repoRoot: string): Promise<AdrDirState>;
  load(repoRoot: string): Promise<AdrSnapshot | null>;
  initialize(repoRoot: string, actor: AdrActor, options?: AdrWriteOptions): Promise<WriteResult>;
  create(repoRoot: string, actor: AdrActor, input: CreateInput, options?: AdrWriteOptions): Promise<WriteResult>;
  createMany(
    repoRoot: string,
    actor: AdrActor,
    inputs: CreateInput[],
    options?: AdrWriteOptions & { initialize?: boolean },
  ): Promise<WriteResult>;
  link(repoRoot: string, actor: AdrActor, id: string, stage: string | undefined, options?: AdrWriteOptions): Promise<WriteResult>;
  relinkStage(repoRoot: string, actor: AdrActor, from: string, to: string, options?: AdrWriteOptions): Promise<WriteResult>;
  registerStageResolver(resolver: StageResolver): () => void;
}

export interface AdrService {
  api: AdrApiV1;
  resolver(): StageResolver | undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Contract errors are plain Errors whose message carries the refusal and its guidance. */
async function settle<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Refusal) throw new Error([error.message, ...error.hints].join(" "), { cause: error });
    if (error instanceof DocumentError) throw new Error(`${error.message} Run adr_check.`, { cause: error });
    throw error;
  }
}

/**
 * Answers `adr:binding-request` synchronously, and only for this instance's own session, with the tool source path and
 * the v1 API. `written` runs after every non-dry-run write so the sidecar follows API callers too.
 */
export function registerService(pi: ExtensionAPI, written: (ctx: ExtensionContext) => void): AdrService {
  let context: ExtensionContext | undefined;
  let resolver: StageResolver | undefined;
  const capture = (_event: unknown, ctx: ExtensionContext): void => {
    context = ctx;
  };
  // Requesters ask lazily (at tool or command time), after these events have captured this session.
  pi.on("session_start", capture);
  pi.on("session_switch", capture);
  pi.on("session_branch", capture);
  pi.on("session_tree", capture);
  pi.on("before_agent_start", capture);
  pi.on("input", capture);
  pi.on("tool_call", capture);

  /** Only the caller's signal and dryRun pass through; the resolver always comes from this session. */
  const write = (options: AdrWriteOptions | undefined, run: (options: WriteOptions) => Promise<WriteResult>): Promise<WriteResult> =>
    settle(async () => {
      const result = await run({ signal: options?.signal, dryRun: options?.dryRun === true, resolver });
      if (!options?.dryRun && result.files.length && context) written(context);
      return result;
    });

  const api: AdrApiV1 = {
    version: 1,
    dirState: (repoRoot) => settle(() => dirState(adrRepo(repoRoot).adrDir)),
    load: (repoRoot) =>
      settle(async () => {
        const model = await loadInitialized(repoRoot);
        return model ? snapshot(model) : null;
      }),
    initialize: (repoRoot, actor, options) => write(options, (resolved) => initialize(repoRoot, actor, resolved)),
    create: (repoRoot, actor, input, options) => write(options, (resolved) => createMany(repoRoot, actor, [input], resolved)),
    createMany: (repoRoot, actor, inputs, options) =>
      write(options, (resolved) => createMany(repoRoot, actor, inputs, { ...resolved, initialize: options?.initialize === true })),
    link: (repoRoot, actor, id, stage, options) => write(options, (resolved) => link(repoRoot, actor, id, stage, resolved)),
    relinkStage: (repoRoot, actor, from, to, options) => write(options, (resolved) => relinkStage(repoRoot, actor, from, to, resolved)),
    registerStageResolver(next) {
      if (typeof next !== "function") throw new Error("A stage resolver must be a function.");
      resolver = next;
      return () => {
        if (resolver === next) resolver = undefined;
      };
    },
  };

  const subscription = pi.events.on("adr:binding-request", (payload) => {
    const ctx = context;
    if (
      !ctx ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== ctx.sessionManager.getSessionId() ||
      typeof payload.requestId !== "string" ||
      !payload.requestId
    )
      return;
    pi.events.emit("adr:binding", {
      v: 1,
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      toolSourcePath: TOOL_SOURCE_PATH,
      api,
    });
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    resolver = undefined;
    subscription();
  });
  return { api, resolver: () => resolver };
}
