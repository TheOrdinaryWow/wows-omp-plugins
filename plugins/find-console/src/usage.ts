import type { JudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import type { FindStats } from "@oh-my-pi/pi-tui/tools/find";

/** Failed or split native attempts can bill without returning a judgment result. */
export function trackJudgmentUsage(journal?: (usage: JudgmentUsage) => void) {
  let cost = 0;
  return {
    onUsage(usage: JudgmentUsage): void {
      cost += usage.usage.cost.total;
      journal?.(usage);
    },
    setReportCost(stats: Pick<FindStats, "cost">, translationCost: number): void {
      stats.cost = cost + translationCost;
    },
  };
}
