import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { check } from "./check.ts";
import {
  type AdrDoc,
  type AdrSections,
  buildAdrBody,
  DocumentError,
  type DoneCriterion,
  generatedBlock,
  lf,
  loadAll,
  type Model,
  markdownHeadings,
  parseAdr,
  parseDoneCriteria,
  parseRoadmapIndex,
  parseRound,
  parseStage,
  parseTodo,
  type Repo,
  type RoundDoc,
  renderAdr,
  renderAdrIndex,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  roundFiles,
  roundSha256,
  type StageDoc,
  sha256,
  stageSha256,
  type TodoDoc,
  type TodoItem,
} from "./documents.ts";
import { renderHandoff } from "./handoff.ts";
import { allocate, type IdKind, withRepoLock } from "./numbering.ts";

export interface Actor {
  sessionId: string;
  kind: "main" | "sub";
}

export type Receipt =
  | { ok: true; summary: string; changedFiles: string[]; warnings: string[]; handoff?: string }
  | { ok: false; reason: string; hints: string[] };

export interface CriterionInput {
  id?: string;
  statement: string;
  verify: string;
}

export interface StageInput {
  id?: string;
  title: string;
  objective: string;
  scope_in: string[];
  scope_out: string[];
  done_criteria: CriterionInput[];
  depends_on?: string[];
  follows?: string;
  design_constraints?: string;
  risks?: string;
}

export interface StageOperationInput extends Partial<StageInput> {
  action: "add" | "edit" | "amend" | "start" | "close" | "drop" | "renumber";
  reason?: string;
  amendments?: {
    add?: CriterionInput[];
    modify?: DoneCriterion[];
    remove?: string[];
    scope?: Array<{ op: "add" | "remove"; side: "in" | "out"; item: string }>;
  };
  delivered?: string;
  deviations?: string;
  evidence?: Array<{ criterion: string; result: "pass" | "fail"; method: string; summary: string; commit?: string }>;
  todos?: Array<{ id: string; disposition: "resolved" | "moved"; target?: string; reference?: string }>;
  adrs?: Array<{ id: string; status: "accepted" | "rejected" }>;
  new_id?: string;
}

export interface TodoOperationInput {
  action: "add" | "update" | "resolve" | "move";
  id?: string;
  title?: string;
  severity?: "high" | "normal" | "low";
  source?: string;
  target?: string;
  trigger?: string;
  body?: string;
  reference?: string;
}

export interface AdrInput {
  id?: string;
  title: string;
  status?: "proposed" | "accepted" | "rejected" | "deprecated";
  stage?: string;
  sections: AdrSections;
  decision_makers?: string[];
  consulted?: string[];
  informed?: string[];
}

export interface AdrOperationInput extends Partial<AdrInput> {
  action: "create" | "revise" | "set_status" | "supersede" | "note";
  text?: string;
}

export interface RoundInput {
  title: string;
  goal: string;
  constraints: string[];
  non_goals: string[];
  principles: Array<{ text: string; adrs: string[] }>;
}

export interface InitInput {
  project: { name: string; description: string };
  round: RoundInput;
  adrs: AdrInput[];
  stages: StageInput[];
}

export interface RoundOpenInput {
  round: RoundInput;
  import_todos: string[];
}

export interface RoundCloseInput {
  expected: { id: string; sha256: string };
  dispositions: Array<{ id: string; disposition: "resolved" | "wontfix" | "carried"; reference?: string }>;
}

export interface OperationOptions {
  writeFile?: (path: string, content: string) => Promise<void>;
  signal?: AbortSignal;
}

interface MutationOptions extends OperationOptions {
  guard?: (model: Model) => Receipt | undefined;
  onSuccess?: () => void;
}

function guardMutation(model: Model, options: MutationOptions): Receipt | undefined {
  if (options.signal?.aborted) return { ok: false, reason: "Roadmap operation cancelled.", hints: [] };
  return options.guard?.(model);
}

export interface PreparedOperation {
  repoRoot: string;
  snapshot: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
  warnings: string[];
}

export type PreparationReceipt =
  | { ok: true; summary: string; files: PreparedOperation["files"]; warnings: string[]; prepared: PreparedOperation }
  | Extract<Receipt, { ok: false }>;

class Refusal extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

const preparedModels = new WeakMap<PreparedOperation, Model>();
const BODY_REPAIR_HINT =
  "Escape structural headings or HTML openers in body text, or put examples inside fenced code blocks; close every code fence and HTML block before retrying.";

function required(value: string | undefined, field: string, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || (!multiline && /[\r\n]/.test(value))) {
    throw new Refusal(
      `${field} must be non-empty${multiline ? "" : " and single-line"}.`,
      !multiline && typeof value === "string" && /[\r\n]/.test(value) ? [`Use single-line text for this field. ${BODY_REPAIR_HINT}`] : [],
    );
  }
  return value.replace(/\r\n/g, "\n");
}

function lines(values: string[] | undefined, field: string): string {
  if (!Array.isArray(values)) throw new Refusal(`${field} must be a list.`);
  return values.map((value) => `- ${requiredBody(value, field)}`).join("\n");
}

function normalizedFields(doc: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(doc)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? lf(value) : value]),
  );
}

function sameFields(actual: object, intended: object): boolean {
  const fields = normalizedFields(intended);
  const entries = Object.entries(normalizedFields(actual));
  return (
    entries.length === Object.keys(fields).length &&
    entries.every(([key, value]) => {
      const intendedValue = fields[key];
      return Array.isArray(value)
        ? Array.isArray(intendedValue) &&
            value.length === intendedValue.length &&
            value.every((entry, index) => entry === intendedValue[index])
        : value === intendedValue;
    })
  );
}

function bodyHeadings(body: string, pattern: RegExp, requireClosedFences = true): RegExpMatchArray[] {
  try {
    return markdownHeadings(lf(body), pattern, { requireClosedFences, topLevelOnly: true });
  } catch (error) {
    if (error instanceof DocumentError) throw new Refusal(`Body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
    throw error;
  }
}

function requiredBody(value: string | undefined, field: string): string {
  const body = required(value, field);
  // Validate the authored input before list labels turn a block opener into inline text.
  bodyHeadings(body, /^#{1,6} .+$/gm, false);
  return body;
}

function assertBody(body: string, headingLevel = 2, reservedHeadings: readonly string[] = []): void {
  if (
    bodyHeadings(body, /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/gm).some((match) => {
      const prefix = match[1] as string;
      const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      return prefix.length <= headingLevel || reservedHeadings.includes(`${prefix} ${title}`);
    })
  )
    throw new Refusal("Body changes the document structure by introducing a reserved heading.", [BODY_REPAIR_HINT]);
}

function adrBody(title: string, sections: AdrSections): string {
  for (const option of sections.options) required(option, "ADR option");
  for (const body of [sections.context, sections.drivers, ...sections.options, sections.outcome, sections.pros_cons, sections.more_info]) {
    if (body !== undefined) assertBody(body, 2, ["### Consequences", "### Confirmation"]);
  }
  for (const body of [sections.consequences, sections.confirmation]) {
    if (body !== undefined) assertBody(body, 3);
  }
  return buildAdrBody(title, sections);
}

function slug(title: string): string {
  const result = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return result || "untitled";
}

function numberOf(id: string): number {
  return Number(id.replace(/\D/g, ""));
}

function highest(model: Model, kind: IdKind): number {
  const ids =
    kind === "round"
      ? model.rounds
      : kind === "stage"
        ? model.stages
        : kind === "adr"
          ? model.adrs
          : model.todos.flatMap((doc) => doc.items);
  return Math.max(0, ...ids.map((doc) => numberOf(doc.id)));
}

function failure(error: unknown): Extract<Receipt, { ok: false }> {
  if (error instanceof Refusal) return { ok: false, reason: error.message, hints: error.hints };
  if (error instanceof DocumentError)
    return { ok: false, reason: error.message, hints: ["Run roadmap_check and repair the document structure.", BODY_REPAIR_HINT] };
  return {
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
    hints: [
      "A partial write may have left stale indexes. Run roadmap_check; use check --fix for generated blocks, or restore other damage with git.",
    ],
  };
}

function actorValid(actor: Actor, mainOnly = false): void {
  required(actor.sessionId, "sessionId");
  if (actor.kind !== "main" && actor.kind !== "sub") throw new Refusal("Unknown actor kind.");
  if (mainOnly && actor.kind !== "main") throw new Refusal("This operation requires the main session acting on a user command.");
}

function activeRound(model: Model): RoundDoc {
  const rounds = model.rounds.filter((round) => round.status === "active");
  if (rounds.length !== 1) throw new Refusal("Exactly one active round is required.", ["Use /roadmap new-round when no round is active."]);
  return rounds[0] as RoundDoc;
}

function findStage(model: Model, id: string | undefined): StageDoc {
  const matches = model.stages.filter((stage) => stage.id === required(id, "stage id"));
  if (matches.length !== 1) throw new Refusal(`Stage ${id} is missing or ambiguous.`);
  return matches[0] as StageDoc;
}

function editableStage(model: Model, id: string | undefined): StageDoc {
  const stage = findStage(model, id);
  if (stage.round !== activeRound(model).id) throw new Refusal(`${stage.id} belongs to a frozen or inactive round.`);
  return stage;
}

function findAdr(model: Model, id: string | undefined): AdrDoc {
  const matches = model.adrs.filter((adr) => adr.id === required(id, "ADR id"));
  if (matches.length !== 1) throw new Refusal(`ADR ${id} is missing or ambiguous.`);
  return matches[0] as AdrDoc;
}

function roundTodo(model: Model, round: RoundDoc): TodoDoc {
  const doc = model.todos.find((todo) => todo.round === round.id);
  if (!doc) throw new Refusal(`The TODO document for ${round.id} is missing.`);
  return doc;
}

function target(model: Model, input: { target?: string; trigger?: string }): { target?: string; trigger?: string } {
  let stageId = input.target;
  let trigger = input.trigger;
  if (stageId?.startsWith("trigger:")) {
    if (trigger !== undefined) throw new Refusal("Provide exactly one target stage or trigger.");
    trigger = stageId.slice("trigger:".length).trim();
    stageId = undefined;
  }
  if ((stageId !== undefined) === (trigger !== undefined)) throw new Refusal("Provide exactly one target stage or trigger.");
  if (trigger !== undefined) return { trigger: required(trigger, "trigger") };
  const stage = editableStage(model, stageId);
  if (stage.status !== "planned" && stage.status !== "active") throw new Refusal(`TODO target ${stage.id} is ${stage.status}.`);
  return { target: stage.id };
}

async function checked(model: Model): Promise<string[]> {
  const diagnostics = await check(model);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) {
    throw new Refusal(
      "Document check has errors; the operation was refused.",
      errors.map((error) => `${error.rule}: ${error.path}: ${error.message}`),
    );
  }
  return diagnostics.map((diagnostic) => diagnostic.message);
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

class Mutation {
  readonly changes = new Map<string, string>();
  readonly removals = new Set<string>();
  readonly warnings: string[] = [];
  handoff?: string;
  readOnly = false;

  constructor(readonly model: Model) {}

  put(path: string, content: string): void {
    const todo = this.model.todos.find((doc) => doc.path === path);
    if (todo) {
      let candidate: TodoDoc;
      try {
        candidate = parseTodo(content, path);
      } catch (error) {
        if (error instanceof DocumentError)
          throw new Refusal(`TODO body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
        throw error;
      }
      const expected = [...todo.items.filter((item) => item.status === "open"), ...todo.items.filter((item) => item.status !== "open")];
      if (
        candidate.items.length !== expected.length ||
        candidate.items.some((item, index) => !sameFields(item, expected[index] as TodoItem))
      )
        throw new Refusal("TODO body changes intended item ids, order, metadata or bodies in the document structure.", [BODY_REPAIR_HINT]);
      for (const item of todo.items) assertBody(item.body, 3);
      Object.assign(todo, candidate);
    }
    const stage = this.model.stages.find((doc) => doc.path === path);
    if (stage) {
      const candidate = parseStage(content, path);
      if (!sameFields(candidate, stage))
        throw new Refusal("Stage body changes intended metadata or sections in the document structure.", [BODY_REPAIR_HINT]);
      for (const body of [
        stage.objective,
        stage.scope_in,
        stage.scope_out,
        stage.done_criteria,
        stage.design_constraints,
        stage.risks,
        stage.amendments,
        stage.free_work_log,
        stage.outcome,
      ]) {
        if (body !== undefined) assertBody(body, 2, ["### In", "### Out"]);
      }
    }
    const round = this.model.rounds.find((doc) => doc.path === path);
    if (round) {
      if (!sameFields(parseRound(content, path), round))
        throw new Refusal("Round body changes intended metadata or sections in the document structure.", [BODY_REPAIR_HINT]);
      for (const body of [round.goal, round.constraints, round.non_goals, round.principles, round.known_limitations]) assertBody(body);
    }
    const adr = this.model.adrs.find((doc) => doc.path === path);
    if (adr && !sameFields(parseAdr(content, path), adr))
      throw new Refusal("ADR body changes intended identity or metadata in the document structure.", [BODY_REPAIR_HINT]);
    const previous = this.model.files?.[path];
    if (previous !== undefined && Buffer.from(previous).toString("utf8") === content) return;
    this.changes.set(path, content);
    this.model.files ??= {};
    this.model.files[path] = content;
  }

  remove(path: string): void {
    this.removals.add(path);
    if (this.model.files) delete this.model.files[path];
  }

  indexes(): void {
    for (const round of this.model.rounds.filter((round) => round.status === "active")) {
      round.stages = generatedBlock("stages", renderStageTable(this.model.stages.filter((stage) => stage.round === round.id)));
      this.put(round.path, renderRound(round));
    }
    this.put(this.model.index.path, renderRoadmapIndex(this.model.index, this.model.rounds, this.model.stages));
    if (this.model.adrIndex) this.put(this.model.adrIndex.path, renderAdrIndex(this.model.adrIndex, this.model.adrs));
  }

  async write(repo: Repo, summary: string, options: OperationOptions): Promise<Receipt> {
    for (const [path, content] of this.changes) await (options.writeFile ?? atomicWrite)(path, content);
    for (const path of this.removals) await rm(path);
    return {
      ok: true,
      summary,
      changedFiles: [...this.changes.keys(), ...this.removals].map((path) => relative(repo.repoRoot, path)),
      warnings: [...new Set(this.warnings)],
      ...(this.handoff ? { handoff: this.handoff } : {}),
    };
  }
}

async function mutate(
  repo: Repo,
  actor: Actor,
  change: (mutation: Mutation) => Promise<string>,
  options: MutationOptions,
): Promise<Receipt> {
  try {
    actorValid(actor);
    return await withRepoLock(repo, async () => {
      const model = await loadAll(repo);
      if (model.parseErrors?.length)
        throw new Refusal(
          "Managed documents could not be loaded.",
          model.parseErrors.map((issue) => issue.message),
        );
      const guarded = guardMutation(model, options);
      if (guarded) return guarded;
      const mutation = new Mutation(model);
      const summary = await change(mutation);
      if (!mutation.readOnly) mutation.indexes();
      mutation.warnings.push(...(await checked(model)));
      const beforeWrite = guardMutation(model, options);
      if (beforeWrite) return beforeWrite;
      const receipt = await mutation.write(repo, summary, options);
      if (receipt.ok) options.onSuccess?.();
      return receipt;
    });
  } catch (error) {
    return failure(error);
  }
}

function criteria(inputs: CriterionInput[] | undefined, reserved: string[] = []): DoneCriterion[] {
  if (!Array.isArray(inputs) || !inputs.length) throw new Refusal("At least one done criterion is required.");
  const used = new Set(reserved);
  for (const input of inputs) {
    if (input.id !== undefined) {
      if (!/^DC[1-9]\d*$/.test(input.id) || used.has(input.id)) throw new Refusal(`Invalid or reused done criterion ${input.id}.`);
      used.add(input.id);
    }
  }
  let next = Math.max(0, ...[...used].map((id) => Number(id.slice(2))));
  return inputs.map((input) => ({
    id: input.id ?? `DC${++next}`,
    statement: requiredBody(input.statement, "criterion statement"),
    verify: requiredBody(input.verify, "criterion verify method"),
  }));
}

function renderCriteria(items: DoneCriterion[]): string {
  return items.map((item) => `- ${item.id} — ${item.statement}\n  - Verify: ${item.verify}`).join("\n");
}

async function newStage(repo: Repo, model: Model, input: Partial<StageInput>): Promise<StageDoc> {
  const round = activeRound(model);
  const title = required(input.title, "stage title");
  const objective = required(input.objective, "objective", true);
  const scopeIn = lines(input.scope_in, "scope_in");
  const scopeOut = lines(input.scope_out, "scope_out");
  const doneCriteria = renderCriteria(criteria(input.done_criteria));
  const n = await allocate(repo, "stage", highest(model, "stage"));
  const stage: StageDoc = {
    format: 1,
    path: join(dirname(round.path), "stages", `${String(n).padStart(2, "0")}-${slug(title)}.md`),
    id: `S${String(n).padStart(2, "0")}`,
    title,
    round: round.id,
    status: "planned",
    depends_on: input.depends_on ?? [],
    follows: input.follows ?? null,
    created: new Date().toISOString().slice(0, 10),
    started: null,
    closed: null,
    closed_sha256: null,
    objective,
    scope_in: scopeIn,
    scope_out: scopeOut,
    done_criteria: doneCriteria,
    amendments: "",
    free_work_log: "",
    ...(input.design_constraints !== undefined ? { design_constraints: input.design_constraints } : {}),
    ...(input.risks !== undefined ? { risks: input.risks } : {}),
  };
  model.stages.push(stage);
  return stage;
}

function amend(stage: StageDoc, input: StageOperationInput): void {
  const reason = requiredBody(input.reason, "amendment reason");
  const changes = input.amendments;
  if (!changes || ![changes.add, changes.modify, changes.remove, changes.scope].some((entries) => entries?.length)) {
    throw new Refusal("An amendment needs at least one criterion or scope change.");
  }
  let current = parseDoneCriteria(stage.done_criteria);
  const log: string[] = [];
  const touched = new Set<string>();
  for (const modification of changes.modify ?? []) {
    const criterion = current.find((item) => item.id === modification.id);
    if (!criterion || touched.has(modification.id)) throw new Refusal(`Unknown or repeated criterion ${modification.id}.`);
    touched.add(modification.id);
    const old = criterion.statement;
    criterion.statement = requiredBody(modification.statement, "criterion statement");
    criterion.verify = requiredBody(modification.verify, "criterion verify method");
    log.push(`- MODIFIED ${criterion.id} — ${criterion.statement} (was: ${old}) · Verify: ${criterion.verify}`);
  }
  for (const id of changes.remove ?? []) {
    const criterion = current.find((item) => item.id === id);
    if (!criterion || touched.has(id)) throw new Refusal(`Unknown or repeated criterion ${id}.`);
    touched.add(id);
    current = current.filter((item) => item.id !== id);
    log.push(`- REMOVED ${id} — ${criterion.statement}`);
  }
  if (changes.add?.length) {
    const reserved = [...new Set([stage.done_criteria, stage.amendments].join("\n").match(/\bDC[1-9]\d*\b/g) ?? [])];
    const added = criteria(changes.add, reserved);
    current.push(...added);
    log.push(...added.map((item) => `- ADDED ${item.id} — ${item.statement} · Verify: ${item.verify}`));
  }
  if (!current.length) throw new Refusal("An active stage must retain at least one done criterion.");
  for (const scope of changes.scope ?? []) {
    const field = scope.side === "in" ? "scope_in" : scope.side === "out" ? "scope_out" : undefined;
    if (!field || (scope.op !== "add" && scope.op !== "remove")) throw new Refusal("Invalid scope amendment.");
    const item = requiredBody(scope.item, "scope item");
    const bullet = `- ${item}`;
    const entries = stage[field] ? stage[field].split("\n") : [];
    if (scope.op === "add") {
      if (entries.includes(bullet)) throw new Refusal(`Scope item already exists: ${item}.`);
      entries.push(bullet);
    } else {
      const index = entries.indexOf(bullet);
      if (index < 0) throw new Refusal(`Scope item does not exist: ${item}.`);
      entries.splice(index, 1);
    }
    stage[field] = entries.join("\n");
    log.push(`- ${scope.op === "add" ? "ADDED" : "REMOVED"} Scope/${scope.side === "in" ? "In" : "Out"}: ${item}`);
  }
  stage.done_criteria = renderCriteria(current);
  const entry = `### ${new Date().toISOString().slice(0, 10)} — ${reason}\n\n${log.join("\n")}\n- Reason: ${reason}`;
  stage.amendments = [stage.amendments, entry].filter(Boolean).join("\n\n");
}

function closeStage(mutation: Mutation, actor: Actor, stage: StageDoc, input: StageOperationInput): void {
  const model = mutation.model;
  const evidence = input.evidence ?? [];
  const current = parseDoneCriteria(stage.done_criteria);
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!current.some((criterion) => criterion.id === item.criterion) || seen.has(item.criterion)) {
      throw new Refusal(`Unknown or repeated evidence criterion ${item.criterion}.`);
    }
    seen.add(item.criterion);
    requiredBody(item.method, "evidence method");
    requiredBody(item.summary, "evidence summary");
    if (item.commit !== undefined) requiredBody(item.commit, "evidence commit");
  }
  for (const criterion of current) {
    if (!evidence.some((item) => item.criterion === criterion.id && item.result === "pass")) {
      throw new Refusal(`${criterion.id} requires passing evidence before the stage can close.`);
    }
  }
  const delivered = required(input.delivered, "delivered", true);
  assertBody(delivered, 3);
  if (input.deviations !== undefined) assertBody(input.deviations, 3);
  const todoDoc = roundTodo(model, activeRound(model));
  const pendingTodos = todoDoc.items.filter((item) => item.status === "open" && item.target === stage.id);
  const todoDispositions = input.todos ?? [];
  const pendingAdrs = model.adrs.filter((adr) => adr.stage === stage.id && adr.status === "proposed");
  if (actor.kind === "sub" && (pendingAdrs.length || input.adrs?.length)) {
    throw new Refusal("The main agent must accept or reject this stage's proposed ADRs before a subagent can close it.");
  }
  const todoLog: string[] = [];
  const disposed = new Set<string>();
  for (const disposition of todoDispositions) {
    const item = pendingTodos.find((todo) => todo.id === disposition.id);
    if (!item || disposed.has(item.id)) throw new Refusal(`Unknown or repeated pending TODO ${disposition.id}.`);
    disposed.add(item.id);
    if (disposition.disposition === "resolved") {
      item.reference = requiredBody(disposition.reference, "TODO resolution reference");
      item.status = "resolved";
      todoLog.push(`- ${item.id} resolved · ${item.reference}`);
    } else if (disposition.disposition === "moved") {
      const next = target(model, { target: disposition.target });
      if (next.target === stage.id) throw new Refusal(`${item.id} still targets the stage being closed.`);
      delete item.target;
      delete item.trigger;
      Object.assign(item, next);
      todoLog.push(`- ${item.id} moved → ${item.target ?? `trigger: ${item.trigger}`}`);
    } else throw new Refusal("Unknown TODO disposition.");
  }
  if (pendingTodos.some((item) => !disposed.has(item.id))) {
    throw new Refusal("Every open TODO targeting this stage needs a resolved or moved disposition.");
  }
  const adrLog: string[] = [];
  const adrDisposed = new Set<string>();
  for (const disposition of input.adrs ?? []) {
    const adr = pendingAdrs.find((candidate) => candidate.id === disposition.id);
    if (!adr || adrDisposed.has(adr.id)) throw new Refusal(`Unknown or repeated proposed ADR ${disposition.id}.`);
    if (disposition.status !== "accepted" && disposition.status !== "rejected")
      throw new Refusal("A proposed ADR needs accepted or rejected.");
    adrDisposed.add(adr.id);
    adr.status = disposition.status;
    mutation.put(adr.path, renderAdr(adr));
    adrLog.push(`- ${adr.id} ${adr.status}`);
  }
  if (pendingAdrs.some((adr) => !adrDisposed.has(adr.id)))
    throw new Refusal("Every proposed ADR for this stage must be accepted or rejected.");
  const removed: string[] = [];
  let amendmentDate = "";
  for (const line of stage.amendments.split("\n")) {
    const date = /^### (\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
    if (date) amendmentDate = date;
    const id = /^- REMOVED (DC[1-9]\d*) — /.exec(line)?.[1];
    if (id) removed.push(`- ${id} — removed by amendment ${amendmentDate}`);
  }
  stage.outcome = [
    `### Delivered\n\n${delivered}`,
    `### Deviations\n\n${input.deviations ?? "None."}`,
    `### Evidence\n\n${[
      ...evidence.map(
        (item) => `- ${item.criterion} — pass — Verify: ${item.method} → ${item.summary}${item.commit ? ` — commit ${item.commit}` : ""}`,
      ),
      ...removed,
    ].join("\n")}`,
    `### TODO\n\n${todoLog.join("\n") || "None."}`,
    `### ADRs\n\n${adrLog.join("\n") || "None."}`,
  ].join("\n\n");
  stage.status = "closed";
  stage.closed = new Date().toISOString().slice(0, 10);
  stage.closed_sha256 = stageSha256(stage);
  mutation.put(stage.path, renderStage(stage));
  if (pendingTodos.length) mutation.put(todoDoc.path, renderTodo(todoDoc));
}

async function renumberStage(repo: Repo, mutation: Mutation, stage: StageDoc, newId: string | undefined): Promise<void> {
  const model = mutation.model;
  const oldId = stage.id;
  const pattern = new RegExp(`\\b${oldId}\\b`, "g");
  const contains = (body: string): boolean => new RegExp(`\\b${oldId}\\b`).test(body);
  for (const round of model.rounds.filter((round) => round.status === "closed")) {
    if (Object.values(roundFiles(model, round)).some((content) => contains(Buffer.from(content).toString("utf8")))) {
      throw new Refusal(`${oldId} is referenced in frozen round ${round.id}; renumbering is refused.`);
    }
  }
  for (const other of model.stages.filter((candidate) => candidate.status === "closed" || candidate.status === "dropped")) {
    if (contains(renderStage(other))) throw new Refusal(`${oldId} is referenced by terminal stage ${other.id}; renumbering is refused.`);
  }
  if (newId !== undefined && (!/^S\d{2,}$/.test(newId) || numberOf(newId) <= highest(model, "stage"))) {
    throw new Refusal("new_id must be a fresh stage id greater than every on-disk stage id.");
  }
  const n = await allocate(repo, "stage", Math.max(highest(model, "stage"), newId ? numberOf(newId) - 1 : 0));
  const allocated = `S${String(n).padStart(2, "0")}`;
  if (newId !== undefined && allocated !== newId) {
    throw new Refusal(`The shared counter has already passed ${newId}; use ${allocated} or a higher id.`);
  }
  const oldPath = stage.path;
  stage.id = allocated;
  stage.path = join(dirname(oldPath), basename(oldPath).replace(/^\d+-/, `${String(n).padStart(2, "0")}-`));
  for (const other of model.stages.filter((candidate) => candidate.status === "planned" || candidate.status === "active")) {
    for (const field of [
      "title",
      "objective",
      "scope_in",
      "scope_out",
      "done_criteria",
      "design_constraints",
      "risks",
      "amendments",
      "free_work_log",
    ] as const) {
      if (other[field] !== undefined) other[field] = other[field]?.replace(pattern, allocated);
    }
    other.depends_on = other.depends_on.map((id) => (id === oldId ? allocated : id));
    if (other.follows === oldId) other.follows = allocated;
    mutation.put(other.path, renderStage(other));
  }
  for (const doc of model.todos.filter((todo) => todo.round === activeRound(model).id)) {
    for (const item of doc.items) {
      for (const field of ["title", "source", "target", "trigger", "reference", "carried_from", "body"] as const) {
        if (item[field] !== undefined) item[field] = item[field]?.replace(pattern, allocated);
      }
    }
    mutation.put(doc.path, renderTodo(doc));
  }
  const round = activeRound(model);
  for (const field of ["goal", "constraints", "non_goals", "principles", "known_limitations"] as const) {
    round[field] = round[field].replace(pattern, allocated);
  }
  for (const adr of model.adrs) {
    if (adr.stage === oldId) {
      adr.stage = allocated;
      mutation.put(adr.path, renderAdr(adr));
    }
  }
  mutation.remove(oldPath);
}

export async function stage(repo: Repo, actor: Actor, input: StageOperationInput, options: MutationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const model = mutation.model;
      if (input.action === "add") {
        const created = await newStage(repo, model, input);
        mutation.put(created.path, renderStage(created));
        return `Added ${created.id} — ${created.title}.`;
      }
      const current = editableStage(model, input.id);
      if (input.action === "start") {
        await checked(model);
        if (current.status !== "planned" && current.status !== "active")
          throw new Refusal(`${current.id} cannot start from ${current.status}.`);
        for (const id of current.depends_on) {
          if (findStage(model, id).status !== "closed") throw new Refusal(`Dependency ${id} must be closed before ${current.id} starts.`);
        }
        if (current.status === "active") {
          mutation.warnings.push("another session may be working on this stage");
          mutation.readOnly = true;
        } else {
          current.status = "active";
          current.started = new Date().toISOString().slice(0, 10);
          mutation.put(current.path, renderStage(current));
        }
        mutation.handoff = renderHandoff(model, current);
        return `Planning handoff for ${current.id} — ${current.title}.`;
      }
      if (input.action === "edit") {
        if (current.status !== "planned") throw new Refusal("Only planned stages can be edited; use amend for an active stage.");
        if (input.title !== undefined) current.title = required(input.title, "stage title");
        if (input.objective !== undefined) current.objective = required(input.objective, "objective", true);
        if (input.scope_in !== undefined) current.scope_in = lines(input.scope_in, "scope_in");
        if (input.scope_out !== undefined) current.scope_out = lines(input.scope_out, "scope_out");
        if (input.done_criteria !== undefined) current.done_criteria = renderCriteria(criteria(input.done_criteria));
        if (input.depends_on !== undefined) current.depends_on = input.depends_on;
        if (input.follows !== undefined) current.follows = input.follows;
        if (input.design_constraints !== undefined) current.design_constraints = input.design_constraints;
        if (input.risks !== undefined) current.risks = input.risks;
      } else if (input.action === "amend") {
        if (current.status !== "active") throw new Refusal("Only an active stage can be amended.");
        amend(current, input);
      } else if (input.action === "close") {
        if (current.status !== "active") throw new Refusal("Only an active stage can close.");
        await checked(model);
        closeStage(mutation, actor, current, input);
        return `Closed ${current.id} — ${current.title}; evidence and dispositions recorded.`;
      } else if (input.action === "drop") {
        if (current.status !== "planned" && current.status !== "active")
          throw new Refusal("Only a planned or active stage can be dropped.");
        if (model.todos.some((doc) => doc.items.some((item) => item.status === "open" && item.target === current.id))) {
          throw new Refusal("Move or resolve every open TODO targeting this stage before dropping it.");
        }
        const reason = required(input.reason, "drop reason", true);
        assertBody(reason, 3);
        current.status = "dropped";
        current.closed = new Date().toISOString().slice(0, 10);
        current.outcome = `### Delivered\n\nNot delivered; stage dropped.\n\n### Deviations\n\n${reason}`;
      } else if (input.action === "renumber") {
        if (current.status !== "planned") throw new Refusal("Only a planned stage can be renumbered.");
        await renumberStage(repo, mutation, current, input.new_id);
        return `Renumbered ${input.id} to ${current.id}; mutable references updated.`;
      } else throw new Refusal("Unknown stage action.");
      mutation.put(current.path, renderStage(current));
      return `${input.action === "edit" ? "Edited" : input.action === "amend" ? "Amended" : "Dropped"} ${current.id} — ${current.title}.`;
    },
    options,
  );
}

export async function todo(repo: Repo, actor: Actor, input: TodoOperationInput, options: OperationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const doc = roundTodo(mutation.model, activeRound(mutation.model));
      let item: TodoItem;
      if (input.action === "add") {
        const title = required(input.title, "TODO title");
        const source = required(input.source, "TODO source");
        if (!input.severity || !["high", "normal", "low"].includes(input.severity)) throw new Refusal("A TODO needs severity.");
        const nextTarget = target(mutation.model, input);
        const n = await allocate(repo, "todo", highest(mutation.model, "todo"));
        item = {
          id: `T${String(n).padStart(3, "0")}`,
          title,
          status: "open",
          severity: input.severity,
          source,
          body: input.body ?? "",
          ...nextTarget,
        };
        doc.items.push(item);
      } else {
        const existing = doc.items.find((item) => item.id === required(input.id, "TODO id"));
        if (existing?.status !== "open") throw new Refusal(`TODO ${input.id} is not open in the active round.`);
        item = existing;
        if (input.action === "resolve") {
          item.reference = requiredBody(input.reference, "TODO resolution reference");
          item.status = "resolved";
        } else if (input.action === "update" || input.action === "move") {
          if (input.action === "move" || input.target !== undefined || input.trigger !== undefined) {
            const nextTarget = target(mutation.model, input);
            delete item.target;
            delete item.trigger;
            Object.assign(item, nextTarget);
          }
          if (input.action === "update") {
            if (input.title !== undefined) item.title = required(input.title, "TODO title");
            if (input.source !== undefined) item.source = required(input.source, "TODO source");
            if (input.severity !== undefined) item.severity = input.severity;
            if (input.body !== undefined) item.body = input.body;
          }
        } else throw new Refusal("Unknown TODO action.");
      }
      mutation.put(doc.path, renderTodo(doc));
      return `TODO ${item.id}: ${input.action} recorded.`;
    },
    options,
  );
}

async function newAdr(repo: Repo, model: Model, actor: Actor, input: Partial<AdrInput>): Promise<AdrDoc> {
  const title = required(input.title, "ADR title");
  if (!input.sections) throw new Refusal("ADR sections are required.");
  required(input.sections.context, "ADR context", true);
  required(input.sections.outcome, "ADR outcome", true);
  if (!input.sections.options?.length) throw new Refusal("An ADR needs at least one considered option.");
  if (input.stage !== undefined) findStage(model, input.stage);
  const body = adrBody(title, input.sections);
  const n = await allocate(repo, "adr", highest(model, "adr"));
  const adr: AdrDoc = {
    format: 1,
    path: join(repo.adrDir, `${String(n).padStart(4, "0")}-${slug(title)}.md`),
    id: `ADR-${String(n).padStart(4, "0")}`,
    title,
    supersedes: [],
    superseded_by: null,
    stage: input.stage ?? null,
    status: actor.kind === "sub" ? "proposed" : (input.status ?? "proposed"),
    date: new Date().toISOString().slice(0, 10),
    decision_makers: input.decision_makers ?? [],
    consulted: input.consulted ?? [],
    informed: input.informed ?? [],
    body,
  };
  model.adrs.push(adr);
  return adr;
}

export async function adr(repo: Repo, actor: Actor, input: AdrOperationInput, options: OperationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      if (input.action === "create") {
        const created = await newAdr(repo, mutation.model, actor, input);
        mutation.put(created.path, renderAdr(created));
        if (actor.kind === "sub" && input.status && input.status !== "proposed")
          mutation.warnings.push("Subagent ADRs are created as proposed.");
        return `Created ${created.id} — ${created.title} (${created.status}).`;
      }
      const current = findAdr(mutation.model, input.id);
      if (input.action === "revise") {
        if (current.status !== "proposed") throw new Refusal("Only proposed ADRs can be revised; use a note or supersede an accepted ADR.");
        if (!input.sections) throw new Refusal("ADR sections are required for a whole-body revision.");
        required(input.sections.context, "ADR context", true);
        required(input.sections.outcome, "ADR outcome", true);
        if (!input.sections.options?.length) throw new Refusal("An ADR needs at least one considered option.");
        current.title = input.title === undefined ? current.title : required(input.title, "ADR title");
        current.body = adrBody(current.title, input.sections);
      } else if (input.action === "set_status") {
        if (actor.kind !== "main") throw new Refusal("Only the main agent can accept, reject or deprecate an ADR.");
        if (!input.status || !["accepted", "rejected", "deprecated"].includes(input.status))
          throw new Refusal("Use accepted, rejected or deprecated.");
        if (current.superseded_by) throw new Refusal("A superseded ADR keeps its successor link and superseded status.");
        current.status = input.status;
      } else if (input.action === "supersede") {
        if (actor.kind !== "main") throw new Refusal("Only the main agent can supersede an ADR.");
        if (current.status !== "accepted" && current.status !== "deprecated")
          throw new Refusal("Only an accepted or deprecated ADR can be superseded.");
        const successor = await newAdr(repo, mutation.model, actor, { ...input, status: "accepted" });
        successor.supersedes = [current.id];
        current.superseded_by = successor.id;
        current.status = "superseded";
        mutation.put(successor.path, renderAdr(successor));
        mutation.put(current.path, renderAdr(current));
        return `${current.id} superseded by ${successor.id} — ${successor.title}.`;
      } else if (input.action === "note") {
        const note = required(input.text, "ADR note", true);
        assertBody(note, 3);
        const information = bodyHeadings(current.body, /^## More Information$/gm);
        current.body += current.body.endsWith("\n\n") ? "" : current.body.endsWith("\n") ? "\n" : "\n\n";
        if (!information.length) current.body += "## More Information\n\n";
        current.body += `### ${new Date().toISOString().slice(0, 10)}\n\n${note}\n\n`;
      } else throw new Refusal("Unknown ADR action.");
      mutation.put(current.path, renderAdr(current));
      return `${current.id}: ${input.action} recorded.`;
    },
    options,
  );
}

async function newRound(repo: Repo, model: Model, input: RoundInput): Promise<RoundDoc> {
  const title = required(input.title, "round title");
  const goal = required(input.goal, "round goal", true);
  assertBody(goal);
  const constraints = lines(input.constraints, "constraints");
  const nonGoals = lines(input.non_goals, "non_goals");
  if (!Array.isArray(input.principles)) throw new Refusal("Round principles must be a list.");
  const principles = input.principles
    .map((principle) => {
      if (!principle.adrs?.length) throw new Refusal("Every round principle must cite at least one ADR.");
      for (const id of principle.adrs) findAdr(model, id);
      return `- ${requiredBody(principle.text, "principle")} (${principle.adrs.join(", ")}).`;
    })
    .join("\n");
  const n = await allocate(repo, "round", highest(model, "round"));
  const round: RoundDoc = {
    format: 1,
    path: join(repo.roadmapDir, `${String(n).padStart(2, "0")}-${slug(title)}`, "README.md"),
    id: `R${n}`,
    title,
    status: "active",
    opened: new Date().toISOString().slice(0, 10),
    closed: null,
    frozen_sha256: null,
    goal,
    constraints,
    non_goals: nonGoals,
    principles,
    stages: generatedBlock("stages", renderStageTable([])),
    known_limitations: "",
  };
  model.rounds.push(round);
  model.todos.push({ format: 1, path: join(dirname(round.path), "TODO.md"), round: round.id, items: [] });
  return round;
}

async function snapshot(repo: Repo): Promise<string> {
  const entries: string[] = [];
  const walk = async (path: string): Promise<void> => {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push(`${relative(repo.repoRoot, path)}\nmissing\n`);
      return;
    }
    const name = relative(repo.repoRoot, path);
    if (info.isDirectory()) {
      entries.push(`${name}\ndirectory\n`);
      for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    } else if (info.isFile()) entries.push(`${name}\n${sha256(await readFile(path))}\n`);
    else throw new Refusal(`Unsupported filesystem entry at ${name}.`);
  };
  await walk(repo.roadmapDir);
  await walk(repo.adrDir);
  return sha256(entries.join(""));
}

async function initPreflight(repo: Repo): Promise<void> {
  try {
    await lstat(repo.roadmapDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if ((await readdir(repo.adrDir)).length) throw new Refusal("docs/adr/ must be absent or empty before initialization.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  throw new Refusal("docs/roadmap/ already exists; this plugin does not adopt existing projects.");
}

async function prepare(
  repo: Repo,
  actor: Actor,
  initialize: boolean,
  build: (mutation: Mutation) => Promise<string>,
): Promise<PreparationReceipt> {
  try {
    actorValid(actor, true);
    return await withRepoLock(repo, async () => {
      if (initialize) await initPreflight(repo);
      const expected = await snapshot(repo);
      const model: Model = initialize
        ? {
            repo,
            index: { format: 1, path: join(repo.roadmapDir, "README.md"), title: "", body: "" },
            adrIndex: { format: 1, path: join(repo.adrDir, "README.md"), body: "" },
            rounds: [],
            stages: [],
            todos: [],
            adrs: [],
            files: {},
          }
        : await loadAll(repo);
      if (!initialize) await checked(model);
      const mutation = new Mutation(model);
      const summary = await build(mutation);
      mutation.indexes();
      mutation.warnings.push(...(await checked(model)));
      const prepared: PreparedOperation = {
        repoRoot: repo.repoRoot,
        snapshot: expected,
        summary,
        files: [...mutation.changes].map(([path, content]) => ({ path, content })),
        warnings: [...new Set(mutation.warnings)],
      };
      preparedModels.set(prepared, model);
      return { ok: true, summary, files: prepared.files, warnings: prepared.warnings, prepared };
    });
  } catch (error) {
    return failure(error);
  }
}

export async function prepareInit(repo: Repo, actor: Actor, input: InitInput): Promise<PreparationReceipt> {
  return prepare(repo, actor, true, async (mutation) => {
    const model = mutation.model;
    model.index.title = required(input.project.name, "project name");
    assertBody(required(input.project.description, "project description", true));
    const adrAliases: Record<string, string> = {};
    const adrStages: Array<{ adr: AdrDoc; origin?: string }> = [];
    for (const [index, original] of input.adrs.entries()) {
      const created = await newAdr(repo, model, actor, { ...original, stage: undefined, status: original.status ?? "accepted" });
      const alias = original.id ?? `ADR-${String(index + 1).padStart(4, "0")}`;
      if (adrAliases[alias]) throw new Refusal(`Repeated initial ADR alias ${alias}.`);
      adrAliases[alias] = created.id;
      adrStages.push({ adr: created, origin: original.stage });
    }
    const round = await newRound(repo, model, {
      ...input.round,
      principles: input.round.principles.map((principle) => ({ ...principle, adrs: principle.adrs.map((id) => adrAliases[id] ?? id) })),
    });
    if (!input.stages.length) throw new Refusal("Initialization needs at least one stage.");
    const stageAliases: Record<string, string> = {};
    const rewriteAdrs = (text: string): string => text.replace(/\bADR-\d{4,}\b/g, (id) => adrAliases[id] ?? id);
    for (const [index, original] of input.stages.entries()) {
      const created = await newStage(repo, model, {
        ...original,
        objective: rewriteAdrs(original.objective),
        scope_in: original.scope_in.map(rewriteAdrs),
        scope_out: original.scope_out.map(rewriteAdrs),
        done_criteria: original.done_criteria.map((criterion) => ({
          ...criterion,
          statement: rewriteAdrs(criterion.statement),
          verify: rewriteAdrs(criterion.verify),
        })),
        design_constraints: original.design_constraints === undefined ? undefined : rewriteAdrs(original.design_constraints),
        risks: original.risks === undefined ? undefined : rewriteAdrs(original.risks),
      });
      const alias = original.id ?? `S${String(index + 1).padStart(2, "0")}`;
      if (stageAliases[alias]) throw new Refusal(`Repeated initial stage alias ${alias}.`);
      stageAliases[alias] = created.id;
    }
    for (const created of model.stages) {
      created.depends_on = created.depends_on.map((id) => stageAliases[id] ?? id);
      if (created.follows) created.follows = stageAliases[created.follows] ?? created.follows;
      mutation.put(created.path, renderStage(created));
    }
    for (const { adr, origin } of adrStages) {
      if (origin) adr.stage = stageAliases[origin] ?? origin;
      mutation.put(adr.path, renderAdr(adr));
    }
    mutation.put(roundTodo(model, round).path, renderTodo(roundTodo(model, round)));
    mutation.indexes();
    const root = renderRoadmapIndex(model.index, model.rounds, model.stages);
    model.index.body = parseRoadmapIndex(root).body.replace(/^# [^\n]+\n\n/, (heading) => `${heading}${input.project.description}\n\n`);
    return `Initialized ${model.index.title} with ${round.id}, ${model.stages.length} stages and ${model.adrs.length} ADRs.`;
  });
}

export async function prepareRoundOpen(repo: Repo, actor: Actor, input: RoundOpenInput): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    const model = mutation.model;
    if (model.rounds.some((round) => round.status === "active")) throw new Refusal("Close the active round before opening another.");
    if (new Set(input.import_todos).size !== input.import_todos.length) throw new Refusal("Repeated import_todos id.");
    const sources = input.import_todos.map((id) => {
      for (const doc of model.todos) {
        const item = doc.items.find((item) => item.id === id);
        if (item && item.status === "carried" && model.rounds.some((round) => round.id === doc.round && round.status === "closed")) {
          return { item, round: doc.round };
        }
      }
      throw new Refusal(`${id} is not a carried TODO from a frozen round.`);
    });
    const round = await newRound(repo, model, input.round);
    const doc = roundTodo(model, round);
    for (const source of sources) {
      const n = await allocate(repo, "todo", highest(model, "todo"));
      const item: TodoItem = {
        ...source.item,
        id: `T${String(n).padStart(3, "0")}`,
        status: "open",
        carried_from: `${source.item.id} (${source.round})`,
        trigger: source.item.trigger ?? `When planning follow-up work for ${source.item.target ?? source.item.id}`,
      };
      delete item.target;
      delete item.reference;
      doc.items.push(item);
    }
    mutation.put(doc.path, renderTodo(doc));
    return `Opened ${round.id} — ${round.title}; imported ${sources.length} carried TODOs.`;
  });
}

export async function applyPrepared(
  repo: Repo,
  actor: Actor,
  prepared: PreparedOperation,
  options: MutationOptions = {},
): Promise<Receipt> {
  try {
    actorValid(actor, true);
    return await withRepoLock(repo, async () => {
      const model = preparedModels.get(prepared);
      if (!model || prepared.repoRoot !== repo.repoRoot) throw new Refusal("Unknown preview; prepare it again in this session.");
      const guarded = guardMutation(model, options);
      if (guarded) return guarded;
      if ((await snapshot(repo)) !== prepared.snapshot)
        throw new Refusal("The preview is stale: managed files changed after it was prepared.");
      await checked(model);
      const mutation = new Mutation(model);
      for (const file of prepared.files) mutation.changes.set(file.path, file.content);
      mutation.warnings.push(...prepared.warnings);
      const beforeWrite = guardMutation(model, options);
      if (beforeWrite) return beforeWrite;
      const result = await mutation.write(repo, prepared.summary, options);
      if (result.ok) options.onSuccess?.();
      preparedModels.delete(prepared);
      return result;
    });
  } catch (error) {
    return failure(error);
  }
}

export async function initProject(repo: Repo, actor: Actor, input: InitInput, options: OperationOptions = {}): Promise<Receipt> {
  const preview = await prepareInit(repo, actor, input);
  return preview.ok ? applyPrepared(repo, actor, preview.prepared, options) : preview;
}

export async function openRound(repo: Repo, actor: Actor, input: RoundOpenInput, options: OperationOptions = {}): Promise<Receipt> {
  const preview = await prepareRoundOpen(repo, actor, input);
  return preview.ok ? applyPrepared(repo, actor, preview.prepared, options) : preview;
}

export async function closeRound(repo: Repo, actor: Actor, input: RoundCloseInput, options: OperationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      actorValid(actor, true);
      const model = mutation.model;
      const round = model.rounds.find((candidate) => candidate.status === "active");
      if (!round || round.id !== input.expected?.id || roundSha256(roundFiles(model, round)) !== input.expected.sha256) {
        throw new Refusal("Round-close authorization is stale.", ["Run /roadmap close-round again to review the current round and TODOs."]);
      }
      await checked(model);
      if (model.stages.some((stage) => stage.round === round.id && stage.status !== "closed" && stage.status !== "dropped")) {
        throw new Refusal("Every stage must be closed or dropped before the round can close.");
      }
      const doc = roundTodo(model, round);
      const open = doc.items.filter((item) => item.status === "open");
      const seen = new Set<string>();
      for (const disposition of input.dispositions) {
        const item = open.find((item) => item.id === disposition.id);
        if (!item || seen.has(item.id)) throw new Refusal(`Unknown or repeated open TODO ${disposition.id}.`);
        seen.add(item.id);
        if (!["resolved", "wontfix", "carried"].includes(disposition.disposition)) throw new Refusal("Unknown round TODO disposition.");
        if (disposition.reference !== undefined) assertBody(disposition.reference, 3);
        item.status = disposition.disposition;
        item.reference =
          disposition.disposition === "resolved"
            ? required(disposition.reference, "TODO resolution reference")
            : (disposition.reference ?? (disposition.disposition === "wontfix" ? "Known limitations" : "Next round"));
        if (disposition.disposition === "wontfix") {
          const limitation = `### ${item.id} — ${item.title}\n\nSource: ${item.source}\n${
            disposition.reference ? `\n${disposition.reference}\n` : ""
          }${item.body ? `\n${item.body}` : ""}`;
          round.known_limitations = [round.known_limitations, limitation].filter(Boolean).join("\n\n");
        }
      }
      if (open.some((item) => !seen.has(item.id))) throw new Refusal("Every open TODO needs a round-close disposition.");
      mutation.put(doc.path, renderTodo(doc));
      round.stages = generatedBlock("stages", renderStageTable(model.stages.filter((stage) => stage.round === round.id)));
      round.status = "closed";
      round.closed = new Date().toISOString().slice(0, 10);
      mutation.put(round.path, renderRound(round));
      round.frozen_sha256 = roundSha256(roundFiles(model, round));
      mutation.put(round.path, renderRound(round));
      return `Closed and froze ${round.id} — ${round.title}. ADR management remains available.`;
    },
    options,
  );
}

export async function recordFreeWork(
  repo: Repo,
  actor: Actor,
  input: { stage: string; intent: string },
  options: MutationOptions = {},
): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const current = editableStage(mutation.model, input.stage);
      if (current.status !== "planned" && current.status !== "active")
        throw new Refusal("Free work can only be recorded on an unclosed stage.");
      const intent = required(input.intent, "free-work intent", true).replace(/\s+/g, " ").trim();
      const entry = `- ${new Date().toISOString().slice(0, 10)} · session ${actor.sessionId} · ${JSON.stringify(intent)}`;
      current.free_work_log = [current.free_work_log, entry].filter(Boolean).join("\n");
      mutation.put(current.path, renderStage(current));
      return `Recorded free work for ${current.id}.`;
    },
    options,
  );
}
