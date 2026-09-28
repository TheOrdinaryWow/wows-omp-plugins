/** Runtime boundary guard for persisted audit entries and tool-provided evidence. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
