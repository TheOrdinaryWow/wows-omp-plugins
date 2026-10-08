import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { resolveConfiguredModelPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgCycleOrder, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

import { registerToolkitModelRoles } from "../plugins/omo-toolkit/src/index.ts";

const pluginRoot = join(import.meta.dir, "../plugins/omo-toolkit");
const agentDir = join(pluginRoot, "agents");
const skillDir = join(pluginRoot, "skills");
const CATEGORY_AGENTS: Record<string, true> = {
  "deep-low": true,
  "deep-high": true,
  ultrabrain: true,
  architect: true,
  "visual-engineering": true,
  artistry: true,
  writing: true,
};
const TOOL_RESTRICTED_AGENTS: Record<string, true> = {
  architect: true,
  librarian: true,
};

const agentFiles = readdirSync(agentDir)
  .filter((file) => file.endsWith(".md"))
  .sort();
const skillFiles = readdirSync(skillDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(skillDir, entry.name, "SKILL.md"))
  .sort();

describe("omo-toolkit agents", () => {
  test.each(agentFiles)("%s parses as an OMP agent", (file) => {
    const path = join(agentDir, file);
    const agent = parseAgent(path, readFileSync(path, "utf8"), "project", "fatal");
    const name = basename(file, ".md");

    expect(agent.name).toBe(name);
    expect(Array.isArray(agent.model)).toBe(true);
    expect(agent.model?.every((model) => model.startsWith("@"))).toBe(true);
    if (CATEGORY_AGENTS[name]) expect(agent.thinkingLevel).toBeDefined();
    if (TOOL_RESTRICTED_AGENTS[name]) expect(agent.tools?.length).toBeGreaterThan(0);
    if (name === "architect") expect(isReadOnlyAgent(agent)).toBe(true);
  });
});

describe("omo-toolkit skills", () => {
  test.each(skillFiles)("%s declares its skill metadata", (path) => {
    const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"), { location: path, level: "fatal" });

    expect(typeof frontmatter.name).toBe("string");
    expect(String(frontmatter.name).trim()).not.toBe("");
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description).trim()).not.toBe("");
  });
});

describe("omo-toolkit model roles", () => {
  test("lists designer and writer without taking over user tags, other runtime tags, or the cycle", () => {
    const settings = Settings.isolated({ modelRoles: { task: "anthropic/claude-sonnet-4-5" } });
    cfgModelTags.set(settings, { writer: { name: "WRITER", color: "accent" } });
    cfgModelTags.override(settings, { ...cfgModelTags.get(settings), atlas: { name: "ATLAS", color: "syntaxNumber" } });

    registerToolkitModelRoles(settings);

    expect(cfgModelTags.get(settings)).toEqual({
      writer: { name: "WRITER", color: "accent" },
      atlas: { name: "ATLAS", color: "syntaxNumber" },
      designer: { name: "DESIGNER", color: "syntaxVariable" },
    });
    expect(getKnownRoleIds(settings)).toEqual(expect.arrayContaining(["designer", "writer", "atlas"]));
    expect(cfgCycleOrder.get(settings)).toEqual(["smol", "default", "slow"]);
  });

  test("an unassigned registered role still falls through to the next selector", () => {
    const settings = Settings.isolated({ modelRoles: { task: "anthropic/claude-sonnet-4-5" } });
    registerToolkitModelRoles(settings);

    expect(resolveConfiguredModelPatterns(["@designer", "@task"], settings)).toContain("anthropic/claude-sonnet-4-5");
    settings.setModelRole("designer", "google/gemini-3-pro");
    expect(resolveConfiguredModelPatterns(["@designer", "@task"], settings)[0]).toBe("google/gemini-3-pro");
  });
});
