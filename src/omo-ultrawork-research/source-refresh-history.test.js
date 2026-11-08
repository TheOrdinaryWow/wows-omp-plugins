import { describe, expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLedger } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";
import { run } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";
import { writeSnapshot } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/source-snapshot.mjs";

const PAGE = "<html><body><p>The main deck spans 320 m in total.</p></body></html>";

function session() {
  const dir = mkdtempSync(join(tmpdir(), "research-capture-history-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function files(dir) {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]));
}

const command = (dir, ...args) => run([...args, "--session-dir", dir]);
const source = (dir) => join(dir, "sources", "S1");
const metadata = (dir) => JSON.parse(readFileSync(join(source(dir), "meta.json"), "utf8"));

async function pageSession() {
  const dir = session();
  await command(dir, "source", "snapshot", "--id", "S1", "--html", capture(dir, "page.html", PAGE));
  await command(dir, "fact", "add", "--source", "S1", "--find", "main deck spans", "--label", "span");
  await command(dir, "fact", "quote", "--source", "S1", "--match", "main deck spans 320 m", "--label", "statement");
  return dir;
}

describe("history-preserving source refresh", () => {
  test("archives every prior capture and records exactly which fact bindings were revalidated", async () => {
    const dir = await pageSession();
    const initialFiles = files(source(dir));
    const initialRows = structuredClone(readLedger(dir).rows);
    const first = await command(
      dir,
      "source",
      "refresh",
      "S1",
      "--html",
      capture(dir, "moved.html", PAGE.replace("<body>", "<body><p>A new preface paragraph.</p>")),
    );
    expect(first.exitCode).toBe(0);
    const firstArchive = join(dir, "sources", first.json.data.previous_capture);
    expect(files(firstArchive)).toEqual(initialFiles);
    expect(first.json.data.rows.map((row) => row.status)).toEqual(["relocated", "relocated"]);
    const refresh = JSON.parse(readFileSync(join(source(dir), "refresh.json"), "utf8"));
    expect(refresh.previous_rows).toEqual(initialRows);
    expect(refresh.rebound_rows).toEqual(readLedger(dir).rows);
    expect(refresh.rebound_rows.every((row) => row.snapshot_sha256 === first.json.data.snapshot_sha256)).toBe(true);
    expect(metadata(dir).previous_capture).toBe(first.json.data.previous_capture);
    const firstFiles = files(source(dir));
    const beforeFailed = structuredClone(readLedger(dir).rows);
    const failed = await command(dir, "source", "refresh", "S1", "--html", capture(dir, "changed.html", PAGE.replace("320", "330")));
    expect(failed.exitCode).toBe(1);
    expect(failed.json.data.rows.map((row) => row.status)).toEqual(["not_found", "not_found"]);
    expect(readLedger(dir).rows).toEqual(beforeFailed);
    expect(files(join(dir, "sources", failed.json.data.previous_capture))).toEqual(firstFiles);
    expect(files(firstArchive)).toEqual(initialFiles);
    const failedRecord = JSON.parse(readFileSync(join(source(dir), "refresh.json"), "utf8"));
    expect(failedRecord.rebound_rows).toEqual([]);
    expect(failedRecord.previous_rows).toEqual(beforeFailed);
  });

  test("same-byte replacement still preserves the old metadata and command receipt", async () => {
    const dir = session();
    const argv = JSON.stringify([process.execPath, "-e", 'process.stdout.write("Span is 320 m.")']);
    await command(dir, "source", "snapshot", "--id", "S1", "--command", argv, "--cwd", dir);
    const before = files(source(dir));
    await command(dir, "source", "snapshot", "--id", "S1", "--command", argv, "--cwd", dir);
    expect(files(source(dir))).toEqual(before);
    const replaced = await command(dir, "source", "snapshot", "--id", "S1", "--command", argv, "--cwd", dir, "--replace");
    expect(replaced.exitCode).toBe(0);
    expect(files(join(dir, "sources", replaced.json.data.previous_capture))).toEqual(before);
    expect(existsSync(join(source(dir), "command.json"))).toBe(true);
  });

  test("a changed declared extraction cannot overwrite an equal-raw-byte capture", async () => {
    const dir = session();
    const raw = capture(dir, "paper.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    const original = capture(dir, "first.txt", "Span is 320 m.");
    await command(dir, "source", "snapshot", "--id", "S1", "--raw", raw, "--text", original, "--extractor", "reader@1");
    const before = files(source(dir));
    const corrected = capture(dir, "corrected.txt", "Span is 330 m.");
    const refused = await command(dir, "source", "snapshot", "--id", "S1", "--raw", raw, "--text", corrected, "--extractor", "reader@1");
    expect(refused.json.error).toBe("snapshot_exists");
    expect(files(source(dir))).toEqual(before);
    const replacement = await command(
      dir,
      "source",
      "snapshot",
      "--id",
      "S1",
      "--raw",
      raw,
      "--text",
      corrected,
      "--extractor",
      "reader@1",
      "--replace",
    );
    expect(replacement.exitCode).toBe(0);
    expect(files(join(dir, "sources", replacement.json.data.previous_capture))).toEqual(before);
    expect(readFileSync(join(source(dir), "text.txt"), "utf8")).toBe("Span is 330 m.");
  });

  for (const legacy of [false, true]) {
    test(`${legacy ? "legacy imported" : "recorded browser"} captures refuse implicit and explicit URL refresh without mutating provenance`, async () => {
      const dir = session();
      writeSnapshot(join(dir, "sources"), "S1", { url: "https://example.invalid/authenticated", html: PAGE, extractor: "model" });
      if (legacy) {
        const meta = metadata(dir);
        delete meta.acquisition;
        writeFileSync(join(source(dir), "meta.json"), JSON.stringify(meta));
      }
      const before = files(source(dir));
      for (const flags of [[], ["--url", "https://example.invalid/public"], ["--text", capture(dir, "text.txt", "Span is 320 m.")]]) {
        await expect(command(dir, "source", "refresh", "S1", ...flags)).rejects.toThrow("actual --html or --raw capture");
        expect(files(source(dir))).toEqual(before);
      }
      const result = await command(dir, "source", "refresh", "S1", "--raw", capture(dir, "recaptured.html", PAGE));
      expect(result.exitCode).toBe(0);
      expect(metadata(dir)).toMatchObject({ acquisition: "browser", url: "https://example.invalid/authenticated" });
      expect(files(join(dir, "sources", result.json.data.previous_capture))).toEqual(before);
      const extracted = await command(
        dir,
        "source",
        "snapshot",
        "--id",
        "S1",
        "--text",
        capture(dir, "verified.txt", "The main deck spans 320 m in total."),
        "--extractor",
        "reader@1",
        "--replace",
      );
      expect(extracted.exitCode).toBe(0);
      expect(metadata(dir).acquisition).toBe("browser");
      await expect(command(dir, "source", "refresh", "S1")).rejects.toThrow("actual --html or --raw capture");
    });
  }

  test("static fetches may refetch their URL while retaining the complete earlier observation", async () => {
    const dir = session();
    let body = PAGE;
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    onTestFinished(() => server.stop(true));
    await command(dir, "source", "snapshot", "--id", "S1", "--url", `http://127.0.0.1:${server.port}/page`);
    const before = files(source(dir));
    body = PAGE.replace("320", "330");
    const result = await command(dir, "source", "refresh", "S1");
    expect(result.exitCode).toBe(0);
    expect(requests).toBe(2);
    expect(metadata(dir).acquisition).toBe("fetch");
    expect(files(join(dir, "sources", result.json.data.previous_capture))).toEqual(before);
    expect(readFileSync(join(source(dir), "raw.bin"), "utf8")).toBe(body);
  });
});
