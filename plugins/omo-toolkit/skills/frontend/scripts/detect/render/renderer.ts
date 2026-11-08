// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../ATTRIBUTION.md section 7.
// The reflow matrix and its unbroken stress string follow changeroa/StyleGallery (MIT, Copyright (c) 2026 IYEN); same section.
import type { PageSnapshot, Viewport } from "../types";

export type RenderTarget = { readonly kind: "html"; readonly html: string } | { readonly kind: "url"; readonly url: string };

export type RenderRequest = {
  readonly target: RenderTarget;
  readonly viewport: Viewport;
  /** Appends an unbroken 300-character token to every element whose last child is text, to expose reflow breaks; owned tabs only. */
  readonly contentStress?: boolean;
};

/** Anything that can turn a page into a PageSnapshot: the OMP native browser (`createNativeBrowserRenderer`) or your own driver. */
export type Renderer = {
  readonly render: (request: RenderRequest) => Promise<PageSnapshot>;
  readonly close: () => Promise<void>;
};

export class RenderError extends Error {
  readonly target: string;
  constructor(target: string, cause: unknown) {
    super(`render failed for ${target}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "RenderError";
    this.target = target;
  }
}

const STRESS_TOKEN = "Unbrokencontentstresstoken".repeat(12);

/** Mutates the page's text and marks the document so the snapshot's coverage records it; run it only in a tab the capture owns. */
export const CONTENT_STRESS_SCRIPT = `(() => {
	const token = ${JSON.stringify(STRESS_TOKEN)};
	for (const el of document.querySelectorAll("body *")) {
		const last = el.lastChild;
		if (!last || last.nodeType !== 3 || last.textContent.trim() === "") continue;
		if (["SCRIPT", "STYLE", "TEXTAREA", "OPTION", "TITLE"].includes(el.tagName)) continue;
		last.textContent = last.textContent + " " + token;
	}
	globalThis.__detectContentStress = true;
})();`;
