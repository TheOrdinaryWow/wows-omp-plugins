// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../ATTRIBUTION.md section 7.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "../core/guards";
import { collectPageSnapshot, SCRIPT_ERROR_PROBE } from "../snapshot/collect";
import { STYLE_PROPS } from "../snapshot/style-props";
import { isPageSnapshot } from "../snapshot/validate";
import type { PageSnapshot } from "../types";
import { CONTENT_STRESS_SCRIPT, RenderError, type Renderer, type RenderRequest } from "./renderer";

/** @public */
export const MAX_ELEMENTS = 20_000;

/** The `BrowserTab` methods a capture uses. @public */
export type NativeTab = {
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
};

/** OMP's eval `browser` global, reduced to what the renderer calls. @public */
export type NativeBrowser = { readonly open: (options: Readonly<Record<string, unknown>>) => Promise<NativeTab> };

/** @public */
export type NativeBrowserRendererOptions = {
  /** Extra `browser.open` options such as `app`, `timeout` or `ignore_https_errors`. */
  readonly open?: Readonly<Record<string, unknown>>;
  readonly maxElements?: number;
};

const OWNED_OPEN_KEYS = ["name", "url", "viewport", "init_scripts", "wait_until"] as const;

/** Page expression that resolves once web fonts load and three animation frames pass, capped at one second for throttled tabs. @public */
export const SETTLE_EXPRESSION = `Promise.race([
	(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))),
	new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
])`;

/** Synchronous page expression returning a PageSnapshot of the current document, for a tab you already drive. @public */
export const snapshotExpression = (maxElements: number = MAX_ELEMENTS): string =>
  `(${collectPageSnapshot.toString()})(${JSON.stringify(STYLE_PROPS)}, ${maxElements})`;

/**
 * A renderer over the OMP native browser. Each pass opens its own tab at the pass viewport, with the script-error probe as an
 * init script, captures, and closes the tab, so content stress only ever touches a page this renderer loaded. A borrowed tab
 * (`app.target`) is refused: capture the user's own page with `snapshotExpression()` instead. @public
 */
export function createNativeBrowserRenderer(browser: NativeBrowser, options: NativeBrowserRendererOptions = {}): Renderer {
  const open = options.open ?? {};
  if (isRecord(open.app) && open.app.target !== undefined) {
    throw new TypeError(
      "createNativeBrowserRenderer loads and stresses only tabs it opens; capture a borrowed tab (app.target) with snapshotExpression()",
    );
  }
  const owned = OWNED_OPEN_KEYS.find((key) => key in open);
  if (owned) throw new TypeError(`createNativeBrowserRenderer sets browser.open's ${owned} itself`);
  const expression = snapshotExpression(options.maxElements ?? MAX_ELEMENTS);
  let scratch: string | null = null;
  let counter = 0;
  const pageUrl = (request: RenderRequest, id: number): string => {
    if (request.target.kind === "url") return request.target.url;
    scratch ??= mkdtempSync(join(tmpdir(), "frontend-detect-"));
    const file = join(scratch, `page-${id}.html`);
    writeFileSync(file, request.target.html);
    return pathToFileURL(file).href;
  };
  return {
    async render(request: RenderRequest): Promise<PageSnapshot> {
      const id = counter++;
      const label = request.target.kind === "url" ? request.target.url : "inline html";
      let tab: NativeTab | null = null;
      try {
        tab = await browser.open({
          ...open,
          name: `frontend-detect-${process.pid}-${id}`,
          url: pageUrl(request, id),
          viewport: { width: request.viewport.width, height: request.viewport.height },
          init_scripts: [SCRIPT_ERROR_PROBE],
          wait_until: "load",
        });
        await tab.evaluate(SETTLE_EXPRESSION);
        if (request.contentStress) await tab.evaluate(CONTENT_STRESS_SCRIPT);
        const snapshot = await tab.evaluate(expression);
        if (!isPageSnapshot(snapshot)) throw new Error("the page did not return a snapshot");
        return snapshot;
      } catch (error) {
        throw new RenderError(label, error);
      } finally {
        await tab?.close();
      }
    },
    async close(): Promise<void> {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    },
  };
}
