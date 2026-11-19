import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

import type { TranslationCache } from "#src/translation-cache.ts";

const EVIDENCE_LIMIT = 2_000;
type EvidenceMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type TurnMessage =
  | { role: "assistant"; content: readonly AssistantMessage["content"][number][] }
  | { role: Exclude<AgentMessage["role"], "assistant">; content?: unknown };

export function qualifiesForJudgment(message: TurnMessage, toolResults: readonly Pick<ToolResultMessage, "toolName">[]): boolean {
  return (
    (message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.trim().length > 0)) ||
    toolResults.some((result) => result.toolName === "task")
  );
}

export function readBranchProgress(branch: readonly SessionEntry[], startEntryId: string) {
  let turns = 0;
  let evidenceId: string | undefined;
  let continues = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.id === startEntryId) break;
    if (entry?.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant") {
      if (turns++ === 0) continues = message.stopReason === "toolUse" || message.content.some((part) => part.type === "toolCall");
      if (evidenceId === undefined && qualifiesForJudgment(message, [])) evidenceId = entry.id;
    } else if (message.role === "toolResult" && message.toolName === "task") {
      evidenceId ??= entry.id;
    }
  }
  return { turns, evidenceId, continues };
}

function summarize(message: EvidenceMessage): string | undefined {
  const content = message.content;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else for (const part of content) if (part.type === "text") parts.push(part.text);
  const text = parts.join("\n").trim();
  if (!text && message.role !== "toolResult") return undefined;
  return text;
}

function truncate(text: string): string {
  return text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT - 1)}…` : text;
}

export async function buildJudgeState(options: {
  goal: string;
  messages: readonly SessionEntry[];
  sidecars: readonly { plugin: string; evidence: string }[];
  contextMessages: number;
  translation: TranslationCache;
}): Promise<string> {
  const { goal, messages, sidecars, contextMessages, translation } = options;
  const relevant: { id: string; label: string; text: string }[] = [];
  for (let i = messages.length - 1; i >= 0 && relevant.length < contextMessages; i--) {
    const entry = messages[i];
    if (entry?.type !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const text = summarize(message);
    if (text === undefined) continue;
    const label = message.role === "toolResult" ? `Tool result ${message.toolName}${message.isError ? " (error)" : ""}` : message.role;
    relevant.push({ id: entry.id, label, text: truncate(text) });
  }
  const sessionEvidence: string[] = [];
  for (const { id, label, text } of relevant.reverse()) {
    sessionEvidence.push(`${label}: ${truncate(await translation.translate(text, id))}`);
  }
  const pluginEvidence: string[] = [];
  for (const { plugin, evidence } of sidecars) {
    pluginEvidence.push(`${plugin}: ${truncate(await translation.translate(truncate(evidence)))}`);
  }
  return [
    `Goal: ${goal}`,
    `Recent session messages:\n${sessionEvidence.join("\n\n")}`,
    `Plugin state:\n${pluginEvidence.join("\n\n")}`,
  ].join("\n\n");
}
