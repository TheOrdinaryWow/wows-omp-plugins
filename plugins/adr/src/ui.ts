import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { type AdrRecord, type AdrStatus, STATUSES } from "#src/documents.ts";

export type MenuAction = "accept" | "reject" | "deprecate" | "note" | "supersede" | "new" | "check" | "check-fix";

/** `id` is set for actions on one ADR; `new` and the checks carry none. */
export interface MenuChoice {
  action: MenuAction;
  id?: string;
}

export interface MenuEntry {
  record: AdrRecord;
  /** The `adr_status` detail text, shown read-only from the detail view. */
  detail: string;
}

export interface PreviewFile {
  /** Repository-relative path. */
  path: string;
  content: string;
}

export interface AdrUi {
  /** False when no dialog can be answered (`hasUI === false`); callers then take their non-interactive path. */
  readonly interactive: boolean;
  /** Status filter, then list, then detail; resolves with the chosen action, or undefined when the menu is closed. */
  menu(entries: MenuEntry[]): Promise<MenuChoice | undefined>;
  /** Single-line text; undefined when cancelled. */
  text(title: string, placeholder: string): Promise<string | undefined>;
  previewConfirm(p: { title: string; files: PreviewFile[] }): Promise<boolean | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export type AdrUiContext = Pick<ExtensionContext, "ui" | "hasUI">;
export type AdrMessenger = Pick<ExtensionAPI, "sendMessage">;
const NOTICE_TYPE = "wows-omp-adr.notice";

/** No dialogs; notices become displayed session messages so headless and SDK clients still see them. */
export class HeadlessUi implements AdrUi {
  readonly interactive = false;

  constructor(private readonly pi: AdrMessenger) {}

  async menu(): Promise<undefined> {
    return undefined;
  }

  async text(): Promise<undefined> {
    return undefined;
  }

  async previewConfirm(): Promise<undefined> {
    return undefined;
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.pi.sendMessage({
      customType: NOTICE_TYPE,
      content: level === "info" ? message : `ADR ${level}: ${message}`,
      display: true,
      attribution: "agent",
    });
  }
}

const STATUS_GLYPHS: Record<AdrStatus, string> = {
  proposed: "○",
  accepted: "●",
  rejected: "×",
  deprecated: "◌",
  superseded: "→",
};

/** Counts by status, nonzero only, in lifecycle order. */
export function statusCounts(records: readonly Pick<AdrRecord, "status">[]): string {
  const parts = STATUSES.map((status) => [status, records.filter((record) => record.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  return parts.length ? parts.join(", ") : "no ADRs yet";
}

/** Status transitions the menu offers for one ADR; a superseded ADR offers none. */
function decisions(record: AdrRecord): Array<readonly [string, MenuAction]> {
  if (record.status === "superseded" || record.superseded_by) return [["Append a dated note", "note"]];
  const result: Array<readonly [string, MenuAction]> = [];
  if (record.status !== "accepted") result.push(["Accept", "accept"]);
  if (record.status !== "rejected") result.push(["Reject", "reject"]);
  if (record.status !== "deprecated") result.push(["Deprecate", "deprecate"]);
  result.push(["Append a dated note", "note"]);
  if (record.status === "accepted" || record.status === "deprecated") result.push(["Supersede with a new decision…", "supersede"]);
  return result;
}

export function createTuiUi(ctx: AdrUiContext, pi: AdrMessenger): AdrUi {
  if (!ctx.hasUI) return new HeadlessUi(pi);
  const ui = ctx.ui;
  const BACK = "← Back";

  async function choose<T>(title: string, options: ReadonlyArray<readonly [string, T]>): Promise<T | undefined> {
    const picked = await ui.select(
      title,
      options.map(([label]) => label),
    );
    return options.find(([label]) => label === picked)?.[1];
  }

  async function detail(entry: MenuEntry): Promise<MenuChoice | "back"> {
    const { record } = entry;
    for (;;) {
      const options: Array<readonly [string, MenuAction | "view" | "back"]> = [
        ["View the decision", "view"],
        ...decisions(record),
        [BACK, "back"],
      ];
      const where = [
        record.date,
        record.stage ? `stage ${record.stage}` : "",
        record.superseded_by ? `superseded by ${record.superseded_by}` : "",
      ];
      const picked = await choose(`${record.id} ${record.title} [${record.status}] · ${where.filter(Boolean).join(" · ")}`, options);
      if (picked === undefined || picked === "back") return "back";
      if (picked !== "view") return { action: picked, id: record.id };
      await ui.editor(`${record.path} (read-only, edits are discarded)`, entry.detail);
    }
  }

  async function list(entries: MenuEntry[], label: string): Promise<MenuChoice | "back"> {
    for (;;) {
      const options: Array<readonly [string, MenuEntry | "back"]> = [
        ...entries.map(
          (entry) =>
            [`${STATUS_GLYPHS[entry.record.status]} ${entry.record.id} ${entry.record.title} [${entry.record.status}]`, entry] as const,
        ),
        [BACK, "back"],
      ];
      const picked = await choose(`${label}: ${entries.length} ADR${entries.length === 1 ? "" : "s"}`, options);
      if (picked === undefined || picked === "back") return "back";
      const choice = await detail(picked);
      if (choice !== "back") return choice;
    }
  }

  return {
    interactive: true,

    async menu(entries) {
      for (;;) {
        const records = entries.map((entry) => entry.record);
        const filters = [
          ["All ADRs", undefined] as const,
          ...STATUSES.filter((status) => records.some((record) => record.status === status)).map(
            (status) => [`${status[0]?.toUpperCase()}${status.slice(1)}`, status] as const,
          ),
        ];
        const options: Array<readonly [string, { filter: AdrStatus | undefined; label: string } | MenuAction]> = [
          ...(entries.length
            ? filters.map(([label, filter]) => {
                const count = filter ? records.filter((record) => record.status === filter).length : records.length;
                return [`${label} (${count})`, { filter, label }] as const;
              })
            : []),
          ["New decision…", "new"],
          ["Run check", "check"],
          ["Run check and regenerate the index", "check-fix"],
        ];
        const picked = await choose(`ADRs: ${statusCounts(records)}`, options);
        if (picked === undefined) return undefined;
        if (typeof picked === "string") return { action: picked };
        const choice = await list(
          entries.filter((entry) => !picked.filter || entry.record.status === picked.filter),
          picked.label,
        );
        if (choice !== "back") return choice;
      }
    },

    text: (title, placeholder) => ui.input(title, placeholder),

    async previewConfirm(p) {
      const write = `Write ${p.files.length} file${p.files.length === 1 ? "" : "s"}`;
      const cancel = "Cancel";
      const labels = [write, ...p.files.map((file) => `View ${file.path}`), cancel];
      let initialIndex = 0;
      for (;;) {
        const picked = await ui.select(`${p.title}\nSelect a file to view it, or write all of them.`, labels, { initialIndex });
        if (picked === undefined) return undefined;
        if (picked === write) return true;
        if (picked === cancel) return false;
        initialIndex = labels.indexOf(picked);
        const file = p.files[initialIndex - 1];
        if (file) await ui.editor(`${file.path} (read-only preview, edits are discarded)`, file.content);
      }
    },

    notify(message, level) {
      ui.notify(message, level);
    },
  };
}
