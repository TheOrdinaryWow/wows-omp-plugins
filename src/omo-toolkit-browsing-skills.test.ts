import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const skillRoot = resolve(import.meta.dir, "../plugins/omo-toolkit/skills");
const browsingRoot = join(skillRoot, "ultimate-browsing");
const browsingFiles = readdirSync(browsingRoot, { recursive: true, withFileTypes: true });

describe("native/reference-only browsing payload", () => {
  test("ships reference documents without an extraction engine or credential utilities", () => {
    expect(readdirSync(browsingRoot).sort()).toEqual(["ATTRIBUTION.md", "SKILL.md", "references"]);
    const files = browsingFiles.filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(2);
    for (const entry of browsingFiles) {
      expect(entry.isSymbolicLink()).toBe(false);
      if (entry.isFile()) expect(extname(entry.name)).toBe(".md");
    }
  });

  test("shipped browsing and visualization document links resolve within the plugin", () => {
    const documents = browsingFiles.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
    documents.push(join(skillRoot, "visualize/SKILL.md"));
    for (const path of documents) {
      for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (!target || /^[a-z]+:|^#/i.test(target)) continue;
        expect(statSync(resolve(dirname(path), target.split("#")[0] ?? target)).isFile()).toBe(true);
      }
    }
  });
});
