import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";

import { adrRepo } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { buildAdrGraph } from "#src/visualize-data.ts";

export interface VisualizeServer {
  url: string;
  notify(): void;
  stop(): void;
}

export function startVisualizeServer(path: string): VisualizeServer {
  const repo = adrRepo(path);
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let revision = 0;
  let stopped = false;
  let debounce: NodeJS.Timeout | undefined;
  const frame = () => encoder.encode(`data: ${JSON.stringify({ revision })}\n\n`);
  function broadcast(bytes: Uint8Array): void {
    for (const client of clients) {
      try {
        client.enqueue(bytes);
      } catch {
        clients.delete(client);
      }
    }
  }
  function notify(): void {
    if (stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      revision++;
      broadcast(frame());
    }, 200);
  }
  const assets: Record<string, readonly [string, string]> = {
    "": ["index.html", "text/html; charset=utf-8"],
    "app.js": ["app.js", "text/javascript; charset=utf-8"],
    "app.css": ["app.css", "text/css; charset=utf-8"],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (request.method !== "GET" || !pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });
      const route = pathname.slice(prefix.length);
      if (route === "api/graph") {
        try {
          return Response.json(await buildAdrGraph(repo.repoRoot), { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }
      if (route === "api/events") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            clients.add(value);
            value.enqueue(frame());
          },
          cancel() {
            clients.delete(controller);
          },
        });
        request.signal.addEventListener(
          "abort",
          () => {
            if (clients.delete(controller)) controller.close();
          },
          { once: true },
        );
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          },
        });
      }
      const asset = Object.hasOwn(assets, route) ? assets[route] : undefined;
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(import.meta.dir, "../assets/visualize", asset[0])), {
        headers: { "Content-Type": asset[1], "Cache-Control": "no-store" },
      });
    },
  });
  let adrWatcher: FSWatcher | undefined;
  let adrWatched = "";
  function watchAdrs(): void {
    let directory = repo.adrDir;
    while (!existsSync(directory)) directory = dirname(directory);
    if (directory === adrWatched) return;
    adrWatcher?.close();
    adrWatched = directory;
    adrWatcher = watch(directory, () => {
      watchAdrs();
      notify();
    });
  }
  let gitWatcher: FSWatcher;
  try {
    watchAdrs();
    gitWatcher = watch(repo.commonDir, { recursive: true }, (_event, filename) => {
      const name = filename?.toString().replaceAll("\\", "/") ?? "";
      if (/(?:^|\/)(?:HEAD|refs(?:\/|$)|packed-refs$)/.test(name)) notify();
    });
  } catch (error) {
    adrWatcher?.close();
    void server.stop(true);
    throw error;
  }
  const keepAlive = setInterval(() => broadcast(encoder.encode(": keep-alive\n\n")), 15_000);
  keepAlive.unref();
  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    notify,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(debounce);
      clearInterval(keepAlive);
      adrWatcher?.close();
      gitWatcher.close();
      for (const client of clients) client.close();
      clients.clear();
      void server.stop(true);
    },
  };
}

export class AdrVisualizer {
  #active?: { session: string; root: string; server: VisualizeServer };

  sync(ctx: ExtensionContext): void {
    if (!this.#active) return;
    if (this.#active.session !== ctx.sessionManager.getSessionId() || this.#active.root !== discoverRepo(ctx.cwd)?.repoRoot) this.stop();
  }

  async open(ctx: ExtensionContext): Promise<string> {
    this.sync(ctx);
    const repo = adrRepo(ctx.cwd);
    this.#active ??= { session: ctx.sessionManager.getSessionId(), root: repo.repoRoot, server: startVisualizeServer(repo.repoRoot) };
    const url = this.#active.server.url;
    if (ctx.hasUI) openPath(url);
    return url;
  }

  notify(ctx: ExtensionContext): void {
    this.sync(ctx);
    this.#active?.server.notify();
  }

  stop(): void {
    this.#active?.server.stop();
    this.#active = undefined;
  }
}
