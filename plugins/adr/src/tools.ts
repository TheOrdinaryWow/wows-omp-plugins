import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { checkCard, manageCard, statusCard } from "#src/cards.ts";
import { check, type Diagnostic } from "#src/check.ts";
import {
  type AdrDoc,
  type AdrModel,
  type AdrRepo,
  type AdrStatus,
  adrRepo,
  DocumentError,
  dirState,
  loadModel,
  ordered,
  repoPath,
  STATUSES,
} from "#src/documents.ts";
import { BODY_REPAIR_HINT, INIT_HINT, manage, Refusal, type StageResolver, type WriteResult } from "#src/operations.ts";
import { Cancelled } from "#src/store.ts";
import { statusCounts } from "#src/ui.ts";

export interface AdrListEntry {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  stage?: string;
  superseded_by?: string;
}

/** One ADR's metadata as `adr_status` reports it; `path` is repository-relative. */
export interface AdrDetail extends AdrListEntry {
  path: string;
  legacy: boolean;
  supersedes: string[];
  /** The supersession chain in both directions, oldest first; empty when the ADR stands alone. */
  chain: Array<{ id: string; status: AdrStatus }>;
  decision_makers: string[];
  consulted: string[];
  informed: string[];
  body: string;
}

/** Structured payload of a receipt for native views; the text the agent reads never depends on it. */
export type ReceiptView =
  | { kind: "list"; status?: AdrStatus; adrs: AdrListEntry[]; counts: Partial<Record<AdrStatus, number>>; legacy: number }
  | { kind: "adr"; adr: AdrDetail }
  | { kind: "check"; diagnostics: Diagnostic[] }
  | { kind: "write"; ids: string[] };

export type Receipt =
  | { ok: true; summary: string; changedFiles: string[]; warnings: string[]; view?: ReceiptView }
  | { ok: false; reason: string; hints: string[]; view?: ReceiptView };

/**
 * The service contract reports this path and every adr_* tool declares it: the host otherwise records the unresolved
 * node_modules symlink, while `import.meta.url` is the cached copy's realpath.
 */
export const TOOL_SOURCE_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

export function toolResult(receipt: Receipt) {
  const text = receipt.ok
    ? [
        receipt.summary,
        ...receipt.warnings.map((warning) => `Warning: ${warning}`),
        receipt.changedFiles.length
          ? `Changed: ${receipt.changedFiles.join(", ")}. Commit these files per the project's rules.`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n")
    : [receipt.reason, ...receipt.hints].join("\n");
  return { content: [{ type: "text" as const, text }], details: receipt, isError: !receipt.ok };
}

export function failure(error: unknown): Extract<Receipt, { ok: false }> {
  if (error instanceof Refusal) return { ok: false, reason: error.message, hints: error.hints };
  if (error instanceof Cancelled) return { ok: false, reason: error.message, hints: [] };
  if (error instanceof DocumentError)
    return {
      ok: false,
      reason: error.message,
      hints: ["Repair the managed file in an editor or restore it with git, then run adr_check.", BODY_REPAIR_HINT],
    };
  return {
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
    hints: ["A partial write may have left a stale index. Run adr_check; use fix: true for the index, or restore other damage with git."],
  };
}

export function written(summary: string, result: WriteResult): Receipt {
  return {
    ok: true,
    summary,
    changedFiles: result.files.map((file) => file.path),
    warnings: result.warnings,
    view: { kind: "write", ids: result.ids },
  };
}

/**
 * Agents never initialize: an absent, empty or unmanaged docs/adr refuses. The agent is told to ask the user for /adr init;
 * a user running /adr gets the command itself in the message.
 */
export async function requireInitialized(cwd: string, audience: "agent" | "user" = "agent"): Promise<AdrRepo> {
  const repo = adrRepo(cwd);
  const state = await dirState(repo.adrDir);
  if (state === "managed") return repo;
  if (state === "unmanaged")
    throw new Refusal(
      "docs/adr/ exists but is not managed by the adr plugin; the plugin does not adopt existing directories.",
      audience === "agent" ? ["Ask the user how to proceed."] : [],
    );
  if (audience === "user") throw new Refusal("ADR management is not initialized in this repository. Run /adr init first.");
  throw new Refusal("ADR management is not initialized in this repository.", [INIT_HINT]);
}

function entry(doc: AdrDoc): AdrListEntry {
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    date: doc.date,
    ...(doc.stage ? { stage: doc.stage } : {}),
    ...(doc.superseded_by ? { superseded_by: doc.superseded_by } : {}),
  };
}

function line(doc: AdrListEntry): string {
  const extra = [doc.stage ? `stage ${doc.stage}` : "", doc.superseded_by ? `superseded by ${doc.superseded_by}` : ""].filter(Boolean);
  return `- ${doc.id} [${doc.status}] ${doc.title} (${doc.date})${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
}

function listView(model: AdrModel, status?: AdrStatus): Extract<ReceiptView, { kind: "list" }> {
  const counts: Partial<Record<AdrStatus, number>> = {};
  for (const doc of model.adrs) counts[doc.status] = (counts[doc.status] ?? 0) + 1;
  return {
    kind: "list",
    ...(status ? { status } : {}),
    adrs: ordered(model.adrs.filter((doc) => !status || doc.status === status)).map(entry),
    counts,
    legacy: model.adrs.filter((doc) => doc.legacy).length + (model.index?.legacy ? 1 : 0),
  };
}

function listText(model: AdrModel, view: Extract<ReceiptView, { kind: "list" }>): string {
  const { legacy, status } = view;
  return [
    `ADRs: ${statusCounts(model.adrs)}.`,
    ...(legacy
      ? [`${legacy} file${legacy === 1 ? " is" : "s are"} still in the legacy roadmap format; the next write of each converts it.`]
      : []),
    status ? `${status[0]?.toUpperCase()}${status.slice(1)}:` : "All:",
    ...(view.adrs.length ? view.adrs.map(line) : ["- none"]),
  ].join("\n");
}

/** Metadata and the supersession chain in both directions. */
function adrDetail(model: AdrModel, doc: AdrDoc): AdrDetail {
  const byId = new Map(model.adrs.map((candidate) => [candidate.id, candidate]));
  const chain = [doc];
  const seen = new Set([doc.id]);
  for (let current = doc.supersedes.length === 1 ? byId.get(doc.supersedes[0] as string) : undefined; current && !seen.has(current.id); ) {
    chain.unshift(current);
    seen.add(current.id);
    current = current.supersedes.length === 1 ? byId.get(current.supersedes[0] as string) : undefined;
  }
  for (let current = doc.superseded_by ? byId.get(doc.superseded_by) : undefined; current && !seen.has(current.id); ) {
    chain.push(current);
    seen.add(current.id);
    current = current.superseded_by ? byId.get(current.superseded_by) : undefined;
  }
  return {
    ...entry(doc),
    path: repoPath(model.repo, doc.path),
    legacy: doc.legacy,
    supersedes: doc.supersedes,
    chain: chain.length > 1 ? chain.map((link) => ({ id: link.id, status: link.status })) : [],
    decision_makers: doc.decision_makers,
    consulted: doc.consulted,
    informed: doc.informed,
    body: doc.body,
  };
}

/** Metadata, the supersession chain in both directions, then the stored MADR body. */
export function detailText(model: AdrModel, doc: AdrDoc): string {
  return adrText(adrDetail(model, doc));
}

function adrText(adr: AdrDetail): string {
  const meta = [
    `${adr.id} — ${adr.title}`,
    `Status: ${adr.status}; date ${adr.date}${adr.stage ? `; stage ${adr.stage}` : ""}`,
    `File: ${adr.path}${adr.legacy ? " (legacy roadmap format; the next write converts it)" : ""}`,
    ...(adr.supersedes.length ? [`Supersedes: ${adr.supersedes.join(", ")}`] : []),
    ...(adr.superseded_by ? [`Superseded by: ${adr.superseded_by}`] : []),
    ...(adr.chain.length ? [`Supersession chain: ${adr.chain.map((link) => `${link.id} (${link.status})`).join(" → ")}`] : []),
    ...(adr.decision_makers.length ? [`Decision-makers: ${adr.decision_makers.join("; ")}`] : []),
    ...(adr.consulted.length ? [`Consulted: ${adr.consulted.join("; ")}`] : []),
    ...(adr.informed.length ? [`Informed: ${adr.informed.join("; ")}`] : []),
  ];
  return `${meta.join("\n")}\n\n${adr.body}`;
}

export async function statusReceipt(repo: AdrRepo, input: { id?: string; status?: string } = {}): Promise<Receipt> {
  const model = await loadModel(repo);
  const warnings = model.parseErrors.map((issue) => `${repoPath(repo, issue.path)}: ${issue.message}`);
  if (input.status !== undefined && !STATUSES.includes(input.status as AdrStatus))
    return { ok: false, reason: `Unknown status ${input.status}; use ${STATUSES.join(", ")}.`, hints: [] };
  if (input.id !== undefined) {
    const matches = model.adrs.filter((doc) => doc.id === input.id);
    if (matches.length !== 1)
      return {
        ok: false,
        reason: `ADR ${input.id} is ${matches.length ? "ambiguous" : "unknown"}.`,
        hints: ["Call adr_status for ADR ids."],
      };
    const adr = adrDetail(model, matches[0] as AdrDoc);
    return { ok: true, summary: adrText(adr), changedFiles: [], warnings, view: { kind: "adr", adr } };
  }
  const view = listView(model, input.status as AdrStatus | undefined);
  return { ok: true, summary: listText(model, view), changedFiles: [], warnings, view };
}

export async function checkReceipt(repo: AdrRepo, fix = false, signal?: AbortSignal): Promise<Receipt> {
  const changedFiles: string[] = [];
  let found: Diagnostic[];
  try {
    found = await check(repo, { fix, signal, changedFiles });
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    return {
      ok: false,
      reason: error.message,
      hints: [
        changedFiles.length ? `Files committed by the interrupted fix: ${changedFiles.join(", ")}.` : "No files were committed.",
        "Run adr_check with fix: true again to regenerate the index.",
      ],
    };
  }
  const lines = found.map((item) => `${item.severity}: ${item.rule} — ${item.path}: ${item.message}`);
  const view: ReceiptView = { kind: "check", diagnostics: found };
  if (found.some((item) => item.severity === "error")) {
    return {
      ok: false,
      reason: lines.join("\n"),
      hints: [
        "Check verifies ADR consistency, not whether code follows the decisions.",
        ...(changedFiles.length ? [`Regenerated: ${changedFiles.join(", ")}. Commit these files per the project's rules.`] : []),
      ],
      view,
    };
  }
  return {
    ok: true,
    summary: `${changedFiles.length ? "Regenerated the ADR index. " : ""}ADR check passed. Check verifies ADR consistency, not whether code follows the decisions.`,
    changedFiles,
    warnings: lines,
    view,
  };
}

export function registerTools(pi: ExtensionAPI, changed: (ctx: ExtensionContext) => void, resolver: () => StageResolver | undefined): void {
  const z = pi.zod;
  const sections = z.object({
    context: z.string(),
    drivers: z.string().optional(),
    options: z.array(z.string()),
    outcome: z.string(),
    consequences: z.string().optional(),
    confirmation: z.string().optional(),
    pros_cons: z.string().optional(),
    more_info: z.string().optional(),
  });
  const statusParameters = z.object({ id: z.string().optional(), status: z.enum(STATUSES).optional() });
  const manageParameters = z.object({
    action: z.enum(["create", "revise", "set_status", "supersede", "note", "link"]),
    id: z.string().optional(),
    title: z.string().optional(),
    status: z.enum(["proposed", "accepted", "rejected", "deprecated"]).optional(),
    stage: z.string().optional(),
    sections: sections.optional(),
    decision_makers: z.array(z.string()).optional(),
    consulted: z.array(z.string()).optional(),
    informed: z.array(z.string()).optional(),
    text: z.string().optional(),
  });
  const checkParameters = z.object({ fix: z.boolean().optional() });

  async function run(ctx: ExtensionContext, operation: (repo: AdrRepo) => Promise<Receipt>) {
    try {
      return toolResult(await operation(await requireInitialized(ctx.cwd)));
    } catch (error) {
      return toolResult(failure(error));
    } finally {
      changed(ctx);
    }
  }

  pi.registerTool({
    name: "adr_status",
    sourcePath: TOOL_SOURCE_PATH,
    label: "ADR status",
    description:
      "List architecture decision records with an optional status filter, or read one ADR's full text and supersession chain by id.",
    parameters: statusParameters,
    approval: "read",
    ...statusCard,
    async execute(_id, params: typeof statusParameters.infer, _signal, _onUpdate, ctx) {
      return run(ctx, (repo) => statusReceipt(repo, params));
    },
  });
  pi.registerTool({
    name: "adr_manage",
    sourcePath: TOOL_SOURCE_PATH,
    label: "ADR manage",
    description:
      "Create MADR decisions, revise proposed ADRs, set status, supersede, append a dated note or link a stage. link requires id; stage sets or changes the link, omitted stage clears it, at any ADR status. Setting a stage needs the roadmap resolver. Subagents create only proposed ADRs and cannot set status, supersede or link.",
    parameters: manageParameters,
    approval: "write",
    ...manageCard,
    async execute(_id, params: typeof manageParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, async (repo) => {
        const result = await manage(repo.repoRoot, ctx.agent.kind, params, { signal, resolver: resolver() });
        const created = params.action === "create" || params.action === "supersede" ? result.ids[0] : undefined;
        const summary =
          params.action === "create"
            ? `Created ${created}.`
            : params.action === "supersede"
              ? `${params.id} superseded by ${created}.`
              : `${params.id}: ${params.action} recorded.`;
        return written(result.files.length ? summary : `${params.id ?? created}: nothing changed.`, result);
      });
    },
  });
  pi.registerTool({
    name: "adr_check",
    sourcePath: TOOL_SOURCE_PATH,
    label: "ADR check",
    description:
      "Check ADR consistency: parse errors, ids and filenames, supersession links and the generated index. fix: true regenerates only the index.",
    parameters: checkParameters,
    approval: "write",
    ...checkCard,
    async execute(_id, params: typeof checkParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo) => checkReceipt(repo, params.fix, signal));
    },
  });
}
