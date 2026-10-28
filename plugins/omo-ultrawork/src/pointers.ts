import type { Pointer } from "#src/keywords.ts";

const POINTER_TEXT: Record<Pointer["target"], string> = {
  "mass-ulw":
    "If mass-ulw execution is the user's request (not a discussion/example), read skill://mass-ulw and follow its dependency-aware fan-out and verification protocol. For independent work, one plain task batch is simpler. Preserve an active loop or approved Atlas plan as the single execution owner.",
  prometheus:
    "If the user wants a reviewed plan, suggest that the user enter /prometheus <request> with omo-prometheus installed. Do not run the command for them, activate Plan Mode, approve a plan or create a competing plan workflow. A mention or question is not authorization.",
  "ulw-loop":
    "If durable criterion/evidence-led execution is the user's request, read skill://ulw-loop and ask the user to enter /ulw-loop <objective>. The command authorizes its native driver. Do not start a loop from a mention, take over /audit or an unrelated goal, or bootstrap an Atlas subtask into another workflow.",
  "ulw-research":
    "This names the private ulw-research procedure. For discussion, explain it or suggest user-entered /ulw-research <request>; do not start a research run from a mention or question. Positive binding requests receive the cached procedure on their own input.",
};
export function renderPointers(pointers: Pointer[], raw: string): string {
  return pointers
    .flatMap((pointer) => {
      if (pointer.target === "ulw-research" && pointer.intent === "binding") return [];
      const tag = `omo-${pointer.target}-pointer`;
      if (raw.includes(`<${tag}>`)) return [];
      const text =
        pointer.target === "mass-ulw" && pointer.intent === "binding"
          ? "The user requested mass-ulw execution. Read skill://mass-ulw before decomposition; use its native dispatch/evidence protocol. Keep an active loop or approved Atlas as the single execution owner."
          : POINTER_TEXT[pointer.target];
      return [`<${tag}>${text}</${tag}>`];
    })
    .join("\n");
}
