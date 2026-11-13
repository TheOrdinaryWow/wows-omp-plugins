import { type AdrDoc, parseAdr } from "#src/documents.ts";
import { datedNotes } from "#src/operations.ts";

export interface HistoryEvent {
  adr: string;
  kind: "created" | "status" | "superseded" | "stage" | "note" | "edited" | "deleted";
  commit: string;
  date: string;
  author: string;
  subject: string;
  from?: string;
  to?: string;
  uncommitted?: true;
}

interface Revision {
  commit: string;
  date: string;
  author: string;
  subject: string;
  changes: Array<{ before: string; after: string }>;
}

export async function visualizeGit(root: string, args: string[], input?: string): Promise<Buffer> {
  const child = Bun.spawn(["git", "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed.`);
  return Buffer.from(stdout);
}

function adrContent(raw: string | undefined): AdrDoc | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseAdr(raw);
  } catch {
    return undefined;
  }
}

function derive(before: string | undefined, after: string | undefined, revision: Omit<HistoryEvent, "adr" | "kind">): HistoryEvent[] {
  if (before === after) return [];
  const old = adrContent(before);
  const next = adrContent(after);
  if (!old && !next) return [];
  if (old && next && old.id !== next.id) return [...derive(before, undefined, revision), ...derive(undefined, after, revision)];
  const events: HistoryEvent[] = [];
  const emit = (kind: HistoryEvent["kind"], from?: string, to?: string): void => {
    events.push({ ...revision, adr: (next ?? (old as AdrDoc)).id, kind, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  };
  if (!next) emit("deleted", old?.status);
  else if (!old) emit("created", undefined, next.status);
  else {
    if (old.status !== next.status) {
      if (next.status === "superseded") emit("superseded", old.status, next.superseded_by);
      else emit("status", old.status, next.status);
    }
    if (old.stage !== next.stage) emit("stage", old.stage, next.stage);
    const oldNotes = new Map<string, number>();
    for (const entry of datedNotes(old.body)) oldNotes.set(entry.heading, (oldNotes.get(entry.heading) ?? 0) + 1);
    for (const entry of datedNotes(next.body)) {
      const count = oldNotes.get(entry.heading) ?? 0;
      if (count) oldNotes.set(entry.heading, count - 1);
      else emit("note", undefined, entry.heading.slice(4));
    }
    if (!events.length) emit("edited");
  }
  return events;
}

function parseLog(text: string): Revision[] {
  const tokens = text.split("\0");
  const revisions: Revision[] = [];
  let revision: Revision | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = (tokens[index] ?? "").trimStart();
    if (token === "commit") {
      revision = {
        commit: (tokens[++index] ?? "").slice(0, 7),
        date: tokens[++index] ?? "",
        author: tokens[++index] ?? "",
        subject: tokens[++index] ?? "",
        changes: [],
      };
      revisions.push(revision);
    } else if (token.startsWith(":")) {
      const fields = token.split(" ");
      const status = fields[4] ?? "";
      const oldPath = tokens[++index] ?? "";
      const newPath = status.startsWith("R") || status.startsWith("C") ? (tokens[++index] ?? "") : oldPath;
      const oldIsAdr = /^docs\/adr\/(?!README\.md$)[^/]+\.md$/.test(oldPath);
      const newIsAdr = /^docs\/adr\/(?!README\.md$)[^/]+\.md$/.test(newPath);
      if (oldIsAdr || newIsAdr)
        revision?.changes.push({
          before: oldIsAdr ? (fields[2] ?? "") : "0",
          after: newIsAdr ? (fields[3] ?? "") : "0",
        });
    }
  }
  return revisions;
}

function parseBatch(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) break;
    const [sha, type, length] = bytes.subarray(offset, end).toString().split(" ");
    if (!sha || type !== "blob" || length === undefined) throw new Error("Git returned an unreadable ADR history object.");
    const size = Number(length);
    offset = end + 1;
    result.set(sha, bytes.subarray(offset, offset + size).toString());
    offset += size + 1;
  }
  return result;
}

export interface HistorySnapshot {
  available: boolean;
  reason?: string;
  events: HistoryEvent[];
  headFiles: Map<string, string>;
  head?: string;
  branch?: string;
}

export async function buildHistory(root: string, files: Record<string, string>, generatedAt: string): Promise<HistorySnapshot> {
  const branch = await visualizeGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]).then(
    (value) => value.toString().trim(),
    () => undefined,
  );
  let head: string;
  try {
    head = (await visualizeGit(root, ["rev-parse", "--verify", "HEAD"])).toString().trim();
  } catch (error) {
    return {
      available: false,
      reason: `Git history is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      events: Object.values(files).flatMap((content) =>
        derive(undefined, content, {
          commit: "",
          date: generatedAt,
          author: "",
          subject: "Uncommitted changes",
          uncommitted: true,
        }),
      ),
      headFiles: new Map(),
      branch,
    };
  }
  try {
    const [log, tree] = await Promise.all([
      visualizeGit(root, [
        "log",
        "--reverse",
        "--topo-order",
        "--full-history",
        "--diff-merges=off",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames",
        "--root",
        "--format=%x00commit%x00%H%x00%aI%x00%an%x00%s%x00",
        "HEAD",
        "--",
        "docs/adr/",
      ]),
      visualizeGit(root, ["ls-tree", "-r", "-z", head, "--", "docs/adr/"]),
    ]);
    const revisions = parseLog(log.toString());
    const headObjects = new Map<string, string>();
    for (const entry of tree.toString().split("\0")) {
      const match = /^\d+ blob ([a-f0-9]+)\t(docs\/adr\/[^/]+\.md)$/.exec(entry);
      if (match && match[2] !== "docs/adr/README.md") headObjects.set(match[2] as string, match[1] as string);
    }
    const objects = new Set(headObjects.values());
    for (const revision of revisions)
      for (const change of revision.changes) {
        if (!/^0+$/.test(change.before)) objects.add(change.before);
        if (!/^0+$/.test(change.after)) objects.add(change.after);
      }
    const contents = objects.size
      ? parseBatch(await visualizeGit(root, ["cat-file", "--batch"], `${[...objects].join("\n")}\n`))
      : new Map<string, string>();
    const events = revisions.flatMap(({ changes, ...revision }) => {
      const before = new Map<string, string>();
      const after = new Map<string, string>();
      for (const change of changes) {
        for (const [sha, target] of [
          [change.before, before],
          [change.after, after],
        ] as const) {
          const content = contents.get(sha);
          const doc = adrContent(content);
          if (doc && content !== undefined) target.set(doc.id, content);
        }
      }
      return [...new Set([...before.keys(), ...after.keys()])].flatMap((id) => derive(before.get(id), after.get(id), revision));
    });
    const headFiles = new Map<string, string>();
    for (const [path, sha] of headObjects) {
      const content = contents.get(sha);
      if (content !== undefined) headFiles.set(path, content);
    }
    const current = new Map<string, string>();
    const previous = new Map<string, string>();
    for (const content of Object.values(files)) {
      const doc = adrContent(content);
      if (doc) current.set(doc.id, content);
    }
    for (const content of headFiles.values()) {
      const doc = adrContent(content);
      if (doc) previous.set(doc.id, content);
    }
    for (const id of new Set([...previous.keys(), ...current.keys()]))
      events.push(
        ...derive(previous.get(id), current.get(id), {
          commit: "",
          date: generatedAt,
          author: "",
          subject: "Uncommitted changes",
          uncommitted: true,
        }),
      );
    return { available: true, events, headFiles, head: head.slice(0, 7), branch };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      events: [],
      headFiles: new Map(),
      head: head.slice(0, 7),
      branch,
    };
  }
}
