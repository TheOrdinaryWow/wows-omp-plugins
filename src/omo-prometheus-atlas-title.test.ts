import { expect, test } from "bun:test";

import { type AtlasTitleSession, retitleForAtlas } from "../plugins/omo-prometheus/src/atlas-title.ts";

const plan = { name: "billing-cleanup", content: "# Billing cleanup\n\nRemove the legacy invoice path." };

function fakeSession(options: { titleSource?: "auto" | "user"; override?: string; titles?: Promise<string | null>[] } = {}) {
  const titles = options.titles ?? [Promise.resolve("Atlas: Remove legacy invoices")];
  const prompts: (string | undefined)[] = [];
  const names: { name: string; source: string }[] = [];
  const manager = { titleSource: options.titleSource, getSessionId: () => "session-1" };
  const session: AtlasTitleSession = {
    titleSystemPrompt: options.override,
    titleGenerationSignal: new AbortController().signal,
    sessionManager: manager,
    async generateTitle(_input, prompt) {
      prompts.push(prompt);
      return titles.shift() ?? null;
    },
    async setSessionName(name, source) {
      names.push({ name, source });
      manager.titleSource = source;
      return true;
    },
  };
  return { session, manager, prompts, names };
}

test("stores the generated title as an automatic name", async () => {
  const { session, names } = fakeSession();
  await retitleForAtlas(session, plan);
  expect(names).toEqual([{ name: "Atlas: Remove legacy invoices", source: "auto" }]);
});

test("falls back to the plan name when the model yields no title", async () => {
  const { session, names } = fakeSession({ titles: [Promise.resolve(null)] });
  await retitleForAtlas(session, plan);
  expect(names).toEqual([{ name: "Atlas: billing-cleanup", source: "auto" }]);
});

test("never replaces a name the user chose, before or during generation", async () => {
  const before = fakeSession({ titleSource: "user" });
  await retitleForAtlas(before.session, plan);
  expect(before.prompts).toHaveLength(0);
  expect(before.names).toHaveLength(0);

  const generation = Promise.withResolvers<string | null>();
  const during = fakeSession({ titles: [generation.promise] });
  const pending = retitleForAtlas(during.session, plan);
  during.manager.titleSource = "user";
  generation.resolve("Atlas: Remove legacy invoices");
  await pending;
  expect(during.names).toHaveLength(0);
});

test("a later request supersedes one still in flight", async () => {
  const firstGeneration = Promise.withResolvers<string | null>();
  const { session, names } = fakeSession({ titles: [firstGeneration.promise, Promise.resolve("Atlas: Second plan")] });
  const first = retitleForAtlas(session, plan);
  await retitleForAtlas(session, { ...plan, name: "second" });
  firstGeneration.resolve("Atlas: First plan");
  await first;
  expect(names).toEqual([{ name: "Atlas: Second plan", source: "auto" }]);
});

test("the user's title prompt override takes precedence over the host default", async () => {
  const custom = fakeSession({ override: "Titles are lowercase Chinese." });
  await retitleForAtlas(custom.session, plan);
  const prompt = custom.prompts[0] ?? "";
  expect(prompt.startsWith("Titles are lowercase Chinese.")).toBe(true);
  expect(prompt).not.toContain("Write a ~5 word title");
  expect(prompt).toContain("Atlas");
});
