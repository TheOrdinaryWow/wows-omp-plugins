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

Every managed file has format: 1 front matter and a managed-by comment. This README also carries roadmap: { format: 1 }. Front matter and fixed headings are structure; section bodies are free Markdown. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages and Known limitations. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

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

export function markdownHeadings(body: string, pattern: RegExp): RegExpMatchArray[] {
  let fenceCharacter = "";
  let fenceLength = 0;
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    let masked = Boolean(fenceCharacter);
    if (fence) {
      const delimiter = fence[1] as string;
      if (!fenceCharacter) {
        fenceCharacter = delimiter[0] as string;
        fenceLength = delimiter.length;
        masked = true;
      } else if (delimiter[0] === fenceCharacter && delimiter.length >= fenceLength && !fence[2]?.trim()) {
        fenceCharacter = "";
      }
    }
    lines.push(masked ? " ".repeat(line.length) : line);
  }
  return [...lines.join("\n").matchAll(pattern)];
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
  const headings = markdownHeadings(rest, /^## .+$/gm);
  if (!rest.startsWith(openHeader) || headings.length !== 2 || headings[1]?.[0] !== "## Closed in this round") {
    invalid("TODO fixed headings must be Open and Closed in this round.");
  }
  const split = headings[1]?.index as number;
  if (!rest.slice(split).startsWith(closedHeader)) invalid("Closed TODO heading requires a blank separator.");
  const items = [...todoItems(rest.slice(openHeader.length, split), true), ...todoItems(rest.slice(split + closedHeader.length), false)];
  return { format: 1, path, round, items };
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
  const headings = markdownHeadings(body, /^## .+$|^### (?:Consequences|Confirmation)$/gm).map((match) => match[0]);
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
  const headings = markdownHeadings(body, /^## .+$/gm).map((heading) => heading[0]);
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
    markdownHeadings(body, /^## .+$/gm)
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
