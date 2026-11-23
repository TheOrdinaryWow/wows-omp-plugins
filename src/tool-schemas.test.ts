import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

const PLUGINS = fileURLToPath(new URL("../plugins/", import.meta.url));
const TOP_LEVEL_FORBIDDEN = ["anyOf", "oneOf", "allOf", "enum", "const", "not"];

function extensionEntries(): string[] {
  return readdirSync(PLUGINS).flatMap((name) => {
    const manifest = JSON.parse(readFileSync(join(PLUGINS, name, "package.json"), "utf8")) as { omp?: { extensions?: string[] } };
    return (manifest.omp?.extensions ?? []).map((entry) => join(PLUGINS, name, entry));
  });
}

test("every plugin tool advertises a plain object schema that function-calling providers accept", async () => {
  const { extensions, errors } = await loadExtensions(extensionEntries(), tmpdir());
  expect(errors).toEqual([]);
  const offenders: string[] = [];
  let checked = 0;
  for (const extension of extensions) {
    for (const [name, tool] of extension.tools) {
      checked++;
      const wire = toolWireSchema(tool.definition as unknown as Tool);
      const forbidden = TOP_LEVEL_FORBIDDEN.filter((key) => key in wire);
      if (wire.type !== "object" || forbidden.length > 0) offenders.push(`${name}: type=${String(wire.type)} ${forbidden.join(",")}`);
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
