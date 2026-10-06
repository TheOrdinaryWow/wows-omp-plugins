import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { parseRoadmapIndex, parseStage } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import type { RoadmapSession } from "#src/ses.ts";

const TOOL_SOURCE_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read only the bound stage synchronously: pi.events cannot await a binding answer. */
function boundStage(repoRoot: string, id: string): { id: string; title: string; round: string } | undefined {
  const roadmapDir = join(repoRoot, "docs/roadmap");
  const indexPath = join(roadmapDir, "README.md");
  parseRoadmapIndex(readFileSync(indexPath, "utf8"), indexPath);
  for (const round of readdirSync(roadmapDir, { withFileTypes: true })) {
    if (!round.isDirectory() || !/^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(round.name)) continue;
    const stagesDir = join(roadmapDir, round.name, "stages");
    let files: string[];
    try {
      files = readdirSync(stagesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".md") || Number(file.split("-")[0]) !== Number(id.slice(1))) continue;
      const path = join(stagesDir, file);
      const stage = parseStage(readFileSync(path, "utf8"), path);
      if (stage.id === id && stage.status === "active") return { id: stage.id, title: stage.title, round: stage.round };
    }
  }
  return undefined;
}

export function registerPrometheusContract(pi: ExtensionAPI, ses: RoadmapSession): void {
  let context: ExtensionContext | undefined;
  const capture = (_event: unknown, ctx: ExtensionContext): void => {
    context = ctx;
    ses.ensure(ctx);
  };
  pi.on("session_start", capture);
  pi.on("session_switch", capture);
  pi.on("session_branch", capture);
  pi.on("session_tree", capture);
  pi.on("before_agent_start", capture);
  pi.on("input", capture);
  pi.on("tool_call", capture);
  pi.on("tool_result", capture);

  const bindingSubscription = pi.events.on("roadmap:binding-request", (payload) => {
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
    try {
      ses.ensure(ctx);
      const repoRoot = discoverRepo(ctx.cwd)?.repoRoot ?? resolve(ctx.cwd);
      const binding = ses.getBinding(repoRoot);
      const stage = binding ? boundStage(repoRoot, binding.stage) : undefined;
      pi.events.emit("roadmap:binding", {
        v: 1,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        repoRoot,
        toolSourcePath: TOOL_SOURCE_PATH,
        ...(stage ? { stage } : {}),
      });
    } catch (error) {
      pi.logger.warn("roadmap could not answer the Prometheus binding request", { error: String(error) });
    }
  });

  const completionSubscription = pi.events.on("atlas:completed", (payload) => {
    const ctx = context;
    if (
      !ctx ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== ctx.sessionManager.getSessionId() ||
      typeof payload.planId !== "string" ||
      !payload.planId ||
      typeof payload.at !== "string" ||
      !object(payload.roadmapStage) ||
      typeof payload.roadmapStage.repoRoot !== "string" ||
      typeof payload.roadmapStage.id !== "string" ||
      !/^S\d+$/.test(payload.roadmapStage.id) ||
      !Array.isArray(payload.gates)
    )
      return;
    if (
      payload.gates.some(
        (gate) => !object(gate) || typeof gate.gateId !== "string" || typeof gate.verdict !== "string" || typeof gate.summary !== "string",
      )
    )
      return;
    try {
      const repoRoot = discoverRepo(ctx.cwd)?.repoRoot;
      if (repoRoot !== payload.roadmapStage.repoRoot) return;
      ses.recordPendingClose(ctx, {
        repoRoot,
        stage: payload.roadmapStage.id,
        planId: payload.planId,
        gates: payload.gates as Array<{ gateId: string; verdict: string; summary: string }>,
      });
    } catch (error) {
      pi.logger.warn("roadmap could not record Atlas completion", { error: String(error) });
    }
  });

  pi.on("session_shutdown", () => {
    context = undefined;
    bindingSubscription();
    completionSubscription();
  });
}
