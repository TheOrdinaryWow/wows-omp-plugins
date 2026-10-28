#!/usr/bin/env node
// Modified-port notice and license. Adapted from oh-my-openagent onboarding/qa-savings-fixture.sh
// at revision 8a8db1d3094da8743989bf693ee5de77889de50e. Sustainable Use License 1.0
// (../../../LICENSE-SUL-1.0): internal business and personal/noncommercial use;
// free distribution for noncommercial purposes.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const usageKeys = ["input", "output", "cacheRead", "cacheWrite"];
const priceKeys = ["input", "output", "cache_read", "cache_write"];
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const round = (value) => Math.round(value * 100) / 100;
const identity = (provider, model) =>
  typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0 ? { provider, model } : null;

function priceFor(catalog, provider, model) {
  const exact = catalog?.[provider]?.models?.[model]?.cost;
  if (exact !== undefined) return { provider, cost: exact };
  for (const key of Object.keys(catalog ?? {}).sort()) {
    const models = catalog[key]?.models ?? {};
    for (const modelKey of Object.keys(models).sort()) {
      if (modelKey === model) return { provider: key, cost: models[modelKey]?.cost };
    }
  }
  return null;
}

function readSession(path, skipped) {
  const entries = [];
  for (const [index, text] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!text.trim()) continue;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      skipped.push({ path, line: index + 1, reason: "malformed JSON entry" });
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      skipped.push({ path, line: index + 1, reason: "non-object entry" });
      continue;
    }
    entries.push({ value, line: index + 1 });
  }
  const header = entries.find(({ value }) => value.type !== "title")?.value;
  if (header?.type !== "session" || header.version !== 3) {
    skipped.push({ path, reason: "requires an explicitly selected native v3 session" });
    return [];
  }
  const valid = entries.filter(({ value, line }) => {
    if (value.type === "title") return false;
    if (typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))) return true;
    skipped.push({ path, line, reason: "missing or malformed timestamp" });
    return false;
  });
  const firstChange = valid.find(({ value }) => value.type === "model_change" && identity(value.provider, value.modelId))?.value;
  let active = firstChange ? identity(firstChange.provider, firstChange.modelId) : null;
  const usage = [];
  // JSONL order is authoritative, including equal/near-equal timestamps.
  for (const { value, line } of valid) {
    if (value.type === "model_change") {
      active = identity(value.provider, value.modelId);
      continue;
    }
    const message = value.type === "message" ? value.message : null;
    if (message?.usage === undefined) continue;
    if (!usageKeys.every((key) => Number.isFinite(message.usage?.[key]) && message.usage[key] >= 0)) {
      skipped.push({ path, line, reason: "invalid or incomplete message usage" });
      continue;
    }
    const model = identity(message.provider, message.model) ?? active;
    if (!model) {
      skipped.push({ path, line, reason: "no provider/model attribution" });
      continue;
    }
    usage.push({ ...model, usage: message.usage });
  }
  return usage;
}

function summarize(files, catalog) {
  const skipped = [];
  const priceFallbacks = [];
  const models = new Map();
  const usage = emptyUsage();
  let used = 0;
  let actual = 0;
  let discount = 0;
  for (const path of files) {
    const rows = readSession(path, skipped);
    if (!rows.length) continue;
    if (rows.reduce((sum, row) => sum + row.usage.input + row.usage.cacheRead + row.usage.cacheWrite, 0) === 0) {
      skipped.push({ path, reason: "zero input tokens" });
      continue;
    }
    const priced = rows.map((row) => ({ ...row, price: priceFor(catalog, row.provider, row.model) }));
    const insufficient = priced.filter(
      (row) => !priceKeys.every((key) => Number.isFinite(row.price?.cost?.[key]) && row.price.cost[key] >= 0),
    );
    if (insufficient.length) {
      skipped.push({
        path,
        reason: "insufficient pricing; entire session excluded",
        models: insufficient.map(({ provider, model }) => ({ provider, model })),
      });
      continue;
    }
    used += 1;
    const fallbacks = new Set();
    for (const row of priced) {
      const { provider, model, usage: tokens, price } = row;
      const key = JSON.stringify([provider, model]);
      let aggregate = models.get(key);
      if (!aggregate) {
        aggregate = { provider, model, priceProvider: price.provider, usage: emptyUsage(), actualUsd: 0, cacheDiscountUsd: 0 };
        models.set(key, aggregate);
      }
      for (const field of usageKeys) {
        usage[field] += tokens[field];
        aggregate.usage[field] += tokens[field];
      }
      const cost =
        (tokens.input * price.cost.input +
          tokens.output * price.cost.output +
          tokens.cacheRead * price.cost.cache_read +
          tokens.cacheWrite * price.cost.cache_write) /
        1_000_000;
      const savings = (tokens.cacheRead * (price.cost.input - price.cost.cache_read)) / 1_000_000;
      actual += cost;
      discount += savings;
      aggregate.actualUsd += cost;
      aggregate.cacheDiscountUsd += savings;
      if (price.provider !== provider && !fallbacks.has(key)) {
        fallbacks.add(key);
        priceFallbacks.push({ path, provider, model, priceProvider: price.provider });
      }
    }
  }
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    schema: "wows-omp-plugins/cache-usage-estimate",
    version: 1,
    status: used === 0 ? "insufficient-data" : skipped.length ? "partial" : "estimated",
    usage,
    models: [...models.values()]
      .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
      .map((row) => ({
        ...row,
        actualUsd: round(row.actualUsd),
        cacheDiscountUsd: round(row.cacheDiscountUsd),
      })),
    actualUsd: used ? round(actual) : null,
    cacheDiscountUsd: used ? round(discount) : null,
    cacheHitRate: input ? round((usage.cacheRead / input) * 100) : null,
    scanned: files.length,
    used,
    skipped,
    priceFallbacks,
  };
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--sessions" || args[2] !== "--prices") {
    throw new Error("Usage: node summarize-cache-usage.mjs --sessions explicit-files.json --prices models.dev.json");
  }
  const input = JSON.parse(readFileSync(args[1], "utf8"));
  if (!Array.isArray(input) || input.some((file) => typeof file !== "string" || !file))
    throw new Error("--sessions must contain an array of explicit file paths");
  const prices = JSON.parse(readFileSync(args[3], "utf8"));
  if (prices !== null && (typeof prices !== "object" || Array.isArray(prices)))
    throw new Error("--prices must contain a provider map (or null for unavailable pricing)");
  const files = [...new Set(input.map((file) => resolve(file)))].sort(
    (a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b),
  );
  console.log(JSON.stringify(summarize(files, prices), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
