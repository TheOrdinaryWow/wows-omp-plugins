import { describe, expect, test } from "bun:test";

import {
  gateOutputSchema,
  parseGateOutput,
  parseVerifyOutput,
  validateGateOutput,
  verifyOutputSchema,
} from "../plugins/omo-prometheus/src/evidence.ts";
import {
  createLedger,
  type ExecutionLedger,
  type LedgerItem,
  noteRetryDispatch,
  recordFailure,
  recordReceipt,
  startRow,
  startVerification,
} from "../plugins/omo-prometheus/src/ledger.ts";

const plan = `# Work plan

## Tasks
- [ ] T1. Implement the change
  - Agent: deep-low
  - Depends on: none
  - Tier: HEAVY
  - Acceptance: changed behavior observed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

const finding = { kind: "new", consequence: "none", summary: "sibling.test.ts:12 uses a fixed 50 ms sleep" };

function fullGate(): { ledger: ExecutionLedger; gate: LedgerItem } {
  const ledger = createLedger("local://example-plan.md", plan);
  for (const row of ledger.items) row.status = "done";
  return { ledger, gate: startRow(ledger, "F2") };
}

function confirmationGate(): { ledger: ExecutionLedger; gate: LedgerItem } {
  const { ledger, gate } = fullGate();
  noteRetryDispatch(gate);
  recordFailure(ledger, gate, {
    outcomeKey: "rejection",
    attempt: gate.attempt as string,
    toolCallId: "rejection",
    sessionId: "session",
    childAgentId: "Rejecting",
    at: Date.now(),
    failureClass: "product",
    check: "code quality",
    firstError: "retention test is nondeterministic",
    signature: "",
    evidence: "Inspected the gate output",
  });
  return { ledger, gate: startRow(ledger, "F2") };
}

function gateOutput(ledger: ExecutionLedger, gate: LedgerItem, extra: Record<string, unknown>): string {
  return JSON.stringify({
    gateId: gate.id,
    planSha256: ledger.planSha256,
    attempt: gate.attempt,
    scope: gate.reviewScope,
    verdict: "FAIL",
    summary: "review finished",
    evidence: ["sibling.test.ts:12"],
    failure: { failureClass: "product", check: "code quality", firstError: "fixed sleep" },
    findings: [finding],
    ...extra,
  });
}

describe("structured gate and verifier verdicts", () => {
  test("a confirmation FAIL listing only new findings without a severe consequence is recorded as PASS", () => {
    const { ledger, gate } = confirmationGate();
    expect(gate.reviewScope).toBe("confirmation");
    const output = gateOutput(ledger, gate, {});
    expect(parseGateOutput(output, ledger, gate)).toMatchObject({ verdict: "PASS", adjudicated: true, findings: [finding] });
    expect(validateGateOutput(output, ledger, gate)).toMatchObject({ verdict: "PASS", summary: "review finished" });
  });

  test("a listed, regressed, unreached or severe finding, no finding at all, or a harness failure keeps a confirmation FAIL", () => {
    const { ledger, gate } = confirmationGate();
    const kept: Array<Record<string, unknown>> = [
      { findings: [] },
      { findings: [finding, { ...finding, kind: "regression" }] },
      { findings: [{ ...finding, kind: "listed" }] },
      { findings: [{ ...finding, kind: "unreached" }] },
      { findings: [{ ...finding, consequence: "secrets" }] },
      { failure: { failureClass: "harness", check: "runner", firstError: "runner missing" } },
    ];
    for (const extra of kept) {
      expect(parseGateOutput(gateOutput(ledger, gate, extra), ledger, gate)).toMatchObject({ verdict: "FAIL", adjudicated: false });
    }
  });

  test("an output that states another scope than the attempt's never passes", () => {
    const { ledger, gate } = fullGate();
    expect(gate.reviewScope).toBe("full");
    expect(parseGateOutput(gateOutput(ledger, gate, {}), ledger, gate)).toMatchObject({ verdict: "FAIL", adjudicated: false });
    const overstated = gateOutput(ledger, gate, { scope: "confirmation" });
    expect(parseGateOutput(overstated, ledger, gate)).toMatchObject({ verdict: "FAIL", adjudicated: false });
    for (const scope of ["confirmation", undefined]) {
      const pass = gateOutput(ledger, gate, { scope, verdict: "PASS", failure: undefined, findings: [] });
      const parsed = parseGateOutput(pass, ledger, gate);
      expect(parsed).toMatchObject({ verdict: "INCONCLUSIVE", adjudicated: false });
      expect(parsed.summary).toContain("this attempt is bound to full");
      expect(parsed.failure).toMatchObject({ failureClass: "harness", check: "output scope" });
      expect(() => validateGateOutput(pass, ledger, gate)).toThrow("F2 did not pass: INCONCLUSIVE");
    }
    const pass = gateOutput(ledger, gate, { verdict: "PASS", failure: undefined });
    expect(parseGateOutput(pass, ledger, gate)).toMatchObject({ verdict: "PASS", adjudicated: false, findings: [finding] });
  });

  test("an attempt started before scopes existed keeps its stated verdict and its then-opaque fields", () => {
    const { ledger, gate } = fullGate();
    gate.reviewScope = undefined;
    const legacyPass = gateOutput(ledger, gate, { verdict: "PASS", failure: undefined, findings: ["no blockers"], reviewedGates: {} });
    expect(parseGateOutput(legacyPass, ledger, gate)).toMatchObject({ verdict: "PASS", adjudicated: false, findings: [] });
    const claimed = gateOutput(ledger, gate, { scope: "confirmation" });
    expect(parseGateOutput(claimed, ledger, gate)).toMatchObject({ verdict: "FAIL", adjudicated: false });
  });

  test("malformed findings on a scoped attempt are refused", () => {
    const { ledger, gate } = confirmationGate();
    for (const findings of [[{ ...finding, kind: "minor" }], [{ ...finding, consequence: "annoying" }], ["no blockers"], "none"]) {
      expect(() => parseGateOutput(gateOutput(ledger, gate, { findings }), ledger, gate)).toThrow("Invalid child findings");
    }
  });

  test("gate and verifier schemas pin the scope the ledger bound, and a verifier output is held to it", () => {
    const { ledger, gate } = confirmationGate();
    const gateSchema = gateOutputSchema(ledger, gate) as { required: string[]; properties: Record<string, unknown> };
    expect(gateSchema.required).toEqual(expect.arrayContaining(["findings", "scope"]));
    expect(gateSchema.properties.scope).toEqual({ const: "confirmation" });

    const fresh = createLedger("local://example-plan.md", plan);
    const row = startRow(fresh, "T1");
    recordReceipt(
      row,
      {
        receiptId: "receipt",
        ledgerId: fresh.ledgerId,
        planSha256: fresh.planSha256,
        rowId: "T1",
        attempt: row.attempt as string,
        childAgentId: "Implementer",
        parentAgentId: "Main",
        sessionId: "session",
        childCreatedAt: 1,
        outputSha256: "b".repeat(64),
        capturedAt: 2,
        nativeFinal: true,
      },
      "implemented",
    );
    startVerification(fresh, "T1");
    const verifySchema = verifyOutputSchema(fresh, row) as { required: string[]; properties: Record<string, unknown> };
    expect(verifySchema.required).toEqual(expect.arrayContaining(["findings", "scope"]));
    expect(verifySchema.properties.scope).toEqual({ const: "full" });
    const verifierOutput = (scope: string, verdict: string) =>
      JSON.stringify({
        rowId: "T1",
        planSha256: fresh.planSha256,
        attempt: row.verification?.attempt,
        scope,
        verdict,
        summary: "one more close order",
        evidence: ["probe.log"],
        findings: [finding],
      });
    expect(parseVerifyOutput(verifierOutput("full", "PASS"), fresh, row)).toMatchObject({ verdict: "PASS", adjudicated: false });
    expect(parseVerifyOutput(verifierOutput("confirmation", "PASS"), fresh, row)).toMatchObject({ verdict: "INCONCLUSIVE" });
    expect(parseVerifyOutput(verifierOutput("confirmation", "FAIL"), fresh, row)).toMatchObject({ verdict: "FAIL", adjudicated: false });
  });
});
