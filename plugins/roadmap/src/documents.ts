import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { AdrApi, AdrView } from "./adr.ts";
import { discoverRepo } from "./git.ts";
import { parseFrontmatter } from "./host.ts";

export type Format = 1 | 2;
const FORMATS: readonly Format[] = [1, 2];

/** Each managed file names its own format here; format-1 files keep the bytes 0.2.3 wrote. */
export function managedComment(format: Format): string {
  return `<!-- Managed by the roadmap OMP plugin (format v${format}). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->`;
}
const MANAGED_COMMENTS: Readonly<Record<string, true>> = { [managedComment(1)]: true, [managedComment(2)]: true };

/** Format-1 repositories keep this text; /init-project writes it, since a new repository starts at format 1. */
const HOW_THIS_DIRECTORY_WORKS_V1 = `## How this directory works

This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.

The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.

Every managed file has format: 1 front matter and a managed-by comment. This README also carries roadmap: { format: 1 }. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages and Known limitations. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with \`<!-- roadmap:generated:<name> -->\` and \`<!-- /roadmap:generated -->\`. The tools own numbering, metadata, headings and generated indexes.

Rounds are active or closed. Stages are planned, active, closed or dropped. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Open TODOs need severity, source and either an unclosed target stage or a trigger. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.

Closed stages carry closed_sha256; closed rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.

Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies or a closed round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.

Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
`;

const HOW_THIS_DIRECTORY_WORKS_V2 = `## How this directory works

This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.

The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on in creation order and are never renumbered; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.

This README carries roadmap: { format: 2 }, the repository format; roadmap plugin 0.2.3 and earlier cannot read a format 2 repository. Every managed file has format: 1 or format: 2 front matter and a managed-by comment naming the same format. Format 1 files keep their bytes until a write needs a format 2 field: a target date, a planned or dropped round, or a round outcome. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages, Known limitations and, for a dropped round or a round closed with its goal outcome, Outcome. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with \`<!-- roadmap:generated:<name> -->\` and \`<!-- /roadmap:generated -->\`. The tools own numbering, metadata, headings and generated indexes.

Rounds are planned, active, closed or dropped. A planned round is drafted ahead with its charter, planned stages and TODOs; only the lowest-numbered planned round can be activated, and an unneeded planned round is dropped together with its planned stages. Stages are planned, active, closed or dropped; only stages of the active round start. A stage depends only on stages in its own or an earlier round. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Closing a round records how its goal turned out in Outcome: an assessment (achieved, partial, not_achieved or cancelled) and a summary. Open TODOs need severity, source and either an unclosed target stage in the active or a planned round, or a trigger. A planned round's TODO.md holds only TODOs for its own stages or with a trigger. When a round closes, its open TODOs that target a planned round's stage continue in that round's TODO.md with the same ID and a Carried from line, and the original is marked carried to that round. Rounds and stages may carry an optional target date; status views compare it with the actual dates and flag unfinished work past its target. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.

Same-ID carry-over may continue through multiple later rounds: every earlier occurrence is carried to the next round with matching Carried from metadata, and only one occurrence is not carried. These continuations cannot be imported again with import_todos. Moving a TODO out of a planned round to another round leaves a moved record naming a fresh ID; the destination keeps the target and records Carried from with the original ID and round.

Closed stages carry closed_sha256; closed and dropped rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.

Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies, a closed round or a dropped round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.

Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
`;

const HOW_THIS_DIRECTORY_WORKS: Readonly<Record<Format, string>> = { 1: HOW_THIS_DIRECTORY_WORKS_V1, 2: HOW_THIS_DIRECTORY_WORKS_V2 };

export type StageStatus = "planned" | "active" | "closed" | "dropped";
export type RoundStatus = "planned" | "active" | "closed" | "dropped";
/** How a closed round met its goal; recorded in a format-2 round's Outcome when it closes. */
export const ROUND_ASSESSMENTS = ["achieved", "partial", "not_achieved", "cancelled"] as const;
export type RoundAssessment = (typeof ROUND_ASSESSMENTS)[number];
type TodoStatus = "open" | "resolved" | "moved" | "wontfix" | "carried";
export interface Repo {
  repoRoot: string;
  commonDir: string;
  roadmapDir: string;
  /** Path only: roadmap never parses docs/adr, but previews hash it to detect stale confirmations. */
  adrDir: string;
  /** The session's adr service. Without it, loadAll leaves `Model.adrs` unset (sidecar, injection and stage resolver reads). */
  adr?: AdrApi;
}

interface Document {
  format: Format;
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
  target: string | null;
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
  status: RoundStatus;
  target: string | null;
  /** Null until a planned round is activated; dropped rounds were never activated. */
  opened: string | null;
  closed: string | null;
  frozen_sha256: string | null;
  goal: string;
  constraints: string;
  non_goals: string;
  principles: string;
  stages: string;
  known_limitations: string;
  /** Only a dropped round has one: the drop date is `closed` and the reason is under Deviations. */
  outcome?: string;
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

export interface RoadmapIndexDoc extends Document {
  title: string;
  body: string;
}

interface DocumentIssue {
  rule: "structure" | "format";
  path: string;
  message: string;
}

export interface Model {
  index: RoadmapIndexDoc;
  rounds: RoundDoc[];
  stages: StageDoc[];
  todos: TodoDoc[];
  repo?: Repo;
  files?: Record<string, string | Uint8Array>;
  parseErrors?: DocumentIssue[];
  /** docs/adr as the adr plugin reported it; set by loadAll only when the repository carries the adr service. */
  adrs?: AdrView;
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

function supported(format: unknown): asserts format is Format {
  if (!FORMATS.includes(format as Format))
    throw new DocumentError("format", `Unsupported roadmap format ${String(format)}; supported formats are ${FORMATS.join(" and ")}.`);
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) invalid(`${key} must be a non-empty single-line string.`);
  return value;
}

function id(value: unknown, kind: "round" | "stage" | "todo", key = "id"): string {
  const patterns = { round: /^R[1-9]\d*$/, stage: /^S\d{2,}$/, todo: /^T\d{3,}$/ };
  const result = text(value, key);
  if (!patterns[kind].test(result) || Number(result.replace(/\D/g, "")) < 1) invalid(`${key} is not a valid ${kind} id.`);
  return result;
}

function stageIds(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) invalid(`${key} must be a list.`);
  return value.map((entry) => id(entry, "stage", key));
}

export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function date(value: unknown, key: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const result = text(value, key);
  if (!isCalendarDate(result)) invalid(`${key} must be an ISO calendar date.`);
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

/** Key sets are per file format: format-1 files keep exactly the keys 0.2.3 wrote. */
type KeySet = readonly string[] | Readonly<Record<Format, readonly string[]>>;

function header(content: string, keySet: KeySet, marker = false): { fm: Record<string, unknown>; body: string; format: Format } {
  const perFormat = Array.isArray(keySet) ? undefined : (keySet as Readonly<Record<Format, readonly string[]>>);
  const known = perFormat ? FORMATS.flatMap((format) => perFormat[format]) : (keySet as readonly string[]);
  const normalized = lf(content);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalized);
  if (!match) invalid("Managed files require delimited front matter at the start.");
  const fields: Record<string, unknown> = {};
  for (const line of (match[1] as string).split("\n")) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!field) invalid("Unsupported or malformed front matter line.");
    const key = field[1] as string;
    if (Object.hasOwn(fields, key)) invalid(`Duplicate front matter key ${key}.`);
    if (!known.includes(key)) invalid(`Unknown front matter key ${key}.`);
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
  supported(fields.format);
  const format = fields.format;
  const keys = perFormat ? perFormat[format] : known;
  for (const key of Object.keys(fields)) if (!keys.includes(key)) invalid(`Front matter key ${key} is not part of format ${format}.`);
  for (const key of keys) if (!Object.hasOwn(fields, key)) invalid(`Missing front matter key ${key}.`);
  const { frontmatter } = parseFrontmatter(normalized, { rawKeys: true, repair: false, level: "off" });
  if (JSON.stringify(frontmatter) !== JSON.stringify(fields)) invalid("Front matter does not match the supported YAML subset.");
  if (marker) {
    const repository = (fields.roadmap as { format?: unknown } | undefined)?.format;
    supported(repository);
    if (repository !== format) invalid(`The roadmap marker format ${repository} must equal this README's format ${format}.`);
  }
  const body = normalized.slice(match[0].length);
  const comment = managedComment(format);
  if (!body.startsWith(`${comment}\n\n`)) invalid("Missing or altered managed-by comment.");
  return { fm: fields, body: body.slice(comment.length + 2), format };
}

function yaml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(yaml).join(", ")}]`;
  if (value === null || typeof value === "number") return String(value);
  invalid("Unsupported front matter value.");
}

function frontmatter(fields: Record<string, unknown>, marker = false): string {
  supported(fields.format);
  const format = fields.format;
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${marker && key === "roadmap" ? `{ format: ${format} }` : yaml(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n${managedComment(format)}\n\n`;
}

function section(heading: string, body: string): string {
  return `${heading}\n${body ? `${lf(body)}\n` : ""}\n`;
}

const BODY_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(?:[ \t]*[a-zA-Z0-9][a-zA-Z0-9_+.-]*)?[ \t]*$/;
const BODY_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function inlineBodyAllowed(line: string, forbidden: RegExp): boolean {
  let start = 0;
  let code: string | undefined;
  for (const run of line.matchAll(/`+/g)) {
    if (code === undefined) {
      if (line[run.index - 1] === "\\" || forbidden.test(line.slice(start, run.index))) return false;
      code = run[0];
    } else if (run[0] === code) {
      start = run.index + run[0].length;
      code = undefined;
    }
  }
  return code === undefined && !forbidden.test(line.slice(start));
}

function plainBodyLine(line: string, number: number): void {
  if (/^#{1,6}(?:[ \t]|$)/.test(line)) invalid(`Unsupported body heading at line ${number}.`);
  if (/^(?:[-=]+|(?:[-*_] *)+) *$/.test(line)) invalid(`Unsupported body heading underline or thematic break at line ${number}.`);
  if (/^(?:>|[-+*](?: |$)|\d{1,9}[.)](?: |$)|`{3,}|~{3,})/.test(line)) invalid(`Unsupported body container or fence at line ${number}.`);
  if (!inlineBodyAllowed(line, /<[a-z/!?]|[[\]\\|]/i))
    invalid(`Unsupported body HTML, inline markup or multiline code span at line ${number}.`);
}

export function validateBody(body: string, options: { inlineOnly?: boolean; afterList?: boolean } = {}): void {
  let fence: { marker: string; length: number } | undefined;
  let list = options.afterList ?? false;
  let blank = options.afterList ?? false;
  let number = 0;
  for (const raw of lf(body).split("\n")) {
    number++;
    if (fence) {
      const closing = BODY_FENCE_CLOSE.exec(raw)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = BODY_FENCE_OPEN.exec(raw);
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
    if (!raw.trim()) {
      blank = true;
      continue;
    }
    if (/^ {4}/.test(raw)) invalid(`Indented body code is unsupported (line ${number}).`);
    const line = raw.trimStart();
    const item = options.inlineOnly ? null : /^(?:[-+*]|\d{1,9}[.)]) (\S.*)$/.exec(line);
    if (item) {
      if (list && raw.startsWith(" ")) invalid(`Nested body lists are unsupported (line ${number}).`);
      plainBodyLine(item[1] as string, number);
      list = true;
    } else {
      if (list && (!blank || raw.startsWith(" ")))
        invalid(`Body list continuations are unsupported; separate a new plain paragraph with a blank line (line ${number}).`);
      plainBodyLine(line, number);
      list = false;
    }
    blank = false;
  }
  if (fence) invalid("Unterminated body fence; close the top-level fenced code block.");
}

function markdownMatches(body: string, pattern: RegExp, validate: boolean): RegExpMatchArray[] {
  const matches: RegExpMatchArray[] = [];
  let fence: { marker: string; length: number } | undefined;
  let list = false;
  let blank = false;
  let offset = 0;
  let number = 0;
  const repair = "Edit the stored file to use plain paragraphs, flat lists and closed top-level fences.";
  for (const source of body.split("\n")) {
    const raw = source.endsWith("\r") ? source.slice(0, -1) : source;
    number++;
    if (fence) {
      const closing = BODY_FENCE_CLOSE.exec(raw)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined;
    } else {
      const opening = BODY_FENCE_OPEN.exec(raw);
      if (opening) {
        if (list && opening[1]) invalid(`Unsupported stored container fence at line ${number}. ${repair}`);
        const marker = opening[2] as string;
        fence = { marker: marker[0] as string, length: marker.length };
        list = false;
      } else {
        const managed =
          MANAGED_COMMENTS[raw] === true ||
          /^<!-- roadmap:generated:(?:stages|rounds|status) -->$/.test(raw) ||
          raw === "<!-- /roadmap:generated -->";
        const line = raw.trimStart();
        const item = /^(?:[-+*]|\d{1,9}[.)]) +/.exec(line);
        const content = item ? line.slice(item[0].length) : line;
        if (validate && !managed) {
          if (
            (raw.trim() && /^ {4}/.test(raw)) ||
            raw.includes("\t") ||
            /^(?:>|`{3,}|~{3,}|\[.*\]:)/.test(content) ||
            /^(?:[-=]+|(?:[-*_] *)+) *$/.test(content) ||
            (item && /^(?:#|[-+*] |\d{1,9}[.)] )/.test(content)) ||
            (line !== raw && /^#{1,6}(?: |$)/.test(line))
          )
            invalid(`Unsupported stored Markdown at line ${number}. ${repair}`);
          if (!inlineBodyAllowed(raw, /<[a-z/!?]/i)) invalid(`Unsupported stored HTML or multiline code span at line ${number}. ${repair}`);
        }
        if (!managed) {
          if (item) list = true;
          else if (raw.trim() && !raw.startsWith(" ")) {
            if (validate && list && !blank && !/^#{1,6}(?: |$)/.test(raw))
              invalid(`Ambiguous stored list continuation at line ${number}. ${repair}`);
            list = false;
          }
        }
        const match = [...raw.matchAll(pattern)][0];
        if (match) {
          match.index = offset + (match.index ?? 0);
          match.input = body;
          matches.push(match);
        }
      }
    }
    offset += source.length + 1;
    blank = !raw.trim();
  }
  if (fence) invalid("Unterminated Markdown fence; edit the stored file to close the top-level fenced code block.");
  return matches;
}

export function markdownHeadings(body: string, pattern: RegExp): RegExpMatchArray[] {
  return markdownMatches(body, pattern, true);
}

function sections(body: string, title: string, headings: readonly string[], optional: readonly string[] = []): Record<string, string> {
  if (!body.startsWith(`${title}\n\n`)) invalid(`Expected fixed title ${title}.`);
  const rest = body.slice(title.length + 2);
  const matches = markdownHeadings(rest, headings.includes("### In") ? /^## .+$|^### (?:In|Out)$/gm : /^## .+$/gm);
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

const STAGE_KEYS: Readonly<Record<Format, readonly string[]>> = {
  1: ["format", "id", "title", "round", "status", "depends_on", "follows", "created", "started", "closed", "closed_sha256"],
  2: ["format", "id", "title", "round", "status", "target", "depends_on", "follows", "created", "started", "closed", "closed_sha256"],
};
const ROUND_KEYS: Readonly<Record<Format, readonly string[]>> = {
  1: ["format", "id", "title", "status", "opened", "closed", "frozen_sha256"],
  2: ["format", "id", "title", "status", "target", "opened", "closed", "frozen_sha256"],
};
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
const ROUND_STATUSES: Readonly<Record<Format, readonly RoundStatus[]>> = {
  1: ["active", "closed"],
  2: ["planned", "active", "closed", "dropped"],
};
const original = new WeakMap<object, { raw: string; rendered: string }>();

function remember<T extends object>(doc: T, raw: string, render: (doc: T) => string): T {
  original.set(doc, { raw: lf(raw), rendered: render(doc) });
  return doc;
}

export function parseStage(content: string, path = ""): StageDoc {
  const { fm, body, format } = header(content, STAGE_KEYS);
  const stageId = id(fm.id, "stage");
  const title = text(fm.title, "title");
  const parts = sections(body, `# ${stageId} — ${title}`, STAGE_HEADINGS, ["## Design constraints", "## Risks", "## Outcome"]);
  if (parts["## Scope"]) invalid("Scope body belongs under In or Out.");
  const doc: StageDoc = {
    format,
    path,
    id: stageId,
    title,
    round: id(fm.round, "round", "round"),
    status: choice(fm.status, ["planned", "active", "closed", "dropped"], "status"),
    target: format === 1 ? null : date(fm.target, "target", true),
    depends_on: stageIds(fm.depends_on, "depends_on"),
    follows: fm.follows === null ? null : id(fm.follows, "stage", "follows"),
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

/** The lowest file format that can express a stage or round; format-1 files are rewritten as format 2 only for these fields. */
export function requiredFormat(doc: StageDoc | RoundDoc): Format {
  if (doc.target !== null) return 2;
  return "opened" in doc && (doc.status === "planned" || doc.status === "dropped" || doc.outcome !== undefined) ? 2 : 1;
}

function expressible(doc: StageDoc | RoundDoc): void {
  supported(doc.format);
  if (requiredFormat(doc) > doc.format)
    throw new DocumentError("format", `${doc.id} uses a target date or a planned or dropped round, which need format 2.`);
}

export function renderStage(doc: StageDoc): string {
  expressible(doc);
  const meta = Object.fromEntries(STAGE_KEYS[doc.format].map((key) => [key, doc[key as keyof StageDoc]]));
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
  const { fm, body, format } = header(content, ROUND_KEYS);
  const roundId = id(fm.id, "round");
  const title = text(fm.title, "title");
  const parts = sections(
    body,
    `# ${roundId} — ${title}`,
    format === 1 ? ROUND_HEADINGS : [...ROUND_HEADINGS, "## Outcome"],
    format === 1 ? [] : ["## Outcome"],
  );
  generatedContent(body, "stages");
  const status = choice(fm.status, ROUND_STATUSES[format], "status");
  const unopened = status === "planned" || status === "dropped";
  const opened = date(fm.opened, "opened", unopened);
  if (unopened && opened !== null) invalid(`A ${status} round has opened: null; only activation records an opened date.`);
  if (status === "dropped" && (fm.closed === null || !parts["## Outcome"]?.trim()))
    invalid("A dropped round records its drop date in closed and its reason in Outcome.");
  return {
    format,
    path,
    id: roundId,
    title,
    status,
    target: format === 1 ? null : date(fm.target, "target", true),
    opened,
    closed: date(fm.closed, "closed", true),
    frozen_sha256: digest(fm.frozen_sha256, "frozen_sha256"),
    goal: parts["## Goal"] as string,
    constraints: parts["## Constraints"] as string,
    non_goals: parts["## Non-goals"] as string,
    principles: parts["## Principles"] as string,
    stages: parts["## Stages"] as string,
    known_limitations: parts["## Known limitations"] as string,
    outcome: parts["## Outcome"],
  };
}

export function renderRound(doc: RoundDoc, stages?: readonly StageDoc[]): string {
  expressible(doc);
  const meta = Object.fromEntries(ROUND_KEYS[doc.format].map((key) => [key, doc[key as keyof RoundDoc]]));
  return (
    `${frontmatter(meta)}# ${doc.id} — ${doc.title}\n\n` +
    section("## Goal", doc.goal) +
    section("## Constraints", doc.constraints) +
    section("## Non-goals", doc.non_goals) +
    section("## Principles", doc.principles) +
    section(
      "## Stages",
      stages
        ? generatedBlock(
            "stages",
            renderStageTable(
              stages.filter((stage) => stage.round === doc.id),
              doc.format,
            ),
          )
        : doc.stages,
    ) +
    section("## Known limitations", doc.known_limitations) +
    (doc.outcome === undefined ? "" : section("## Outcome", doc.outcome))
  );
}

export function parseTodo(content: string, path = ""): TodoDoc {
  const { fm, body, format } = header(content, ["format", "round"]);
  const round = id(fm.round, "round", "round");
  if (!body.startsWith(`# ${round} — TODO\n\n`)) invalid("Malformed TODO title.");
  const rest = body.slice(`# ${round} — TODO\n\n`.length);
  const openHeader = "## Open\n\n";
  const closedHeader = "## Closed in this round\n\n";
  const headings = markdownHeadings(rest, /^## .+$/gm);
  if (!rest.startsWith(openHeader) || headings.length !== 2 || headings[1]?.[0] !== "## Closed in this round") {
    invalid("TODO fixed headings must be Open and Closed in this round.");
  }
  const split = headings[1]?.index as number;
  if (!rest.slice(split).startsWith(closedHeader)) invalid("Closed TODO heading requires a blank separator.");
  const items = [...todoItems(rest.slice(openHeader.length, split), true), ...todoItems(rest.slice(split + closedHeader.length), false)];
  return { format, path, round, items };
}

function todoItems(body: string, open: boolean): TodoItem[] {
  const outline = markdownHeadings(body, /^### .+$/gm);
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

export function generatedBlock(name: string, content: string): string {
  return `<!-- roadmap:generated:${name} -->\n${content}\n<!-- /roadmap:generated -->`;
}

const GENERATED_SECTIONS: Record<string, string> = {
  stages: "## Stages",
  rounds: "## Rounds",
  status: "## Current status",
};

function blockBounds(body: string, name: string): { start: number; end: number; innerStart: number; innerEnd: number } {
  const begin = `<!-- roadmap:generated:${name} -->`;
  const end = "<!-- /roadmap:generated -->";
  let start = -1;
  let close = -1;
  let section: string | undefined;
  let owner: string | undefined;
  for (const match of markdownMatches(body, /^## .+$|^<!-- roadmap:generated:[^ ]+ -->$|^<!-- \/roadmap:generated -->$/gm, false)) {
    const offset = match.index as number;
    if (match[0].startsWith("## ")) {
      if (start >= 0 && close < 0) invalid(`Generated block ${name} crosses its owning section.`);
      section = match[0];
    } else if (match[0] === begin) {
      if (start >= 0) invalid(`Missing or duplicate generated block ${name}.`);
      start = offset;
      owner = section;
    } else if (start >= 0 && close < 0) {
      if (match[0] !== end) invalid(`Nested generated block ${name}.`);
      close = offset;
    }
  }
  if (start < 0 || close < 0) invalid(`Missing or duplicate generated block ${name}.`);
  if (section !== undefined && owner !== GENERATED_SECTIONS[name]) invalid(`Generated block ${name} must be in its owning section.`);
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

/** Format-1 files keep the 0.2.3 columns; format 2 adds Target. Generated blocks never depend on today's date. */
export function renderStageTable(stages: readonly StageDoc[], format: Format): string {
  const target = format === 2;
  return [
    `| Stage | Title | Status |${target ? " Target |" : ""} Dependencies | Created | Started | Closed |`,
    `| --- | --- | --- |${target ? " --- |" : ""} --- | --- | --- | --- |`,
    ...ordered(stages).map(
      (stage) =>
        `| ${stage.id} | ${cell(stage.title)} | ${stage.status} |${target ? ` ${cell(stage.target)} |` : ""} ${stage.depends_on.join(", ") || "—"} | ${stage.created} | ${cell(stage.started)} | ${cell(stage.closed)} |`,
    ),
  ].join("\n");
}

export function renderRoundTable(rounds: readonly RoundDoc[], format: Format): string {
  const target = format === 2;
  return [
    `| Round | Title | Status |${target ? " Target |" : ""} Opened | Closed |`,
    `| --- | --- | --- |${target ? " --- |" : ""} --- | --- |`,
    ...ordered(rounds).map(
      (round) =>
        `| ${round.id} | ${cell(round.title)} | ${round.status} |${target ? ` ${cell(round.target)} |` : ""} ${cell(round.opened)} | ${cell(round.closed)} |`,
    ),
  ].join("\n");
}

export function renderCurrentStatus(rounds: readonly RoundDoc[], stages: readonly StageDoc[], format: Format): string {
  const active = ordered(rounds.filter((round) => round.status === "active")).map((round) => {
    const own = stages.filter((stage) => stage.round === round.id);
    const done = own.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
    const target = format === 2 && round.target ? `; target ${round.target}` : "";
    return `${round.id} — ${round.title}: ${done}/${own.length} stages finished; ${own.filter((stage) => stage.status === "active").length} active${target}.`;
  });
  if (!active.length) active.push("No active round. Free work is unrestricted; ADR management remains available.");
  if (format === 1) return active.join("\n");
  const planned = ordered(rounds.filter((round) => round.status === "planned")).map((round) => {
    const count = stages.filter((stage) => stage.round === round.id && stage.status !== "dropped").length;
    return `${round.id} — ${round.title}: planned with ${count} stage${count === 1 ? "" : "s"}${round.target ? `; target ${round.target}` : ""}.`;
  });
  return [...active, ...planned].join("\n");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Status views only: an unfinished round or stage whose target date has passed. */
export function overdue(item: { status: string; target: string | null }, on: string): boolean {
  return item.target !== null && item.target < on && (item.status === "planned" || item.status === "active");
}

export function parseRoadmapIndex(content: string, path = ""): RoadmapIndexDoc {
  const { fm, body, format } = header(content, ["format", "roadmap", "title"], true);
  const title = text(fm.title, "title");
  const headings = markdownHeadings(body, /^## .+$/gm).map((heading) => heading[0]);
  if (!body.startsWith(`# ${title}\n\n`) || headings.join("\n") !== "## How this directory works\n## Rounds\n## Current status") {
    invalid("Roadmap index missing or altered fixed title, How this directory works, Rounds or Current status headings.");
  }
  generatedContent(body, "rounds");
  generatedContent(body, "status");
  return { format, path, title, body };
}

export function renderRoadmapIndex(doc: RoadmapIndexDoc, rounds?: readonly RoundDoc[], stages: readonly StageDoc[] = []): string {
  let body =
    doc.body ||
    `# ${doc.title}\n\n${HOW_THIS_DIRECTORY_WORKS[doc.format]}\n## Rounds\n\n${generatedBlock("rounds", renderRoundTable([], doc.format))}\n\n## Current status\n\n${generatedBlock("status", renderCurrentStatus([], [], doc.format))}\n`;
  if (rounds) {
    body = replaceGenerated(body, "rounds", renderRoundTable(rounds, doc.format));
    body = replaceGenerated(body, "status", renderCurrentStatus(rounds, stages, doc.format));
  }
  return frontmatter({ format: doc.format, roadmap: { format: doc.format }, title: doc.title }, true) + lf(body);
}

/** Bumps the repository marker to format 2 and replaces the directory text; other authored README text stays. */
export function upgradeRoadmapIndex(doc: RoadmapIndexDoc): void {
  const headings = markdownHeadings(doc.body, /^## .+$/gm);
  const how = headings.find((heading) => heading[0] === "## How this directory works")?.index;
  const rounds = headings.find((heading) => heading[0] === "## Rounds")?.index;
  if (how === undefined || rounds === undefined) invalid("Roadmap index missing How this directory works or Rounds headings.");
  doc.body = `${doc.body.slice(0, how)}${HOW_THIS_DIRECTORY_WORKS[2]}\n${doc.body.slice(rounds)}`;
  doc.format = 2;
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The planning-basis revision shared with Atlas plans: what a plan is drafted against. Dates, status, amendment and
 * free-work logs and the outcome are excluded, so only objective, scope, criteria and design constraints change it.
 */
export function planningRevision(stage: StageDoc): string {
  return sha256(JSON.stringify([stage.objective, stage.scope_in, stage.scope_out, stage.done_criteria, stage.design_constraints ?? ""]));
}

export function stageSha256(doc: StageDoc): string {
  const rendered = renderStage(doc);
  const saved = original.get(doc);
  const content = saved?.rendered === rendered ? saved.raw : rendered;
  return sha256(lf(content).replace(/^closed_sha256:[^\n]*\n/m, ""));
}

type RoundFiles = ReadonlyMap<string, string | Uint8Array> | Record<string, string | Uint8Array>;
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
    files: {},
    parseErrors: [],
  };
  const files = model.files as NonNullable<Model["files"]>;
  const parseErrors = model.parseErrors as DocumentIssue[];
  try {
    for (const path of await regularFiles(repo.roadmapDir)) files[path] = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parseErrors.push({ rule: "structure", path: repo.roadmapDir, message: "Managed directory is missing." });
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
  if (repo.adr) {
    try {
      const snapshot = await repo.adr.load(repo.repoRoot);
      model.adrs = snapshot
        ? { managed: true, records: snapshot.records, parseErrors: snapshot.parseErrors }
        : { managed: false, records: [], parseErrors: [] };
    } catch (error) {
      model.adrs = { managed: false, records: [], parseErrors: [], error: error instanceof Error ? error.message : String(error) };
    }
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
