import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AtlasSession {
  path: string;
  id: string;
  title: string;
  modified: number;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join(" ");
}

/**
 * Sessions in `sessionDir` whose persisted workflow state ever executed `planId`, most recently used first.
 * Reads only the session header, title slot, first user message and `stateType` entries.
 */
export async function findPlanSessions(sessionDir: string, stateType: string, planId: string): Promise<AtlasSession[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return [];
  }
  const sessions = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name): Promise<AtlasSession | undefined> => {
        const file = path.join(sessionDir, name);
        let text: string;
        let modified: number;
        try {
          [text, modified] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file).then((stat) => stat.mtimeMs)]);
        } catch {
          return undefined;
        }
        if (!text.includes(planId)) return undefined;
        let id = "";
        let title = "";
        let firstMessage = "";
        let executed = false;
        for (const line of text.split("\n")) {
          const header = !id || (!title && line.includes('"type":"title"'));
          const state = line.includes(stateType) && line.includes(planId);
          const prompt = !firstMessage && line.includes('"role":"user"');
          if (!header && !state && !prompt) continue;
          let entry: { type?: unknown; id?: unknown; title?: unknown; customType?: unknown; data?: unknown; message?: unknown };
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry.type === "title" && typeof entry.title === "string") title = entry.title.trim();
          else if (entry.type === "session" && typeof entry.id === "string") id = entry.id;
          else if (entry.type === "custom" && entry.customType === stateType) {
            const data = entry.data as { phase?: unknown; atlasPlanId?: unknown } | undefined;
            if (data?.phase === "executing" && data.atlasPlanId === planId) executed = true;
          } else if (entry.type === "message" && !firstMessage) {
            const message = entry.message as { role?: unknown; content?: unknown } | undefined;
            if (message?.role === "user") firstMessage = messageText(message.content).replace(/\s+/g, " ").trim();
          }
        }
        if (!executed || !id) return undefined;
        return { path: file, id, title: title || firstMessage, modified };
      }),
  );
  return sessions.filter((session) => session !== undefined).sort((a, b) => b.modified - a.modified);
}
