import { relative } from "node:path";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { Model, StageDoc, StageStatus, TodoItem } from "#src/documents.ts";

export type OverlapAnswer = "roadmap" | "free" | "unrelated";
export type StatusMenuAction = "check" | "stage" | "new-round" | "close-round" | "close";
export type RoundTodoDisposition = "resolved" | "wontfix" | "carried";

export interface OverlapQuestion {
  stage: { id: string; title: string; status: StageStatus };
  intent: string;
}

export interface PreviewFile {
  path: string;
  content: string;
}

export interface StatusMenuChoice {
  action: StatusMenuAction;
  stage?: string;
}

export interface RoundTodoDispositionChoice {
  id: string;
  disposition: RoundTodoDisposition;
  reference?: string;
}

export interface RoadmapUi {
  overlap(q: OverlapQuestion): Promise<OverlapAnswer | undefined>;
  previewConfirm(p: { title: string; root: string; files: PreviewFile[] }): Promise<boolean | undefined>;
  statusMenu(m: Model): Promise<StatusMenuChoice | undefined>;
  closeRoundDispositions(todos: TodoItem[]): Promise<RoundTodoDispositionChoice[] | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export type RoadmapUiContext = Pick<ExtensionContext, "ui" | "hasUI">;

export class HeadlessUi implements RoadmapUi {
  async overlap(): Promise<undefined> {
    return undefined;
  }

  async previewConfirm(): Promise<undefined> {
    return undefined;
  }

  async statusMenu(): Promise<undefined> {
    return undefined;
  }

  async closeRoundDispositions(): Promise<undefined> {
    return undefined;
  }

  notify(): void {}
}

export const STATUS_GLYPHS: Record<StageStatus, string> = {
  planned: "○",
  active: "◐",
  closed: "●",
  dropped: "×",
};

const OVERLAP_OPTIONS: ReadonlyArray<readonly [string, OverlapAnswer]> = [
  ["Use the roadmap: bind this session to the stage", "roadmap"],
  ["Free work: proceed and log it on the stage", "free"],
  ["Unrelated: do not ask again for this stage", "unrelated"],
];

const DISPOSITION_OPTIONS: ReadonlyArray<readonly [string, RoundTodoDisposition]> = [
  ["Resolved", "resolved"],
  ["Won't fix", "wontfix"],
  ["Carry to the next round", "carried"],
];

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function stageLabel(stage: StageDoc, todos: readonly TodoItem[]): string {
  const count = todos.filter((item) => item.target === stage.id).length;
  const suffix = count > 0 ? ` · ${plural(count, "open TODO")}` : "";
  return `${STATUS_GLYPHS[stage.status]} ${stage.id} ${stage.title} [${stage.status}]${suffix}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, "")) || a.id.localeCompare(b.id);
}

export function createTuiUi(ctx: RoadmapUiContext): RoadmapUi {
  if (!ctx.hasUI) return new HeadlessUi();
  const ui = ctx.ui;

  async function choose<T>(title: string, options: ReadonlyArray<readonly [string, T]>): Promise<T | undefined> {
    const picked = await ui.select(
      title,
      options.map(([label]) => label),
    );
    return options.find(([label]) => label === picked)?.[1];
  }

  return {
    overlap: (q) =>
      choose(`This request overlaps stage ${q.stage.id} "${q.stage.title}" [${q.stage.status}]\nRequest: ${q.intent}`, OVERLAP_OPTIONS),

    async previewConfirm(p) {
      const write = `Write ${plural(p.files.length, "file")}`;
      const cancel = "Cancel";
      const labels = [write, ...p.files.map((file) => `View ${relative(p.root, file.path)}`), cancel];
      let initialIndex = 0;
      for (;;) {
        const picked = await ui.select(`${p.title}\nSelect a file to view it, or write all of them.`, labels, { initialIndex });
        if (picked === undefined) return undefined;
        if (picked === write) return true;
        if (picked === cancel) return false;
        initialIndex = labels.indexOf(picked);
        const file = p.files[initialIndex - 1];
        if (file) await ui.editor(`${relative(p.root, file.path)} (read-only preview, edits are discarded)`, file.content);
      }
    },

    statusMenu(m) {
      const round = m.rounds.find((candidate) => candidate.status === "active");
      const options: Array<readonly [string, StatusMenuChoice]> = [];
      let title: string;
      if (round) {
        const stages = m.stages.filter((stage) => stage.round === round.id).sort(byId);
        const todos = m.todos.filter((doc) => doc.round === round.id).flatMap((doc) => doc.items.filter((item) => item.status === "open"));
        const untargeted = todos.filter((item) => !stages.some((stage) => stage.id === item.target)).length;
        title = `Roadmap ${round.id} ${round.title} [active] · ${plural(stages.length, "stage")} · ${plural(todos.length, "open TODO")}`;
        if (untargeted > 0) title += ` (${untargeted} by trigger)`;
        for (const stage of stages) options.push([stageLabel(stage, todos), { action: "stage", stage: stage.id }]);
        for (const stage of stages.filter((candidate) => candidate.status === "active")) {
          options.push([`Close stage ${stage.id}`, { action: "close", stage: stage.id }]);
        }
        options.push(["Run check", { action: "check" }]);
        if (stages.every((stage) => stage.status === "closed" || stage.status === "dropped")) {
          options.push([`Close round ${round.id}`, { action: "close-round" }]);
        }
      } else {
        const last = [...m.rounds].sort(byId).at(-1);
        title = last ? `Roadmap: no active round (last: ${last.id} ${last.title}, closed)` : "Roadmap: no rounds yet";
        options.push(["Run check", { action: "check" }]);
        options.push(["Open a new round", { action: "new-round" }]);
      }
      return choose(title, options);
    },

    async closeRoundDispositions(todos) {
      const result: RoundTodoDispositionChoice[] = [];
      for (const [index, item] of todos.entries()) {
        const where = item.target ? `target ${item.target}` : item.trigger ? `trigger: ${item.trigger}` : "no target";
        const disposition = await choose(
          `Close round: ${item.id} ${item.title} (${index + 1}/${todos.length}, ${item.severity ?? "normal"}, ${where})`,
          DISPOSITION_OPTIONS,
        );
        if (disposition === undefined) return undefined;
        if (disposition === "carried") {
          result.push({ id: item.id, disposition });
          continue;
        }
        const prompt = disposition === "resolved" ? "commit, stage or document that resolved it" : "reason it will not be fixed";
        const reference = await ui.input(`${item.id} reference`, prompt);
        if (reference === undefined) return undefined;
        const trimmed = reference.trim();
        result.push(trimmed ? { id: item.id, disposition, reference: trimmed } : { id: item.id, disposition });
      }
      return result;
    },

    notify(message, level) {
      ui.notify(message, level);
    },
  };
}
