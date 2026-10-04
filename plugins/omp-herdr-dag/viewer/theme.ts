import type { NodeState, Snapshot, Source, ThemeColors } from "../src/model.ts";

/**
 * Viewer design tokens. Every color, glyph and spacing value the renderer uses lives here so the
 * DAG, Tasks and transcript views stay visually consistent and follow the OMP theme pushed by the host.
 */

export type ColorMode = "truecolor" | "256";
export type ThemeToken = Exclude<keyof ThemeColors, "background">;
export interface Style {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  underline?: boolean;
}

/** Used until the host pushes the OMP theme (e.g. a recovery snapshot written by an older host). */
export const DEFAULT_THEME: ThemeColors = {
  text: "#d4d4d4",
  muted: "#8b949e",
  dim: "#6e7681",
  accent: "#58a6ff",
  success: "#3fb950",
  error: "#f85149",
  warning: "#d29922",
  border: "#6e7681",
  borderAccent: "#58a6ff",
  borderMuted: "#484f58",
};
export const DEFAULT_SOURCES: Snapshot["sources"] = { todo: "#4f8cff", plan: "#a371f7", atlas: "#3fb950" };
export const SOURCE_LABELS: Record<Source, string> = { todo: "TODO", plan: "PLAN", atlas: "ATLAS" };

export const STATE_ICONS: Record<NodeState, string> = {
  pending: "○",
  running: "◐",
  done: "✔",
  failed: "✖",
  blocked: "⊘",
  abandoned: "⊖",
};
export const STATE_TOKENS: Record<NodeState, ThemeToken> = {
  pending: "muted",
  running: "accent",
  done: "success",
  failed: "error",
  blocked: "warning",
  abandoned: "dim",
};
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const GLYPHS = {
  ellipsis: "…",
  missing: "—",
  bandRule: "╌",
  rule: "─",
  arrow: "▼",
  backReference: "↑",
  attached: "↳",
  tool: "▸",
  retry: "↻",
  warning: "▲",
  history: "⟲",
  tabMark: "▍",
  barFull: "▰",
  barEmpty: "▱",
  overflowLeft: "‹",
  overflowRight: "›",
  separator: " · ",
};

export type BoxKind = "rounded" | "heavy" | "double";
export interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  tee: string;
}
export const BOXES: Record<BoxKind, BoxGlyphs> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", tee: "┬" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", tee: "┳" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", tee: "╦" },
};

/** Connector bits: up, right, down, left. */
export const UP = 1;
export const RIGHT = 2;
export const DOWN = 4;
export const LEFT = 8;
export type LineKind = "dotted" | "solid" | "heavy";
export const LINE_RANK: Record<LineKind, number> = { dotted: 0, solid: 1, heavy: 2 };
const LIGHT: Record<number, string> = {
  [UP]: "╵",
  [DOWN]: "╷",
  [LEFT]: "╴",
  [RIGHT]: "╶",
  [UP | DOWN]: "│",
  [LEFT | RIGHT]: "─",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [UP | RIGHT | DOWN | LEFT]: "┼",
};
const HEAVY: Record<number, string> = {
  [UP]: "╹",
  [DOWN]: "╻",
  [LEFT]: "╸",
  [RIGHT]: "╺",
  [UP | DOWN]: "┃",
  [LEFT | RIGHT]: "━",
  [UP | RIGHT]: "┗",
  [UP | LEFT]: "┛",
  [DOWN | RIGHT]: "┏",
  [DOWN | LEFT]: "┓",
  [UP | DOWN | RIGHT]: "┣",
  [UP | DOWN | LEFT]: "┫",
  [LEFT | RIGHT | DOWN]: "┳",
  [LEFT | RIGHT | UP]: "┻",
  [UP | RIGHT | DOWN | LEFT]: "╋",
};
export function connectorGlyph(bits: number, kind: LineKind): string {
  if (kind === "heavy") return HEAVY[bits] ?? "╋";
  if (kind === "dotted" && bits === (UP | DOWN)) return "┆";
  if (kind === "dotted" && bits === (LEFT | RIGHT)) return "┄";
  return LIGHT[bits] ?? "┼";
}

/** Layout spacing on the character grid. */
export const SPACING = {
  nodeGap: 2,
  dummyGap: 2,
  laneGap: 2,
  minNode: 20,
  maxNode: 30,
  outputLines: 3,
  labelLines: 3,
  detailLines: 6,
  footerDetailLines: 2,
};

export interface Palette {
  theme: ThemeColors;
  sources: Snapshot["sources"];
  mode: ColorMode;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Accepts host colors only when they are real hex values; anything else falls back to the default token. */
export function palette(snapshot: Pick<Snapshot, "theme" | "sources"> | undefined, mode: ColorMode): Palette {
  const theme = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME) as ThemeToken[]) {
    const value = snapshot?.theme?.[key];
    if (typeof value === "string" && HEX.test(value)) theme[key] = value;
  }
  const sources = { ...DEFAULT_SOURCES };
  for (const key of Object.keys(DEFAULT_SOURCES) as Source[]) {
    const value = snapshot?.sources?.[key];
    if (typeof value === "string" && HEX.test(value)) sources[key] = value;
  }
  return { theme, sources, mode };
}

export function detectColorMode(env: Record<string, string | undefined> = process.env): ColorMode {
  const value = (env.COLORTERM ?? "").toLowerCase();
  return value.includes("truecolor") || value.includes("24bit") ? "truecolor" : "256";
}

function rgb(hex: string): [number, number, number] | undefined {
  if (!HEX.test(hex)) return undefined;
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** Nearest xterm-256 index from the 6×6×6 cube or the gray ramp. */
export function to256(r: number, g: number, b: number): number {
  const level = (value: number): number => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeDistance = ((steps[cr] as number) - r) ** 2 + ((steps[cg] as number) - g) ** 2 + ((steps[cb] as number) - b) ** 2;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayDistance = (gray - r) ** 2 + (gray - g) ** 2 + (gray - b) ** 2;
  return grayDistance < cubeDistance ? 232 + grayIndex : cube;
}

export const RESET = "\x1b[0m";
export function sgr(style: Style | undefined, mode: ColorMode): string {
  if (!style) return "";
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  const color = style.fg ? rgb(style.fg) : undefined;
  if (color) codes.push(mode === "truecolor" ? `38;2;${color.join(";")}` : `38;5;${to256(...color)}`);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

export const sameStyle = (a: Style | undefined, b: Style | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.fg === b.fg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.inverse === !!b.inverse &&
    !!a.underline === !!b.underline);
