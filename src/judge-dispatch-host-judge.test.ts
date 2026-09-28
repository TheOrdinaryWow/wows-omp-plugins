import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const CHILD_SCENARIO_ENV = "JUDGE_DISPATCH_HOST_JUDGE_SCENARIO";
const CHILD_OUTPUT_MARKER = "JUDGE_DISPATCH_HOST_JUDGE_RESULT:";
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_URL = pathToFileURL(join(dirname(THIS_FILE), "../plugins/judge-dispatch/src/index.ts")).href;
const HOST_KEY = ["host", "typesafe", "key"].join("-");

interface SessionSpec {
  project: string;
  calls: number;
}

interface ChildScenario {
  sessions: SessionSpec[];
  response: "success" | "unauthorized" | "network-error";
  hostKey?: string;
}

interface RecordedRequest {
  authorization: string | null;
  body: string;
}

/** Results cross a JSON boundary, so a fail-open `undefined` arrives as `null`. */
interface SessionReport {
  results: unknown[];
  warnings: unknown[];
  notifications: unknown[];
  usage: unknown[];
}

interface ChildReport {
  requests: RecordedRequest[];
  sessions: SessionReport[];
}

type TestHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

/** Bundled OMP agents, so candidate discovery finds real definitions for both names. */
const TASK_DESCRIPTION = "# Available Agents\n### scout\nRead-only investigator\n### task\nGeneral-purpose agent";

function startTypeSafeServer(scenario: ChildScenario, requests: RecordedRequest[]): { origin: string; stop(): void } {
  if (scenario.response === "network-error") return { origin: "http://127.0.0.1:1", stop() {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") return new Response(null, { status: 404 });
      const body = await request.text();
      requests.push({ authorization: request.headers.get("authorization"), body });
      if (scenario.response === "unauthorized") return new Response("invalid api key", { status: 401 });

      // Answer every question asked: the agent question picks the first non-scout option, others their last (highest) option.
      const payload = JSON.parse(body) as { questions?: Record<string, { criteria?: Record<string, unknown> }> };
      const answers = Object.fromEntries(
        Object.entries(payload.questions ?? {}).map(([id, question]) => {
          const choices = Object.keys(question.criteria ?? {});
          const choice = (id === "agent" ? choices.find((name) => name !== "scout") : choices.at(-1)) ?? "";
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(choices.map((name) => [name, name === choice ? 1 : 0])),
              confidence: 0.99,
            },
          ];
        }),
      );
      return Response.json({
        model: "system-one",
        answers,
        usage: { input_tokens: 17, output_tokens: 3 },
      });
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

async function executeChildScenario(scenario: ChildScenario): Promise<ChildReport> {
  const requests: RecordedRequest[] = [];
  const server = startTypeSafeServer(scenario, requests);
  try {
    if (scenario.hostKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = scenario.hostKey;

    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "models.yml"), `providers:\n  typesafe:\n    baseUrl: ${server.origin}\n`);

    // The child runs outside the test runner with its own HOME, so host modules load only after isolation is in place.
    const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
    const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent/sdk");
    // This runtime-selected absolute URL keeps the child fixture on the same plugin source as the parent checkout.
    const { default: registerJudgeDispatch } = await import(PLUGIN_URL);

    const sessionReports: SessionReport[] = [];
    for (const [sessionIndex, session] of scenario.sessions.entries()) {
      const settings = await Settings.loadIsolated({ cwd: session.project, agentDir });
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"), { settings });
      const handlers = new Map<string, TestHandler[]>();
      const report: SessionReport = { results: [], warnings: [], notifications: [], usage: [] };

      const api = {
        logger: {
          warn(message: unknown, details?: unknown) {
            report.warnings.push(details === undefined ? message : [message, details]);
          },
        },
        on(event: string, handler: TestHandler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        getAllTools: () => [{ name: "task", description: TASK_DESCRIPTION, parameters: {}, source: "builtin" }],
      } as unknown as ExtensionAPI;

      const context = {
        cwd: session.project,
        ui: {
          notify(message: unknown, level?: unknown) {
            report.notifications.push({ message, level });
          },
        },
        sessionManager: {
          getSessionId: () => `host-judge-session-${sessionIndex}`,
          getLeafId: () => `host-judge-leaf-${sessionIndex}`,
          appendModelUsage(entry: unknown) {
            report.usage.push(entry);
          },
        },
        modelRegistry: registry,
      } as unknown as ExtensionContext;

      const onlyHandler = (event: string): TestHandler => {
        const registered = handlers.get(event) ?? [];
        if (registered.length !== 1) throw new Error(`expected one ${event} handler, received ${registered.length}`);
        return registered[0] as TestHandler;
      };

      registerJudgeDispatch(api);

      for (let call = 0; call < session.calls; call += 1) {
        report.results.push(
          await onlyHandler("tool_call")(
            {
              type: "tool_call",
              toolCallId: `host-judge-tool-${sessionIndex}-${call}`,
              toolName: "task",
              input: { task: "Implement the requested repository change", agent: "scout" },
            },
            context,
          ),
        );
      }
      sessionReports.push(report);
    }

    return { requests, sessions: sessionReports };
  } finally {
    server.stop();
  }
}

async function createProject(settings: Record<string, unknown>): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "judge-dispatch-host-judge-"));
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
  const isolationRoot = scenario.sessions[0]?.project;
  if (!isolationRoot) throw new Error("host judge scenario requires at least one session");

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
  if (exitCode !== 0) throw new Error(`isolated host judge fixture exited ${exitCode}\n${stderr}\n${stdout}`);

  const resultLine = stdout.split("\n").find((line) => line.startsWith(CHILD_OUTPUT_MARKER));
  if (!resultLine) throw new Error(`isolated host judge fixture returned no result\n${stderr}\n${stdout}`);
  return JSON.parse(resultLine.slice(CHILD_OUTPUT_MARKER.length)) as ChildReport;
}

function diagnostics(report: ChildReport): string {
  return JSON.stringify({ sessions: report.sessions, bodies: report.requests.map(({ body }) => body) });
}

async function registerTests(): Promise<void> {
  // The child fixture executes this file outside Bun's test runner, so only the parent branch may load bun:test.
  const { describe, expect, test } = await import("bun:test");

  describe.serial("judge-dispatch through the host judge role", () => {
    test("a native judge that is not Jev routes task calls and journals usage", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          hostKey: HOST_KEY,
        });

        expect(report.requests.map((request) => request.authorization)).toEqual([`Bearer ${HOST_KEY}`]);
        expect(report.sessions[0]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "task" } }]);
        expect(report.sessions[0]?.usage).toHaveLength(1);
        expect(report.sessions[0]?.notifications).toEqual([]);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("judgeEffort adds the effort question and writes the judged effort", async () => {
      await withProjects([{}, { judgeEffort: true }], async ([plain, effort]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: plain as string, calls: 1 },
            { project: effort as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });

        const askedQuestions = report.requests.map((request) => Object.keys(JSON.parse(request.body).questions ?? {}));
        expect(askedQuestions).toEqual([["agent"], ["agent", "effort"]]);
        expect(report.sessions[1]?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "task", effort: "hi" } },
        ]);
      });
    });

    test("without a host credential task calls keep the requested agent and warn once per session", async () => {
      await withProjects([{}, {}], async ([first, second]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: first as string, calls: 2 },
            { project: second as string, calls: 2 },
          ],
          response: "success",
        });

        expect(report.requests).toHaveLength(0);
        for (const session of report.sessions) {
          expect(session.results).toEqual([null, null]);
          expect(session.usage).toHaveLength(0);
          expect(session.notifications).toHaveLength(1);
          expect(session.notifications[0]).toMatchObject({ level: "warning" });
        }
      });
    });

    test("a rejected host credential fails open without the availability warning or leaking the key", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "unauthorized",
          hostKey: HOST_KEY,
        });

        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(report.requests[0]?.body).not.toContain(HOST_KEY);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("a transport failure fails open without the availability warning", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "network-error",
          hostKey: HOST_KEY,
        });

        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });
  });
}

const childScenario = process.env[CHILD_SCENARIO_ENV];
if (childScenario !== undefined) {
  try {
    const report = await executeChildScenario(JSON.parse(childScenario) as ChildScenario);
    console.log(`${CHILD_OUTPUT_MARKER}${JSON.stringify(report)}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  await registerTests();
}
