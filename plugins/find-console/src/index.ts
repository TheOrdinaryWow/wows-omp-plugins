import type { Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { hasNativeJudge, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { runCascade } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import { resolveSearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { formatPathRelativeToCwd, resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { cfgFindEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { argumentCompletions, parseFindArgs, USAGE } from "#src/args.ts";
import { showResults } from "#src/dialogs.ts";
import { commandNotice } from "#src/notices.ts";
import { PreviewReader } from "#src/preview.ts";
import { searchWithProgress } from "#src/progress.ts";
import { coverageWarning, disabledReason, rankedDigest } from "#src/results.ts";

export default function findConsole(pi: ExtensionAPI): void {
  pi.setLabel("Find console");
  let active: AbortController | undefined;
  const cancel = () => {
    active?.abort();
  };
  pi.on("session_before_switch", cancel);
  pi.on("session_shutdown", cancel);

  pi.registerCommand("find", {
    description: "Search by behavior and browse ranked, judged source ranges",
    getArgumentCompletions: argumentCompletions,
    async handler(input: string, ctx: ExtensionCommandContext): Promise<void> {
      let controller: AbortController | undefined;
      try {
        const args = parseFindArgs(input);
        if (args.help) {
          commandNotice(pi, ctx, USAGE);
          return;
        }
        if (args.cancel) {
          const running = active !== undefined;
          active?.abort();
          commandNotice(pi, ctx, running ? "Cancelling the current find search." : "No find search is running.");
          return;
        }
        if (active) {
          commandNotice(
            pi,
            ctx,
            "A find search is already running. Cancel it with Esc or /find --cancel before starting another.",
            "warning",
          );
          return;
        }
        const settings = findScopedSettings(ctx.cwd);
        if (!settings)
          throw new Error("The active session has no project-scoped settings; /find cannot resolve find.enabled or the judge role.");
        const mode = cfgFindEnabled.get(settings);
        const reason = disabledReason(mode, mode === "auto" && hasNativeJudge(settings, ctx.modelRegistry));
        if (reason) {
          commandNotice(pi, ctx, reason, "warning");
          return;
        }
        if (!args.query) {
          if (!ctx.hasUI) {
            commandNotice(pi, ctx, `A query is required without an interactive UI. ${USAGE}`, "error");
            return;
          }
          args.query =
            (await ctx.ui.input("Find: what behavior are you looking for?", "where release-please versions are bumped"))?.trim() ?? "";
          if (!args.query) return;
        }
        controller = new AbortController();
        active = controller;
        const signal = controller.signal;
        const filesystem = new InternalUrlFilesystem({
          context: {
            cwd: ctx.cwd,
            settings,
            signal,
            sessionId: ctx.sessionManager.getSessionId(),
            sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
            localProtocolOptions: ctx.localProtocolOptions ?? {
              getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
              getSessionId: () => ctx.sessionManager.getSessionId(),
            },
          },
          tier: "read",
        });
        const onUsage = journalJudgmentUsage(ctx.sessionManager);
        if (!onUsage) pi.logger.warn("Find judge usage cannot be journaled: this host's session manager has no appendModelUsage method.");
        const chain = resolveJudge({
          settings,
          registry: ctx.modelRegistry,
          sessionId: ctx.sessionManager.getSessionId(),
          purpose: "find",
          onUsage,
          cache: sharedJudgmentCache(),
        });
        const judge: Judge = {
          label: "native judge role",
          judge(request, options) {
            // `on` bypasses the host's auto gate, not the calibrated-score requirement.
            return chain.withCandidate((candidate, kind) => {
              if (kind !== "native")
                throw new Error("/find requires a native judge; a chat or local text model cannot supply calibrated search scores.");
              return candidate.judge(request, options);
            }, options);
          },
        };
        const report = await searchWithProgress(ctx, args.query, controller, async (onProgress) => {
          const started = performance.now();
          const root = await resolveSearchRoot(filesystem, args.path, ctx.cwd);
          const raw = await runCascade({
            root,
            filesystem,
            query: args.query,
            extraKeywords: args.keywords,
            judge,
            includeHidden: false,
            signal,
            onProgress,
          });
          const report: FindToolDetails = {
            ...raw,
            query: args.query,
            elapsedMs: performance.now() - started,
            cwd: ctx.cwd,
            scopePath: formatPathRelativeToCwd(root.path, ctx.cwd),
            hits: raw.hits.map((hit) => ({ ...hit, rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), ctx.cwd) })),
          };
          return report;
        });
        if (signal.aborted) {
          commandNotice(pi, ctx, "Find search cancelled.");
          return;
        }
        if (!ctx.hasUI) {
          commandNotice(
            pi,
            ctx,
            rankedDigest(report),
            report.coverage === "unavailable" ? "error" : report.coverage === "partial" ? "warning" : "info",
          );
          return;
        }
        if (report.coverage === "unavailable") {
          commandNotice(pi, ctx, [coverageWarning(report), ...report.stats.failures].join("\n"), "error");
          return;
        }
        if (!report.hits.length) {
          commandNotice(
            pi,
            ctx,
            `No hits for ${JSON.stringify(args.query)} in ${report.scopePath}.${report.coverage === "partial" ? ` ${coverageWarning(report)}` : ""}`,
            "info",
          );
          return;
        }
        active = undefined;
        await showResults(pi, ctx, report, new PreviewReader(filesystem, ctx.cwd));
      } catch (error) {
        if (controller?.signal.aborted) commandNotice(pi, ctx, "Find search cancelled.");
        else commandNotice(pi, ctx, `Find failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });
}
