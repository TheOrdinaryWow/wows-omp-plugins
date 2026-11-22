import { isUrlPath } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { SearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { type ShellFsDirEntry, ShellFsFileType } from "@oh-my-pi/pi-natives";

/** Entry name of a raw URL segment; a segment the host keeps verbatim (an invalid escape such as `100%`) stays as is. */
export function decodeUrlSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build only the ancestors of known hit files; no directory enumeration or repository scan occurs. */
export function withinTree(root: SearchRoot, files: readonly string[]): Map<string, ShellFsDirEntry[]> {
  const tree = new Map<string, Map<string, ShellFsDirEntry>>([[root.path, new Map()]]);
  const url = isUrlPath(root.path);
  const prefix = `${root.path.replace(/\/+$/, "")}/`;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split("/");
    let parent = root.path;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const name = url ? decodeUrlSegment(part) : part;
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
