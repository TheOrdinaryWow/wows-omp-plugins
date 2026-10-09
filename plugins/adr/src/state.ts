import { type AdrModel, type AdrStatus, ordered, STATUSES } from "#src/documents.ts";
import { statusCounts } from "#src/ui.ts";

/** The `adr/status` sidecar payload, version 1. */
export interface AdrStatusState {
  kind: "adr/status";
  version: 1;
  repoRoot: string;
  /** Marker format, or null while docs/adr/README.md is still a legacy roadmap ADR index. */
  format: number | null;
  /** Files under docs/adr (index included) still stored in the legacy roadmap format. */
  legacyFiles: number;
  counts: Record<AdrStatus, number>;
  records: Array<{ id: string; title: string; status: AdrStatus; date: string; stage?: string; superseded_by?: string }>;
}

export function adrStatus(model: AdrModel): AdrStatusState {
  return {
    kind: "adr/status",
    version: 1,
    repoRoot: model.repo.repoRoot,
    format: model.index && !model.index.legacy ? model.index.format : null,
    legacyFiles: model.adrs.filter((doc) => doc.legacy).length + (model.index?.legacy ? 1 : 0),
    counts: Object.fromEntries(STATUSES.map((status) => [status, model.adrs.filter((doc) => doc.status === status).length])) as Record<
      AdrStatus,
      number
    >,
    records: ordered(model.adrs).map((doc) => ({
      id: doc.id,
      title: doc.title,
      status: doc.status,
      date: doc.date,
      ...(doc.stage ? { stage: doc.stage } : {}),
      ...(doc.superseded_by ? { superseded_by: doc.superseded_by } : {}),
    })),
  };
}

const PROPOSED_SHOWN = 5;

/** The per-turn summary: counts by status, up to five proposed ADRs and a pointer to adr_status. */
export function renderInjection(model: AdrModel): string {
  const proposed = ordered(model.adrs.filter((doc) => doc.status === "proposed"));
  const lines = [`ADRs in docs/adr: ${statusCounts(model.adrs)}.`];
  if (proposed.length) {
    const shown = proposed.slice(0, PROPOSED_SHOWN).map((doc) => `${doc.id} ${doc.title.replace(/\s+/g, " ").slice(0, 80)}`);
    const more = proposed.length - shown.length;
    lines.push(`Proposed: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`);
  }
  if (model.parseErrors.length)
    lines.push(`${model.parseErrors.length} ADR file${model.parseErrors.length === 1 ? "" : "s"} could not be parsed; run adr_check.`);
  lines.push("Read decisions with adr_status (an id gives the full text); change them only through adr_manage.");
  return lines.join("\n");
}
