import { lstat, readdir, readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { isRecord, logger } from "@oh-my-pi/pi-utils";

export async function readSidecars(sessionId: string): Promise<{ plugin: string; evidence: string }[]> {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const uid = process.getuid?.();
  const root =
    runtime && isAbsolute(runtime) ? join(runtime, "wows-omp-plugins") : join(tmpdir(), `wows-omp-plugins-${uid ?? userInfo().username}`);
  if (basename(sessionId) !== sessionId || sessionId === "." || sessionId === ".." || !sessionId) return [];
  const dir = join(root, "plugin-state", sessionId);
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) return [];
    const files = await readdir(dir, { withFileTypes: true });
    const sidecars: { plugin: string; evidence: string }[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      try {
        const data: unknown = JSON.parse(await readFile(join(dir, file.name), "utf8"));
        if (
          !isRecord(data) ||
          data.schema !== "wows-omp-plugins/plugin-state" ||
          data.version !== 1 ||
          data.sessionId !== sessionId ||
          typeof data.plugin !== "string" ||
          !Object.hasOwn(data, "state")
        )
          continue;
        sidecars.push({ plugin: data.plugin, evidence: JSON.stringify(data.state) });
      } catch (error) {
        logger.debug("switch-until could not read a plugin sidecar", { file: file.name, error });
      }
    }
    return sidecars;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") logger.debug("switch-until could not list plugin sidecars", { error });
    return [];
  }
}
