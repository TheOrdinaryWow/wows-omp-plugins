import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { discoverRepo } from "#src/git.ts";
import { parseFrontmatter } from "#src/host.ts";

/** The only format this plugin writes. Legacy roadmap files (formats 1 and 2) are read and rewritten in it when touched. */
const ADR_FORMAT = 1;
const LEGACY_FORMATS: readonly number[] = [1, 2];
export const ADR_DIR = "docs/adr";
export const STATUSES = ["proposed", "accepted", "rejected", "deprecated", "superseded"] as const;
export type AdrStatus = (typeof STATUSES)[number];
export type AdrDirState = "absent" | "empty" | "managed" | "unmanaged";

function managedComment(format = ADR_FORMAT): string {
  return `<!-- Managed by the adr OMP plugin (format v${format}). Change it through adr_* tools. Format: docs/adr/README.md -->`;
}

/** The comment roadmap 0.4.0 and earlier wrote into docs/adr; its presence marks a legacy file. */
function legacyComment(format: number): string {
  return `<!-- Managed by the roadmap OMP plugin (format v${format}). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->`;
}

const MANAGED_LINES: Readonly<Record<string, true>> = {
  [managedComment()]: true,
  [legacyComment(1)]: true,
  [legacyComment(2)]: true,
  "<!-- adr:generated:index -->": true,
  "<!-- /adr:generated -->": true,
  "<!-- roadmap:generated:adrs -->": true,
  "<!-- /roadmap:generated -->": true,
};

const INDEX_TITLE = "# Architecture Decision Records";
const INDEX_CONVENTIONS =
  "ADRs record significant, hard-to-reverse decisions in the vendored MADR 4.0 format. Files are NNNN-slug.md with ids ADR-NNNN; numbers are monotonic and never reused. Agents change these files only through the adr_* tools: proposed records are created and revised as a whole, while accepted records change only through status transitions, supersession or dated notes under More Information. Confirmation describes how a decision is verified; implementation steps belong to plans. Each file has format: 1 front matter and a managed-by comment; optional fields are omitted when empty. Files written by the roadmap plugin are read as they are and rewritten in this format when a write touches them. The table below is generated: run adr_check with fix: true, or /adr check --fix, when it is stale.";
/** The conventions paragraph roadmap 0.4.0 and earlier wrote into the ADR index; conversion swaps only this paragraph. */
const LEGACY_INDEX_CONVENTIONS =
  "ADRs use the vendored MADR 4.0 body and format: 1 metadata. Files are NNNN-slug.md with ids ADR-NNNN. Create and revise proposed records through roadmap_adr; accepted records change through status transitions, supersession or dated notes under More Information. Confirmation describes verification; implementation steps belong to the plan. ADRs outlive roadmap rounds.";

export interface AdrRepo {
  repoRoot: string;
  commonDir: string;
  adrDir: string;
}

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

export interface AdrDoc {
  /** Absolute path. */
  path: string;
  /** Stored in the legacy roadmap format; the next write of this file converts it. */
  legacy: boolean;
  /** The stored file's own format number: 1 for this plugin, 1 or 2 for legacy roadmap files. */
  format: number;
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  stage?: string;
  supersedes: string[];
  superseded_by?: string;
  decision_makers: string[];
  consulted: string[];
  informed: string[];
  /** MADR body starting with the "# title" line. */
  body: string;
}

export interface IndexDoc {
  path: string;
  legacy: boolean;
  format: number;
  body: string;
}

export interface DocumentIssue {
  rule: "structure" | "format";
  path: string;
  message: string;
}

export interface AdrModel {
  repo: AdrRepo;
  index?: IndexDoc;
  adrs: AdrDoc[];
  /** Raw contents of the Markdown files directly under docs/adr, by absolute path. */
  files: Record<string, string>;
  parseErrors: DocumentIssue[];
}

/** One ADR as the service contract and the sidecar expose it. */
export interface AdrRecord {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  stage?: string;
  supersedes: string[];
  superseded_by?: string;
  decision_makers: string[];
  consulted: string[];
  informed: string[];
  path: string;
  body: string;
  legacy: boolean;
}

export interface AdrSnapshot {
  repoRoot: string;
  records: AdrRecord[];
  parseErrors: Array<{ path: string; message: string }>;
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

function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function invalid(message: string): never {
  throw new DocumentError("structure", message);
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) invalid(`${key} must be a non-empty single-line string.`);
  return value;
}

const ID_PATTERNS = { stage: /^S\d{2,}$/, adr: /^ADR-\d{4,}$/ };

export function validId(value: string, kind: "stage" | "adr"): boolean {
  return ID_PATTERNS[kind].test(value) && Number(value.replace(/\D/g, "")) >= 1;
}

function id(value: unknown, kind: "stage" | "adr", key = "id"): string {
  const result = text(value, key);
  if (!validId(result, kind)) invalid(`${key} is not a valid ${kind} id.`);
  return result;
}

function strings(value: unknown, key: string, kind?: "adr"): string[] {
  if (!Array.isArray(value)) invalid(`${key} must be a list.`);
  return value.map((entry) => (kind ? id(entry, kind, key) : text(entry, key)));
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function date(value: unknown, key: string): string {
  const result = text(value, key);
  if (!isCalendarDate(result)) invalid(`${key} must be an ISO calendar date.`);
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

interface KeySets {
  /** Keys of this plugin's format 1: required ones must be present, optional ones may be omitted. */
  current: { required: readonly string[]; optional?: readonly string[] };
  /** Keys of the legacy roadmap format; all of them are always present. */
  legacy: readonly string[];
}

interface Header {
  fm: Record<string, unknown>;
  body: string;
  format: number;
  legacy: boolean;
}

function header(content: string, keys: KeySets, marker = false): Header {
  const known = new Set([...keys.current.required, ...(keys.current.optional ?? []), ...keys.legacy]);
  const normalized = lf(content);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalized);
  if (!match) invalid("Managed files require delimited front matter at the start.");
  const fields: Record<string, unknown> = {};
  for (const line of (match[1] as string).split("\n")) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!field) invalid("Unsupported or malformed front matter line.");
    const key = field[1] as string;
    if (Object.hasOwn(fields, key)) invalid(`Duplicate front matter key ${key}.`);
    if (!known.has(key)) invalid(`Unknown front matter key ${key}.`);
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
    fields[key] = key === "adr" && /^\{\s*format:\s*\d+\s*\}$/.test(value) ? { format: Number(value.match(/\d+/)?.[0]) } : scalar(value);
  }
  const body = normalized.slice(match[0].length);
  // The managed-by comment brand decides between this plugin's format and the legacy roadmap format.
  const legacy = body.startsWith("<!-- Managed by the roadmap OMP plugin ");
  if (!legacy && !body.startsWith("<!-- Managed by the adr OMP plugin ")) invalid("Missing or altered managed-by comment.");
  const format = fields.format;
  if (legacy ? !LEGACY_FORMATS.includes(format as number) : format !== ADR_FORMAT) {
    throw new DocumentError(
      "format",
      legacy
        ? `Unsupported legacy roadmap format ${String(format)}; supported legacy formats are ${LEGACY_FORMATS.join(" and ")}.`
        : `Unsupported adr format ${String(format)}; this plugin supports format ${ADR_FORMAT}.`,
    );
  }
  const required = legacy ? keys.legacy : keys.current.required;
  const allowed = legacy ? keys.legacy : [...keys.current.required, ...(keys.current.optional ?? [])];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) invalid(`Front matter key ${key} is not part of ${legacy ? "the legacy roadmap" : "the adr"} format.`);
  }
  for (const key of required) if (!Object.hasOwn(fields, key)) invalid(`Missing front matter key ${key}.`);
  const { frontmatter } = parseFrontmatter(normalized, { rawKeys: true, repair: false, level: "off" });
  if (JSON.stringify(frontmatter) !== JSON.stringify(fields)) invalid("Front matter does not match the supported YAML subset.");
  if (marker && !legacy) {
    const repository = (fields.adr as { format?: unknown } | undefined)?.format;
    if (repository !== ADR_FORMAT)
      throw new DocumentError("format", `Unsupported adr marker format ${String(repository)}; this plugin supports format ${ADR_FORMAT}.`);
  }
  const comment = legacy ? legacyComment(format as number) : managedComment(format as number);
  if (!body.startsWith(`${comment}\n\n`)) invalid("Missing or altered managed-by comment.");
  return { fm: fields, body: body.slice(comment.length + 2), format: format as number, legacy };
}

function yaml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(yaml).join(", ")}]`;
  if (value === null || typeof value === "number") return String(value);
  invalid("Unsupported front matter value.");
}

function frontmatter(fields: Record<string, unknown>, marker = false): string {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${marker && key === "adr" ? `{ format: ${ADR_FORMAT} }` : yaml(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n${managedComment()}\n\n`;
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

/** The tool-owned body subset, identical to the roadmap plugin's. */
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
        const managed = MANAGED_LINES[raw] === true;
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

/** Generated index blocks: `adr` for this plugin's marker, `roadmap` for a legacy roadmap ADR index. */
type Brand = "adr" | "roadmap";
const BLOCK_NAMES: Readonly<Record<Brand, string>> = { adr: "index", roadmap: "adrs" };

function generatedBlock(brand: Brand, content: string): string {
  return `<!-- ${brand}:generated:${BLOCK_NAMES[brand]} -->\n${content}\n<!-- /${brand}:generated -->`;
}

function blockBounds(body: string, brand: Brand): { start: number; end: number; innerStart: number; innerEnd: number } {
  const begin = `<!-- ${brand}:generated:${BLOCK_NAMES[brand]} -->`;
  const end = `<!-- /${brand}:generated -->`;
  let start = -1;
  let close = -1;
  let section: string | undefined;
  let owner: string | undefined;
  for (const match of markdownMatches(
    body,
    /^## .+$|^<!-- (?:adr|roadmap):generated:[^ ]+ -->$|^<!-- \/(?:adr|roadmap):generated -->$/gm,
    false,
  )) {
    const offset = match.index as number;
    if (match[0].startsWith("## ")) {
      if (start >= 0 && close < 0) invalid("The generated ADR index block crosses its owning section.");
      section = match[0];
    } else if (match[0] === begin) {
      if (start >= 0) invalid("Missing or duplicate generated ADR index block.");
      start = offset;
      owner = section;
    } else if (start >= 0 && close < 0) {
      if (match[0] !== end) invalid("Nested generated block in the ADR index.");
      close = offset;
    }
  }
  if (start < 0 || close < 0) invalid("Missing or duplicate generated ADR index block.");
  if (owner !== "## Decisions") invalid("The generated ADR index block must be in the Decisions section.");
  return { start, end: close + end.length, innerStart: start + begin.length, innerEnd: close };
}

function generatedContent(body: string, brand: Brand): string {
  const bounds = blockBounds(body, brand);
  const inner = lf(body.slice(bounds.innerStart, bounds.innerEnd));
  if (!inner.startsWith("\n") || !inner.endsWith("\n")) invalid("Malformed generated ADR index block.");
  return inner.slice(1, -1);
}

function replaceGenerated(body: string, brand: Brand, content: string): string {
  const bounds = blockBounds(body, brand);
  return body.slice(0, bounds.start) + generatedBlock(brand, content) + body.slice(bounds.end);
}

const madrTemplate = lf(readFileSync(new URL("../assets/madr/adr-template.md", import.meta.url), "utf8"));
const MADR_BODY_TEMPLATE = madrTemplate.slice(madrTemplate.indexOf("\n---\n") + 5).replace(/^\n/, "");
const MADR_HEADINGS = /^## .+$|^### (?:Consequences|Confirmation)$/gm;
const REQUIRED_HEADINGS = ["## Context and Problem Statement", "## Considered Options", "## Decision Outcome"];

export function buildAdrBody(title: string, input: AdrSections): string {
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
    if (value !== undefined || REQUIRED_HEADINGS.includes(name)) result += section(name, value ?? "");
  }
  return result;
}

function validateAdrBody(body: string): string {
  const title = /^# (.+)\n\n/.exec(body)?.[1];
  if (!title) invalid("ADR requires a MADR title.");
  const headings = markdownHeadings(body, MADR_HEADINGS).map((match) => match[0]);
  const templateHeadings = [...MADR_BODY_TEMPLATE.matchAll(MADR_HEADINGS)].map((match) => match[0]);
  let previous = -1;
  for (const heading of headings) {
    const position = templateHeadings.indexOf(heading);
    if (position <= previous) invalid("ADR fixed headings must follow the vendored MADR template.");
    previous = position;
  }
  for (const required of REQUIRED_HEADINGS) {
    if (!headings.includes(required)) invalid(`ADR missing fixed heading ${required}.`);
  }
  return title;
}

const ADR_KEYS: KeySets = {
  current: {
    required: ["format", "id", "status", "date"],
    optional: ["supersedes", "superseded_by", "stage", "decision-makers", "consulted", "informed"],
  },
  legacy: ["format", "id", "supersedes", "superseded_by", "stage", "status", "date", "decision-makers", "consulted", "informed"],
};

export function parseAdr(content: string, path = ""): AdrDoc {
  const { fm, body, format, legacy } = header(content, ADR_KEYS);
  const title = validateAdrBody(body);
  const optionalId = (key: "superseded_by" | "stage", kind: "stage" | "adr"): string | undefined => {
    const value = fm[key];
    if (value === undefined || (legacy && value === null)) return undefined;
    if (value === null) invalid(`${key} is omitted when absent; adr format ${ADR_FORMAT} has no null values.`);
    return id(value, kind, key);
  };
  const list = (key: string, kind?: "adr"): string[] => (fm[key] === undefined ? [] : strings(fm[key], key, kind));
  return {
    path,
    legacy,
    format,
    id: id(fm.id, "adr"),
    title,
    status: choice(fm.status, STATUSES, "status"),
    date: date(fm.date, "date"),
    stage: optionalId("stage", "stage"),
    supersedes: list("supersedes", "adr"),
    superseded_by: optionalId("superseded_by", "adr"),
    decision_makers: list("decision-makers"),
    consulted: list("consulted"),
    informed: list("informed"),
    body,
  };
}

/** Writes this plugin's format only: absent stage and successor and empty lists are omitted. */
export function renderAdr(doc: AdrDoc): string {
  const fields: Record<string, unknown> = { format: ADR_FORMAT, id: doc.id, status: doc.status, date: doc.date };
  if (doc.supersedes.length) fields.supersedes = doc.supersedes;
  if (doc.superseded_by) fields.superseded_by = doc.superseded_by;
  if (doc.stage) fields.stage = doc.stage;
  if (doc.decision_makers.length) fields["decision-makers"] = doc.decision_makers;
  if (doc.consulted.length) fields.consulted = doc.consulted;
  if (doc.informed.length) fields.informed = doc.informed;
  return frontmatter(fields) + lf(doc.body);
}

const INDEX_KEYS: KeySets = { current: { required: ["format", "adr"] }, legacy: ["format"] };

export function parseIndex(content: string, path = ""): IndexDoc {
  const { body, format, legacy } = header(content, INDEX_KEYS, true);
  if (
    !body.startsWith(`${INDEX_TITLE}\n\n`) ||
    markdownHeadings(body, /^## .+$/gm)
      .map((heading) => heading[0])
      .join("\n") !== "## Decisions"
  )
    invalid("Malformed ADR index fixed headings.");
  generatedContent(body, legacy ? "roadmap" : "adr");
  return { path, legacy, format, body };
}

export function ordered<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, "")) || a.id.localeCompare(b.id));
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function renderAdrTable(adrs: readonly AdrDoc[]): string {
  return [
    "| ADR | Title | Status | Date |",
    "| --- | --- | --- | --- |",
    ...ordered(adrs).map(
      (adr) =>
        `| ${adr.id} | ${cell(adr.title)} | ${adr.superseded_by ? `superseded by ${adr.superseded_by}` : adr.status} | ${adr.date} |`,
    ),
  ].join("\n");
}

/** Whether the stored index table matches the ADRs; a legacy index is compared in place. */
export function indexFresh(doc: IndexDoc, adrs: readonly AdrDoc[]): boolean {
  return generatedContent(doc.body, doc.legacy ? "roadmap" : "adr") === renderAdrTable(adrs);
}

/**
 * Renders the marker in this plugin's format. A missing index starts from the canonical text; a legacy roadmap index
 * keeps all authored text and swaps only the roadmap conventions paragraph (when still unedited) and the block delimiters.
 */
export function renderIndex(doc: IndexDoc | undefined, adrs: readonly AdrDoc[]): string {
  const table = renderAdrTable(adrs);
  let body: string;
  if (!doc) body = `${INDEX_TITLE}\n\n${INDEX_CONVENTIONS}\n\n## Decisions\n\n${generatedBlock("adr", table)}\n`;
  else if (doc.legacy) {
    const decisions = markdownHeadings(doc.body, /^## Decisions$/gm)[0]?.index;
    if (decisions === undefined) invalid("Malformed ADR index fixed headings.");
    const bounds = blockBounds(doc.body, "roadmap");
    const preamble = doc.body
      .slice(0, decisions)
      .split("\n\n")
      .map((paragraph) => (paragraph === LEGACY_INDEX_CONVENTIONS ? INDEX_CONVENTIONS : paragraph))
      .join("\n\n");
    body = `${preamble}${doc.body.slice(decisions, bounds.start)}${generatedBlock("adr", table)}${doc.body.slice(bounds.end)}`;
  } else body = replaceGenerated(doc.body, "adr", table);
  return frontmatter({ format: ADR_FORMAT, adr: { format: ADR_FORMAT } }, true) + lf(body);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolves the git work tree that owns `path`; ADR management needs one for its lock and counters. */
export function adrRepo(path: string): AdrRepo {
  const git = discoverRepo(path);
  if (!git) throw new Error("ADR management requires a git work tree.");
  return { ...git, adrDir: join(git.repoRoot, ADR_DIR) };
}

/** A README that claims to be managed (this plugin's marker or a roadmap-written ADR index) must parse, or reads fail. */
function markerCandidate(content: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return false;
  return /^adr:/m.test(match[1] as string) || /^<!-- Managed by the (?:adr|roadmap) OMP plugin /.test(content.slice(match[0].length));
}

/** Throws when the marker claims management but is malformed, so callers never treat a damaged repository as unmanaged. */
export async function dirState(adrDir: string): Promise<AdrDirState> {
  let entries: string[];
  try {
    entries = await readdir(adrDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "unmanaged";
    throw error;
  }
  if (!entries.length) return "empty";
  const path = join(adrDir, "README.md");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return "unmanaged";
    throw error;
  }
  if (!markerCandidate(content)) return "unmanaged";
  parseIndex(content, path);
  return "managed";
}

/** Loads every Markdown file directly under docs/adr; problems become parse errors instead of exceptions. */
export async function loadModel(repo: AdrRepo): Promise<AdrModel> {
  const model: AdrModel = { repo, adrs: [], files: {}, parseErrors: [] };
  const indexPath = join(repo.adrDir, "README.md");
  for (const entry of (await readdir(repo.adrDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      model.files[join(repo.adrDir, entry.name)] = await readFile(join(repo.adrDir, entry.name), "utf8");
  }
  const parse = <T>(path: string, parser: (content: string, path: string) => T): T | undefined => {
    const raw = model.files[path];
    if (raw === undefined) {
      model.parseErrors.push({ rule: "structure", path, message: "Managed file is missing." });
      return undefined;
    }
    try {
      return parser(raw, path);
    } catch (error) {
      model.parseErrors.push({
        rule: error instanceof DocumentError ? error.rule : "structure",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  model.index = parse(indexPath, parseIndex);
  for (const path of Object.keys(model.files).filter((path) => path !== indexPath)) {
    const adr = parse(path, parseAdr);
    const name = path.slice(repo.adrDir.length + 1);
    if (!/^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name) || (adr && Number(name.split("-")[0]) !== Number(adr.id.slice(4)))) {
      model.parseErrors.push({ rule: "structure", path, message: "ADR file requires NNNN-slug.md naming with its ADR number." });
    }
    if (adr) model.adrs.push(adr);
  }
  return model;
}

export function repoPath(repo: AdrRepo, path: string): string {
  return relative(repo.repoRoot, path).split(sep).join("/");
}

export function toRecord(repo: AdrRepo, doc: AdrDoc): AdrRecord {
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    date: doc.date,
    ...(doc.stage ? { stage: doc.stage } : {}),
    supersedes: [...doc.supersedes],
    ...(doc.superseded_by ? { superseded_by: doc.superseded_by } : {}),
    decision_makers: [...doc.decision_makers],
    consulted: [...doc.consulted],
    informed: [...doc.informed],
    path: repoPath(repo, doc.path),
    body: doc.body.replace(/^# [^\n]*\n\n?/, ""),
    legacy: doc.legacy,
  };
}

export function snapshot(model: AdrModel): AdrSnapshot {
  return {
    repoRoot: model.repo.repoRoot,
    records: ordered(model.adrs).map((doc) => toRecord(model.repo, doc)),
    parseErrors: model.parseErrors.map((issue) => ({ path: repoPath(model.repo, issue.path), message: issue.message })),
  };
}

/** The ADR snapshot of an initialized repository, or null when docs/adr is absent, empty or unmanaged. */
export async function loadInitialized(path: string): Promise<AdrModel | null> {
  const repo = adrRepo(path);
  if ((await dirState(repo.adrDir)) !== "managed") return null;
  return loadModel(repo);
}
