import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { formatModelRoleAlias, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { JudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

import type { ConsoleReport } from "#src/report.ts";

const TRANSLATION_PROMPT =
  "Translate the user's question into one concise English source-code search query. Preserve code identifiers and product names. Do not answer the question, add explanations, markdown, quotes, or alternative queries. Return only the English query.";

export interface QueryTranslation {
  query: string;
  originalQuery?: string;
  translation?: ConsoleReport["translation"];
  cost: number;
}

/** Non-Latin letters trigger translation; Latin accents, identifiers, numbers and punctuation do not. */
export function needsTranslation(query: string): boolean {
  return /(?=\p{L})\P{Script=Latin}/u.test(query);
}

export async function translateQuery(options: {
  query: string;
  enabled: boolean;
  settings: Settings;
  ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
  signal: AbortSignal;
  onUsage?: (usage: JudgmentUsage) => void;
}): Promise<QueryTranslation> {
  const { query, enabled, settings, ctx, signal, onUsage } = options;
  if (!needsTranslation(query)) return { query, cost: 0 };
  if (!enabled) return { query, cost: 0, translation: { skipped: "disabled by autoTranslate or --no-translate" } };
  const reasons: string[] = [];
  let cost = 0;
  for (const role of ["tiny", "smol"] as const) {
    signal.throwIfAborted();
    try {
      const { model } = resolveModelRoleValue(formatModelRoleAlias(role), roleCandidatePool(role, settings, ctx.modelRegistry), {
        settings,
      });
      if (!model) throw new Error("role is not configured or has no available model");
      let text: string | null;
      if (model.api === "local-inference") {
        text = await tinyModelClient.chat(
          model.id,
          [
            { role: "system", content: TRANSLATION_PROMPT },
            { role: "user", content: query },
          ],
          { signal, maxTokens: 128 },
        );
      } else {
        const message = await completeSimple(
          model,
          { systemPrompt: [TRANSLATION_PROMPT], messages: [{ role: "user", content: query, timestamp: Date.now() }] },
          {
            apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
            disableReasoning: true,
            maxTokens: 128,
            signal,
          },
        );
        cost += message.usage.cost.total;
        onUsage?.({
          purpose: "find-translate",
          role,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: message.usage,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        });
        if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? message.stopReason);
        text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
      signal.throwIfAborted();
      const translated = text
        ?.trim()
        .replace(/^(["'`])([\s\S]*)\1$/, "$2")
        .replace(/\s+/g, " ");
      if (!translated || translated.length > 1024 || needsTranslation(translated) || !/[a-z]/i.test(translated))
        throw new Error("model did not return an English search query");
      return { query: translated, originalQuery: query, translation: { model: `${role}: ${model.provider}/${model.id}` }, cost };
    } catch (error) {
      signal.throwIfAborted();
      reasons.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { query, cost, translation: { skipped: reasons.join("; ") } };
}
