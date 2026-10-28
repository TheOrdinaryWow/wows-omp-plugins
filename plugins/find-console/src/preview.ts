import { type InternalUrlFilesystem, isUrlPath } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { lines, readText } from "@oh-my-pi/pi-coding-agent/tools/jfind/text";
import { resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { FindHit } from "@oh-my-pi/pi-tui/tools/find";

export interface PreviewSource {
  lines: string[];
  truncated: boolean;
  error?: string;
}

export function externalOpenReason(hit: FindHit): string | undefined {
  return isUrlPath(hit.rel) ? "Internal URL hits cannot be opened in an external editor; preview them here instead." : undefined;
}

export class PreviewReader {
  readonly #cache = new Map<string, Promise<PreviewSource>>();

  constructor(
    readonly filesystem: InternalUrlFilesystem,
    readonly cwd: string,
  ) {}

  read(hit: FindHit): Promise<PreviewSource> {
    let pending = this.#cache.get(hit.rel);
    if (!pending) {
      pending = readText(this.filesystem, resolveSearchResultPath(this.cwd, hit.rel), 4 * 1024 * 1024).then(
        (source) => ({ lines: lines(source.text), truncated: source.truncated }),
        (error: unknown) => ({ lines: [], truncated: false, error: error instanceof Error ? error.message : String(error) }),
      );
      this.#cache.set(hit.rel, pending);
    }
    return pending;
  }

  invalidate(hit: FindHit): void {
    this.#cache.delete(hit.rel);
  }
}
