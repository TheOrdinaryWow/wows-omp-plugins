import { describe, expect, test } from "bun:test";

import {
  type AuditState,
  auditItemsIn,
  createConclusion,
  effectiveLaneLimit,
  extensionChoices,
  parseSettings,
  type RoundRecord,
  remainingFindings,
  renderTemplate,
  restoreAuditState,
  selfFeedingSignal,
  validateConclusion,
  validateRound,
  verdict,
} from "../plugins/audit-goal/src/ledger.ts";

function round(n: number, counts: Partial<RoundRecord> = {}): RoundRecord {
  const critical = counts.critical ?? 0;
  const major = counts.major ?? 0;
  const minor = counts.minor ?? 0;
  const picky = counts.picky ?? 0;
  const loopInduced = counts.loopInduced ?? 0;
  let index = 0;
  const findings = (["critical", "major", "minor", "picky"] as const).flatMap((severity) =>
    Array.from({ length: Math.max(0, counts[severity] ?? 0) }, () => ({
      id: `round-${n}-${++index}`,
      severity,
      summary: `Verified ${severity} finding ${index}`,
      evidence: `source:${n}:${index} exercise failed`,
      origin: index <= loopInduced ? ("loop-induced" as const) : ("pre-existing" as const),
      status: "open" as const,
    })),
  );
  return {
    round: n,
    critical,
    major,
    minor,
    picky,
    rejected: 0,
    loopInduced,
    auditorModels: ["auditor-model-A"],
    coverage: `round ${n} production chain axis`,
    checks: `round ${n} CI pass`,
    findings,
    resolutions: [],
    rejectedEvidence: [],
    ...counts,
  };
}

function state(overrides: Partial<AuditState> = {}): AuditState {
  return {
    version: 2,
    status: "active",
    goalId: "g1",
    target: "plan X",
    intensity: "standard",
    maxRounds: null,
    laneLimit: 3,
    baseline: "abc123",
    rounds: [],
    capPending: false,
    conclusion: null,
    addedTools: [],
    ...overrides,
  };
}

describe("exit gates by intensity", () => {
  test("relaxed converges on the first round without Critical or Major", () => {
    expect(verdict(state({ intensity: "relaxed", rounds: [round(1, { minor: 4, picky: 2 })] }))).toBe("threshold-ready");
  });

  test("standard needs two consecutive rounds without Critical or Major", () => {
    expect(verdict(state({ rounds: [round(1, { minor: 3 })] }))).toBe("continue");
    expect(verdict(state({ rounds: [round(1, { major: 1 }), round(2, { minor: 1 })] }))).toBe("continue");
    expect(verdict(state({ rounds: [round(1, { major: 1 }), round(2, { minor: 1 }), round(3, { picky: 5 })] }))).toBe("threshold-ready");
  });

  test("strict also counts Minor findings", () => {
    const rounds = [round(1), round(2, { minor: 1 })];
    expect(verdict(state({ intensity: "strict", rounds }))).toBe("continue");
    expect(verdict(state({ intensity: "strict", rounds: [...rounds, round(3, { picky: 2 }), round(4)] }))).toBe("threshold-ready");
  });
});

describe("round limit", () => {
  test("a met exit gate wins over an exhausted limit", () => {
    expect(verdict(state({ maxRounds: 2, rounds: [round(1), round(2)] }))).toBe("threshold-ready");
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

describe("self-feeding signal is only diagnostic", () => {
  test("detects a loop-induced majority without declaring convergence", () => {
    const previous = round(1, { major: 2, minor: 1, loopInduced: 2 });
    const latest = round(2, { major: 1, minor: 1, loopInduced: 2 });
    expect(selfFeedingSignal([previous, latest])).toBe(true);
    expect(verdict(state({ rounds: [previous, latest] }))).toBe("continue");
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
describe("finding and conclusion integrity", () => {
  test("keeps unresolved Major findings open after a threshold discovery streak", () => {
    const rounds = [round(1, { major: 1 }), round(2), round(3)];
    const current = state({ rounds });
    expect(verdict(current)).toBe("threshold-ready");
    const evidence = [{ round: 3, observation: "Second clean production-chain audit; no new blocking discoveries" }];
    expect(validateConclusion(current, "threshold-convergence", "Standard two-round discovery gate met", evidence)).toBeUndefined();
    const conclusion = createConclusion(current, "threshold-convergence", "Standard two-round discovery gate met", evidence);
    expect(conclusion.remaining.counts.major).toBe(1);
    expect(conclusion.remaining.findings.map((finding) => finding.id)).toEqual(["round-1-1"]);
    expect(conclusion.artifactAccepted).toBe(false);
    expect(restoreAuditState({ ...current, conclusion })).toEqual({ ...current, conclusion });
  });

  test("closes earlier findings only with an evidenced resolution", () => {
    const first = round(1, { major: 1 });
    const second = round(2, { resolutions: [{ findingId: "round-1-1", evidence: "Patch abc verified by checkout scenario" }] });
    expect(validateRound(state({ rounds: [first] }), second)).toBeUndefined();
    expect(remainingFindings([first, second]).counts.major).toBe(0);
    expect(
      validateRound(state({ rounds: [first] }), round(2, { resolutions: [{ findingId: "not-recorded", evidence: "claim" }] })),
    ).toContain("previously open");
  });

  test("requires concrete matching round evidence, not an unsupported tally", () => {
    const falseCounts = round(1, { major: 1, findings: [] });
    expect(validateRound(state(), falseCounts)).toContain("Severity counts");
    const duplicate = round(2, { major: 1 });
    const firstFinding = duplicate.findings.at(0);
    if (!firstFinding) throw new Error("Test fixture must have a finding");
    firstFinding.id = "round-1-1";
    expect(validateRound(state({ rounds: [round(1, { major: 1 })] }), duplicate)).toContain("already recorded");
  });

  test("saturation needs repeated same-model varied axes and observations, not a self-feeding flag", () => {
    const rounds = [
      round(1, { major: 3, coverage: "entry to DB" }),
      round(2, { major: 2, coverage: "restart and replay" }),
      round(3, { major: 1, coverage: "shutdown and recovery" }),
    ];
    const current = state({ rounds });
    const evidence = rounds.map(({ round: number, coverage }) => ({
      round: number,
      observation: `Inspected ${coverage}; remaining behavior still needs repair`,
    }));
    expect(verdict(current)).toBe("continue");
    expect(
      validateConclusion(
        current,
        "capability-saturation",
        "Three repeated same-model passes have exhausted credible new axes; repairs remain open",
        evidence,
      ),
    ).toBeUndefined();
    const conclusion = createConclusion(
      current,
      "capability-saturation",
      "Same-model discovery limit reached; repairs remain open",
      evidence,
    );
    expect(conclusion.remaining.counts.major).toBe(6);
    expect(conclusion.artifactAccepted).toBe(false);
    expect(restoreAuditState({ ...current, conclusion })).toEqual({ ...current, conclusion });
    expect(validateConclusion(state({ rounds: rounds.slice(0, 1) }), "capability-saturation", "one pass", evidence.slice(0, 1))).toContain(
      "at least three",
    );
    expect(validateConclusion(current, "capability-saturation", "unsubstantiated", evidence.slice(1))).toContain("last three");
    const [first, second, third] = rounds;
    if (!first || !second || !third) throw new Error("Test fixture must have three rounds");
    expect(
      validateConclusion(
        state({ rounds: [first, { ...second, auditorModels: ["other"] }, third] }),
        "capability-saturation",
        "mixed",
        evidence,
      ),
    ).toContain("same model");
    expect(validateConclusion(state({ maxRounds: 3, rounds }), "capability-saturation", "finite", evidence)).toContain("unlimited");
  });

  test("rejects corrupt or internally contradictory resume entries", () => {
    const first = round(1, { major: 1 });
    const current = state({ rounds: [first] });
    expect(restoreAuditState({ ...current, version: 1 })).toBeUndefined();
    expect(restoreAuditState({ ...current, rounds: [{ ...first, major: 7 }] })).toBeUndefined();
    expect(restoreAuditState({ ...current, capPending: true })).toBeUndefined();
    const stopped = createConclusion(current, "stop", "User stopped the audit", []);
    expect(
      restoreAuditState({
        ...current,
        conclusion: { ...stopped, remaining: { counts: { critical: 0, major: 0, minor: 0, picky: 0 }, findings: [] } },
      }),
    ).toBeUndefined();
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
