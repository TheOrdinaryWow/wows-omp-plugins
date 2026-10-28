import type { SearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { type ShellFsDirEntry, ShellFsFileType } from "@oh-my-pi/pi-natives";

/** Build only the ancestors of known hit files; no directory enumeration or repository scan occurs. */
export function withinTree(root: SearchRoot, files: readonly string[]): Map<string, ShellFsDirEntry[]> {
  const tree = new Map<string, Map<string, ShellFsDirEntry>>([[root.path, new Map()]]);
  const prefix = `${root.path.replace(/\/+$/, "")}/`;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split("/");
    let parent = root.path;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!name) continue;
      const directory = i < parts.length - 1;
      let entries = tree.get(parent);
      if (!entries) {
        entries = new Map();
        tree.set(parent, entries);
      }
      entries.set(name, { name, fileType: directory ? ShellFsFileType.Dir : ShellFsFileType.File });
      parent = resolveSearchResultPath(parent, name);
    }
  }
  return new Map([...tree].map(([path, entries]) => [path, [...entries.values()]]));
}
