import { describe, expect, test } from "bun:test";

import {
  type AuditState,
  auditItemsIn,
  effectiveLaneLimit,
  extensionChoices,
  parseSettings,
  type RoundRecord,
  renderTemplate,
  validateRound,
  verdict,
} from "../plugins/audit-goal/src/ledger.ts";

function round(n: number, counts: Partial<RoundRecord> = {}): RoundRecord {
  return { round: n, critical: 0, major: 0, minor: 0, picky: 0, rejected: 0, loopInduced: 0, ...counts };
}

function state(overrides: Partial<AuditState> = {}): AuditState {
  return {
    version: 1,
    status: "active",
    goalId: "g1",
    target: "plan X",
    intensity: "standard",
    maxRounds: null,
    laneLimit: 3,
    baseline: "abc123",
    rounds: [],
    capPending: false,
    addedTools: [],
    ...overrides,
  };
}

describe("exit gates by intensity", () => {
  test("relaxed converges on the first round without Critical or Major", () => {
    expect(verdict(state({ intensity: "relaxed", rounds: [round(1, { minor: 4, picky: 2 })] }))).toBe("converged");
  });

  test("standard needs two consecutive rounds without Critical or Major", () => {
    expect(verdict(state({ rounds: [round(1, { minor: 3 })] }))).toBe("continue");
    expect(verdict(state({ rounds: [round(1, { major: 1 }), round(2, { minor: 1 })] }))).toBe("continue");
    expect(verdict(state({ rounds: [round(1, { major: 1 }), round(2, { minor: 1 }), round(3, { picky: 5 })] }))).toBe("converged");
  });

  test("strict also counts Minor findings", () => {
    const rounds = [round(1), round(2, { minor: 1 })];
    expect(verdict(state({ intensity: "strict", rounds }))).toBe("continue");
    expect(verdict(state({ intensity: "strict", rounds: [...rounds, round(3, { picky: 2 }), round(4)] }))).toBe("converged");
  });
});

describe("round limit", () => {
  test("a met exit gate wins over an exhausted limit", () => {
    expect(verdict(state({ maxRounds: 2, rounds: [round(1), round(2)] }))).toBe("converged");
  });

  test("an exhausted limit without convergence is cap-reached", () => {
    expect(verdict(state({ maxRounds: 2, rounds: [round(1, { major: 2 }), round(2, { major: 1 })] }))).toBe("cap-reached");
  });

  test("extension choices derive from the current limit", () => {
    expect(extensionChoices(10).map((choice) => choice.newLimit)).toEqual([15, 20, null, undefined]);
    expect(extensionChoices(3).map((choice) => choice.newLimit)).toEqual([5, 6, null, undefined]);
    expect(extensionChoices(1).map((choice) => choice.newLimit)).toEqual([2, null, undefined]);
  });

  test("records are refused while a limit decision is pending", () => {
    expect(validateRound(state({ capPending: true, rounds: [round(1)] }), round(2))).toContain("extend");
  });
});

describe("self-feeding signal", () => {
  test("fires when every finding is loop-induced and severity falls", () => {
    const previous = round(1, { major: 2, minor: 1 });
    expect(verdict(state({ rounds: [previous, round(2, { major: 1, minor: 3, loopInduced: 4 })] }))).toBe("self-feeding");
    expect(verdict(state({ rounds: [previous, round(2, { major: 2, minor: 1, loopInduced: 3 })] }))).toBe("continue");
  });

  test("fires when loop-induced findings are at least half of two consecutive rounds", () => {
    const latest = round(2, { major: 3, minor: 3, loopInduced: 3 });
    expect(verdict(state({ rounds: [round(1, { major: 3, minor: 1, loopInduced: 2 }), latest] }))).toBe("self-feeding");
    expect(verdict(state({ rounds: [round(1, { major: 3, minor: 1, loopInduced: 1 }), latest] }))).toBe("continue");
  });

  test("does not fire when the latest findings are pre-existing", () => {
    expect(verdict(state({ rounds: [round(1, { major: 2, loopInduced: 2 }), round(2, { major: 1 })] }))).toBe("continue");
  });
});

describe("round validation", () => {
  test("rejects out-of-order rounds and invalid counts", () => {
    const current = state({ rounds: [round(1)] });
    expect(validateRound(current, round(3))).toContain("next round to record is 2");
    expect(validateRound(current, round(2, { major: -1 }))).toContain("major");
    expect(validateRound(current, round(2, { critical: Number.NaN }))).toContain("critical");
    expect(validateRound(current, round(2, { minor: 1, loopInduced: 2 }))).toContain("loopInduced");
    expect(validateRound(current, round(2))).toBeUndefined();
  });
});

describe("settings", () => {
  test("defaults to standard with no limits", () => {
    expect(parseSettings({})).toEqual({ intensity: "standard", maxRounds: undefined, maxParallelLanes: undefined });
  });

  test("rejects unknown intensity and non-positive limits", () => {
    expect(() => parseSettings({ intensity: "extreme" })).toThrow("intensity");
    expect(() => parseSettings({ maxRounds: 0 })).toThrow("maxRounds");
    expect(() => parseSettings({ maxParallelLanes: 2.5 })).toThrow("maxParallelLanes");
  });

  test("OMP task concurrency caps the lane limit", () => {
    expect(effectiveLaneLimit(10, 3)).toBe(3);
    expect(effectiveLaneLimit(2, 32)).toBe(2);
    expect(effectiveLaneLimit(undefined, 32)).toBe(32);
    expect(effectiveLaneLimit(4, undefined)).toBe(4);
    expect(effectiveLaneLimit(undefined, undefined)).toBeNull();
  });
});

describe("task dispatch inspection", () => {
  test("counts audit agents in batch and flat task shapes", () => {
    expect(auditItemsIn({ tasks: [{ agent: "audit-auditor" }, { agent: "scout" }, { agent: "audit-fixer" }, {}] })).toBe(2);
    expect(auditItemsIn({ agent: "audit-fixer", task: "x" })).toBe(1);
    expect(auditItemsIn({ task: "x" })).toBe(0);
  });
});

describe("protocol rendering", () => {
  test("fails on placeholders the extension does not supply", () => {
    expect(renderTemplate("{{a}} and {{a}}", { a: "x" })).toBe("x and x");
    expect(() => renderTemplate("{{a}} {{b}}", { a: "x" })).toThrow("{{b}}");
  });
});
