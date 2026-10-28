// Mask non-newlines rather than remove them, preserving offsets and preventing false adjacent keywords.
function mask(region: string): string {
  return region.replace(/[^\r\n]/g, "\0");
}

const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/** Fenced blocks (an unterminated fence runs to the end), then inline code spans of any backtick length. */
function maskCode(text: string): string {
  let visible = text;
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

const HOST_INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
// Comments, paired elements, then lone tags: the host ignores keywords in all of them.
const HTML_REGION = /<!--[\s\S]*?(?:-->|$)|<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][A-Za-z0-9-]*\b[^>]*>/g;

/**
 * Standalone-prose match under OMP's magic-keyword rules: exact case, no identifier/path/call neighbours, and
 * nothing inside code or HTML/XML. The host's own matcher is not exposed to extensions. OMP masks only code and
 * HTML/XML, so the workflow scanner's quote, relay, URL and prohibition masks never apply here: the host still acts on
 * `"orchestrate" it`, so the conflict check must see it too.
 */
export function containsHostKeyword(text: string, word: string): boolean {
  const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${escaped}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`, "u");
  return pattern.test(maskCode(text.replace(HOST_INJECTED_BLOCK, mask)).replace(HTML_REGION, mask));
}

// The workflow scanner masks, besides code and injected blocks, everything that is not this user's own request to this
// session: blockquotes, quoted spans, URLs, relayed messages, and the objects of a negated invocation.
const WORKFLOW_INJECTED_BLOCK = /<(omo-[a-z0-9-]+-(?:pointer|mode)|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
// A relayed message opens with a sender header: a bracketed tag (`[REPORT]`), an arrow naming one sender, optionally relayed
// "via" others, and any recipients (`[lead via coordinator -> lane, PR#1]`), or `Name (id), recipient:` / `Name (id) to
// recipient:`. All of it is someone else's text. A bracketed prose arrow (`[step 1 -> step 2]`) names no sender.
const RELAY_TAG = String.raw`\[(?:[A-Z][A-Z0-9_-]{2,}|[\w.:@#-]+(?: via [\w.:@#-]+)* -> [\w.:@#-]+[^\]\n]{0,160})\]`;
const RELAY_ADDRESS = String.raw`[A-Z][\w.-]{0,30} \([^()\s]{1,40}\)(?:, | to )[\w.-]{1,40}:`;
const RELAY_HEADER = new RegExp(String.raw`^\s*(?:${RELAY_TAG}|${RELAY_ADDRESS})`);
const BLOCK_QUOTE_LINE = /^ {0,3}>[^\n]*/gm;
const DOUBLE_QUOTED = /"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g;
// A single-quoted span opens after a non-word character and closes before one, so contractions (`don't`, `it's`) never pair.
const SINGLE_QUOTED = /(?<![\w'])'[^'\n]{1,200}'(?![\w])|\u2018[^\u2019\n]{1,200}\u2019/g;
const URL_SPAN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
// A workflow named only to forbid it ("Do not load mass-ulw or ulw-research") is not a request. The negated verb's objects
// are masked to the next sentence or clause break. A comma keeps a list of prohibitions masked; `but`, `then`, `instead`,
// `however` or a spaced dash end the clause, because the request follows ("Do not use tmux, but ulw the fix").
const NEGATED_VERB = String.raw`\b(?:do\s+not|don['\u2019]t|dont|never)\s+(?:load|use|run|invoke|start|trigger|arm|enable)\b`;
const CLAUSE_END = String.raw`(?=[.;:!?\n]|\s(?:but|then|instead|however)\b|\s[\u2014\u2013-]\s|$)`;
const NEGATED_INVOCATION = new RegExp(String.raw`${NEGATED_VERB}[^.;:!?\n]*?${CLAUSE_END}`, "gi");

function maskWorkflowRegions(text: string): string {
  if (RELAY_HEADER.test(text)) return mask(text);
  return maskCode(text.replace(WORKFLOW_INJECTED_BLOCK, mask))
    .replace(BLOCK_QUOTE_LINE, mask)
    .replace(DOUBLE_QUOTED, mask)
    .replace(SINGLE_QUOTED, mask)
    .replace(URL_SPAN, mask)
    .replace(NEGATED_INVOCATION, mask);
}

// A name glued to a preceding identifier segment (`mass-ulw`, `v1.ulw`) or path (`.omo/ulw/`) names something else, and so
// does one that continues into a longer identifier or file name (`ulw_helper`, `ulw-plan.md`) or opens a path (`ulw-x/`).
// A chained workflow word may follow (`ulw-loop`, `ulw-plan.`) when it, too, ends there, so `mass-ulw-loop-runner` is still
// an identifier. ASCII word guards stand in for `\b`, so configured literals that end in punctuation (`c++`) still match.
const NOT_AFTER_IDENTIFIER = String.raw`(?<![A-Za-z0-9_]|[A-Za-z0-9][-_.]|[/\\])`;
const SEGMENT_END = "(?![-_.]?[A-Za-z0-9])";
const NOT_INTO_IDENTIFIER = String.raw`(?![A-Za-z0-9_]|-(?!(?:loop|plan|research|execute|mass)${SEGMENT_END})[A-Za-z0-9]|\.[A-Za-z0-9])`;
const NOT_BEFORE_PATH = String.raw`(?![-_.]?[A-Za-z0-9]*[/\\])`;

function standaloneName(body: string): RegExp {
  return new RegExp(`${NOT_AFTER_IDENTIFIER}(?:${body})${NOT_INTO_IDENTIFIER}${NOT_BEFORE_PATH}`, "i");
}

const DEFAULT_KEYWORDS = ["ulw", "ultrawork"];

export function detectUltrawork(text: string, keywords: readonly string[] = DEFAULT_KEYWORDS): boolean {
  if (keywords.length === 0) return false;
  const names = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return standaloneName(names).test(maskWorkflowRegions(text));
}

export function hasEmbeddedDirective(text: string): boolean {
  return text.includes("<ultrawork-mode>") && text.includes("</ultrawork-mode>");
}

export type PointerTarget = "mass-ulw" | "prometheus" | "ulw-loop" | "ulw-research";
/** `binding`: the user's own request to run the workflow now. `mention`: anything else that names it. */
export type PointerIntent = "mention" | "binding";

export interface Pointer {
  readonly target: PointerTarget;
  readonly intent: PointerIntent;
}

// Spaced, hyphenated and fused spellings alike. The aliases without a separate "ulw" (`mulw`, `meth`, `ulw mass`) also stand
// in for it before "research", so "mulw research" names both workflows. `meth` is an ordinary word as well: never binding.
const MASS_ALIAS = String.raw`mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth`;
const MASS_NAME = String.raw`mass[\s-]*ulw|ulw[\s-]*mass|mulw`;

// Binding is a positive grammar, never "the name matched": (a) the workflow's slash command opens the prompt; (b) the
// prompt opens with a listed verb directly before the name, then ends or continues with punctuation or a connector word
// ("run mass ulw on the flaky suite"); (c) the name opens the prompt and exactly one Korean request ending closes the
// sentence ("mass ulw 돌려줘"). Only image or paste placeholders may precede it, never a masked quote or relay, and a
// question mark anywhere after it (unless masked inside a URL) keeps the prompt a question.
const BIND_LEAD = String.raw`^\s*(?:\[(?:Image|Pasted text)\b[^\]\n]*\]\s*)*`;
const BIND_VERB = "(?:run|start|use|do|execute)";
const NO_QUESTION = String.raw`(?![\s\S]*[?\uFF1F])`;
// A `.` must end the sentence (`run mass ulw.ts again` names a file); a connector must be a word of its own.
const BIND_FOLLOW = String.raw`(?=\s*(?:$|[,!:;\n\0]|\.(?:\s|$))|\s+(?:to|on|for|with|and|now|here)\b)${NO_QUESTION}`;
// A Korean question ("돌려도 돼?") or a past-tense or declarative ending ("돌렸어", "했는데") is not a request.
const KOREAN_ENDING = String.raw`(?:(?:으로|로|를|을)\s*)?(?:돌려줘|실행해줘|써줘|해줘|돌려|실행해)`;
const KOREAN_REQUEST = String.raw`\s*${KOREAN_ENDING}(?=\s*(?:[.!\n]|$))${NO_QUESTION}`;

function bindingForms(command: string, name: string): RegExp {
  return new RegExp(
    [
      String.raw`${BIND_LEAD}/(?:skill:)?(?:${command})(?=\s|$)${NO_QUESTION}`,
      String.raw`${BIND_LEAD}${BIND_VERB}\s+(?:${name})${BIND_FOLLOW}`,
      `${BIND_LEAD}(?:${name})${KOREAN_REQUEST}`,
    ].join("|"),
    "i",
  );
}

interface TargetPattern {
  readonly target: PointerTarget;
  readonly mention: RegExp;
  readonly binding?: RegExp;
}

const TARGETS: readonly TargetPattern[] = [
  {
    target: "mass-ulw",
    mention: standaloneName(MASS_ALIAS),
    // The composite "run mass ulw research ..." binds mass-ulw as well as ulw-research.
    binding: bindingForms("mass-ulw|mulw", String.raw`(?:${MASS_NAME})(?:[\s-]*research)?`),
  },
  { target: "prometheus", mention: standaloneName(String.raw`ulw[\s-]*plan`) },
  { target: "ulw-loop", mention: standaloneName(String.raw`ulw[\s-]*loop`) },
  {
    target: "ulw-research",
    mention: standaloneName(String.raw`(?:ulw|${MASS_ALIAS})[\s-]*research`),
    binding: bindingForms(String.raw`ulw-research|(?:mass-ulw|mulw)\s+research`, String.raw`(?:ulw|${MASS_NAME})[\s-]*research`),
  },
];

/** Workflows named in the user's own words, each once and in table order, so composites compose independently. */
export function detectPointers(text: string): Pointer[] {
  const visible = maskWorkflowRegions(text);
  const pointers: Pointer[] = [];
  for (const { target, mention, binding } of TARGETS) {
    if (binding?.test(visible)) pointers.push({ target, intent: "binding" });
    else if (mention.test(visible)) pointers.push({ target, intent: "mention" });
  }
  return pointers;
}
