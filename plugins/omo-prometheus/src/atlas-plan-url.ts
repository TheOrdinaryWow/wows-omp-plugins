import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type InternalResource,
  type InternalUrl,
  InternalUrlRouter,
  type ProtocolHandler,
  type ResolveContext,
  type SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";

import type { AtlasPlan } from "./atlas-store.ts";
import { planDigest } from "./ledger.ts";

/** A plan URL names only the approved bundle, never a caller-controlled filesystem path. */
export function atlasPlanUrl(planId: string): string {
  return `atlas://${planId}/plan.md`;
}

const ATLAS_HANDLER_BRAND = Symbol.for("wows-omp-plugin-omo-prometheus/atlas-plan-url/v1");

export class AtlasPlanReferences implements ProtocolHandler {
  readonly scheme = "atlas";
  readonly spec: SchemeSpec = { backing: "file", selectors: "none", immutable: true };
  readonly [ATLAS_HANDLER_BRAND] = true;
  readonly #bindings = new Map<string, Map<string, { plan: AtlasPlan; directory: string }>>();
  #pendingBinds = 0;
  /** Separate extension instances in one host process share one handler without replacing a foreign registration. */
  static current(candidate: AtlasPlanReferences): AtlasPlanReferences {
    const registered = InternalUrlRouter.instance().getHandler(candidate.scheme) as AtlasPlanReferences | undefined;
    return registered?.[ATLAS_HANDLER_BRAND] === true && typeof registered.bind === "function" && typeof registered.unbind === "function"
      ? registered
      : candidate;
  }

  async bind(sessionId: string, plan: AtlasPlan): Promise<void> {
    const router = InternalUrlRouter.instance();
    const registered = router.getHandler(this.scheme);
    if (registered && registered !== this) throw new Error("atlas:// is already registered by another handler");
    if (router.isBuiltin(this.scheme)) throw new Error("atlas:// is reserved by the host");
    if (!registered) router.register(this);
    this.#pendingBinds += 1;
    try {
      const bundle = await fs.lstat(plan.directory);
      const directory = await fs.realpath(plan.directory);
      if (!bundle.isDirectory() || (await fs.realpath(plan.planFilePath)) !== path.join(directory, "plan.md"))
        throw new Error("Atlas approved plan backing changed");
      if (router.getHandler(this.scheme) !== this) throw new Error("atlas:// handler changed during plan binding");
      let plans = this.#bindings.get(sessionId);
      if (!plans) {
        plans = new Map();
        this.#bindings.set(sessionId, plans);
      }
      plans.set(plan.id, { plan, directory });
    } finally {
      this.#pendingBinds -= 1;
      this.#unregisterIfIdle();
    }
  }

  unbind(sessionId: string, planId: string): void {
    const plans = this.#bindings.get(sessionId);
    plans?.delete(planId);
    if (plans?.size === 0) this.#bindings.delete(sessionId);
    this.#unregisterIfIdle();
  }

  #unregisterIfIdle(): void {
    if (this.#bindings.size === 0 && this.#pendingBinds === 0) {
      const router = InternalUrlRouter.instance();
      if (router.getHandler(this.scheme) === this) router.unregister(this.scheme);
    }
  }

  #plan(url: InternalUrl, context?: ResolveContext): { plan: AtlasPlan; directory: string } {
    const sessionId = context?.localProtocolOptions?.getSessionId?.();
    const planId = url.rawHost;
    const inheritedSessionId = context?.session?.localProtocolOptions?.getSessionId?.();
    if (
      !sessionId ||
      !/^[a-zA-Z0-9_-]+$/.test(planId) ||
      url.rawHref !== atlasPlanUrl(planId) ||
      (context?.sessionId !== undefined && context.sessionId !== sessionId && inheritedSessionId !== sessionId)
    )
      throw new Error("atlas:// plan reference is unavailable for this session or URL");
    const plan = this.#bindings.get(sessionId)?.get(planId);
    if (!plan) throw new Error("atlas:// plan reference is unavailable for this session or URL");
    return plan;
  }

  async #verified(url: InternalUrl, context?: ResolveContext): Promise<{ path: string; content: string }> {
    const { plan, directory: boundDirectory } = this.#plan(url, context);
    const backing = await fs.lstat(plan.planFilePath);
    const bundle = await fs.lstat(plan.directory);
    const directory = await fs.realpath(plan.directory);
    const resolved = await fs.realpath(plan.planFilePath);
    if (!backing.isFile() || !bundle.isDirectory() || directory !== boundDirectory || resolved !== path.join(directory, "plan.md"))
      throw new Error("Atlas approved plan backing changed");
    const file = plan.planFilePath;
    const content = await fs.readFile(file, "utf8");
    if (planDigest(content) !== plan.planSha256) throw new Error("Atlas approved plan content changed");
    return { path: file, content };
  }

  async locate(url: InternalUrl, context?: ResolveContext): Promise<string> {
    return (await this.#verified(url, context)).path;
  }

  async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const { path, content } = await this.#verified(url, context);
    return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content), sourcePath: path, immutable: true };
  }
}
