import { join } from "node:path";

import { diagnostics } from "#src/check.ts";
import {
  type AdrDoc,
  type AdrModel,
  type AdrRepo,
  type AdrSections,
  type AdrStatus,
  adrRepo,
  buildAdrBody,
  DocumentError,
  dirState,
  loadModel,
  markdownHeadings,
  parseAdr,
  parseIndex,
  renderAdr,
  renderIndex,
  repoPath,
  today,
  validateBody,
  validId,
} from "#src/documents.ts";
import { allocatedAdrs, atomicWrite, Cancelled, recordAllocated, withAdrLock } from "#src/store.ts";

export type AdrActor = "main" | "sub";
export type StageResolver = (repoRoot: string, stageId: string) => Promise<string | undefined>;

export interface CreateInput {
  title: string;
  sections: AdrSections;
  status?: Exclude<AdrStatus, "superseded">;
  stage?: string;
  decision_makers?: string[];
  consulted?: string[];
  informed?: string[];
}

export interface WriteOptions {
  signal?: AbortSignal;
  /** Return the would-be files and provisional ids without writing files or consuming counters. */
  dryRun?: boolean;
  /** Main only: lets createMany write the marker into an absent or empty docs/adr in the same locked batch. */
  initialize?: boolean;
  /** The session's registered stage resolver; stage links are refused without one. */
  resolver?: StageResolver;
}

export interface WriteResult {
  /** Repository-relative paths, ADR files first and the index last. */
  files: Array<{ path: string; content: string }>;
  ids: string[];
  warnings: string[];
}

export class Refusal extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export const BODY_REPAIR_HINT =
  "Use plain paragraphs or flat lists with plain-text items. Keep inline code on one line; put literal Markdown or HTML inside a fully closed top-level fenced code block. Use spaces, not tabs, outside fences; single-line fields accept only plain text and same-line code spans.";
export const INIT_HINT = "Ask the user to run /adr init; agents cannot initialize ADR management.";

function required(value: string | undefined, field: string, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || (!multiline && /[\r\n]/.test(value))) {
    throw new Refusal(
      `${field} must be non-empty${multiline ? "" : " and single-line"}.`,
      !multiline && typeof value === "string" && /[\r\n]/.test(value) ? [`Use single-line text for this field. ${BODY_REPAIR_HINT}`] : [],
    );
  }
  return value.replace(/\r\n/g, "\n");
}

function assertBody(body: string, options: Parameters<typeof validateBody>[1] = {}): void {
  try {
    validateBody(body, options);
  } catch (error) {
    if (error instanceof DocumentError) throw new Refusal(`Body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
    throw error;
  }
}

function adrBody(title: string, sections: AdrSections | undefined): string {
  if (!sections) throw new Refusal("ADR sections are required.");
  required(sections.context, "ADR context", true);
  required(sections.outcome, "ADR outcome", true);
  if (!Array.isArray(sections.options) || !sections.options.length) throw new Refusal("An ADR needs at least one considered option.");
  for (const option of sections.options) assertBody(required(option, "ADR option"), { inlineOnly: true });
  for (const body of [
    sections.context,
    sections.drivers,
    sections.outcome,
    sections.consequences,
    sections.confirmation,
    sections.pros_cons,
    sections.more_info,
  ]) {
    if (body !== undefined) assertBody(body);
  }
  return buildAdrBody(title, sections);
}

function participants(values: string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Refusal(`${field} must be a list.`);
  return values.map((value) => required(value, field));
}

function slug(title: string): string {
  const result = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return result || "untitled";
}

function assertActor(actor: AdrActor, mainOnly?: string): void {
  if (actor !== "main" && actor !== "sub") throw new Refusal("Unknown actor; use main or sub.");
  if (mainOnly && actor !== "main") throw new Refusal(mainOnly);
}

function stageId(value: string, field = "stage"): string {
  if (typeof value !== "string" || !validId(value, "stage")) throw new Refusal(`${field} must be a stage id such as S01.`);
  return value;
}

/** Runs before the ADR lock is taken, so a resolver never waits on it. */
async function resolveStage(repoRoot: string, stage: string, resolver: StageResolver | undefined): Promise<void> {
  if (!resolver)
    throw new Refusal("Stage links need the roadmap plugin: no stage resolver is registered in this session.", [
      "Omit stage, or install and enable the roadmap plugin: omp plugin install roadmap@wows-omp-plugins.",
    ]);
  const reason = await resolver(repoRoot, stageId(stage));
  if (reason !== undefined) throw new Refusal(`Stage ${stage} cannot be linked: ${reason}`);
}

function notInitialized(state: string): Refusal {
  return state === "unmanaged"
    ? new Refusal("docs/adr/ is not empty and is not managed by the adr plugin; this plugin does not adopt existing directories.", [
        "Move the existing files out of docs/adr/ or ask the user how to proceed.",
      ])
    : new Refusal("ADR management is not initialized in this repository.", [INIT_HINT]);
}

function find(model: AdrModel, id: string | undefined): AdrDoc {
  const matches = model.adrs.filter((doc) => doc.id === required(id, "ADR id"));
  if (matches.length !== 1) throw new Refusal(`ADR ${id} is missing or ambiguous.`, ["Call adr_status for ADR ids."]);
  return matches[0] as AdrDoc;
}

/** The files one locked operation writes: changed ADRs first, the regenerated index last. */
class Batch {
  readonly changes = new Map<string, string>();
  readonly ids: string[] = [];
  readonly warnings: string[] = [];
  #allocated?: number;
  #highest = 0;

  constructor(readonly model: AdrModel) {}

  /** Next id above the stored counters, the legacy roadmap counter and every id on disk or in this batch. */
  async allocate(): Promise<string> {
    this.#allocated ??= await allocatedAdrs(this.model.repo.commonDir);
    const onDisk = Math.max(0, ...this.model.adrs.map((doc) => Number(doc.id.slice(4))));
    const next = Math.max(this.#allocated, onDisk) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("ADR id counter exhausted.");
    this.#allocated = next;
    this.#highest = next;
    return `ADR-${String(next).padStart(4, "0")}`;
  }

  get highestAllocated(): number {
    return this.#highest;
  }

  /** Renders `doc` in this plugin's format and refuses bodies whose rendering would change its identity. */
  put(doc: AdrDoc): void {
    const content = renderAdr(doc);
    let parsed: AdrDoc;
    try {
      parsed = parseAdr(content, doc.path);
    } catch (error) {
      if (error instanceof DocumentError)
        throw new Refusal(`ADR body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
      throw error;
    }
    const identity = (value: AdrDoc) =>
      JSON.stringify([
        value.id,
        value.title,
        value.status,
        value.date,
        value.stage ?? null,
        value.supersedes,
        value.superseded_by ?? null,
        value.decision_makers,
        value.consulted,
        value.informed,
        value.body,
      ]);
    if (identity(parsed) !== identity(doc))
      throw new Refusal("ADR body changes intended identity or metadata in the document structure.", [BODY_REPAIR_HINT]);
    doc.legacy = false;
    doc.format = parsed.format;
    if (this.model.files[doc.path] === content) return;
    this.changes.set(doc.path, content);
    if (!this.ids.includes(doc.id)) this.ids.push(doc.id);
  }

  index(): void {
    const path = this.model.index?.path ?? join(this.model.repo.adrDir, "README.md");
    const content = renderIndex(this.model.index, this.model.adrs);
    try {
      parseIndex(content, path);
    } catch (error) {
      if (error instanceof DocumentError) throw new Refusal(`The ADR index cannot be regenerated: ${error.message}`, ["Run adr_check."]);
      throw error;
    }
    if (this.model.files[path] !== content) this.changes.set(path, content);
  }
}

/**
 * Loads under the ADR lock, applies `change`, regenerates the index whenever an ADR changed (converting a legacy index)
 * and writes each file atomically. Parse errors refuse every write; check results become warnings.
 */
async function mutate(
  path: string,
  change: (batch: Batch) => Promise<void> | void,
  options: WriteOptions,
  initialize = false,
): Promise<WriteResult> {
  const repo: AdrRepo = adrRepo(path);
  return withAdrLock(repo.commonDir, async () => {
    if (options.signal?.aborted) throw new Cancelled();
    const state = await dirState(repo.adrDir);
    let model: AdrModel;
    if (state === "managed") {
      model = await loadModel(repo);
      if (model.parseErrors.length)
        throw new Refusal("Managed ADR documents could not be loaded.", [
          ...model.parseErrors.map((issue) => `${repoPath(repo, issue.path)}: ${issue.message}`),
          "Repair them in an editor or restore them with git, then run adr_check.",
        ]);
    } else if (initialize && state !== "unmanaged") model = { repo, adrs: [], files: {}, parseErrors: [] };
    else throw notInitialized(state);
    const batch = new Batch(model);
    await change(batch);
    if (batch.changes.size || !model.index) batch.index();
    for (const issue of diagnostics(model)) if (issue.rule !== "generated") batch.warnings.push(`${issue.path}: ${issue.message}`);
    const result: WriteResult = {
      files: [...batch.changes].map(([file, content]) => ({ path: repoPath(repo, file), content })),
      ids: batch.ids,
      warnings: [...new Set(batch.warnings)],
    };
    if (options.dryRun) return result;
    if (options.signal?.aborted) throw new Cancelled();
    if (batch.highestAllocated) await recordAllocated(repo.commonDir, batch.highestAllocated);
    const written: string[] = [];
    try {
      for (const [file, content] of batch.changes) {
        await atomicWrite(file, content, options.signal);
        written.push(repoPath(repo, file));
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      throw new Refusal(
        "ADR operation cancelled.",
        written.length
          ? [
              `Files committed by the interrupted operation: ${written.join(", ")}.`,
              "Run adr_check with fix: true to regenerate the index; restore other partial changes with git, then run adr_check again.",
            ]
          : [],
      );
    }
    return result;
  });
}

function prepareCreate(actor: AdrActor, input: CreateInput, warnings: string[]): Omit<AdrDoc, "path" | "id"> {
  const title = required(input.title, "ADR title");
  const body = adrBody(title, input.sections);
  if (input.status !== undefined && !["proposed", "accepted", "rejected", "deprecated"].includes(input.status))
    throw new Refusal("A new ADR is proposed, accepted, rejected or deprecated.");
  if (actor === "sub" && input.status && input.status !== "proposed") warnings.push("Subagent ADRs are created as proposed.");
  return {
    legacy: false,
    format: 1,
    title,
    status: actor === "sub" ? "proposed" : (input.status ?? "proposed"),
    date: today(),
    ...(input.stage !== undefined ? { stage: stageId(input.stage) } : {}),
    supersedes: [],
    decision_makers: participants(input.decision_makers, "decision-makers"),
    consulted: participants(input.consulted, "consulted"),
    informed: participants(input.informed, "informed"),
    body,
  };
}

async function place(batch: Batch, draft: Omit<AdrDoc, "path" | "id">): Promise<AdrDoc> {
  const id = await batch.allocate();
  const doc: AdrDoc = { ...draft, id, path: join(batch.model.repo.adrDir, `${id.slice(4)}-${slug(draft.title)}.md`) };
  batch.model.adrs.push(doc);
  batch.put(doc);
  return doc;
}

/** Creates ADRs in one locked batch with sequential ids; `initialize` (main only) also writes the marker when needed. */
export async function createMany(path: string, actor: AdrActor, inputs: CreateInput[], options: WriteOptions = {}): Promise<WriteResult> {
  assertActor(actor, options.initialize ? "Only the main session can initialize ADR management." : undefined);
  if (!Array.isArray(inputs) || (!inputs.length && !options.initialize)) throw new Refusal("Supply at least one ADR to create.");
  const warnings: string[] = [];
  const drafts = inputs.map((input) => prepareCreate(actor, input, warnings));
  const root = adrRepo(path).repoRoot;
  for (const draft of drafts) if (draft.stage) await resolveStage(root, draft.stage, options.resolver);
  return mutate(
    root,
    async (batch) => {
      batch.warnings.push(...warnings);
      for (const draft of drafts) await place(batch, draft);
    },
    options,
    options.initialize === true,
  );
}

/** Main only. Refuses an unmanaged docs/adr; an already managed one is a no-op. */
export async function initialize(path: string, actor: AdrActor, options: WriteOptions = {}): Promise<WriteResult> {
  assertActor(actor, "Only the main session can initialize ADR management.");
  const repo = adrRepo(path);
  const state = await dirState(repo.adrDir);
  if (state === "managed") return { files: [], ids: [], warnings: ["ADR management is already initialized in this repository."] };
  if (state === "unmanaged") throw notInitialized(state);
  return mutate(repo.repoRoot, () => {}, options, true);
}

export async function revise(
  path: string,
  actor: AdrActor,
  input: { id: string; title?: string; sections: AdrSections },
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor);
  return mutate(
    path,
    (batch) => {
      const current = find(batch.model, input.id);
      if (current.status !== "proposed") throw new Refusal("Only proposed ADRs can be revised; use a note or supersede an accepted ADR.");
      const title = input.title === undefined ? current.title : required(input.title, "ADR title");
      current.body = adrBody(title, input.sections);
      current.title = title;
      batch.put(current);
    },
    options,
  );
}

export async function setStatus(
  path: string,
  actor: AdrActor,
  id: string,
  status: AdrStatus | undefined,
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor, "Only the main agent can accept, reject or deprecate an ADR.");
  if (status !== "accepted" && status !== "rejected" && status !== "deprecated") throw new Refusal("Use accepted, rejected or deprecated.");
  return mutate(
    path,
    (batch) => {
      const current = find(batch.model, id);
      if (current.superseded_by || current.status === "superseded")
        throw new Refusal("A superseded ADR keeps its successor link and superseded status.");
      if (current.status === status) batch.warnings.push(`${current.id} is already ${status}.`);
      current.status = status;
      batch.put(current);
    },
    options,
  );
}

/** Main only: an accepted or deprecated ADR gets a new accepted successor with reciprocal links. */
export async function supersede(
  path: string,
  actor: AdrActor,
  id: string,
  input: CreateInput,
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor, "Only the main agent can supersede an ADR.");
  const warnings: string[] = [];
  if (input.status !== undefined && input.status !== "accepted") warnings.push("A successor ADR is created as accepted.");
  const draft = prepareCreate(actor, { ...input, status: "accepted" }, warnings);
  const root = adrRepo(path).repoRoot;
  if (draft.stage) await resolveStage(root, draft.stage, options.resolver);
  return mutate(
    root,
    async (batch) => {
      batch.warnings.push(...warnings);
      const current = find(batch.model, id);
      if (current.status !== "accepted" && current.status !== "deprecated")
        throw new Refusal("Only an accepted or deprecated ADR can be superseded.");
      const successor = await place(batch, { ...draft, supersedes: [current.id] });
      current.superseded_by = successor.id;
      current.status = "superseded";
      batch.put(current);
    },
    options,
  );
}

/** Appends a dated `### YYYY-MM-DD` note under More Information, adding that section when missing. */
export async function note(
  path: string,
  actor: AdrActor,
  id: string,
  text: string | undefined,
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor);
  const body = required(text, "ADR note", true);
  assertBody(body);
  return mutate(
    path,
    (batch) => {
      const current = find(batch.model, id);
      const information = markdownHeadings(current.body, /^## More Information$/gm);
      current.body += current.body.endsWith("\n\n") ? "" : current.body.endsWith("\n") ? "\n" : "\n\n";
      if (!information.length) current.body += "## More Information\n\n";
      current.body += `### ${today()}\n\n${body}\n\n`;
      batch.put(current);
    },
    options,
  );
}

/** Sets or clears one ADR's stage link; setting one needs the registered resolver to accept the stage. */
export async function link(
  path: string,
  actor: AdrActor,
  id: string,
  stage: string | undefined,
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor);
  const root = adrRepo(path).repoRoot;
  if (stage !== undefined) await resolveStage(root, stage, options.resolver);
  return mutate(
    root,
    (batch) => {
      const current = find(batch.model, id);
      if (current.stage === stage) return;
      current.stage = stage;
      batch.put(current);
    },
    options,
  );
}

/**
 * Rewrites every `stage: from` to `to` for a stage renumbering. It needs a registered resolver like any stage write, but does
 * not ask it about `to`: the caller owns the rename and may not have written the renamed stage yet.
 */
export async function relinkStage(
  path: string,
  actor: AdrActor,
  from: string,
  to: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  assertActor(actor);
  stageId(from, "from");
  stageId(to, "to");
  if (!options.resolver)
    throw new Refusal("Stage links need the roadmap plugin: no stage resolver is registered in this session.", [
      "Install and enable the roadmap plugin: omp plugin install roadmap@wows-omp-plugins.",
    ]);
  return mutate(
    path,
    (batch) => {
      for (const doc of batch.model.adrs) {
        if (doc.stage !== from) continue;
        doc.stage = to;
        batch.put(doc);
      }
    },
    options,
  );
}

export interface ManageInput {
  action: "create" | "revise" | "set_status" | "supersede" | "note";
  id?: string;
  title?: string;
  status?: "proposed" | "accepted" | "rejected" | "deprecated";
  stage?: string;
  sections?: AdrSections;
  decision_makers?: string[];
  consulted?: string[];
  informed?: string[];
  text?: string;
}

/** The `adr_manage` tool: one action per call, with the tool's argument rules. */
export async function manage(path: string, actor: AdrActor, input: ManageInput, options: WriteOptions = {}): Promise<WriteResult> {
  if (input.stage !== undefined && input.action !== "create" && input.action !== "supersede")
    throw new Refusal("stage applies only to create and supersede.");
  const created = (): CreateInput => ({
    title: input.title as string,
    sections: input.sections as AdrSections,
    status: input.status,
    stage: input.stage,
    decision_makers: input.decision_makers,
    consulted: input.consulted,
    informed: input.informed,
  });
  switch (input.action) {
    case "create":
      return createMany(path, actor, [created()], options);
    case "revise":
      return revise(
        path,
        actor,
        { id: required(input.id, "ADR id"), title: input.title, sections: input.sections as AdrSections },
        options,
      );
    case "set_status":
      return setStatus(path, actor, required(input.id, "ADR id"), input.status, options);
    case "supersede":
      return supersede(path, actor, required(input.id, "ADR id"), created(), options);
    case "note":
      return note(path, actor, required(input.id, "ADR id"), input.text, options);
    default:
      throw new Refusal("Unknown ADR action; use create, revise, set_status, supersede or note.");
  }
}
