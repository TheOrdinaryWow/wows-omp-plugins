import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { runSnippetCommand, snippetArgumentCompletions } from "#src/command.ts";
import { registerSnippetHighlights } from "#src/highlight.ts";
import { expandSnippets, triggerWord } from "#src/matching.ts";
import { readSnippetSettings } from "#src/settings.ts";
import { SnippetStore } from "#src/store.ts";

export default function snippets(pi: ExtensionAPI): void {
  pi.setLabel("Snippets");
  const stores = new Map<string, SnippetStore>();
  const settingsWarnings = new Set<string>();
  const storeWarnings = new Map<string, Set<string>>();
  let currentStore: SnippetStore | undefined;

  const warn = (ctx: ExtensionContext, content: string): void => {
    if (ctx.hasUI) ctx.ui.notify(content, "warning");
    else pi.sendMessage({ customType: "wows-omp-snippets.notice", content, display: true, attribution: "agent" });
  };

  const storeFor = (cwd: string): SnippetStore => {
    let store = stores.get(cwd);
    if (!store) {
      store = new SnippetStore({ cwd });
      stores.set(cwd, store);
    }
    currentStore = store;
    return store;
  };

  const reload = async (ctx: ExtensionContext) => {
    const store = storeFor(ctx.cwd);
    await store.load();
    const settings = await readSnippetSettings(ctx.cwd);
    registerSnippetHighlights(store.active().flatMap((entry) => triggerWord(settings, entry.key) ?? []));
    const session = ctx.sessionManager.getSessionId();
    if (settings.problem && !settingsWarnings.has(session)) {
      warn(ctx, settings.problem);
      settingsWarnings.add(session);
    }
    const warned = storeWarnings.get(session) ?? new Set<string>();
    storeWarnings.set(session, warned);
    for (const problem of store.problems) {
      const warning = `${problem.path}: ${problem.message}`;
      if (warned.has(warning)) continue;
      warn(ctx, warning);
      warned.add(warning);
    }
    return { store, settings };
  };

  pi.on("session_start", async (_event, ctx) => {
    await reload(ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    await reload(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const { store, settings } = await reload(ctx);
    const expanded = expandSnippets(event.text, store.active(), settings);
    if (expanded.used.length) {
      try {
        await store.recordUse(expanded.used.map((entry) => entry.id));
      } catch (error) {
        warn(ctx, `Snippet usage could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      registerSnippetHighlights(store.active().flatMap((entry) => triggerWord(settings, entry.key) ?? []));
    }
    if (expanded.text !== event.text) return { text: expanded.text };
  });

  pi.registerCommand("snippet", {
    description: "Browse, insert, send, and manage global or workspace text snippets",
    getArgumentCompletions: (prefix) => snippetArgumentCompletions(prefix, currentStore?.entries ?? []),
    async handler(args, ctx) {
      const { store } = await reload(ctx);
      await runSnippetCommand(args, ctx, {
        store,
        settings: () => readSnippetSettings(ctx.cwd),
        send: (text) => pi.sendUserMessage(text),
        message: (content) => pi.sendMessage({ customType: "wows-omp-snippets.notice", content, display: true, attribution: "agent" }),
        changed: async () => {
          await reload(ctx);
        },
      });
    },
  });
}
