const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

// Mask non-newlines rather than remove them, preserving offsets and preventing false adjacent keywords.
function mask(region: string): string {
  return region.replace(/[^\r\n]/g, "\0");
}

export function stripQuotedRegions(text: string): string {
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

export const ULTRAWORK_PATTERN = /\b(?:ultrawork|ulw)\b/i;
const MASS_ULW_PATTERN = /\b(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i;

export function detectUltrawork(text: string): boolean {
  return ULTRAWORK_PATTERN.test(stripQuotedRegions(text));
}

export function hasEmbeddedDirective(text: string): boolean {
  return text.includes("<ultrawork-mode>") && text.includes("</ultrawork-mode>");
}

export type Pointer = "mass-ulw";

export function detectPointers(text: string): Pointer[] {
  return MASS_ULW_PATTERN.test(stripQuotedRegions(text)) ? ["mass-ulw"] : [];
}
