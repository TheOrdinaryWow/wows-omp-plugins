import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PACKAGE_NAME = "wows-omp-plugin-jev-dispatch";
const CHILD_SCENARIO_ENV = "JEV_DISPATCH_AUTH_TEST_SCENARIO";
const CHILD_OUTPUT_MARKER = "JEV_DISPATCH_AUTH_RESULT:";
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_URL = pathToFileURL(join(dirname(THIS_FILE), "../plugins/jev-dispatch/src/index.ts")).href;

interface InvocationSpec {
  project: string;
  surface: "enhanced" | "standard";
  candidateCount?: number;
  toolCatalog?: "empty" | "one";
}

interface ChildScenario {
  invocations: InvocationSpec[];
  response: "success" | "unauthorized" | "network-error";
  environmentKey?: string;
  answerChoice?: string;
}

interface RecordedRequest {
  url: string;
  authorization: string | null;
  body: string;
}

interface InvocationReport {
  result?: {
    agent?: string;
    block?: boolean;
    reason?: string;
  };
  warnings: unknown[];
  notifications: unknown[];
  usage: unknown[];
  getAllToolsCalls: number;
}

interface ChildReport {
  requests: RecordedRequest[];
  invocations: InvocationReport[];
}

type TestHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

const CANDIDATES = [
  {
    name: "scout",
    description: "Read-only repository investigator",
    source: "test fixture",
    readOnly: true,
    model: { patterns: ["fixture/scout"], fallbackChain: [] },
  },
  {
    name: "writer",
    description: "Write-capable implementation agent",
    source: "test fixture",
    readOnly: false,
    model: { patterns: ["fixture/writer"], fallbackChain: [] },
  },
] as const;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function executeChildScenario(scenario: ChildScenario): Promise<ChildReport> {
  const previousBaseUrl = process.env.TYPESAFE_BASE_URL;
  const previousModel = process.env.TYPESAFE_DEFAULT_MODEL;
  const previousApiKey = process.env.TYPESAFE_API_KEY;
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  let stopServer: (() => void) | undefined;

  try {
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-auth-test";
    if (Object.hasOwn(scenario, "environmentKey")) process.env.TYPESAFE_API_KEY = scenario.environmentKey;
    else delete process.env.TYPESAFE_API_KEY;

    if (scenario.response === "network-error") {
      process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("authorization"),
          body: typeof init?.body === "string" ? init.body : "",
        });
        throw new TypeError(`simulated network failure: ${headers.get("authorization")}`);
      }) as unknown as typeof fetch;
    } else {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") {
            return new Response(null, { status: 204 });
          }
          const body = await request.text();
          requests.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
            body,
          });
          if (scenario.response === "unauthorized")
            return new Response(`rejected ${request.headers.get("authorization")}`, { status: 401 });

          const payload = JSON.parse(body) as {
            questions?: { agent?: { criteria?: Record<string, unknown> } };
          };
          const choices = Object.keys(payload.questions?.agent?.criteria ?? {});
          const choice = scenario.answerChoice ?? choices.at(-1) ?? "";
          return Response.json({
            model: "jev-auth-test",
            answers: {
              agent: {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(choices.map((name) => [name, name === choice ? 1 : 0])),
                confidence: 0.99,
              },
            },
            usage: { input_tokens: 17, output_tokens: 3 },
          });
        },
      });
      process.env.TYPESAFE_BASE_URL = server.url.origin;
      stopServer = () => server.stop(true);
    }

    // This runtime-selected absolute URL keeps the child fixture on the same plugin source as the parent checkout.
    const { default: registerJevDispatch } = await import(PLUGIN_URL);
    const invocationReports: InvocationReport[] = [];

    for (const [invocationIndex, invocation] of scenario.invocations.entries()) {
      const handlers = new Map<string, TestHandler[]>();
      const warnings: unknown[] = [];
      const notifications: unknown[] = [];
      const usage: unknown[] = [];
      let getAllToolsCalls = 0;

      const api = {
        pi: { SUBAGENT_ROUTING_EXTENSION_API_VERSION: 2 },
        logger: {
          warn(message: unknown, details?: unknown) {
            warnings.push(details === undefined ? message : [message, details]);
          },
        },
        on(event: string, handler: TestHandler) {
          const registered = handlers.get(event) ?? [];
          registered.push(handler);
          handlers.set(event, registered);
        },
        getAllTools() {
          getAllToolsCalls += 1;
          if (invocation.toolCatalog === "one") {
            return [
              {
                name: "task",
                description: "# Available Agents\n### scout\nRead-only investigator",
                parameters: {},
                source: "builtin",
              },
            ];
          }
          return [];
        },
      } as unknown as ExtensionAPI;

      const context = {
        cwd: invocation.project,
        ui: {
          notify(message: unknown, level?: unknown) {
            notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionId: () => `auth-session-${invocationIndex}`,
          getLeafId: () => `auth-leaf-${invocationIndex}`,
          appendModelUsage(entry: unknown, options: unknown) {
            usage.push({ entry, options });
          },
        },
        modelRegistry: { find: () => undefined },
      } as unknown as ExtensionContext;

      const onlyHandler = (event: string): TestHandler => {
        const registered = handlers.get(event) ?? [];
        if (registered.length !== 1) throw new Error(`expected one ${event} handler, received ${registered.length}`);
        return registered[0] as TestHandler;
      };

      registerJevDispatch(api);
      await onlyHandler("session_start")({ type: "session_start" }, context);

      let result: unknown;
      if (invocation.surface === "enhanced") {
        result = await onlyHandler("before_subagent_spawn")(
          {
            type: "before_subagent_spawn",
            invocationKind: "task",
            assignment: "Implement the requested repository change",
            context: "Preserve existing conventions",
            requestedAgent: "scout",
            candidates: CANDIDATES.slice(0, invocation.candidateCount ?? CANDIDATES.length),
          },
          context,
        );
      } else {
        result = await onlyHandler("tool_call")(
          {
            type: "tool_call",
            toolCallId: `auth-tool-${invocationIndex}`,
            toolName: "task",
            input: { task: "Implement the requested repository change", agent: "scout" },
          },
          context,
        );
      }

      invocationReports.push({
        result: result as InvocationReport["result"],
        warnings,
        notifications,
        usage,
        getAllToolsCalls,
      });
    }

    return { requests, invocations: invocationReports };
  } finally {
    stopServer?.();
    globalThis.fetch = originalFetch;
    restoreEnvironment("TYPESAFE_BASE_URL", previousBaseUrl);
    restoreEnvironment("TYPESAFE_DEFAULT_MODEL", previousModel);
    restoreEnvironment("TYPESAFE_API_KEY", previousApiKey);
  }
}

async function createProject(settings: Record<string, unknown>): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "jev-dispatch-auth-"));
  const configDirectory = join(project, ".omp");
  await mkdir(configDirectory, { recursive: true });
  await Bun.write(join(configDirectory, "plugin-overrides.json"), JSON.stringify({ settings: { [PACKAGE_NAME]: settings } }));
  return project;
}

async function withProjects<T>(settings: Record<string, unknown>[], run: (projects: string[]) => Promise<T>): Promise<T> {
  const projects: string[] = [];
  try {
    for (const projectSettings of settings) projects.push(await createProject(projectSettings));
    return await run(projects);
  } finally {
    await Promise.all(projects.map((project) => rm(project, { recursive: true, force: true })));
  }
}

async function runIsolatedScenario(scenario: ChildScenario): Promise<ChildReport> {
  const isolationRoot = scenario.invocations[0]?.project;
  if (!isolationRoot) throw new Error("auth scenario requires at least one invocation");

  const child = Bun.spawn({
    cmd: [process.execPath, THIS_FILE],
    cwd: isolationRoot,
    env: {
      HOME: isolationRoot,
      XDG_CACHE_HOME: join(isolationRoot, ".xdg-cache"),
      XDG_CONFIG_HOME: join(isolationRoot, ".xdg-config"),
      XDG_DATA_HOME: join(isolationRoot, ".xdg-data"),
      XDG_STATE_HOME: join(isolationRoot, ".xdg-state"),
      PI_CODING_AGENT_DIR: join(isolationRoot, ".agent"),
      NO_COLOR: "1",
      [CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`isolated auth fixture exited ${exitCode}\n${stderr}\n${stdout}`);

  const resultLine = stdout.split("\n").find((line) => line.startsWith(CHILD_OUTPUT_MARKER));
  if (!resultLine) throw new Error(`isolated auth fixture returned no result\n${stderr}\n${stdout}`);
  return JSON.parse(resultLine.slice(CHILD_OUTPUT_MARKER.length)) as ChildReport;
}

function diagnosticsWithoutAuthorization(report: ChildReport): string {
  return JSON.stringify({
    invocations: report.invocations,
    requests: report.requests.map(({ url, body }) => ({ url, body })),
  });
}

async function registerTests(): Promise<void> {
  // The child fixture executes this file outside Bun's test runner, so only the parent branch may load bun:test.
  const { describe, expect, test } = await import("bun:test");

  describe.serial("jev-dispatch authentication boundary", () => {
    test("a trimmed environment key wins over the manual setting and routes through a real TypeSafe response", async () => {
      await withProjects(
        [
          {
            integrationMode: "enhanced",
            minimumConfidence: 0.7,
            includeSharedContext: true,
            apiKey: " manual-loser ",
          },
        ],
        async ([project]) => {
          const report = await runIsolatedScenario({
            invocations: [{ project: project as string, surface: "enhanced" }],
            response: "success",
            environmentKey: "  environment-winner  ",
            answerChoice: "writer",
          });

          expect(report.requests).toHaveLength(1);
          expect(report.requests[0]?.authorization).toBe("Bearer environment-winner");
          expect(report.invocations[0]?.result).toEqual({ agent: "writer" });
          expect(report.invocations[0]?.usage).toHaveLength(1);
          expect(diagnosticsWithoutAuthorization(report)).not.toContain("environment-winner");
          expect(diagnosticsWithoutAuthorization(report)).not.toContain("manual-loser");
        },
      );
    });

    for (const [label, environmentKey] of [
      ["absent", undefined],
      ["blank", " \t "],
    ] as const) {
      test(`the manual setting authenticates when the environment key is ${label}`, async () => {
        await withProjects(
          [
            {
              integrationMode: "enhanced",
              minimumConfidence: 0.7,
              includeSharedContext: true,
              apiKey: "  manual-auth-key  ",
            },
          ],
          async ([project]) => {
            const report = await runIsolatedScenario({
              invocations: [{ project: project as string, surface: "enhanced" }],
              response: "success",
              ...(environmentKey === undefined ? {} : { environmentKey }),
              answerChoice: "writer",
            });

            expect(report.requests).toHaveLength(1);
            expect(report.requests[0]?.authorization).toBe("Bearer manual-auth-key");
            expect(report.invocations[0]?.result).toEqual({ agent: "writer" });
            expect(diagnosticsWithoutAuthorization(report)).not.toContain("manual-auth-key");
          },
        );
      });
    }

    test("manual keys remain scoped to their own session project", async () => {
      await withProjects(
        [
          { integrationMode: "enhanced", apiKey: "first-session-key" },
          { integrationMode: "enhanced", apiKey: "second-session-key" },
        ],
        async ([firstProject, secondProject]) => {
          const report = await runIsolatedScenario({
            invocations: [
              { project: firstProject as string, surface: "enhanced" },
              { project: secondProject as string, surface: "enhanced" },
            ],
            response: "success",
            answerChoice: "writer",
          });

          expect(report.requests.map((request) => request.authorization)).toEqual([
            "Bearer first-session-key",
            "Bearer second-session-key",
          ]);
          expect(report.invocations.map((invocation) => invocation.result)).toEqual([{ agent: "writer" }, { agent: "writer" }]);
          expect(diagnosticsWithoutAuthorization(report)).not.toContain("first-session-key");
          expect(diagnosticsWithoutAuthorization(report)).not.toContain("second-session-key");
        },
      );
    });

    test("missing credentials block both routing surfaces before candidate or tool discovery", async () => {
      await withProjects(
        [
          { integrationMode: "enhanced", apiKey: " \t " },
          { integrationMode: "standard", apiKey: " \t " },
        ],
        async ([enhancedProject, standardProject]) => {
          const report = await runIsolatedScenario({
            invocations: [
              { project: enhancedProject as string, surface: "enhanced", candidateCount: 0 },
              { project: enhancedProject as string, surface: "enhanced", candidateCount: 1 },
              { project: standardProject as string, surface: "standard", toolCatalog: "empty" },
              { project: standardProject as string, surface: "standard", toolCatalog: "one" },
            ],
            response: "success",
            environmentKey: " \t ",
          });

          expect(report.requests).toHaveLength(0);
          for (const invocation of report.invocations) {
            expect(invocation.result?.block).toBe(true);
            expect(typeof invocation.result?.reason).toBe("string");
            expect(invocation.result?.reason?.trim().length).toBeGreaterThan(0);
            expect(invocation.usage).toHaveLength(0);
          }
        },
      );
    });

    test("an environment credential rejected with 401 fails open without trying the manual key or leaking either key", async () => {
      const rejectedEnvironmentKey = ["rejected", "environment", "key"].join("-");
      const manualKey = ["manual", "fallback", "must", "not", "run"].join("-");
      await withProjects([{ integrationMode: "enhanced", apiKey: manualKey }], async ([project]) => {
        const report = await runIsolatedScenario({
          invocations: [{ project: project as string, surface: "enhanced" }],
          response: "unauthorized",
          environmentKey: rejectedEnvironmentKey,
        });

        expect(report.requests).toHaveLength(1);
        expect(report.requests[0]?.authorization).toBe(`Bearer ${rejectedEnvironmentKey}`);
        expect(report.invocations[0]?.result).toBeUndefined();
        expect(report.requests[0]?.body).not.toContain(rejectedEnvironmentKey);
        expect(report.requests[0]?.body).not.toContain(manualKey);
        expect(diagnosticsWithoutAuthorization(report)).not.toContain(rejectedEnvironmentKey);
        expect(diagnosticsWithoutAuthorization(report)).not.toContain(manualKey);
      });
    });

    test("a transport failure remains fail-open without putting the bearer in payloads or diagnostics", async () => {
      await withProjects([{ integrationMode: "enhanced", apiKey: "unused-manual-key" }], async ([project]) => {
        const report = await runIsolatedScenario({
          invocations: [{ project: project as string, surface: "enhanced" }],
          response: "network-error",
          environmentKey: "network-failure-key",
        });

        expect(report.requests.length).toBeGreaterThan(0);
        expect(report.requests.every((request) => request.authorization === "Bearer network-failure-key")).toBe(true);
        expect(report.invocations[0]?.result).toBeUndefined();
        expect(report.requests.every((request) => !request.body.includes("network-failure-key"))).toBe(true);
        expect(diagnosticsWithoutAuthorization(report)).not.toContain("network-failure-key");
        expect(diagnosticsWithoutAuthorization(report)).not.toContain("unused-manual-key");
      });
    });
  });
}

const childScenario = process.env[CHILD_SCENARIO_ENV];
if (childScenario !== undefined) {
  try {
    const report = await executeChildScenario(JSON.parse(childScenario) as ChildScenario);
    console.log(`${CHILD_OUTPUT_MARKER}${JSON.stringify(report)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  await registerTests();
}
