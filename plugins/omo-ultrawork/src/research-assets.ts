import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RESEARCH_UPSTREAM_PIN = "8a8db1d3094da8743989bf693ee5de77889de50e";

interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
  content: Buffer;
}

export interface ResearchAssetsSnapshot {
  directory: string;
  pin: string;
  digest: string;
  durable: boolean;
}

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const MANIFEST = "manifest.json";

/** Cache code and references before an upgrade can remove this installation. No session state lives here. */
function cacheBundle(): { files: BundleFile[]; digest: string; manifest: string } | { error: Error } {
  try {
    const root = fileURLToPath(new URL("../assets/ulw-research/", import.meta.url));
    const files: BundleFile[] = [];
    const add = (path: string, content: Buffer): void => {
      files.push({ path, content, bytes: content.length, sha256: hash(content) });
    };
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) add(relative(root, path).split(sep).join("/"), readFileSync(path));
        else throw new Error(`Research asset is not a regular file or directory: ${path}`);
      }
    };
    visit(root);
    add("procedure.md", readFileSync(new URL("../assets/ulw-research.md", import.meta.url)));
    files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    for (const required of ["scripts/report-tools.mjs", "references/research-setup.md", "references/fact-ledger.md"]) {
      if (!files.some((file) => file.path === required && file.bytes > 0)) throw new Error(`Research bundle is missing ${required}`);
    }
    const entries = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    const digest = hash(JSON.stringify(entries));
    const manifest = `${JSON.stringify({ version: 1, pin: RESEARCH_UPSTREAM_PIN, digest, files: entries }, null, 2)}\n`;
    return { files, digest, manifest };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

const BUNDLE = cacheBundle();

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
    throw new Error(`${directory} is not a private directory owned by the current user`);
  }
}

async function validateSnapshot(directory: string, bundle: Exclude<typeof BUNDLE, { error: Error }>): Promise<void> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    if (!(await lstat(current)).isDirectory()) throw new Error(`Research snapshot directory is not a real directory: ${current}`);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(relative(directory, path).split(sep).join("/"));
      else throw new Error(`Research snapshot contains a non-regular entry: ${path}`);
    }
  };
  await visit(directory);
  const expected = [MANIFEST, ...bundle.files.map((file) => file.path)].sort();
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expected))
    throw new Error(`Research snapshot file inventory is invalid: ${directory}`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  } catch (error) {
    throw new Error(`Research snapshot manifest is unreadable: ${directory}`, { cause: error });
  }
  if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(bundle.manifest))) {
    throw new Error(`Research snapshot manifest does not match the cached pin and digest: ${directory}`);
  }
  for (const file of bundle.files) {
    const content = await readFile(join(directory, file.path));
    if (content.length !== file.bytes || hash(content) !== file.sha256) {
      throw new Error(`Research snapshot content does not match its manifest: ${join(directory, file.path)}`);
    }
  }
}

/** Pin a coherent bundle outside the disposable plugin installation; an empty session dir is explicitly ephemeral. */
export async function materializeResearchAssets(sessionDir: string): Promise<ResearchAssetsSnapshot> {
  if ("error" in BUNDLE) throw BUNDLE.error;
  if (sessionDir !== "" && !isAbsolute(sessionDir)) throw new Error("Research assets require an absolute session-store directory");
  const durable = sessionDir !== "";
  const store = durable ? sessionDir : join(tmpdir(), `wows-omp-plugins-${process.getuid?.() ?? userInfo().username}`);
  if (!durable) await privateDirectory(store);
  const root = join(store, "ulw-research-assets");
  await privateDirectory(root);
  const directory = join(root, `${RESEARCH_UPSTREAM_PIN}-${BUNDLE.digest}`);
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const staging = await mkdtemp(join(root, ".materializing-"));
    try {
      for (const file of BUNDLE.files) {
        const path = join(staging, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.content, { mode: 0o600 });
      }
      await writeFile(join(staging, MANIFEST), BUNDLE.manifest, { mode: 0o600 });
      try {
        await rename(staging, directory);
      } catch (renameError) {
        if (!["EEXIST", "ENOTEMPTY"].includes((renameError as NodeJS.ErrnoException).code ?? "")) throw renameError;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await validateSnapshot(directory, BUNDLE);
  return { directory, pin: RESEARCH_UPSTREAM_PIN, digest: BUNDLE.digest, durable };
}
