import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { discoverRepo } from "./git.ts";
import { parseFrontmatter } from "./host.ts";

export const FORMAT = 1;
export const MANAGED_COMMENT =
  "<!-- Managed by the roadmap OMP plugin (format v1). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->";

export const HOW_THIS_DIRECTORY_WORKS = `## How this directory works

This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.

The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.

Every managed file has format: 1 front matter and a managed-by comment. This README also carries roadmap: { format: 1 }. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat plain-text lists and closed top-level fences, with same-line inline code spans; other Markdown or raw HTML syntax is refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages and Known limitations. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with <!-- roadmap:generated:<name> --> and <!-- /roadmap:generated -->. The tools own numbering, metadata, headings and generated indexes.

Rounds are active or closed. Stages are planned, active, closed or dropped. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Open TODOs need severity, source and either an unclosed target stage or a trigger. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.

Closed stages carry closed_sha256; closed rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.

Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies or a closed round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.

Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
`;

export type StageStatus = "planned" | "active" | "closed" | "dropped";
export type TodoStatus = "open" | "resolved" | "moved" | "wontfix" | "carried";
export type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
export interface Repo {
  repoRoot: string;
  commonDir: string;
  roadmapDir: string;
  adrDir: string;
}

interface Document {
  format: 1;
  path: string;
}

export interface StageDoc extends Document {
  id: string;
  title: string;
  round: string;
  status: StageStatus;
  depends_on: string[];
  follows: string | null;
  created: string;
  started: string | null;
  closed: string | null;
  closed_sha256: string | null;
  objective: string;
  scope_in: string;
  scope_out: string;
  done_criteria: string;
  design_constraints?: string;
  risks?: string;
  amendments: string;
  free_work_log: string;
  outcome?: string;
}

export interface DoneCriterion {
  id: string;
  statement: string;
  verify: string;
}

export interface RoundDoc extends Document {
  id: string;
  title: string;
  status: "active" | "closed";
  opened: string;
  closed: string | null;
  frozen_sha256: string | null;
  goal: string;
  constraints: string;
  non_goals: string;
  principles: string;
  stages: string;
  known_limitations: string;
}

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  severity?: "high" | "normal" | "low";
  source?: string;
  target?: string;
  trigger?: string;
  reference?: string;
  carried_from?: string;
  body: string;
}

export interface TodoDoc extends Document {
  round: string;
  items: TodoItem[];
}

export interface AdrDoc extends Document {
  id: string;
  title: string;
  supersedes: string[];
  superseded_by: string | null;
  stage: string | null;
  status: AdrStatus;
  date: string;
  decision_makers: string[];
  consulted: string[];
  informed: string[];
  body: string;
}

export interface RoadmapIndexDoc extends Document {
  title: string;
  body: string;
}

export interface AdrIndexDoc extends Document {
  body: string;
}

export interface DocumentIssue {
  rule: "structure" | "format";
  path: string;
  message: string;
}

export interface Model {
  index: RoadmapIndexDoc;
  rounds: RoundDoc[];
  stages: StageDoc[];
  todos: TodoDoc[];
  adrs: AdrDoc[];
  repo?: Repo;
  adrIndex?: AdrIndexDoc;
  files?: Record<string, string | Uint8Array>;
  parseErrors?: DocumentIssue[];
}

export class DocumentError extends Error {
  constructor(
    readonly rule: "structure" | "format",
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function invalid(message: string): never {
  throw new DocumentError("structure", message);
}

function supported(format: unknown): asserts format is 1 {
  if (format !== FORMAT) throw new DocumentError("format", `Unsupported roadmap format ${String(format)}; supported format is ${FORMAT}.`);
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) invalid(`${key} must be a non-empty single-line string.`);
  return value;
}

function id(value: unknown, kind: "round" | "stage" | "todo" | "adr", key = "id"): string {
  const patterns = { round: /^R[1-9]\d*$/, stage: /^S\d{2,}$/, todo: /^T\d{3,}$/, adr: /^ADR-\d{4,}$/ };
  const result = text(value, key);
  if (!patterns[kind].test(result) || Number(result.replace(/\D/g, "")) < 1) invalid(`${key} is not a valid ${kind} id.`);
  return result;
}

function nullableId(value: unknown, kind: "stage" | "adr", key: string): string | null {
  return value === null ? null : id(value, kind, key);
}

function strings(value: unknown, key: string, kind?: "stage" | "adr"): string[] {
  if (!Array.isArray(value)) invalid(`${key} must be a list.`);
  return value.map((entry) => (kind ? id(entry, kind, key) : text(entry, key)));
}

function date(value: unknown, key: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const result = text(value, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) {
    invalid(`${key} must be an ISO calendar date.`);
  }
  return result;
}

function digest(value: unknown, key: string): string | null {
  if (value === null) return null;
  const result = text(value, key);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(`${key} must be a SHA-256 digest or null.`);
  return result;
}

function choice<T extends string>(value: unknown, options: readonly T[], key: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) invalid(`${key} must be one of ${options.join(", ")}.`);
  return value as T;
}

// The host helper falls back to key/value parsing on malformed YAML even with repair:false.
// Validate the supported YAML subset separately so that fallback never repairs managed state.
function scalar(value: string): unknown {
  const clean = value.trim();
  if (clean.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(clean);
      if (typeof parsed === "string") return parsed;
    } catch {
      invalid("Malformed quoted front matter scalar.");
    }
    invalid("Malformed quoted front matter scalar.");
  }
  if (clean.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(clean)) invalid("Malformed quoted front matter scalar.");
    return clean.slice(1, -1).replaceAll("''", "'");
  }
  if (clean.startsWith("[")) {
    if (!clean.endsWith("]")) invalid("Malformed front matter list.");
    const inside = clean.slice(1, -1).trim();
    if (!inside) return [];
    const parts: string[] = [];
    let quote = "";
    let start = 0;
    for (let index = 0; index < inside.length; index++) {
      const character = inside[index];
      if (quote) {
        if (quote === '"' && character === "\\") index++;
        else if (quote === "'" && character === "'" && inside[index + 1] === "'") index++;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ",") {
        parts.push(inside.slice(start, index));
        start = index + 1;
      }
    }
    if (quote) invalid("Malformed quoted front matter list.");
    parts.push(inside.slice(start));
    return parts.map((part) => {
      const item = scalar(part);
      if (Array.isArray(item) || (item !== null && typeof item === "object")) invalid("Nested front matter lists are unsupported.");
      return item;
    });
  }
  if (clean === "null") return null;
  if (/^-?\d+$/.test(clean)) return Number(clean);
  if (!clean || /[:{}[\]"'`]|^(?:[!&*|>@%]|---$)/.test(clean) || /\s#/.test(clean)) invalid("Malformed front matter scalar.");
  return clean;
}

function header(content: string, keys: readonly string[], marker = false): { fm: Record<string, unknown>; body: string } {
  const normalized = lf(content);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalized);
  if (!match) invalid("Managed files require delimited front matter at the start.");
  const fields: Record<string, unknown> = {};
  for (const line of (match[1] as string).split("\n")) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!field) invalid("Unsupported or malformed front matter line.");
    const key = field[1] as string;
    if (Object.hasOwn(fields, key)) invalid(`Duplicate front matter key ${key}.`);
    if (!keys.includes(key)) invalid(`Unknown front matter key ${key}.`);
    let value = (field[2] as string).trim();
    let quote = "";
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (quote) {
        if (quote === '"' && character === "\\") index++;
        else if (quote === "'" && character === "'" && value[index + 1] === "'") index++;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "#" && (index === 0 || /\s/.test(value[index - 1] as string))) {
        value = value.slice(0, index).trimEnd();
        break;
      }
    }
    fields[key] =
      key === "roadmap" && /^\{\s*format:\s*\d+\s*\}$/.test(value) ? { format: Number(value.match(/\d+/)?.[0]) } : scalar(value);
  }
  for (const key of keys) if (!Object.hasOwn(fields, key)) invalid(`Missing front matter key ${key}.`);
  const { frontmatter } = parseFrontmatter(normalized, { rawKeys: true, repair: false, level: "off" });
  if (JSON.stringify(frontmatter) !== JSON.stringify(fields)) invalid("Front matter does not match the supported YAML subset.");
  supported(fields.format);
  if (marker) supported((fields.roadmap as { format?: unknown } | undefined)?.format);
  const body = normalized.slice(match[0].length);
  if (!body.startsWith(`${MANAGED_COMMENT}\n\n`)) invalid("Missing or altered managed-by comment.");
  return { fm: fields, body: body.slice(MANAGED_COMMENT.length + 2) };
}

function yaml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(yaml).join(", ")}]`;
  if (value === null || typeof value === "number") return String(value);
  invalid("Unsupported front matter value.");
}

function frontmatter(fields: Record<string, unknown>, marker = false): string {
  supported(fields.format);
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${marker && key === "roadmap" ? "{ format: 1 }" : yaml(value)}`);
  return `---\n${lines.join("\n")}\n---\n${MANAGED_COMMENT}\n\n`;
}

function section(heading: string, body: string): string {
  return `${heading}\n${body ? `${lf(body)}\n` : ""}\n`;
}

function plainBodyLine(line: string, number: number): void {
  if (/^#{1,6}(?:[ \t]|$)/.test(line)) invalid(`Unsupported body heading at line ${number}.`);
  if (/^(?:[-=]+|(?:[-*_] *)+) *$/.test(line)) invalid(`Unsupported body heading underline or thematic break at line ${number}.`);
  if (/^(?:>|[-+*](?: |$)|\d{1,9}[.)](?: |$)|`{3,}|~{3,})/.test(line)) invalid(`Unsupported body container or fence at line ${number}.`);
  const plain = (text: string): void => {
    if (/[<>[\]\\|*_~]/.test(text)) invalid(`Unsupported body HTML or inline markup at line ${number}.`);
  };
  let start = 0;
  let code: string | undefined;
  for (const run of line.matchAll(/`+/g)) {
    if (code === undefined) {
      plain(line.slice(start, run.index));
      code = run[0];
    } else if (run[0] === code) {
      start = run.index + run[0].length;
      code = undefined;
    }
  }
  if (code !== undefined) invalid(`Inline code spans must close on the same line (${number}).`);
  plain(line.slice(start));
}

export function validateBody(body: string, options: { inlineOnly?: boolean; afterList?: boolean } = {}): void {
  let fence: { marker: string; length: number } | undefined;
  let list = options.afterList ?? false;
  let number = 0;
  for (const raw of lf(body).split("\n")) {
    number++;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^( {0,3})(`{3,}|~{3,})(?:[ \t]*[a-zA-Z0-9][a-zA-Z0-9_+.-]*)?[ \t]*$/.exec(raw);
    if (opening && !options.inlineOnly) {
      if (list && opening[1]) invalid(`A body fence must be top-level, not a list continuation (line ${number}).`);
      const marker = opening[2] as string;
      fence = { marker: marker[0] as string, length: marker.length };
      list = false;
      continue;
    }
    for (const character of raw) {
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        invalid(`Body heading indentation, tabs or control characters are unsupported outside fences (line ${number}).`);
    }
    if (!raw.trim()) continue;
    if (/^ {4}/.test(raw)) invalid(`Indented body code is unsupported (line ${number}).`);
    const line = raw.trimStart();
    const item = options.inlineOnly ? null : /^(?:[-+*]|\d{1,9}[.)]) (\S.*)$/.exec(line);
    if (item) {
      if (list && raw.startsWith(" ")) invalid(`Nested body lists are unsupported (line ${number}).`);
      plainBodyLine(item[1] as string, number);
      list = true;
    } else {
      if (list && raw.startsWith(" ")) invalid(`Indented body list continuations are unsupported (line ${number}).`);
      plainBodyLine(line, number);
      list = false;
    }
  }
  if (fence) invalid("Unterminated body fence; close the top-level fenced code block.");
}

type MarkdownContainer = { kind: "quote" } | { kind: "list"; indent: number; empty: boolean };
type MarkdownHtml = { end?: RegExp; opener: string; line: number; inline?: boolean };

const HTML_BLOCK_TAG =
  /^ {0,3}(<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$))/i;
const HTML_COMPLETE_TAG =
  /^ {0,3}(<[a-z][a-z\d-]*(?:[ \t]+[a-z_:][a-z\d_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^ \t"'=<>`]+))?)*[ \t]*\/?>|<\/[a-z][a-z\d-]*[ \t]*>)[ \t]*$/i;
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MARKDOWN_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const MARKDOWN_THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const MARKDOWN_ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const MARKDOWN_LIST = /^( {0,3})([*+-]|\d{1,9}[.)])( +|$)/;
const MARKDOWN_REFERENCE_START = /^ {0,3}\[(?:\\.|[^[\]\\])+\]:/;
const MARKDOWN_REFERENCE =
  /^ {0,3}\[(?:\\.|[^[\]\\]){1,999}\]:[ \t]*(?:<[^<>\n]+>|[^\s<>]+)(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*$/;

function markdownHtml(line: string, paragraph: boolean, number: number): MarkdownHtml | undefined {
  // Paragraph continuation indentation does not make a raw HTML opener code.
  const content = paragraph ? line.trimStart() : line;
  const opener =
    /^ {0,3}(<(?:script|pre|style|textarea)(?=[ \t>]|$))/i.exec(content) ?? /^ {0,3}(<!--|<\?|<![A-Z]|<!\[CDATA\[)/.exec(content);
  if (opener) {
    const start = opener[1] as string;
    const end =
      start === "<!--"
        ? /-->/
        : start === "<?"
          ? /\?>/
          : start === "<![CDATA["
            ? /\]\]>/
            : /^<![A-Z]/.test(start)
              ? />/
              : /<\/(?:script|pre|style|textarea)>/i;
    return { end, opener: start, line: number };
  }
  const tag = HTML_BLOCK_TAG.exec(line) ?? (!paragraph ? HTML_COMPLETE_TAG.exec(line) : null);
  return tag ? { opener: tag[1] as string, line: number } : undefined;
}

function markdownInlineText(line: string): string {
  let text = "";
  for (let cursor = 0; cursor < line.length; ) {
    if (line[cursor] === "\\" && line[cursor + 1]) {
      text += "  ";
      cursor += 2;
    } else if (line[cursor] === "`") {
      let end = cursor + 1;
      while (line[end] === "`") end++;
      const marker = line.slice(cursor, end);
      let close = line.indexOf(marker, end);
      while (close >= 0 && (line[close - 1] === "`" || line[close + marker.length] === "`"))
        close = line.indexOf(marker, close + marker.length);
      if (close >= 0) {
        const length = close + marker.length - cursor;
        text += " ".repeat(length);
        cursor += length;
      } else {
        text += marker;
        cursor = end;
      }
    } else text += line[cursor++];
  }
  return text;
}

// Raw HTML ignores Markdown escapes and can keep comments/raw-text elements open
// after the Markdown block itself ends at a blank line or container boundary.
function markdownRawHtml(line: string, state: MarkdownHtml | undefined, number: number, inline = false): MarkdownHtml | undefined {
  const text = inline ? markdownInlineText(line) : line;
  let cursor = 0;
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    if (state) {
      const closing = state.end?.exec(rest);
      if (!closing) return state;
      cursor += closing.index + closing[0].length;
      state = undefined;
    } else {
      const special = inline ? null : /<!--|<\?|<![A-Z]|<!\[CDATA\[/.exec(rest);
      const tag = /<(script|pre|style|textarea)(?=[ \t/>]|$)/i.exec(rest);
      const opening = special && (!tag || special.index < tag.index) ? special : tag;
      if (!opening) return undefined;
      if (opening === tag && /^<(?:script|pre|style|textarea)\b[^>]*\/>/i.test(rest.slice(opening.index)))
        invalid("Ambiguous self-closing raw-text HTML element; use an explicit opening and closing tag before retrying.");
      state = markdownHtml(rest.slice(opening.index), false, number);
      if (state) state.inline = inline;
      if (opening === tag && tag && state) state.end = new RegExp(`</${tag[1]}>`, "i");
      else if (state?.opener === "<?" || state?.opener === "<![CDATA[") state.end = />/;
      cursor += opening.index + opening[0].length;
    }
  }
  return state;
}

function markdownFence(line: string): RegExpExecArray | null {
  const fence = MARKDOWN_FENCE.exec(line);
  return fence && (fence[1]?.[0] !== "`" || !fence[2]?.includes("`")) ? fence : null;
}

function markdownList(line: string, paragraph: boolean): RegExpExecArray | null {
  if (MARKDOWN_THEMATIC.test(line)) return null;
  const marker = MARKDOWN_LIST.exec(line);
  if (
    paragraph &&
    marker &&
    (!line.slice(marker[0].length).trim() || (/\d/.test(marker[2] as string) && !/^1[.)]$/.test(marker[2] as string)))
  )
    return null;
  return marker;
}

// Tabs advance to four-column stops, including after list and quote markers.
// The source map keeps all heading spans in the original, unexpanded Markdown.
function markdownLine(raw: string): { text: string; source: number[] } {
  let text = "";
  const source: number[] = [];
  for (let index = 0; index < raw.length; index++) {
    const width = raw[index] === "\t" ? 4 - (text.length % 4) : 1;
    text += raw[index] === "\t" ? " ".repeat(width) : raw[index];
    for (let column = 0; column < width; column++) source.push(index);
  }
  source.push(raw.length);
  return { text, source };
}

export function markdownHeadings(
  body: string,
  pattern: RegExp,
  options: { requireClosedFences?: boolean; topLevelOnly?: boolean } = {},
): RegExpMatchArray[] {
  const headings: RegExpMatchArray[] = [];
  const containers: MarkdownContainer[] = [];
  let fence: { character: string; length: number } | undefined;
  let html: MarkdownHtml | undefined;
  let rawHtml: MarkdownHtml | undefined;
  let indented = false;
  let paragraph: { offset: number; lines: string[] } | undefined;
  let reference = false;
  let offset = 0;
  let number = 0;
  for (const raw of body.split("\n")) {
    number++;
    const line = markdownLine(raw);
    let cursor = 0;
    let continued = 0;
    for (const container of containers) {
      const rest = line.text.slice(cursor);
      if (container.kind === "quote") {
        const marker = /^ {0,3}> ?/.exec(rest);
        if (!marker) break;
        cursor += marker[0].length;
      } else if (!rest.trim()) {
        // An empty item can begin with only its marker's blank line.
        if (container.empty) break;
        cursor = line.text.length;
      } else {
        const indent = /^ */.exec(rest)?.[0].length ?? 0;
        if (indent < container.indent) break;
        cursor += container.indent;
        container.empty = false;
      }
      continued++;
    }
    let content = line.text.slice(cursor);
    if (options.requireClosedFences && reference && /^ {4}/.test(content) && content.trim())
      invalid("Ambiguous indented link reference continuation; add a blank line after the complete definition before retrying.");
    if (options.requireClosedFences && (paragraph || reference) && /^ {4}/.test(content) && markdownHtml(content.trimStart(), true, number))
      invalid("Ambiguous indented HTML continuation; escape the opener or put the example in a closed fenced code block before retrying.");
    if (
      options.requireClosedFences &&
      continued < containers.length &&
      paragraph &&
      markdownList(content, false) &&
      !markdownList(content, true) &&
      /<|\]:/.test(markdownInlineText(content))
    )
      invalid("Ambiguous list marker on a lazy container continuation; add a blank line before the list before retrying.");
    const lazy =
      continued < containers.length &&
      paragraph &&
      content.trim() &&
      !MARKDOWN_ATX.test(content) &&
      !MARKDOWN_UNDERLINE.test(content) &&
      !MARKDOWN_THEMATIC.test(content) &&
      !/^ {0,3}>/.test(content) &&
      !markdownList(content, true) &&
      !markdownFence(content) &&
      !markdownHtml(content, true, number);
    if (continued < containers.length && !lazy) {
      if (html?.end)
        invalid(`Unterminated HTML block (${html.opener}) at line ${html.line}; close it inside its container before retrying.`);
      if (reference && content.trim() && options.requireClosedFences)
        invalid(
          "Ambiguous link reference continuation across a container boundary; add a blank line after the definition before retrying.",
        );
      if (fence && options.requireClosedFences) invalid("Unterminated Markdown fence; close the fenced code block before retrying.");
      containers.length = continued;
      fence = html = paragraph = undefined;
      reference = false;
      indented = false;
    }
    if (!fence && !html && !lazy) {
      for (;;) {
        const quote = /^ {0,3}> ?/.exec(content);
        const item = quote ? null : markdownList(content, Boolean(paragraph));
        if (!quote && !item) break;
        if (quote) {
          containers.push({ kind: "quote" });
          cursor += quote[0].length;
        } else if (item) {
          const empty = !content.slice(item[0].length).trim();
          const padding = (item[3] as string).length;
          const indent = (item[1] as string).length + (item[2] as string).length + (!empty && padding >= 1 && padding <= 4 ? padding : 1);
          containers.push({ kind: "list", indent, empty });
          cursor += indent;
        }
        paragraph = undefined;
        reference = false;
        indented = false;
        content = line.text.slice(cursor);
      }
    }
    let masked = false;
    let rawHtmlLine = false;
    if (html) {
      masked = true;
      rawHtmlLine = true;
      if (html.end ? html.end.test(content) : !content.trim()) html = undefined;
    } else if (fence) {
      masked = true;
      const closing = /^ {0,3}(`{3,}|~{3,}) *$/.exec(content);
      if (closing?.[1]?.[0] === fence.character && closing[1].length >= fence.length) fence = undefined;
    } else {
      if (indented && content.trim() && !/^ {4}/.test(content)) indented = false;
      if (!paragraph && /^ {4}/.test(content)) indented = true;
      if (indented) masked = true;
      else {
        const opener = markdownHtml(content, Boolean(paragraph), number);
        const openingFence = opener ? null : markdownFence(content);
        if (opener) {
          masked = true;
          rawHtmlLine = true;
          if (!opener.end?.test(content)) html = opener;
        } else if (openingFence) {
          masked = true;
          fence = { character: openingFence[1]?.[0] as string, length: (openingFence[1] as string).length };
        }
      }
    }
    if (rawHtmlLine && options.requireClosedFences) rawHtml = markdownRawHtml(content, rawHtml, number);
    else if (rawHtml && !rawHtml.inline)
      invalid(`Unterminated raw HTML (${rawHtml.opener}) leaves its Markdown block; close it before the blank line or container exit.`);
    else if (!masked && options.requireClosedFences && (rawHtml || /<(?:script|pre|style|textarea)(?=[ \t/>]|$)/i.test(content)))
      rawHtml = markdownRawHtml(content, rawHtml, number, true);
    if (masked) {
      paragraph = undefined;
      reference = false;
    } else {
      const underline = MARKDOWN_UNDERLINE.exec(content);
      if (underline && paragraph && !lazy) {
        const prefix = underline[1]?.startsWith("=") ? "#" : "##";
        const match = [...`${prefix} ${paragraph.lines.join(" ")}`.matchAll(pattern)][0];
        if (match && (!options.topLevelOnly || !containers.length)) {
          match[0] = body.slice(paragraph.offset, offset + raw.length);
          match.index = paragraph.offset;
          match.input = body;
          headings.push(match);
        }
        paragraph = undefined;
      } else if (MARKDOWN_ATX.test(content)) {
        if (!options.topLevelOnly || !containers.length) {
          const match = [...content.matchAll(pattern)][0];
          if (match) {
            const start = cursor + (match.index ?? 0);
            const sourceStart = line.source[start] ?? raw.length;
            const sourceEnd = line.source[start + match[0].length] ?? raw.length;
            match[0] = raw.slice(sourceStart, sourceEnd);
            match.index = offset + sourceStart;
            match.input = body;
            headings.push(match);
          }
        }
        paragraph = undefined;
      } else if (!content.trim() || MARKDOWN_THEMATIC.test(content)) {
        paragraph = undefined;
        reference = false;
      } else if (!paragraph && MARKDOWN_REFERENCE_START.test(content)) {
        if (!MARKDOWN_REFERENCE.test(content)) {
          if (options.requireClosedFences)
            invalid("Ambiguous link reference definition; use a complete single-line definition before retrying.");
          paragraph = { offset, lines: [content.trim()] };
        } else reference = true;
      } else {
        if (reference && options.requireClosedFences && /^ {0,3}["'(]/.test(content))
          invalid("Ambiguous multiline link reference title; keep the definition and its title on one line before retrying.");
        reference = false;
        paragraph ??= { offset, lines: [] };
        paragraph.lines.push(content.trim());
      }
    }
    offset += raw.length + 1;
  }
  if (html?.end) invalid(`Unterminated HTML block (${html.opener}) at line ${html.line}; close the HTML block before retrying.`);
  if (rawHtml) invalid(`Unterminated raw HTML (${rawHtml.opener}) at line ${rawHtml.line}; close the HTML construct before retrying.`);
  if (options.requireClosedFences && fence) invalid("Unterminated Markdown fence; close the fenced code block before retrying.");
  return headings;
}

function sections(body: string, title: string, headings: readonly string[], optional: readonly string[] = []): Record<string, string> {
  if (!body.startsWith(`${title}\n\n`)) invalid(`Expected fixed title ${title}.`);
  const rest = body.slice(title.length + 2);
  const matches = markdownHeadings(rest, headings.includes("### In") ? /^## .+$|^### (?:In|Out)$/gm : /^## .+$/gm, {
    topLevelOnly: true,
    requireClosedFences: true,
  });
  if (matches[0]?.index !== 0) invalid("Unexpected text before the first fixed heading.");
  const actual = matches.map((match) => match[0]);
  const expected = headings.filter((heading) => !optional.includes(heading) || actual.includes(heading));
  if (actual.join("\n") !== expected.join("\n")) invalid(`Fixed headings must be ${expected.join(", ")}, in order.`);
  const result: Record<string, string> = {};
  for (const [index, match] of matches.entries()) {
    const start = (match.index as number) + match[0].length;
    const end = matches[index + 1]?.index ?? rest.length;
    const chunk = rest.slice(start, end);
    if (!chunk.startsWith("\n") || !chunk.endsWith("\n")) invalid(`Malformed section ${match[0]}.`);
    result[match[0]] = chunk === "\n\n" ? "" : chunk.slice(1).replace(/\n\n$/, "");
  }
  return result;
}

const STAGE_KEYS = ["format", "id", "title", "round", "status", "depends_on", "follows", "created", "started", "closed", "closed_sha256"];
const ROUND_KEYS = ["format", "id", "title", "status", "opened", "closed", "frozen_sha256"];
const ADR_KEYS = ["format", "id", "supersedes", "superseded_by", "stage", "status", "date", "decision-makers", "consulted", "informed"];
const STAGE_HEADINGS = [
  "## Objective",
  "## Scope",
  "### In",
  "### Out",
  "## Done criteria",
  "## Design constraints",
  "## Risks",
  "## Amendments",
  "## Free-work log",
  "## Outcome",
];
const ROUND_HEADINGS = ["## Goal", "## Constraints", "## Non-goals", "## Principles", "## Stages", "## Known limitations"];
const original = new WeakMap<object, { raw: string; rendered: string }>();

function remember<T extends object>(doc: T, raw: string, render: (doc: T) => string): T {
  original.set(doc, { raw: lf(raw), rendered: render(doc) });
  return doc;
}

export function parseStage(content: string, path = ""): StageDoc {
  const { fm, body } = header(content, STAGE_KEYS);
  const stageId = id(fm.id, "stage");
  const title = text(fm.title, "title");
  const parts = sections(body, `# ${stageId} — ${title}`, STAGE_HEADINGS, ["## Design constraints", "## Risks", "## Outcome"]);
  if (parts["## Scope"]) invalid("Scope body belongs under In or Out.");
  const doc: StageDoc = {
    format: 1,
    path,
    id: stageId,
    title,
    round: id(fm.round, "round", "round"),
    status: choice(fm.status, ["planned", "active", "closed", "dropped"], "status"),
    depends_on: strings(fm.depends_on, "depends_on", "stage"),
    follows: nullableId(fm.follows, "stage", "follows"),
    created: date(fm.created, "created") as string,
    started: date(fm.started, "started", true),
    closed: date(fm.closed, "closed", true),
    closed_sha256: digest(fm.closed_sha256, "closed_sha256"),
    objective: parts["## Objective"] as string,
    scope_in: parts["### In"] as string,
    scope_out: parts["### Out"] as string,
    done_criteria: parts["## Done criteria"] as string,
    design_constraints: parts["## Design constraints"],
    risks: parts["## Risks"],
    amendments: parts["## Amendments"] as string,
    free_work_log: parts["## Free-work log"] as string,
    outcome: parts["## Outcome"],
  };
  parseDoneCriteria(doc.done_criteria);
  return remember(doc, content, renderStage);
}

export function parseDoneCriteria(body: string): DoneCriterion[] {
  const matches = [...body.matchAll(/^- (DC[1-9]\d*) — (.+)\n {2}- Verify: (.+)$/gm)];
  if (!matches.length || new Set(matches.map((match) => match[1])).size !== matches.length)
    invalid("Done criteria need unique DC ids, statements and Verify methods.");
  if (matches.map((match) => match[0]).join("\n") !== body) invalid("Malformed Done criteria section.");
  return matches.map((match) => ({ id: match[1] as string, statement: match[2] as string, verify: match[3] as string }));
}

export function renderStage(doc: StageDoc): string {
  const meta = Object.fromEntries(STAGE_KEYS.map((key) => [key, doc[key as keyof StageDoc]]));
  let output = `${frontmatter(meta)}# ${doc.id} — ${doc.title}\n\n`;
  output += section("## Objective", doc.objective) + section("## Scope", "");
  output += section("### In", doc.scope_in) + section("### Out", doc.scope_out) + section("## Done criteria", doc.done_criteria);
  if (doc.design_constraints !== undefined) output += section("## Design constraints", doc.design_constraints);
  if (doc.risks !== undefined) output += section("## Risks", doc.risks);
  output += section("## Amendments", doc.amendments) + section("## Free-work log", doc.free_work_log);
  if (doc.outcome !== undefined) output += section("## Outcome", doc.outcome);
  return output;
}

export function parseRound(content: string, path = ""): RoundDoc {
  const { fm, body } = header(content, ROUND_KEYS);
  const roundId = id(fm.id, "round");
  const title = text(fm.title, "title");
  const parts = sections(body, `# ${roundId} — ${title}`, ROUND_HEADINGS);
  generatedContent(parts["## Stages"] as string, "stages");
  return {
    format: 1,
    path,
    id: roundId,
    title,
    status: choice(fm.status, ["active", "closed"], "status"),
    opened: date(fm.opened, "opened") as string,
    closed: date(fm.closed, "closed", true),
    frozen_sha256: digest(fm.frozen_sha256, "frozen_sha256"),
    goal: parts["## Goal"] as string,
    constraints: parts["## Constraints"] as string,
    non_goals: parts["## Non-goals"] as string,
    principles: parts["## Principles"] as string,
    stages: parts["## Stages"] as string,
    known_limitations: parts["## Known limitations"] as string,
  };
}

export function renderRound(doc: RoundDoc, stages?: readonly StageDoc[]): string {
  const meta = Object.fromEntries(ROUND_KEYS.map((key) => [key, doc[key as keyof RoundDoc]]));
  return (
    `${frontmatter(meta)}# ${doc.id} — ${doc.title}\n\n` +
    section("## Goal", doc.goal) +
    section("## Constraints", doc.constraints) +
    section("## Non-goals", doc.non_goals) +
    section("## Principles", doc.principles) +
    section(
      "## Stages",
      stages ? generatedBlock("stages", renderStageTable(stages.filter((stage) => stage.round === doc.id))) : doc.stages,
    ) +
    section("## Known limitations", doc.known_limitations)
  );
}

export function parseTodo(content: string, path = ""): TodoDoc {
  const { fm, body } = header(content, ["format", "round"]);
  const round = id(fm.round, "round", "round");
  if (!body.startsWith(`# ${round} — TODO\n\n`)) invalid("Malformed TODO title.");
  const rest = body.slice(`# ${round} — TODO\n\n`.length);
  const openHeader = "## Open\n\n";
  const closedHeader = "## Closed in this round\n\n";
  const headings = markdownHeadings(rest, /^## .+$/gm, { topLevelOnly: true, requireClosedFences: true });
  if (!rest.startsWith(openHeader) || headings.length !== 2 || headings[1]?.[0] !== "## Closed in this round") {
    invalid("TODO fixed headings must be Open and Closed in this round.");
  }
  const split = headings[1]?.index as number;
  if (!rest.slice(split).startsWith(closedHeader)) invalid("Closed TODO heading requires a blank separator.");
  const items = [...todoItems(rest.slice(openHeader.length, split), true), ...todoItems(rest.slice(split + closedHeader.length), false)];
  return { format: 1, path, round, items };
}

function todoItems(body: string, open: boolean): TodoItem[] {
  const outline = markdownHeadings(body, /^### .+$/gm, { topLevelOnly: true, requireClosedFences: true });
  const headings = outline.map((heading) => {
    const item = /^### (T\d{3,}) — (.+)$/.exec(heading[0]);
    if (!item) invalid("Malformed TODO item heading.");
    item.index = heading.index as number;
    return item;
  });
  if (!headings.length && body !== "") invalid("Malformed TODO item headings.");
  if (headings.length && headings[0]?.index !== 0) invalid("Unexpected text before TODO item.");
  return headings.map((heading, index) => {
    const chunk = body.slice((heading.index as number) + heading[0].length + 1, headings[index + 1]?.index ?? body.length);
    if (!chunk.endsWith("\n\n")) invalid("TODO items require a blank separator.");
    const lines = chunk.slice(0, -2).split("\n");
    const item: TodoItem = { id: id(heading[1], "todo"), title: text(heading[2], "title"), status: "open", body: "" };
    const seen = new Set<string>();
    while (lines[0]?.startsWith("- ")) {
      const metadata = /^- (Severity|Source|Target|Trigger|Resolved|Moved|Won't fix|Carried|Carried from)(?:: | → )(.*)$/.exec(lines[0]);
      if (!metadata) break;
      const key = metadata[1] as string;
      const value = metadata[2] as string;
      if (seen.has(key)) invalid(`Duplicate TODO ${key}.`);
      seen.add(key);
      lines.shift();
      if (key === "Severity") item.severity = choice(value, ["high", "normal", "low"] as const, "severity");
      else if (key === "Source") item.source = value;
      else if (key === "Target") item.target = value;
      else if (key === "Trigger") item.trigger = value;
      else if (key === "Carried from") item.carried_from = value;
      else {
        if (item.status !== "open") invalid("A closed TODO needs exactly one disposition.");
        item.status = key === "Resolved" ? "resolved" : key === "Moved" ? "moved" : key === "Won't fix" ? "wontfix" : "carried";
        item.reference = value;
      }
    }
    if (open !== (item.status === "open")) invalid("TODO disposition does not match its fixed section.");
    if (lines[0] === "") lines.shift();
    item.body = lines.join("\n");
    return item;
  });
}

export function renderTodo(doc: TodoDoc): string {
  const renderItem = (item: TodoItem): string => {
    const lines = [`### ${item.id} — ${item.title}`];
    if (item.severity !== undefined) lines.push(`- Severity: ${item.severity}`);
    if (item.source !== undefined) lines.push(`- Source: ${item.source}`);
    if (item.target !== undefined) lines.push(`- Target: ${item.target}`);
    if (item.trigger !== undefined) lines.push(`- Trigger: ${item.trigger}`);
    if (item.carried_from !== undefined) lines.push(`- Carried from: ${item.carried_from}`);
    if (item.status !== "open") {
      const labels = { resolved: "Resolved", moved: "Moved", wontfix: "Won't fix", carried: "Carried" };
      lines.push(`- ${labels[item.status]}${item.status === "resolved" ? ":" : " →"} ${item.reference ?? ""}`);
    }
    if (item.body) lines.push("", lf(item.body));
    return `${lines.join("\n")}\n\n`;
  };
  return (
    `${frontmatter({ format: doc.format, round: doc.round })}# ${doc.round} — TODO\n\n## Open\n\n` +
    doc.items
      .filter((item) => item.status === "open")
      .map(renderItem)
      .join("") +
    "## Closed in this round\n\n" +
    doc.items
      .filter((item) => item.status !== "open")
      .map(renderItem)
      .join("")
  );
}

const madrTemplate = lf(readFileSync(new URL("../assets/madr/adr-template.md", import.meta.url), "utf8"));
export const MADR_BODY_TEMPLATE = madrTemplate.slice(madrTemplate.indexOf("\n---\n") + 5).replace(/^\n/, "");
export interface AdrSections {
  context: string;
  drivers?: string;
  options: string[];
  outcome: string;
  consequences?: string;
  confirmation?: string;
  pros_cons?: string;
  more_info?: string;
}

export function buildAdrBody(title: string, input: AdrSections): string {
  const keep = ["## Context and Problem Statement", "## Considered Options", "## Decision Outcome"];
  const content: Record<string, string | undefined> = {
    "## Context and Problem Statement": input.context,
    "## Decision Drivers": input.drivers,
    "## Considered Options": input.options.map((option) => `* ${option}`).join("\n"),
    "## Decision Outcome": input.outcome,
    "### Consequences": input.consequences,
    "### Confirmation": input.confirmation,
    "## Pros and Cons of the Options": input.pros_cons,
    "## More Information": input.more_info,
  };
  const headings = [...MADR_BODY_TEMPLATE.matchAll(/^##? .+$|^### (?:Consequences|Confirmation)$/gm)];
  let result = `# ${text(title, "title")}\n\n`;
  for (const heading of headings) {
    const name = heading[0];
    if (name.startsWith("# ")) continue;
    const value = content[name];
    if (value !== undefined || keep.includes(name)) result += section(name, value ?? "");
  }
  return result;
}

function validateAdrBody(body: string): string {
  const title = /^# (.+)\n\n/.exec(body)?.[1];
  if (!title) invalid("ADR requires a MADR title.");
  const headings = markdownHeadings(body, /^## .+$|^### (?:Consequences|Confirmation)$/gm, {
    topLevelOnly: true,
    requireClosedFences: true,
  }).map((match) => match[0]);
  const templateHeadings = [...MADR_BODY_TEMPLATE.matchAll(/^## .+$|^### (?:Consequences|Confirmation)$/gm)].map((match) => match[0]);
  let previous = -1;
  for (const heading of headings) {
    const position = templateHeadings.indexOf(heading);
    if (position <= previous) invalid("ADR fixed headings must follow the vendored MADR template.");
    previous = position;
  }
  for (const required of ["## Context and Problem Statement", "## Considered Options", "## Decision Outcome"]) {
    if (!headings.includes(required)) invalid(`ADR missing fixed heading ${required}.`);
  }
  return title;
}

export function parseAdr(content: string, path = ""): AdrDoc {
  const { fm, body } = header(content, ADR_KEYS);
  const title = validateAdrBody(body);
  return {
    format: 1,
    path,
    id: id(fm.id, "adr"),
    title,
    supersedes: strings(fm.supersedes, "supersedes", "adr"),
    superseded_by: nullableId(fm.superseded_by, "adr", "superseded_by"),
    stage: nullableId(fm.stage, "stage", "stage"),
    status: choice(fm.status, ["proposed", "accepted", "rejected", "deprecated", "superseded"], "status"),
    date: date(fm.date, "date") as string,
    decision_makers: strings(fm["decision-makers"], "decision-makers"),
    consulted: strings(fm.consulted, "consulted"),
    informed: strings(fm.informed, "informed"),
    body,
  };
}

export function renderAdr(doc: AdrDoc): string {
  return (
    frontmatter({
      format: doc.format,
      id: doc.id,
      supersedes: doc.supersedes,
      superseded_by: doc.superseded_by,
      stage: doc.stage,
      status: doc.status,
      date: doc.date,
      "decision-makers": doc.decision_makers,
      consulted: doc.consulted,
      informed: doc.informed,
    }) + lf(doc.body)
  );
}

export function generatedBlock(name: string, content: string): string {
  return `<!-- roadmap:generated:${name} -->\n${content}\n<!-- /roadmap:generated -->`;
}

function blockBounds(body: string, name: string): { start: number; end: number; innerStart: number; innerEnd: number } {
  const begin = `<!-- roadmap:generated:${name} -->`;
  const end = "<!-- /roadmap:generated -->";
  const start = body.indexOf(begin);
  const close = body.indexOf(end, start + begin.length);
  if (start < 0 || close < 0 || body.indexOf(begin, start + begin.length) >= 0) invalid(`Missing or duplicate generated block ${name}.`);
  const nested = body.indexOf("<!-- roadmap:generated:", start + begin.length);
  if (nested >= 0 && nested < close) invalid(`Nested generated block ${name}.`);
  return { start, end: close + end.length, innerStart: start + begin.length, innerEnd: close };
}

export function generatedContent(body: string, name: string): string {
  const bounds = blockBounds(body, name);
  const inner = lf(body.slice(bounds.innerStart, bounds.innerEnd));
  if (!inner.startsWith("\n") || !inner.endsWith("\n")) invalid(`Malformed generated block ${name}.`);
  return inner.slice(1, -1);
}

export function replaceGenerated(body: string, name: string, content: string): string {
  const bounds = blockBounds(body, name);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  return body.slice(0, bounds.start) + generatedBlock(name, content).replaceAll("\n", newline) + body.slice(bounds.end);
}

function ordered<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, "")) || a.id.localeCompare(b.id));
}

function cell(value: string | null): string {
  return (value ?? "—").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

export function renderStageTable(stages: readonly StageDoc[]): string {
  return [
    "| Stage | Title | Status | Dependencies | Created | Started | Closed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...ordered(stages).map(
      (stage) =>
        `| ${stage.id} | ${cell(stage.title)} | ${stage.status} | ${stage.depends_on.join(", ") || "—"} | ${stage.created} | ${cell(stage.started)} | ${cell(stage.closed)} |`,
    ),
  ].join("\n");
}

export function renderRoundTable(rounds: readonly RoundDoc[]): string {
  return [
    "| Round | Title | Status | Opened | Closed |",
    "| --- | --- | --- | --- | --- |",
    ...ordered(rounds).map((round) => `| ${round.id} | ${cell(round.title)} | ${round.status} | ${round.opened} | ${cell(round.closed)} |`),
  ].join("\n");
}

export function renderCurrentStatus(rounds: readonly RoundDoc[], stages: readonly StageDoc[]): string {
  const active = ordered(rounds.filter((round) => round.status === "active"));
  if (!active.length) return "No active round. Free work is unrestricted; ADR management remains available.";
  return active
    .map((round) => {
      const own = stages.filter((stage) => stage.round === round.id);
      const done = own.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      return `${round.id} — ${round.title}: ${done}/${own.length} stages finished; ${own.filter((stage) => stage.status === "active").length} active.`;
    })
    .join("\n");
}

export function parseRoadmapIndex(content: string, path = ""): RoadmapIndexDoc {
  const { fm, body } = header(content, ["format", "roadmap", "title"], true);
  const title = text(fm.title, "title");
  const headings = markdownHeadings(body, /^## .+$/gm, { topLevelOnly: true, requireClosedFences: true }).map((heading) => heading[0]);
  if (!body.startsWith(`# ${title}\n\n`) || headings.join("\n") !== "## How this directory works\n## Rounds\n## Current status") {
    invalid("Roadmap index missing or altered fixed title, How this directory works, Rounds or Current status headings.");
  }
  generatedContent(body, "rounds");
  generatedContent(body, "status");
  return { format: 1, path, title, body };
}

export function renderRoadmapIndex(doc: RoadmapIndexDoc, rounds?: readonly RoundDoc[], stages: readonly StageDoc[] = []): string {
  let body =
    doc.body ||
    `# ${doc.title}\n\n${HOW_THIS_DIRECTORY_WORKS}\n## Rounds\n\n${generatedBlock("rounds", renderRoundTable([]))}\n\n## Current status\n\n${generatedBlock("status", renderCurrentStatus([], []))}\n`;
  if (rounds) {
    body = replaceGenerated(body, "rounds", renderRoundTable(rounds));
    body = replaceGenerated(body, "status", renderCurrentStatus(rounds, stages));
  }
  return frontmatter({ format: doc.format, roadmap: { format: 1 }, title: doc.title }, true) + lf(body);
}

export const ADR_INDEX_CONVENTIONS = `# Architecture Decision Records

ADRs use the vendored MADR 4.0 body and format: 1 metadata. Files are NNNN-slug.md with ids ADR-NNNN. Create and revise proposed records through roadmap_adr; accepted records change through status transitions, supersession or dated notes under More Information. Confirmation describes verification; implementation steps belong to the plan. ADRs outlive roadmap rounds.

## Decisions
`;

export function renderAdrTable(adrs: readonly AdrDoc[]): string {
  return [
    "| ADR | Title | Status | Date |",
    "| --- | --- | --- | --- |",
    ...ordered(adrs).map(
      (adr) =>
        `| ${adr.id} | ${cell(adr.title)} | ${adr.superseded_by ? `superseded by ${adr.superseded_by}` : adr.status} | ${adr.date} |`,
    ),
  ].join("\n");
}

export function parseAdrIndex(content: string, path = ""): AdrIndexDoc {
  const { body } = header(content, ["format"]);
  if (
    !body.startsWith("# Architecture Decision Records\n\n") ||
    markdownHeadings(body, /^## .+$/gm, { topLevelOnly: true, requireClosedFences: true })
      .map((heading) => heading[0])
      .join("\n") !== "## Decisions"
  )
    invalid("Malformed ADR index fixed headings.");
  generatedContent(body, "adrs");
  return { format: 1, path, body };
}

export function renderAdrIndex(doc: AdrIndexDoc, adrs?: readonly AdrDoc[]): string {
  let body = doc.body || `${ADR_INDEX_CONVENTIONS}\n${generatedBlock("adrs", renderAdrTable([]))}\n`;
  if (adrs) body = replaceGenerated(body, "adrs", renderAdrTable(adrs));
  return frontmatter({ format: doc.format }) + lf(body);
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stageSha256(doc: StageDoc): string {
  const rendered = renderStage(doc);
  const saved = original.get(doc);
  const content = saved?.rendered === rendered ? saved.raw : rendered;
  return sha256(lf(content).replace(/^closed_sha256:[^\n]*\n/m, ""));
}

export type RoundFiles = ReadonlyMap<string, string | Uint8Array> | Record<string, string | Uint8Array>;
export function roundSha256(files: RoundFiles): string {
  const entries: Array<[string, string | Uint8Array]> = files instanceof Map ? [...files] : Object.entries(files);
  const manifest = entries
    .map(([path, content]) => {
      const name = path.split(sep).join("/");
      if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "."))
        invalid("Round hash paths must be relative.");
      const bytes =
        name === "README.md"
          ? Buffer.from(content)
              .toString("utf8")
              .replace(/^frozen_sha256:[^\n]*\n/m, "")
          : content;
      return [name, sha256(bytes)] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(manifest.map(([path, hash]) => `${path}\n${hash}\n`).join(""));
}

export async function loadRepo(repoRoot: string): Promise<Repo | null> {
  const git = discoverRepo(repoRoot);
  if (!git) return null;
  const repo: Repo = { ...git, roadmapDir: join(git.repoRoot, "docs/roadmap"), adrDir: join(git.repoRoot, "docs/adr") };
  let content: string;
  try {
    content = await readFile(join(repo.roadmapDir, "README.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!metadata || !/^roadmap:/m.test(metadata)) return null;
  parseRoadmapIndex(content, join(repo.roadmapDir, "README.md"));
  return repo;
}

async function regularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await regularFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

export async function loadAll(repo: Repo): Promise<Model> {
  const indexPath = join(repo.roadmapDir, "README.md");
  const model: Model = {
    repo,
    index: { format: 1, path: indexPath, title: "", body: "" },
    rounds: [],
    stages: [],
    todos: [],
    adrs: [],
    files: {},
    parseErrors: [],
  };
  const files = model.files as NonNullable<Model["files"]>;
  const parseErrors = model.parseErrors as DocumentIssue[];
  for (const base of [repo.roadmapDir, repo.adrDir]) {
    try {
      for (const path of await regularFiles(base)) files[path] = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parseErrors.push({ rule: "structure", path: base, message: "Managed directory is missing." });
    }
  }
  const parse = <T>(path: string, parser: (content: string, path: string) => T): T | undefined => {
    const raw = files[path];
    if (raw === undefined) {
      parseErrors.push({ rule: "structure", path, message: "Managed file is missing." });
      return undefined;
    }
    try {
      return parser(Buffer.from(raw).toString("utf8"), path);
    } catch (error) {
      parseErrors.push({
        rule: error instanceof DocumentError ? error.rule : "structure",
        path,
        message: String(error instanceof Error ? error.message : error),
      });
      return undefined;
    }
  };
  model.index = parse(indexPath, parseRoadmapIndex) ?? model.index;
  model.adrIndex = parse(join(repo.adrDir, "README.md"), parseAdrIndex);
  const roundDirs = await readdir(repo.roadmapDir, { withFileTypes: true });
  for (const entry of roundDirs.filter((item) => item.isDirectory())) {
    const base = join(repo.roadmapDir, entry.name);
    if (!/^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      parseErrors.push({ rule: "structure", path: base, message: "Round directory requires NN-slug naming." });
    }
    const round = parse(join(base, "README.md"), parseRound);
    if (round && Number(entry.name.split("-")[0]) !== Number(round.id.slice(1))) {
      parseErrors.push({ rule: "structure", path: round.path, message: "Round id does not match its directory number." });
    }
    if (round) model.rounds.push(round);
    const todo = parse(join(base, "TODO.md"), parseTodo);
    if (todo && round && todo.round !== round.id)
      parseErrors.push({ rule: "structure", path: todo.path, message: "TODO round does not match its directory charter." });
    if (todo) model.todos.push(todo);
    for (const path of Object.keys(files).filter((path) => dirname(path) === join(base, "stages") && path.endsWith(".md"))) {
      const stage = parse(path, parseStage);
      if (
        !/^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(basename(path)) ||
        (stage && Number(basename(path).split("-")[0]) !== Number(stage.id.slice(1)))
      ) {
        parseErrors.push({ rule: "structure", path, message: "Stage file requires NN-slug.md naming with its stage number." });
      }
      if (stage && round && stage.round !== round.id)
        parseErrors.push({ rule: "structure", path, message: "Stage round does not match its directory charter." });
      if (stage) model.stages.push(stage);
    }
  }
  for (const path of Object.keys(files).filter(
    (path) => dirname(path) === repo.adrDir && path.endsWith(".md") && path !== join(repo.adrDir, "README.md"),
  )) {
    const adr = parse(path, parseAdr);
    if (
      !/^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(basename(path)) ||
      (adr && Number(basename(path).split("-")[0]) !== Number(adr.id.slice(4)))
    ) {
      parseErrors.push({ rule: "structure", path, message: "ADR file requires NNNN-slug.md naming with its ADR number." });
    }
    if (adr) model.adrs.push(adr);
  }
  return model;
}

export function roundFiles(model: Model, round: RoundDoc): Record<string, string | Uint8Array> {
  const base = dirname(round.path);
  const files: Record<string, string | Uint8Array> = {};
  for (const [path, content] of Object.entries(model.files ?? {})) {
    const name = relative(base, resolve(path));
    if (!name.startsWith(`..${sep}`) && name !== ".." && !name.startsWith(sep)) files[name] = content;
  }
  return files;
}
