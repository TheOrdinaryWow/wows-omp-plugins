import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "../plugins/omo-toolkit");
const skillRoot = join(pluginRoot, "skills");

function skillDirectories(): string[] {
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function frontmatter(source: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1] ?? ""] = (field[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

function relativeLinkTargets(source: string): string[] {
  const prose = source.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => target.split("#")[0] ?? "")
    .filter((target) => target !== "");
}

describe("omo-toolkit skill packaging", () => {
  test("every skill directory has a SKILL.md whose name matches the directory and has a description", () => {
    const problems: string[] = [];
    for (const directory of skillDirectories()) {
      const path = join(skillRoot, directory, "SKILL.md");
      if (!existsSync(path)) {
        problems.push(`${directory}: missing SKILL.md`);
        continue;
      }
      const fields = frontmatter(readFileSync(path, "utf8"));
      if (fields.name !== directory) problems.push(`${directory}: frontmatter name is ${JSON.stringify(fields.name)}`);
      if (!fields.description) problems.push(`${directory}: frontmatter description is missing`);
    }
    expect(problems).toEqual([]);
  });

  test("relative markdown links inside skills resolve to existing files or directories", () => {
    const problems: string[] = [];
    for (const file of markdownFiles(skillRoot)) {
      for (const target of relativeLinkTargets(readFileSync(file, "utf8"))) {
        if (!existsSync(resolve(dirname(file), target))) problems.push(`${relative(pluginRoot, file)} -> ${target}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("the plugin package declares no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(manifest, "dependencies")).toBe(false);
  });
});
