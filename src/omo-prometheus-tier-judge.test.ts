import { describe, expect, test } from "bun:test";

import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import type { ChainJudge, JudgeKind } from "@oh-my-pi/pi-coding-agent/judgment";

import type { ParsedPlan } from "../plugins/omo-prometheus/src/ledger.ts";
import {
  DEFAULT_TIER_JUDGE_SETTINGS,
  decideTier,
  evaluateTierRow,
  parseTierJudgeSettings,
  TierJudge,
  type TierProbabilities,
  tierJudgeState,
} from "../plugins/omo-prometheus/src/tier-judge.ts";

function task(id = "T1", tierBasis?: string): ParsedPlan["items"][number] {
  return {
    id,
    title: `Work ${id}`,
    agent: "task",
    acceptance: "observed",
    dependsOn: [],
    status: "open",
    tier: "light",
    bodyLines: ["  - Acceptance: observed"],
    ...(tierBasis === undefined ? {} : { tierBasis }),
  };
}

function judgeFixture(
  query: (state: string, signal?: AbortSignal) => Promise<TierProbabilities>,
  kind: JudgeKind = "native",
): Pick<ChainJudge, "withCandidate"> {
  const candidate: Judge = {
    label: "controlled judgment",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: { signal?: AbortSignal }): Promise<JudgmentResult<Q>> {
      expect(Object.keys(request.questions).sort()).toEqual(["kind", "tier"]);
      const probabilities = await query(String(request.state), options?.signal);
      return {
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        answers: {
          tier: {
            type: "choice",
            choice: probabilities.heavy >= 0.5 ? "HEAVY" : "LIGHT",
            probabilities: { HEAVY: probabilities.heavy, LIGHT: 1 - probabilities.heavy },
            confidence: 1,
          },
          kind: {
            type: "choice",
            choice: "production",
            probabilities: { production: probabilities.production, tests: 1 - probabilities.production, docs: 0, ui: 0, tooling: 0 },
            confidence: 1,
          },
        },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as JudgmentResult<Q>;
    },
  };
  return { withCandidate: async (run) => run(candidate, kind) };
}

describe("tier decision", () => {
  test.each([
    { heavy: 0.9, production: 0.1, threshold: 0.6, p: 0.1, tier: "light" },
    { heavy: 0.1, production: 0.9, threshold: 0.6, p: 0.1, tier: "light" },
    { heavy: 0.2, production: 1, threshold: 0.6, p: 0.2, tier: "light" },
    { heavy: 0.20001, production: 1, threshold: 0.6, p: 0.20001, tier: undefined },
    { heavy: 0.8, production: 1, threshold: 0.6, p: 0.8, tier: "heavy" },
    { heavy: 0.79999, production: 1, threshold: 0.6, p: 0.79999, tier: undefined },
    { heavy: 0.75, production: 1, threshold: 0.5, p: 0.75, tier: "heavy" },
    { heavy: 0.25, production: 1, threshold: 0.5, p: 0.25, tier: "light" },
    { heavy: 0.49999, production: 1, threshold: 0, p: 0.49999, tier: "light" },
    { heavy: 0.5, production: 1, threshold: 0, p: 0.5, tier: "heavy" },
    { heavy: 0.50001, production: 1, threshold: 0, p: 0.50001, tier: "heavy" },
    { heavy: 0.5, production: 1, threshold: 0.001, p: 0.5, tier: undefined },
    { heavy: 1, production: 1, threshold: 1, p: 1, tier: "heavy" },
    { heavy: 0, production: 1, threshold: 1, p: 0, tier: "light" },
  ])("uses min probabilities and an inclusive confidence threshold: $heavy / $production / $threshold", (row) => {
    const result = decideTier(row, row.threshold);
    expect(result.heavyProbability).toBe(row.p);
    expect(result.confidence).toBeCloseTo(Math.abs(2 * row.p - 1));
    expect(result.tier).toBe(row.tier);
  });
});

describe("per-row tier gate", () => {
  const light = decideTier({ heavy: 0.1, production: 1 }, 0.6);
  const heavy = decideTier({ heavy: 0.9, production: 1 }, 0.6);
  const undecided = decideTier({ heavy: 0.55, production: 1 }, 0.6);
  test.each([
    { label: "owner overrides the judge", row: { ...task(), tierBasis: "owner — user confirmed" }, decision: heavy, refusal: undefined },
    { label: "owner bypasses fallback", row: { ...task(), tierBasis: "OWNER — user confirmed" }, decision: undefined, refusal: undefined },
    {
      label: "LIGHT conflicts with a HEAVY judgment",
      row: task(),
      decision: heavy,
      refusal: /T1:.*HEAVY with confidence 0\.800.*ask the user.*owner —/,
    },
    {
      label: "HEAVY conflicts with a LIGHT judgment",
      row: { ...task(), tier: "heavy" as const },
      decision: light,
      refusal: /LIGHT with confidence 0\.800/,
    },
    {
      label: "a planner basis cannot override the judge",
      row: task("T1", "lower risk"),
      decision: heavy,
      refusal: /Change Tier: to HEAVY.*remove any planner basis/,
    },
    {
      label: "a matching settled tier cannot retain a basis",
      row: task("T1", "acceptance catches failures"),
      decision: light,
      refusal: /LIGHT with confidence.*Remove the Tier basis: line/,
    },
    { label: "a matching settled tier needs no basis", row: task(), decision: light, refusal: undefined },
    {
      label: "an undecided tier needs a basis",
      row: task(),
      decision: undecided,
      refusal: /T1:.*HEAVY probability 0\.550.*written criteria.*add Tier basis:/,
    },
    {
      label: "an undecided tier accepts the planner basis",
      row: task("T1", "acceptance catches failures"),
      decision: undecided,
      refusal: undefined,
    },
    { label: "fallback needs a basis", row: task(), decision: undefined, refusal: /T1:.*no native tier judgment.*add Tier basis:/ },
    {
      label: "fallback accepts either tier with a basis",
      row: { ...task("T1", "consequence applies"), tier: "heavy" as const },
      decision: undefined,
      refusal: undefined,
    },
    { label: "ownership is not the owner marker", row: task("T1", "ownership alone"), decision: heavy, refusal: /Change Tier: to HEAVY/ },
  ])("$label", ({ row, decision, refusal }) => {
    const result = evaluateTierRow(row, decision);
    if (refusal) expect(result).toMatch(refusal);
    else expect(result).toBeUndefined();
  });
});

describe("tier judge state", () => {
  test("keeps ordered indented task content but removes tier fields, their continuation and whole tier words", () => {
    const state = tierJudgeState({
      title: "Keep the export bounded",
      bodyLines: [
        "  - Agent: task",
        "  - tIeR: HEAVY",
        "    Do not leak the previous classification",
        "      or this deeper continuation",
        "  - Tier basis: owner — keep LIGHT",
        "    This decision must not leak either",
        "  - Change: HEAVY or LIGHT, not HEAVYWEIGHT or LIGHTHOUSE",
        "",
        "not part of the indented body",
        "  - Acceptance: observed",
      ],
    });
    expect(state).toBe(
      "Task: Keep the export bounded\n  - Agent: task\n  - Change:  or , not HEAVYWEIGHT or LIGHTHOUSE\n  - Acceptance: observed",
    );
    expect(state).not.toMatch(/\b(HEAVY|LIGHT)\b|Tier basis:|tIeR:/);
  });

  test("truncates the complete state at 7000 characters after redaction", () => {
    const state = tierJudgeState({ title: "Bounded", bodyLines: [`  - Change: ${"x".repeat(8000)}`] });
    expect(state).toBe(`Task: Bounded\n  - Change: ${"x".repeat(8000)}`.slice(0, 7000));
  });
});

describe("tier judge session", () => {
  test("requires bases with the setting off without resolving a judge", async () => {
    const gate = new TierJudge(
      () => {
        throw new Error("must not resolve");
      },
      () => {
        throw new Error("must not notify");
      },
    );
    const settings = { ...DEFAULT_TIER_JUDGE_SETTINGS, enabled: false };
    expect(await gate.check([task("T1"), task("T2"), task("T3", "owner — confirmed")], settings)).toMatch(/T1:.*\nT2:/);
    expect(await gate.check([task("T1", "acceptance catches failures")], settings)).toBeUndefined();
  });

  test("never calls a non-native candidate and warns only once per session", async () => {
    const notices: string[] = [];
    const gate = new TierJudge(
      () =>
        judgeFixture(async () => {
          throw new Error("chat judge must not run");
        }, "online"),
      (message) => notices.push(message),
    );
    expect(await gate.check([task()], DEFAULT_TIER_JUDGE_SETTINGS)).toMatch(/T1:.*no native tier judgment/);
    expect(await gate.check([task("T1", "acceptance catches failures")], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/native judge/);
  });

  test("caches successful states across tier edits and deduplicates identical states", async () => {
    const states: string[] = [];
    const gate = new TierJudge(
      () =>
        judgeFixture(async (state) => {
          states.push(state);
          return { heavy: 0.1, production: 1 };
        }),
      () => {},
    );
    const first = task();
    expect(await gate.check([first, { ...first, id: "T2" }], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
    expect(await gate.check([{ ...first, tier: "heavy" }], DEFAULT_TIER_JUDGE_SETTINGS)).toMatch(/judge decided LIGHT/);
    expect(states).toHaveLength(1);
    expect(await gate.check([{ ...first, bodyLines: ["  - Change: different"] }], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
    expect(states).toHaveLength(2);
  });

  test("skips the judge entirely for owner-decided tasks", async () => {
    const gate = new TierJudge(
      () => {
        throw new Error("must not resolve");
      },
      () => {
        throw new Error("must not notify");
      },
    );
    expect(await gate.check([task("T1", "owner — confirmed")], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
  });

  test("limits concurrent task judgments to four", async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let started = 0;
    let active = 0;
    let maximum = 0;
    const gate = new TierJudge(
      () =>
        judgeFixture(async () => {
          started += 1;
          active += 1;
          maximum = Math.max(maximum, active);
          if (started === 4) ready.resolve();
          await release.promise;
          active -= 1;
          return { heavy: 0.1, production: 1 };
        }),
      () => {},
    );
    const result = gate.check(
      Array.from({ length: 7 }, (_, i) => task(`T${i + 1}`)),
      DEFAULT_TIER_JUDGE_SETTINGS,
    );
    await ready.promise;
    expect(started).toBe(4);
    release.resolve();
    expect(await result).toBeUndefined();
    expect(started).toBe(7);
    expect(maximum).toBe(4);
  });

  test("does not cache failures and reports each failed call", async () => {
    const notices: string[] = [];
    let calls = 0;
    const gate = new TierJudge(
      () =>
        judgeFixture(async () => {
          calls += 1;
          throw new Error("controlled failure");
        }),
      (message) => notices.push(message),
    );
    expect(await gate.check([task()], DEFAULT_TIER_JUDGE_SETTINGS)).toMatch(/T1:.*add Tier basis:/);
    expect(await gate.check([task("T1", "bounded")], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
    expect(calls).toBe(2);
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.includes("controlled failure"))).toBe(true);
  });

  test("keeps earlier judgments binding while the judge is down and asks a basis only of unsettled tasks", async () => {
    const notices: string[] = [];
    let down = false;
    const gate = new TierJudge(
      () =>
        judgeFixture(async () => {
          if (down) throw new Error("controlled outage");
          return { heavy: 0.1, production: 1 };
        }),
      (message) => notices.push(message),
    );
    const settled = task("T1");
    expect(await gate.check([settled], DEFAULT_TIER_JUDGE_SETTINGS)).toBeUndefined();
    down = true;
    const added = [2, 3, 4, 5, 6].map((n) => ({ ...task(`T${n}`), bodyLines: [`  - Change: new work ${n}`] }));
    const refusal = await gate.check([{ ...settled, tier: "heavy" }, ...added], DEFAULT_TIER_JUDGE_SETTINGS);
    expect(refusal).toMatch(/T1: the judge decided LIGHT/);
    for (const row of added) expect(refusal).toContain(`${row.id}: no native tier judgment is available`);
    expect(notices).toHaveLength(1);
  });

  test("combines caller cancellation with the check deadline even when the candidate ignores abort", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const answer = Promise.withResolvers<TierProbabilities>();
    const caller = new AbortController();
    const notices: string[] = [];
    const gate = new TierJudge(
      () =>
        judgeFixture(async (_state, signal) => {
          started.resolve(signal);
          return await answer.promise;
        }),
      (message) => notices.push(message),
    );
    const result = gate.check([task()], DEFAULT_TIER_JUDGE_SETTINGS, caller.signal);
    const signal = await started.promise;
    caller.abort(new Error("caller cancelled"));
    expect(await result).toMatch(/T1:.*add Tier basis:/);
    expect(signal?.aborted).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/caller cancelled/);
    answer.resolve({ heavy: 0.1, production: 1 });
  });
});

test("tier settings validate independently and preserve inclusive probability endpoints", () => {
  const warnings: string[] = [];
  expect(parseTierJudgeSettings({}, (message) => warnings.push(message))).toEqual({ enabled: true, minimumConfidence: 0.6 });
  for (const threshold of [0, 1]) {
    expect(parseTierJudgeSettings({ tierJudge: false, tierJudgeConfidence: threshold }, (message) => warnings.push(message))).toEqual({
      enabled: false,
      minimumConfidence: threshold,
    });
  }
  expect(warnings).toEqual([]);
  for (const value of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.6", null]) {
    expect(parseTierJudgeSettings({ tierJudge: false, tierJudgeConfidence: value }, (message) => warnings.push(message))).toEqual({
      enabled: false,
      minimumConfidence: 0.6,
    });
  }
  expect(parseTierJudgeSettings({ tierJudge: "true", tierJudgeConfidence: 0.8 }, (message) => warnings.push(message))).toEqual({
    enabled: true,
    minimumConfidence: 0.8,
  });
  expect(warnings).toHaveLength(7);
});
