const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
// Comments, paired elements, then lone tags: the host ignores keywords in all of them.
const HTML_REGION = /<!--[\s\S]*?(?:-->|$)|<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][A-Za-z0-9-]*\b[^>]*>/g;

// Mask non-newlines rather than remove them, preserving offsets and preventing false adjacent keywords.
function mask(region: string): string {
  return region.replace(/[^\r\n]/g, "\0");
}

function stripQuotedRegions(text: string): string {
  let visible = text.replace(INJECTED_BLOCK, mask);
  const fenceStart = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  while (true) {
    const opening = fenceStart.exec(visible);
    if (opening === null) break;
    const fence = opening[1];
    if (!fence) break;
    const fenceEnd = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm");
    fenceEnd.lastIndex = fenceStart.lastIndex;
    const closing = fenceEnd.exec(visible);
    const end = closing === null ? visible.length : fenceEnd.lastIndex;
    visible = visible.slice(0, opening.index) + mask(visible.slice(opening.index, end)) + visible.slice(end);
    fenceStart.lastIndex = end;
  }
  return visible.replace(INLINE_CODE, mask);
}

/**
 * Standalone-prose match under OMP's magic-keyword rules: exact case, no identifier/path/call neighbours, and
 * nothing inside code or HTML/XML. The host's own matcher is not exposed to extensions.
 */
export function containsHostKeyword(text: string, word: string): boolean {
  const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${escaped}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`, "u");
  return pattern.test(stripQuotedRegions(text).replace(HTML_REGION, mask));
}

const DEFAULT_KEYWORDS = ["ulw", "ultrawork"];
const MASS_ULW_PATTERN = /\b(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i;

export function detectUltrawork(text: string, keywords: readonly string[] = DEFAULT_KEYWORDS): boolean {
  if (keywords.length === 0) return false;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`,
    "i",
  );
  return pattern.test(stripQuotedRegions(text));
}

export function hasEmbeddedDirective(text: string): boolean {
  return text.includes("<ultrawork-mode>") && text.includes("</ultrawork-mode>");
}

export type Pointer = "mass-ulw";

export function detectPointers(text: string): Pointer[] {
  return MASS_ULW_PATTERN.test(stripQuotedRegions(text)) ? ["mass-ulw"] : [];
}
