import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHerdr, HerdrError, type HerdrExec, isMissingPane, type PaneLayout } from "../plugins/omp-herdr-dag/src/herdr.ts";
import { PaneManager, type PaneSettings, paneOrientation, unsplitDimensions } from "../plugins/omp-herdr-dag/src/pane.ts";
import { type PaneState, readPane, writePane } from "../plugins/omp-herdr-dag/src/persisted.ts";
import { buildViewerCommand, resolveViewerRuntime, shellQuote } from "../plugins/omp-herdr-dag/src/runtime.ts";

const dirs: string[] = [];
const settings: PaneSettings = {
  landscapePosition: "right",
  portraitPosition: "bottom",
  landscapeSize: 0.35,
  portraitSize: 0.4,
  followOrientation: true,
  focusPane: false,
  finishBehavior: "close-with-omp",
};

class RecordingHerdr {
  calls: string[][] = [];
  cols = 160;
  rows = 50;
  dag?: { id: string; direction: "right" | "down"; ratio: number; swapped: boolean };
  nextId = 1;
  fail?: string;
  emptyRun = false;
  before?: (args: readonly string[]) => Promise<void>;

  layout(): PaneLayout {
    const hostRect = { x: 0, y: 0, width: this.cols, height: this.rows };
    const panes = [{ pane_id: "host", rect: hostRect }];
    if (this.dag) {
      const horizontal = this.dag.direction === "right";
      const full = horizontal ? this.cols : this.rows;
      const first = Math.round(full * this.dag.ratio);
      const sourceRect = { x: 0, y: 0, width: horizontal ? first : this.cols, height: horizontal ? this.rows : first };
      const newRect = {
        x: horizontal ? first : 0,
        y: horizontal ? 0 : first,
        width: horizontal ? full - first : this.cols,
        height: horizontal ? this.rows : full - first,
      };
      panes[0] = { pane_id: "host", rect: this.dag.swapped ? newRect : sourceRect };
      panes.push({ pane_id: this.dag.id, rect: this.dag.swapped ? sourceRect : newRect });
    }
    return { area: hostRect, tab_id: "tab", focused_pane_id: "host", panes };
  }

  exec: HerdrExec = async (args, options) => {
    expect(options.timeoutMs).toBe(5_000);
    this.calls.push([...args]);
    await this.before?.(args);
    const op = args[1];
    const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
    const response = (result: unknown) => ({ stdout: JSON.stringify({ id: "fake", result }), exitCode: 0 });
    if (op === this.fail) return { stdout: JSON.stringify({ error: { code: "probe_failure", message: `${op} failed` } }), exitCode: 1 };
    if (op === "layout") return response({ layout: this.layout() });
    if (op === "split") {
      this.dag = {
        id: `dag${this.nextId++}`,
        direction: flag("--direction") as "right" | "down",
        ratio: Number(flag("--ratio")),
        swapped: false,
      };
      return response({ pane: { pane_id: this.dag.id, tab_id: "tab" } });
    }
    if (op === "swap") {
      if (this.dag) this.dag.swapped = !this.dag.swapped;
      return response({ swap: { changed: true } });
    }
    if (op === "get") {
      if (!this.dag || args[2] !== this.dag.id) {
        return { stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" } }), exitCode: 1 };
      }
      return response({ pane: { pane_id: this.dag.id, tab_id: "tab" } });
    }
    if (op === "rename" && args[2] !== this.dag?.id)
      return { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" } }), exitCode: 1 };
    if (op === "close") {
      if (args[2] !== this.dag?.id) {
        return { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" } }), exitCode: 1 };
      }
      this.dag = undefined;
    }
    if (op === "run" && this.emptyRun) return { stdout: "", stderr: "viewer launched", exitCode: 0 };
    if (op === "current") return response({ pane: { pane_id: "host", tab_id: "tab" } });
    return response({ type: "ok" });
  };
}

async function fixture(overrides: Partial<PaneSettings> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-dag-pane-test-"));
  dirs.push(dir);
  const fake = new RecordingHerdr();
  const notices: string[] = [];
  const logs: string[] = [];
  const manager = new PaneManager({
    herdr: createHerdr(fake.exec),
    dir,
    sessionId: "session123456",
    sessionName: "Example",
    hostPaneId: "host",
    settings: { ...settings, ...overrides },
    socketPath: "/tmp/current.sock",
    cwd: "/work/project",
    viewerCommand: (paneId) => `bun viewer.ts --pane ${paneId}`,
    notify: (message) => notices.push(message),
    log: (message) => logs.push(message),
  });
  return { dir, fake, manager, notices, logs };
}

afterEach(async () => {
  jest.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Herdr command client", () => {
  test("unwraps pane results and sends explicit targeting and background flags", async () => {
    const fake = new RecordingHerdr();
    const herdr = createHerdr(fake.exec);
    expect(await herdr.current()).toEqual({ pane_id: "host", tab_id: "tab" });
    await herdr.resize("host", "left", 0.1);
    expect(fake.calls).toEqual([
      ["pane", "current", "--current"],
      ["pane", "resize", "--direction", "left", "--amount", "0.1", "--pane", "host"],
    ]);
  });

  test("accepts an empty successful run response and recognizes structured missing-pane errors", async () => {
    const fake = new RecordingHerdr();
    fake.emptyRun = true;
    const herdr = createHerdr(fake.exec);
    await herdr.run("owned", "bun viewer.ts");
    const error = await herdr.close("absent").catch((value: unknown) => value);
    expect(isMissingPane(error)).toBe(true);
    expect(isMissingPane(new Error("pane_not_found"))).toBe(false);
    expect(isMissingPane(new HerdrError("different", "other"))).toBe(false);
  });

  test("aborts a hanging command at 5 seconds", async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const herdr = createHerdr((_args, options) => {
      signal = options.signal;
      return Promise.withResolvers<never>().promise;
    });
    const result = herdr.layout("host").catch((error: unknown) => error);
    jest.advanceTimersByTime(4_999);
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    const error = await result;
    expect(signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("timeout");
  });

  test("rejects malformed JSON and failed commands without pretending they ran", async () => {
    await expect(createHerdr(async () => ({ stdout: "not json", exitCode: 0 })).run("owned", "echo")).rejects.toThrow("not json");
    await expect(createHerdr(async () => ({ stdout: "", stderr: "failed", exitCode: 2 })).get("owned")).rejects.toThrow("failed");
    await expect(createHerdr(async () => ({ stdout: "{}", exitCode: 0 })).get("owned")).rejects.toThrow("no result");
  });
});

describe("PaneManager", () => {
  for (const orientation of ["landscape", "portrait"] as const) {
    for (const position of ["left", "right", "top", "bottom"] as const) {
      test(`${orientation} ${position}: exact open commands and pane phases`, async () => {
        const { manager, fake, dir } = await fixture({ landscapePosition: position, portraitPosition: position });
        fake.cols = orientation === "landscape" ? 160 : 70;
        fake.rows = orientation === "landscape" ? 50 : 60;
        const states: PaneState[] = [];
        fake.before = async (args) => {
          if (args[1] === "split" || args[1] === "swap" || args[1] === "rename") {
            const state = await readPane(join(dir, "pane.json"));
            if (!state) throw new Error("Missing pane state before mutation");
            states.push(state);
          }
        };
        const state = await manager.open();
        const swapped = position === "left" || position === "top";
        const size = orientation === "landscape" ? 0.35 : 0.4;
        expect(fake.calls).toEqual([
          ["pane", "layout", "--pane", "host"],
          [
            "pane",
            "split",
            "--pane",
            "host",
            "--direction",
            position === "left" || position === "right" ? "right" : "down",
            "--ratio",
            String(swapped ? size : 1 - size),
            "--cwd",
            "/work/project",
            "--no-focus",
          ],
          ...(swapped ? [["pane", "swap", "--source-pane", "host", "--target-pane", "dag1"]] : []),
          ["pane", "rename", "dag1", "DAG · Example"],
          ["pane", "run", "dag1", "bun viewer.ts --pane dag1"],
        ]);
        expect(states[0]?.phase).toBe("splitting");
        expect(states[0]?.paneId).toBeUndefined();
        expect(states.slice(1).every((value) => value.phase === "open" && value.paneId === "dag1")).toBe(true);
        expect(state).toMatchObject({ phase: "open", paneId: "dag1", tabId: "tab", orientation, position, dismissed: false });
        const reopened = await readPane(join(dir, "pane.json"));
        expect(reopened).toEqual(state);
        const rect = fake.layout().panes.find((pane) => pane.pane_id === "dag1")?.rect;
        expect(rect).toBeDefined();
        const share = position === "left" || position === "right" ? (rect?.width ?? 0) / fake.cols : (rect?.height ?? 0) / fake.rows;
        expect(Math.abs(share - size)).toBeLessThan(0.02);
        await manager.close();
      });
    }
  }

  test("focusPane=true chooses the new pane as swap source", async () => {
    const { manager, fake } = await fixture({ landscapePosition: "left", focusPane: true });
    await manager.open();
    expect(fake.calls[1]?.at(-1)).toBe("--focus");
    expect(fake.calls[2]).toEqual(["pane", "swap", "--source-pane", "dag1", "--target-pane", "host"]);
    await manager.close();
  });

  test("serializes concurrent opens to one split and does not focus an existing pane", async () => {
    const { manager, fake } = await fixture();
    await Promise.all([manager.open(), manager.open(), manager.ensure()]);
    expect(fake.calls.filter((args) => args[1] === "split")).toHaveLength(1);
    expect(fake.calls.filter((args) => args[1] === "get")).toHaveLength(2);
    expect(fake.calls.filter((args) => args[1] === "rename")).toHaveLength(1);
    await manager.close();
  });

  test("a later launch failure closes exactly the recorded pane and removes its state", async () => {
    const { manager, fake, dir, notices, logs } = await fixture();
    fake.fail = "rename";
    await expect(manager.open()).rejects.toThrow("rename failed");
    expect(fake.calls.at(-1)).toEqual(["pane", "close", "dag1"]);
    expect(await readPane(join(dir, "pane.json"))).toBeUndefined();
    expect(manager.paneId).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(logs).toHaveLength(1);
    fake.fail = undefined;
    await manager.open();
    expect(manager.paneId).toBe("dag2");
    await manager.close();
  });

  test("a failed cleanup retains the owned id for an explicit close retry", async () => {
    const { manager, fake, dir } = await fixture();
    fake.before = async (args) => {
      if (args[1] === "run") throw new Error("viewer failed");
      if (args[1] === "close") throw new Error("close failed");
    };
    await expect(manager.open()).rejects.toThrow("viewer failed");
    expect((await readPane(join(dir, "pane.json")))?.paneId).toBe("dag1");
    fake.before = undefined;
    await manager.close();
    expect(await readPane(join(dir, "pane.json"))).toBeUndefined();
  });

  test("a leftover splitting record never searches, adopts, or closes an unrecorded pane", async () => {
    const { manager, fake, dir, notices } = await fixture();
    await writePane(join(dir, "pane.json"), {
      version: 1,
      phase: "splitting",
      hostPaneId: "host",
      orientation: "landscape",
      position: "right",
      launchedAt: 1,
      dismissed: false,
    });
    await manager.open();
    expect(fake.calls.map((args) => args[1])).toEqual(["layout", "split", "rename", "run"]);
    expect(notices).toEqual(["A previous DAG pane may be left open; close it manually"]);
    await manager.open();
    expect(notices).toHaveLength(1);
    await manager.close();
  });

  test("a foreign-host record is discarded without mutating its pane", async () => {
    const { manager, fake, dir } = await fixture();
    await writePane(join(dir, "pane.json"), {
      version: 1,
      phase: "open",
      paneId: "not-owned",
      hostPaneId: "other-host",
      orientation: "landscape",
      position: "right",
      launchedAt: 1,
      dismissed: false,
    });
    await manager.open();
    expect(fake.calls.some((args) => args.includes("not-owned"))).toBe(false);
    await manager.close();
  });

  test("close targets only a recorded id, tolerates pane_not_found, and missing close is a no-op", async () => {
    const { manager, fake } = await fixture();
    await manager.close();
    expect(fake.calls).toHaveLength(0);
    await manager.open();
    fake.dag = undefined;
    await manager.close();
    expect(fake.calls.at(-1)).toEqual(["pane", "close", "dag1"]);
    expect(manager.state).toBeUndefined();
    const count = fake.calls.length;
    await manager.close();
    expect(fake.calls).toHaveLength(count);
  });

  test("an unknown pane.json version is rewritten as v1 on fresh open", async () => {
    const { manager, fake, dir } = await fixture();
    await writeFile(join(dir, "pane.json"), JSON.stringify({ version: 2, phase: "open", paneId: "foreign" }));
    await manager.open();
    expect(fake.calls.some((args) => args.includes("foreign"))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "pane.json"), "utf8")).version).toBe(1);
    await manager.close();
  });

  test("dismissal survives close and reload; explicit open clears it", async () => {
    const { manager, fake, dir } = await fixture();
    await manager.open();
    await manager.dismiss();
    await manager.close("manual");
    expect((await readPane(join(dir, "pane.json")))?.dismissed).toBe(true);
    expect(manager.paneId).toBeUndefined();
    const count = fake.calls.length;
    await manager.ensure();
    expect(fake.calls).toHaveLength(count);
    const reloaded = new PaneManager({
      herdr: createHerdr(fake.exec),
      dir,
      sessionId: "session",
      hostPaneId: "host",
      settings,
      socketPath: "/tmp/current.sock",
      viewerCommand: () => "bun viewer.ts",
      notify: () => undefined,
      log: () => undefined,
    });
    await reloaded.ensure();
    expect(fake.calls).toHaveLength(count);
    await reloaded.open();
    expect(reloaded.state?.dismissed).toBe(false);
    expect(reloaded.paneId).toBe("dag2");
    await reloaded.close();
  });

  test("keep-open preserves the pane on shutdown but not on explicit close", async () => {
    const { manager, fake } = await fixture({ finishBehavior: "keep-open" });
    await manager.open();
    await manager.close("shutdown");
    expect(manager.paneId).toBe("dag1");
    expect(fake.calls.filter((args) => args[1] === "close")).toHaveLength(0);
    await manager.close("manual");
    expect(fake.calls.at(-1)).toEqual(["pane", "close", "dag1"]);
  });

  test("viewer dismissal followed by session rebinding clears a missing pane but preserves suppression", async () => {
    const { manager, fake, dir } = await fixture();
    await manager.open();
    await manager.dismiss();
    fake.dag = undefined; // Viewer q already closed the owned pane.
    const nextDir = join(dir, "next-session");
    await manager.update({ dir: nextDir, sessionId: "next" });
    expect(manager.paneId).toBeUndefined();
    expect(manager.state?.dismissed).toBe(true);
    expect((await readPane(join(nextDir, "pane.json")))?.dismissed).toBe(true);
    const count = fake.calls.length;
    await manager.ensure();
    expect(fake.calls).toHaveLength(count);
  });

  test("session rebind reuses the recorded pane, migrates pane.json, and renames", async () => {
    const { manager, fake, dir } = await fixture();
    await manager.open();
    const newDir = join(dir, "next-session");
    await manager.update({ dir: newDir, sessionId: "new-session", sessionName: "Next" });
    expect(fake.calls.at(-1)).toEqual(["pane", "rename", "dag1", "DAG · Next"]);
    expect(manager.paneId).toBe("dag1");
    expect(await readPane(join(dir, "pane.json"))).toBeUndefined();
    expect((await readPane(join(newDir, "pane.json")))?.paneId).toBe("dag1");
    expect(fake.calls.filter((args) => args[1] === "split")).toHaveLength(1);
    await manager.close();
  });

  test("orientation flip is debounced 750ms and recreates only once per flip", async () => {
    const { manager, fake, dir } = await fixture();
    await manager.open();
    jest.useFakeTimers();
    fake.cols = 80;
    fake.rows = 60;
    const before = fake.calls.length;
    manager.onResize();
    jest.advanceTimersByTime(749);
    expect(fake.calls).toHaveLength(before);
    manager.onResize();
    jest.advanceTimersByTime(749);
    expect(fake.calls).toHaveLength(before);
    jest.advanceTimersByTime(1);
    await manager.idle();
    expect(fake.calls.slice(before).map((args) => args[1])).toEqual(["layout", "close", "layout", "split", "rename", "run"]);
    expect(fake.calls[before + 1]).toEqual(["pane", "close", "dag1"]);
    expect(manager.state).toMatchObject({ paneId: "dag2", orientation: "portrait", position: "bottom" });
    expect((await readPane(join(dir, "pane.json")))?.paneId).toBe("dag2");
    await manager.checkOrientation();
    await manager.checkOrientation();
    expect(fake.calls.filter((args) => args[1] === "close")).toHaveLength(1);
    fake.cols = 160;
    fake.rows = 50;
    manager.onResize();
    jest.advanceTimersByTime(750);
    await manager.idle();
    expect(manager.state).toMatchObject({ paneId: "dag3", orientation: "landscape", position: "right" });
    expect(fake.calls.filter((args) => args[1] === "close")).toHaveLength(2);
    await manager.close();
  });

  test("the DAG split never changes its own orientation measurement", async () => {
    const { manager, fake } = await fixture();
    fake.cols = 120;
    fake.rows = 50;
    await manager.open();
    // OMP alone is 78x50 (portrait); reconstructed pre-split area is 120x50 (landscape).
    expect(fake.layout().panes[0]?.rect.width).toBe(78);
    await manager.checkOrientation();
    expect(fake.calls.filter((args) => args[1] === "close")).toHaveLength(0);
    expect(manager.state?.orientation).toBe("landscape");
    await manager.close();
  });

  test("followOrientation=false and close cancel pending resize work", async () => {
    const { manager, fake } = await fixture({ followOrientation: false });
    await manager.open();
    fake.cols = 60;
    const count = fake.calls.length;
    await manager.checkOrientation();
    expect(fake.calls).toHaveLength(count);
    jest.useFakeTimers();
    manager.onResize();
    await manager.close();
    const closedCount = fake.calls.length;
    jest.advanceTimersByTime(750);
    await manager.idle();
    expect(fake.calls).toHaveLength(closedCount);
  });
});

describe("orientation and runtime helpers", () => {
  test("uses initial 2:1 aspect and four-cell hysteresis at both boundaries", () => {
    expect(paneOrientation(99, 50)).toBe("portrait");
    expect(paneOrientation(100, 50)).toBe("landscape");
    expect(paneOrientation(96, 50, "landscape")).toBe("landscape");
    expect(paneOrientation(95, 50, "landscape")).toBe("portrait");
    expect(paneOrientation(104, 50, "portrait")).toBe("portrait");
    expect(paneOrientation(105, 50, "portrait")).toBe("landscape");
  });

  test("adds back horizontal or vertical DAG share, not unrelated panes", () => {
    const layout: PaneLayout = {
      area: { x: 0, y: 0, width: 200, height: 100 },
      tab_id: "tab",
      panes: [
        { pane_id: "host", rect: { x: 0, y: 0, width: 70, height: 30 } },
        { pane_id: "dag", rect: { x: 70, y: 0, width: 30, height: 20 } },
        { pane_id: "other", rect: { x: 100, y: 0, width: 100, height: 100 } },
      ],
    };
    const state: PaneState = {
      version: 1,
      phase: "open",
      paneId: "dag",
      hostPaneId: "host",
      orientation: "landscape",
      position: "right",
      launchedAt: 0,
      dismissed: false,
    };
    expect(unsplitDimensions(layout, "host", state)).toEqual({ cols: 100, rows: 30 });
    expect(unsplitDimensions(layout, "host", { ...state, position: "top" })).toEqual({ cols: 70, rows: 50 });
    expect(unsplitDimensions(layout, "host", { ...state, paneId: "missing" })).toEqual({ cols: 70, rows: 30 });
  });

  test("runtime override wins, PATH Bun wins next, and a compiled OMP binary is rejected", () => {
    const lookup = { which: () => "/path/bun", execPath: "/compiled/omp", version: () => "omp/18.5.1" };
    expect(resolveViewerRuntime("/custom/bun", lookup)).toBe("/custom/bun");
    expect(resolveViewerRuntime("", lookup)).toBe("/path/bun");
    expect(resolveViewerRuntime("", { ...lookup, which: () => null })).toBeUndefined();
    expect(resolveViewerRuntime("", { ...lookup, which: () => null, execPath: "/actual/bun", version: () => "1.4.2" })).toBe("/actual/bun");
    expect(resolveViewerRuntime("", { ...lookup, which: () => null, version: () => "v22.1.0" })).toBeUndefined();
    expect(resolveViewerRuntime("", { ...lookup, which: () => null, version: () => undefined })).toBeUndefined();
  });

  test("POSIX command quoting protects paths, quotes, spaces, and shell substitutions", () => {
    expect(shellQuote("a'b $(touch x)\nnext")).toBe("'a'\\''b $(touch x)\nnext'");
    expect(
      buildViewerCommand({
        runtime: "/bin/bun",
        viewer: "/plugin/view er.ts",
        socket: "/tmp/sock",
        snapshot: "/a/snapshot.json",
        state: "/a/view-state.json",
        pane: "w1:p2",
        finish: "keep-open",
      }),
    ).toBe(
      "'/bin/bun' '/plugin/view er.ts' '--socket' '/tmp/sock' '--snapshot' '/a/snapshot.json' '--state' '/a/view-state.json' '--pane' 'w1:p2' '--finish' 'keep-open'",
    );
  });
});
