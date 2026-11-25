import type { FindHit, FindLexicalMatch, FindRange, FindToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/find";

export type HitScope = "whole-file" | "ranges";
export type PreviewMode = "full-file" | "snippet";

export interface ConsoleHit extends FindHit {
  scope: HitScope;
  refined: FindRange[];
  refineFailed?: string;
  /** An unranked literal keyword line: its single range is that line, and its scores are 0, never shown as a score. */
  literal?: true;
}

export interface CacheState {
  mode: "on" | "off" | "unavailable";
  cached: number;
  total: number;
}

export interface ConsoleReport extends Omit<FindToolDetails, "hits" | "lexicalFallback"> {
  hits: ConsoleHit[];
  /** Paths are cwd-relative, unlike the cascade's root-relative rows. */
  lexicalFallback: FindLexicalMatch[];
  originalQuery?: string;
  translation?: { model: string } | { skipped: string };
  cache: CacheState;
  within?: { query: string; files: number };
  previewMode: PreviewMode;
}
