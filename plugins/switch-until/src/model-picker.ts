import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { batch, computed, type KeyEvent, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspPickerItem, TspPickerLevel, TspSpan, TspText } from "@oh-my-pi/pi-wire";

import { h, span } from "#src/tsp.ts";

export interface ModelPickerOptions {
  /** Models in display order. */
  models: readonly Model[];
  current?: Model;
  /** The session's configured thinking level, shown on the slider until the user moves it. */
  thinking?: ConfiguredThinkingLevel;
  contextTokens: number;
  /** Terminal rows, for the list height. */
  rows(): number;
  /** `thinking` is set only when the user moved the slider. */
  onPick(model: Model, thinking?: ConfiguredThinkingLevel): void;
  onCancel(): void;
}

export interface ThinkingSlider {
  steps: readonly ConfiguredThinkingLevel[];
  value: ConfiguredThinkingLevel;
  disabled?: string;
}

const TITLE = "Temporary session model";
const STATUS = "Switches until the goal is met, then restores the current model";
const MAX_LABEL_WIDTH = 46;

const STEP_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto",
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const ACTIONS: readonly TspPickerAction[] = [
  { id: "pick", label: "Switch", keys: ["enter"], primary: true },
  { id: "close", label: "Cancel", keys: ["esc"], end: true },
];

/** `model`'s thinking steps (auto, off, its efforts) showing `level`, clamped to its ladder; frozen without efforts. */
export function thinkingSlider(model: Model, level: ConfiguredThinkingLevel | undefined): ThinkingSlider {
  const efforts = getSupportedEfforts(model);
  if (efforts.length === 0) {
    return {
      steps: [],
      value: "off",
      disabled: model.reasoning ? `${model.name} picks its own effort` : `${model.name} does not reason`,
    };
  }
  const steps: ConfiguredThinkingLevel[] = ["auto", "off", ...efforts];
  const wanted = level === undefined || level === "inherit" ? (model.thinking?.defaultLevel ?? "off") : level;
  if (steps.includes(wanted)) return { steps, value: wanted };
  return { steps, value: clampThinkingLevelForModel(model, wanted as Effort) ?? "off" };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function stepTone(step: ConfiguredThinkingLevel): string {
  return step === "auto" ? "accent" : `thinking${step === "xhigh" ? "Xhigh" : step.charAt(0).toUpperCase() + step.slice(1)}`;
}

function isPrintable(text: string | undefined): text is string {
  return text !== undefined && text.length > 0 && !/\p{Cc}/u.test(text);
}

interface Entry {
  id: string;
  model: Model;
  haystack: string;
}

/** A searchable model picker with a thinking slider, as one node tree for the terminal and Tern. */
export function modelPickerView(options: ModelPickerOptions): UiNode {
  const entries: Entry[] = options.models.map((model) => {
    const id = formatModelStringWithRouting(model);
    return { id, model, haystack: `${id} ${model.name}`.toLowerCase() };
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry.model]));
  const currentId = options.current && formatModelStringWithRouting(options.current);
  const current = currentId !== undefined && byId.has(currentId) ? [currentId] : [];
  const labelWidth = Math.min(MAX_LABEL_WIDTH, Math.max(0, ...entries.map((entry) => entry.id.length)) + 2);
  const overContext = (model: Model) => (model.contextWindow ?? 0) > 0 && options.contextTokens > (model.contextWindow ?? 0);

  const items: TspPickerItem[] = entries.map(({ id, model }) => ({
    id,
    label: id,
    detail: model.name,
    mono: true,
    mark: { text: model.provider, icon: `provider:${model.provider}` },
    ...(model.contextWindow ? { facts: { context: formatTokens(model.contextWindow) } } : {}),
    ...(overContext(model) ? { badges: [{ text: "compacts first", tone: "warning" as const }] } : {}),
  }));

  const rows: Record<string, TspText> = {};
  for (const { id, model } of entries) {
    const facts = [model.name, model.contextWindow ? `${formatTokens(model.contextWindow)} ctx` : undefined].filter(Boolean).join(" · ");
    const line: TspSpan[] = [span(id.padEnd(labelWidth))];
    if (id === currentId) line.push(span("current  ", "success"));
    if (facts) line.push(span(facts, "dim"));
    if (overContext(model)) line.push(span(" · compacts first", "warning"));
    rows[id] = line;
  }

  const query = signal("");
  const pending = signal<ConfiguredThinkingLevel | undefined>(undefined);
  const selected = signal<string | null>(current[0] ?? entries[0]?.id ?? null);

  const search = (text: string): { ids: string[]; hits: Record<string, [number, number][]> } => {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    const ids: string[] = [];
    const hits: Record<string, [number, number][]> = {};
    for (const entry of entries) {
      if (!terms.every((term) => entry.haystack.includes(term))) continue;
      ids.push(entry.id);
      const lower = entry.id.toLowerCase();
      const ranges: [number, number][] = [];
      for (const term of terms) {
        const at = lower.indexOf(term);
        if (at >= 0) ranges.push([at, at + term.length]);
      }
      if (ranges.length > 0) hits[entry.id] = ranges;
    }
    return { ids, hits };
  };
  const view = computed(() => search(query()));

  const selectedModel = (): Model | undefined => {
    const id = selected();
    return id === null ? undefined : byId.get(id);
  };
  const slider = (): ThinkingSlider | undefined => {
    const model = selectedModel();
    return model && thinkingSlider(model, pending() ?? options.thinking);
  };

  const setQuery = (next: string): void => {
    batch(() => {
      query.set(next);
      const { ids } = search(next);
      const at = selected.peek();
      if (at === null || !ids.includes(at)) selected.set(ids[0] ?? null);
    });
  };
  const setThinking = (step: string | undefined): void => {
    const shown = slider();
    if (!shown || shown.disabled) return;
    const next = shown.steps.find((level) => level === step);
    if (next !== undefined && next !== shown.value) pending.set(next);
  };
  const stepThinking = (delta: -1 | 1): void => {
    const shown = slider();
    if (!shown || shown.disabled) return;
    const index = shown.steps.indexOf(shown.value);
    setThinking(shown.steps[Math.max(0, Math.min(shown.steps.length - 1, index + delta))]);
  };
  const pick = (id: string | null): void => {
    const model = id === null ? undefined : byId.get(id);
    if (!model) return;
    const level = pending.peek();
    const shown = level === undefined ? undefined : thinkingSlider(model, level);
    options.onPick(model, shown && !shown.disabled ? shown.value : undefined);
  };

  const onKey = (key: KeyEvent): boolean => {
    if (key.kind === "release") return false;
    switch (key.id) {
      case "left":
      case "right":
        stepThinking(key.id === "left" ? -1 : 1);
        return true;
      case "backspace":
        setQuery(query.peek().slice(0, -1));
        return true;
      case "ctrl+u":
        setQuery("");
        return true;
      case "escape":
        if (query.peek() === "") return false;
        setQuery("");
        return true;
    }
    if (!isPrintable(key.text)) return false;
    setQuery(query.peek() + key.text);
    return true;
  };

  const thinkingRow = (): TspText => {
    const shown = slider();
    if (!shown) return [];
    if (shown.disabled) return [span("Thinking  ", "muted"), span(shown.disabled, "dim")];
    const line: TspSpan[] = [span("Thinking ", "muted")];
    for (const step of shown.steps) {
      const label = ` ${STEP_LABELS[step] ?? step} `;
      line.push(step === shown.value ? span(label, `inverse strong ${stepTone(step)}`) : span(label, "muted"));
    }
    return line;
  };
  const level = (): TspPickerLevel | null => {
    const shown = slider();
    const model = selectedModel();
    if (!shown || !model) return null;
    if (shown.disabled)
      return { label: "Thinking", icon: "brain", steps: [{ id: "off", label: "Off" }], value: "off", disabled: shown.disabled };
    return {
      label: "Thinking",
      icon: "brain",
      detail: model.provider,
      steps: shown.steps.map((id) => ({ id, label: STEP_LABELS[id] ?? id })),
      value: shown.value,
      keys: ["left", "right"],
    };
  };

  return h("picker", {
    title: TITLE,
    subtitle: STATUS,
    icon: "cpu",
    noun: "models",
    size: "md",
    layout: "rows",
    preview: "none",
    placeholder: "Search models…",
    columns: [{ id: "context", head: "Context", format: "dim", priority: 1 }],
    items,
    order: () => view().ids,
    hits: () => view().hits,
    query,
    selected,
    current,
    total: entries.length,
    empty: () => (entries.length === 0 ? "No models available" : "No models match"),
    level,
    actions: ACTIONS,
    term: () => {
      const shown = slider();
      const steps = shown && !shown.disabled ? " · ←→ thinking" : "";
      const close = query() === "" ? "esc cancel" : "esc clear search";
      return {
        head: [[span(STATUS, "muted")], thinkingRow()],
        rows,
        hint: `↑↓ move · ⏎ switch${steps} · type to search · ${close}`,
        maxRows: Math.max(5, Math.min(15, options.rows() - 12)),
      };
    },
    onKey,
    onPaste: (paste) => {
      setQuery(query.peek() + paste.text.replace(/\s+/g, " "));
      return true;
    },
    onSelect: (id: string) => {
      if (byId.has(id)) selected.set(id);
    },
    onActivate: (id: string) => pick(id),
    onAction: (act, event) => {
      switch (act) {
        case "pick":
          pick(selected.peek());
          return;
        case "close":
        case "cancel":
          options.onCancel();
          return;
        case "clear":
          setQuery("");
          return;
        case "level":
          setThinking(event.value);
          return;
      }
    },
  });
}
