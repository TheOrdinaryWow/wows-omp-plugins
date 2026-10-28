import type { Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { hasNativeJudge, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { runCascade } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import { resolveSearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { formatPathRelativeToCwd, resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { cfgFindEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

import { argumentCompletions, parseFindArgs, USAGE } from "#src/args.ts";
import { accountCache } from "#src/cache.ts";
import { pickHistory, showResults } from "#src/dialogs.ts";
import { emptyCascade, fileMatcher, filteredFilesystem, filterHits } from "#src/filters.ts";
import { type HistoryEntry, HistoryStore, historyCommand, type WithinSearch } from "#src/history.ts";
import { commandNotice } from "#src/notices.ts";
import { PreviewReader } from "#src/preview.ts";
import { searchWithProgress } from "#src/progress.ts";
import { refineHits } from "#src/refinement.ts";
import type { ConsoleReport } from "#src/report.ts";
import { countLabel, disabledReason, rankedDigest } from "#src/results.ts";
import { readSearchSettings } from "#src/settings.ts";
import { translateQuery } from "#src/translation.ts";

export default function findConsole(pi: ExtensionAPI): void {
  pi.setLabel("Find console");
  let active: AbortController | undefined;
  let recent: HistoryEntry[] = [];
  const cancel = () => active?.abort();
  const refreshHistory = async (cwd: string) => {
    try {
      const history = new HistoryStore(cwd);
      recent = await history.load();
      if (history.warning) pi.logger.warn(history.warning);
    } catch (error) {
      recent = [];
      pi.logger.warn("Find history completion is unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  pi.on("session_before_switch", cancel);
  pi.on("session_shutdown", cancel);
  pi.on("session_start", async (_event, ctx) => refreshHistory(ctx.cwd));
  pi.on("session_switch", async (_event, ctx) => refreshHistory(ctx.cwd));

  pi.registerCommand("find", {
    description: "Advanced native-judge search with precise ranges, translation, filters and history",
    getArgumentCompletions(prefix) {
      const options = argumentCompletions(prefix) ?? [];
      const queries = recent
        .filter((entry) => !entry.within && entry.args.query.toLowerCase().startsWith(prefix.trim().toLowerCase()))
        .map((entry) => ({
          value: historyCommand(entry),
          label: entry.args.query,
          description: `Recent search · ${entry.args.path} · saved flags`,
        }));
      return queries.length || options.length ? [...queries, ...options] : null;
    },
    async handler(input: string, ctx: ExtensionCommandContext): Promise<void> {
      let controller: AbortController | undefined;
      try {
        let args = parseFindArgs(input);
        let within: WithinSearch | undefined;
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
        const history = new HistoryStore(ctx.cwd);
        for (;;) {
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
          if (args.history) {
            if (!ctx.hasUI) {
              commandNotice(pi, ctx, "/find --history requires an interactive history picker. Supply a query without UI.", "error");
              return;
            }
            recent = await history.load();
            if (history.warning) commandNotice(pi, ctx, history.warning, "warning");
            if (!recent.length) {
              commandNotice(pi, ctx, "No recent searches in this project.");
              return;
            }
            const picked = await pickHistory(ctx, recent);
            if (!picked) return;
            args = picked.args;
            within = picked.within;
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
          const reader = new PreviewReader(filesystem, ctx.cwd);
          const onUsage = journalJudgmentUsage(ctx.sessionManager);
          if (!onUsage) pi.logger.warn("Find judge usage cannot be journaled: this host's session manager has no appendModelUsage method.");
          const accounting = accountCache(args.noCache ? undefined : sharedJudgmentCache(), args.noCache);
          const chain = resolveJudge({
            settings,
            registry: ctx.modelRegistry,
            sessionId: ctx.sessionManager.getSessionId(),
            purpose: "find",
            onUsage,
            ...(accounting.cache ? { cache: accounting.cache } : {}),
          });
          const judge: Judge = {
            label: "native judge role",
            judge(request, options) {
              accounting.requested(request);
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
            const pluginSettings = await readSearchSettings(ctx.cwd);
            onProgress("checking query language");
            const translated = await translateQuery({
              query: args.query,
              enabled: pluginSettings.autoTranslate && !args.noTranslate,
              settings,
              ctx,
              signal,
              onUsage,
              onProgress,
            });
            if (translated.originalQuery) onProgress(`searched as: ${translated.query}`);
            else if (translated.translation && "skipped" in translated.translation)
              onProgress(`Translation skipped: ${translated.translation.skipped}`);
            const root = await resolveSearchRoot(filesystem, args.path, ctx.cwd);
            const excluded =
              root.type === "file" &&
              (!fileMatcher(args)(root.path.split("/").at(-1) ?? root.path) || (within !== undefined && !within.files.includes(root.path)));
            const raw = excluded
              ? emptyCascade()
              : await runCascade({
                  root,
                  filesystem: filteredFilesystem(filesystem, root, args, within?.files),
                  query: translated.query,
                  extraKeywords: args.keywords,
                  judge,
                  includeHidden: false,
                  signal,
                  onProgress,
                });
            const hits = await refineHits({
              hits: raw.hits
                .filter((hit) => hit.contentScore >= args.minScore)
                .map((hit) => ({ ...hit, rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), ctx.cwd) })),
              query: translated.query,
              threshold: Math.max(raw.threshold, args.minScore),
              reader,
              judge,
              stats: raw.stats,
              signal,
              onProgress,
            });
            raw.stats.cost += translated.cost;
            const report: ConsoleReport = {
              ...raw,
              threshold: Math.max(raw.threshold, args.minScore),
              query: translated.query,
              originalQuery: translated.originalQuery,
              translation: translated.translation,
              elapsedMs: performance.now() - started,
              cwd: ctx.cwd,
              scopePath: formatPathRelativeToCwd(root.path, ctx.cwd),
              hits: filterHits(hits, args),
              coverage: raw.coverage === "complete" && hits.some((hit) => hit.refineFailed) ? "partial" : raw.coverage,
              cache: accounting.state,
              previewMode: pluginSettings.previewMode,
              ...(within ? { within: { query: within.query, files: within.files.length } } : {}),
            };
            return report;
          });
          if (signal.aborted) {
            commandNotice(pi, ctx, "Find search cancelled.");
            return;
          }
          active = undefined;
          try {
            recent = await history.remember({ args, searchedAt: Date.now(), ...(within ? { within } : {}) });
          } catch (error) {
            commandNotice(pi, ctx, `Find history could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
          if (!ctx.hasUI || report.coverage === "unavailable" || !report.hits.length) {
            commandNotice(
              pi,
              ctx,
              rankedDigest(report),
              report.coverage === "unavailable" ? "error" : report.coverage === "partial" ? "warning" : "info",
            );
            return;
          }
          const action = await showResults(pi, ctx, report, reader);
          if (action === "refine") {
            const query = (
              await ctx.ui.input(`Search within ${countLabel(report.hits.length, "result file")}`, "Ask a more specific question")
            )?.trim();
            if (!query) return;
            within = { query: args.query, files: report.hits.map((hit) => resolveSearchResultPath(ctx.cwd, hit.rel)) };
            args = { ...args, query, history: false };
          } else if (action === "history") {
            args = { ...args, history: true };
          } else return;
        }
      } catch (error) {
        if (controller?.signal.aborted) commandNotice(pi, ctx, "Find search cancelled.");
        else commandNotice(pi, ctx, `Find failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });
}
