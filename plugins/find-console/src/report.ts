import type { FindHit, FindRange, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

export type HitScope = "whole-file" | "ranges";
export type PreviewMode = "full-file" | "snippet";

export interface ConsoleHit extends FindHit {
  scope: HitScope;
  refined: FindRange[];
  refineFailed?: string;
}

export interface CacheState {
  mode: "on" | "off" | "unavailable";
  cached: number;
  total: number;
}

export interface ConsoleReport extends Omit<FindToolDetails, "hits"> {
  hits: ConsoleHit[];
  originalQuery?: string;
  translation?: { model: string } | { skipped: string };
  cache: CacheState;
  within?: { query: string; files: number };
  previewMode: PreviewMode;
}
