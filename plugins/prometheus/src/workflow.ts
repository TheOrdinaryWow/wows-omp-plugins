/**
 * Pure workflow logic for the Prometheus plugin: command parsing, the trusted
 * approval predicate, the execution-phase tool allowlist, and the system-prompt
 * blocks the runtime appends after the host prompt.
 *
 * Nothing here touches the filesystem, the host, or session state, so each
 * decision can be exercised in isolation.
 */

/** Slash commands that enter (or release) the Prometheus workflow. */
export const PROMETHEUS_COMMANDS: Record<string, true> = { prometheus: true, hyperplan: true };

export type PrometheusCommand =
  /** Enter the workflow; `request` carries any trailing user request. */
  | { kind: "activate"; request: string }
  /** Emergency release of planning/execution state for the current session. */
  | { kind: "release" };

/**
 * Parse `/prometheus` and `/hyperplan`, preserving any trailing request.
 * `off` releases. Matching is case-sensitive, like the host's own builtins.
 */
export function parsePrometheusCommand(text: string): PrometheusCommand | undefined {
  const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name || PROMETHEUS_COMMANDS[name] !== true) return undefined;
  const request = (match[2] ?? "").trim();
  if (request === "off") return { kind: "release" };
  return { kind: "activate", request };
}

export const PROMETHEUS_OPT_IN_QUESTION_ID = "prometheus-workflow-opt-in";
export const PROMETHEUS_STANDARD_OPTION_INDEX = 0;
export const PROMETHEUS_DEEP_OPTION_INDEX = 1;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function canonicalPlanPath(path: string): string {
  return path.replace(/^local:\/(?!\/)/, "local://");
}

/** Compare host plan references while tolerating legacy local:/ spelling. */
export function planReferencesMatch(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && canonicalPlanPath(left) === canonicalPlanPath(right));
}

/** Labels offered by the fixed two-choice opt-in question, if well formed. */
function prometheusOptInLabels(input: unknown): string[] | undefined {
  const args = record(input);
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (questions.length !== 1) return undefined;
  const question = record(questions[0]);
  if (question?.id !== PROMETHEUS_OPT_IN_QUESTION_ID || question.multi === true) return undefined;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  if (rawOptions.length !== 2) return undefined;
  const offered = rawOptions.map((option) => record(option)?.label);
  return offered.every((label): label is string => typeof label === "string") ? offered : undefined;
}

/** Whether an ask call is the fixed two-choice native Prometheus opt-in. */
export function isPrometheusOptInQuestion(input: unknown): boolean {
  return prometheusOptInLabels(input) !== undefined;
}

/**
 * Validate the completed native ask result. Labels may be localized; consent
 * is the non-timeout selection at the fixed Prometheus option index.
 */
export function isPrometheusOptInConsent(input: unknown, details: unknown, isError: boolean, hasUI: boolean): boolean {
  if (isError || !hasUI) return false;
  const offered = prometheusOptInLabels(input);
  if (!offered) return false;
  const result = record(details);
  if (!result || result.chatRedirect === true || result.timedOut === true) return false;
  const resultOptions = stringArray(result.options);
  const selected = stringArray(result.selectedOptions);
  return (
    resultOptions?.length === offered.length &&
    resultOptions.every((label, index) => label === offered[index]) &&
    selected?.length === 1 &&
    selected[0] === offered[PROMETHEUS_DEEP_OPTION_INDEX] &&
    result.customInput === undefined
  );
}

/** Canonical plan path carried by a successful native `write xd://propose` result. */
export function proposedPlanPathFromToolResult(toolName: string, isError: boolean, details: unknown): string | undefined {
  if (toolName !== "write" || isError) return undefined;
  const xdev = record(record(details)?.xdev);
  if (xdev?.tool !== "propose" || xdev.mode !== "execute") return undefined;
  const inner = record(xdev.inner);
  const path = typeof inner?.planFilePath === "string" ? inner.planFilePath.trim() : "";
  if (!path || inner?.planExists !== true) return undefined;
  return canonicalPlanPath(path);
}

/**
 * Trusted detection of the host's post-approval handoff turn. A proposal
 * result, the host-owned reference, and the complete native synthetic envelope
 * must all agree; ordinary user text such as `Plan approved.` is insufficient.
 */
export function isApprovedPlanHandoff(
  prompt: string,
  proposedPlanFilePath: string | undefined,
  planReferencePath: string | undefined,
): boolean {
  if (!proposedPlanFilePath || !planReferencePath) return false;
  const proposed = canonicalPlanPath(proposedPlanFilePath);
  if (!planReferencesMatch(planReferencePath, proposed)) return false;
  const text = prompt.trimStart();
  if (!text.startsWith("Plan approved.\n")) return false;
  if (!text.includes(`<plan path="${proposed}">`) || !text.includes("</plan>")) return false;
  return text.includes(`Full plan inlined below; durable copy at \`${proposed}\``);
}

/** Parent-session orchestration and observation surfaces retained by Atlas. */
const ALLOWED_TOOLS: Record<string, true> = {
  ask: true,
  find: true,
  glob: true,
  grep: true,
  prometheus_release: true,
  task: true,
  think: true,
  todo: true,
  web_search: true,
};

const READ_ONLY_LSP_ACTIONS: Record<string, true> = {
  capabilities: true,
  definition: true,
  diagnostics: true,
  hover: true,
  implementation: true,
  references: true,
  status: true,
  symbols: true,
  type_definition: true,
};

const OBSERVING_OR_COORDINATING_HUB_OPS: Record<string, true> = {
  cancel: true,
  describe: true,
  inbox: true,
  jobs: true,
  list: true,
  logs: true,
  ps: true,
  send: true,
  wait: true,
};

const SAFE_XDEV_TOOLS: Record<string, true> = {
  ...ALLOWED_TOOLS,
  hub: true,
  lsp: true,
  read: true,
};

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

export interface NestedXdevToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  documentation: boolean;
}

/** Decode the inner call transported by `write xd://<tool>`. */
export function nestedXdevToolCall(input: unknown): NestedXdevToolCall | undefined {
  const args = record(input);
  const path = stringField(args ?? {}, "path");
  const match = /^xd:\/\/([^/?#]+)\/?$/.exec(path);
  if (!match?.[1]) return undefined;
  let toolName: string;
  try {
    toolName = decodeURIComponent(match[1]);
  } catch {
    toolName = match[1];
  }
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  if (content === "?") return { toolName, documentation: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { toolName, documentation: false };
  }
  return { toolName, input: record(parsed), documentation: false };
}

function readBlockReason(input: Record<string, unknown>): string | undefined {
  const path = stringField(input, "path").toLowerCase();
  if (path.startsWith("ssh://")) return "`ssh://` resolution starts a remote shell rather than a local read backend";
  // Native SQLite reads run through a query-only connection. `?q=` on images,
  // agent URLs, and web URLs is also an observation surface, not SQL.
  return undefined;
}

function lspBlockReason(input: Record<string, unknown>): string | undefined {
  const action = stringField(input, "action");
  if (!action) return "an `lsp` call without an explicit observation action";
  if (READ_ONLY_LSP_ACTIONS[action] === true) return undefined;
  if (action === "code_actions" && input.apply !== true) return undefined;
  if (action === "request") return "raw `lsp` requests can invoke arbitrary server commands";
  return `\`lsp\` action \`${action}\` can mutate files or server state`;
}

function hubBlockReason(input: Record<string, unknown>): string | undefined {
  const op = stringField(input, "op");
  if (!op) return "a `hub` call without an explicit op";
  if (input.signal !== undefined || input.keys !== undefined || input.text !== undefined) {
    return "`hub` process input (signal/keys/stdin) is an execution surface";
  }
  if (op === "send" && stringField(input, "name")) return "`hub send` with `name` writes to a supervised process";
  if (OBSERVING_OR_COORDINATING_HUB_OPS[op] !== true) return `\`hub\` op \`${op}\` starts or mutates a process`;
  return undefined;
}

function writeBlockReason(input: Record<string, unknown>): string {
  const path = stringField(input, "path");
  const nested = nestedXdevToolCall(input);
  if (!nested) {
    return path.toLowerCase().startsWith("xd://")
      ? "the `xd://` target or its JSON payload is not a valid guarded device call"
      : "normal file/database/archive writes are direct implementation";
  }
  if (SAFE_XDEV_TOOLS[nested.toolName] !== true) {
    return `\`xd://${nested.toolName}\` is not an approved orchestration or observation device`;
  }
  if (nested.documentation) return "";
  if (!nested.input) return `\`xd://${nested.toolName}\` requires a JSON object before it can be safety-classified`;
  return executionBlockReason(nested.toolName, nested.input) ?? "";
}

/**
 * Why a tool call must not run in the Atlas parent, or `undefined` when it is
 * orchestration/observation. Nested xdev calls are classified recursively and
 * their real inner dispatch is intercepted again by the host's `tool_call` event.
 */
export function executionBlockReason(toolName: string, input: unknown): string | undefined {
  if (ALLOWED_TOOLS[toolName] === true) return undefined;
  const args = record(input) ?? {};
  switch (toolName) {
    case "read":
      return readBlockReason(args);
    case "lsp":
      return lspBlockReason(args);
    case "hub":
      return hubBlockReason(args);
    case "write": {
      const reason = writeBlockReason(args);
      return reason || undefined;
    }
    default:
      return `\`${toolName}\` is neither an orchestration tool nor a read-only inspection surface`;
  }
}

/** Reject extension/MCP shadows of host tools and untrusted release shadows. */
export function executionToolSourceBlockReason(
  toolName: string,
  source: string | undefined,
  trustedPrometheusTool = false,
): string | undefined {
  if (toolName === "prometheus_release") {
    return trustedPrometheusTool ? undefined : "`prometheus_release` is not the plugin-owned confirmed-release tool";
  }
  if (source === "builtin") return undefined;
  return `\`${toolName}\` resolves to ${source ? `a ${source} tool` : "an unverified tool"}, not a trusted native/plugin tool`;
}

/** Model-facing explanation returned with a blocked tool call. */
export function blockedToolMessage(toolName: string, detail: string): string {
  return [
    `Prometheus execution guard: this main session is Atlas, so \`${toolName}\` is blocked here — ${detail}.`,
    "Delegate implementation, tests, QA, documentation, cleanup, and final verification to child agents with `task`; the parent only orchestrates, tracks `todo`, collects results, and observes.",
    "This overrides implementation preferences such as `task.eager`. A disabled `task` tool or denied spawn is a capability blocker: report it and do not implement in the parent.",
    "This is an extension interception policy, not an operating-system sandbox. The user can release it with `/prometheus off`.",
  ].join("\n");
}

export const BLOCKED_TOOL_NOTICE =
  "Prometheus: Atlas cannot implement directly. Delegate every plan task to children; if spawning is disabled, report the capability block. Release only with /prometheus off or a confirmed release request.";

export const EXECUTION_START_NOTICE =
  "Prometheus: native plan approval verified — Atlas execution is active. All implementation and verification is delegated; release only with /prometheus off or a confirmed release request.";

export const PLANNING_PREAMBLE = [
  "# Prometheus planning workflow (active)",
  "",
  "The Prometheus workflow owns this native plan-mode session. Follow the complete workflow below until native approval or an explicit user exit.",
  "Do not repeat opt-in, do not mix in the host's generic planning workflow, and do not announce this instruction block. Keep native read-only boundaries and submit the final local://<slug>-plan.md only through write xd://propose.",
].join("\n");

export const EXECUTION_PREAMBLE = [
  "# Prometheus execution (Atlas)",
  "",
  "A Prometheus plan was approved through the host's native approval flow. This main session is Atlas, the orchestrator of that exact approved plan.",
  "Every plan task — implementation, tests, QA, documentation, cleanup, and final verification — MUST be executed by child agents spawned with `task`. Atlas delegates, tracks `todo`, collects and inspects child evidence, and uses observation/coordination tools only.",
  "This overrides `task.eager` and every preference that would permit parent implementation. It does not override capability policy: if `task` is disabled or spawning is denied, report the blocker and never downgrade to parent implementation.",
  "The runtime guard is policy interception, not an OS sandbox. It stays active after completion until the user explicitly releases it. Once every plan item has child-produced proof, call `prometheus_release` exactly once with a concise evidence summary; only human confirmation releases the guard. `/prometheus off` is the user's direct escape hatch.",
].join("\n");

export const OPT_IN_ADDENDUM = [
  "# Native plan-mode depth choice (Prometheus plugin)",
  "",
  "Classify the request before planning. `SIMPLE` means outcome, scope, constraints, and material decisions are already settled and ordinary native planning is sufficient. `COMPLEX` means cross-cutting work, architecture/migration choices, unresolved tradeoffs, or substantial delegated execution.",
  "For `SIMPLE`: continue ordinary native plan mode immediately. Do NOT show an opt-in popup and do NOT call `prometheus_activate`.",
  `For \`COMPLEX\`: call \`ask\` once with exactly one single-select question whose id is \`${PROMETHEUS_OPT_IN_QUESTION_ID}\`. Offer exactly two choices: index ${PROMETHEUS_STANDARD_OPTION_INDEX} is standard native planning and index ${PROMETHEUS_DEEP_OPTION_INDEX} is Prometheus deep planning. Labels may be localized, but those indices and the id are fixed; recommend index ${PROMETHEUS_DEEP_OPTION_INDEX}.`,
  `Only a non-timeout user selection of index ${PROMETHEUS_DEEP_OPTION_INDEX} authorizes \`prometheus_activate\`. Call it with \`{ "questionId": "${PROMETHEUS_OPT_IN_QUESTION_ID}", "selectedOptionIndex": ${PROMETHEUS_DEEP_OPTION_INDEX} }\`. Cancellation, empty selection, custom input, timeout, chat redirect, or index ${PROMETHEUS_STANDARD_OPTION_INDEX} means continue native planning and never activate.`,
  "Do not mention this instruction block and do not ask the depth choice again in the same native plan-mode episode.",
].join("\n");
