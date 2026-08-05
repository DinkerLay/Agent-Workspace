import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createOpencodeModelCapabilityRegistry,
  parseOpencodeVerboseModelList,
} = require("./model-capability-registry.cjs");

test("reads only OpenCode-declared reasoning variants and never invents an effort", () => {
  const models = parseOpencodeVerboseModelList(`
opencode-go/gpt-5.6-luna
{
  "id": "gpt-5.6-luna",
  "providerID": "opencode-go",
  "name": "GPT-5.6 Luna",
  "status": "active",
  "capabilities": { "reasoning": true },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" }
  }
}
opencode-go/deepseek-v4-flash
{
  "id": "deepseek-v4-flash",
  "providerID": "opencode-go",
  "name": "DeepSeek V4 Flash",
  "status": "active",
  "capabilities": { "reasoning": true },
  "variants": {}
}
`);

  assert.deepEqual(models, [
    {
      id: "opencode-go/gpt-5.6-luna",
      providerId: "opencode-go",
      modelId: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      availability: "available",
      status: "active",
      capabilities: { reasoning: true },
      variants: [
        { id: "low", reasoningEffort: "low" },
        { id: "high", reasoningEffort: "high" },
      ],
    },
    {
      id: "opencode-go/deepseek-v4-flash",
      providerId: "opencode-go",
      modelId: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      availability: "available",
      status: "active",
      capabilities: { reasoning: true },
      variants: [],
    },
  ]);
});

test("keeps historical model ids visible without claiming they are currently selectable", async () => {
  const registry = createOpencodeModelCapabilityRegistry({
    resolvePath: () => "/opt/homebrew/bin/opencode",
    execFile: (_path, _args, _options, callback) => callback(undefined, `opencode-go/gpt-5.6-luna
{
  "id": "gpt-5.6-luna",
  "providerID": "opencode-go",
  "name": "GPT-5.6 Luna",
  "capabilities": { "reasoning": true },
  "variants": { "max": { "reasoningEffort": "max" } }
}`),
  });

  const result = await registry.list({
    historicalModelIds: ["opencode-go/gpt-5.6-luna", "retired-provider/retired-model"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "opencode-cli-verbose");
  assert.deepEqual(result.models.map((model) => [model.id, model.availability, model.variants]), [
    ["opencode-go/gpt-5.6-luna", "available", [{ id: "max", reasoningEffort: "max" }]],
    ["retired-provider/retired-model", "historical", []],
  ]);
});

test("falls back to the basic OpenCode catalog when verbose metadata is unavailable", async () => {
  const calls = [];
  const registry = createOpencodeModelCapabilityRegistry({
    resolvePath: () => "/opt/homebrew/bin/opencode",
    execFile: (_path, args, _options, callback) => {
      calls.push(args);
      if (args.includes("--verbose")) {
        callback(new Error("unknown option --verbose"));
        return;
      }
      callback(undefined, "\u001B[32mopencode-go/gpt-5.6-luna\u001B[0m  GPT-5.6 Luna\nopenai/gpt-5.6-sol  GPT-5.6 Sol\n");
    },
  });

  const result = await registry.list();

  assert.deepEqual(calls, [["models", "--verbose"], ["models"]]);
  assert.equal(result.ok, true);
  assert.equal(result.source, "opencode-cli-list");
  assert.deepEqual(result.models.map((model) => model.id), ["opencode-go/gpt-5.6-luna", "openai/gpt-5.6-sol"]);
  assert.deepEqual(result.models[0].variants, []);
});

test("caches the Provider catalog but lets a caller explicitly refresh it", async () => {
  let clock = 100;
  let calls = 0;
  const registry = createOpencodeModelCapabilityRegistry({
    resolvePath: () => "/opt/homebrew/bin/opencode",
    now: () => clock,
    execFile: (_path, _args, _options, callback) => {
      calls += 1;
      callback(undefined, `opencode-go/gpt-5.6-luna\n{"id":"gpt-5.6-luna","providerID":"opencode-go","variants":{}}`);
    },
  });

  await registry.list();
  await registry.list();
  clock += 1;
  await registry.list({ forceRefresh: true });

  assert.equal(calls, 2);
});

test("merges concurrent reads into one Provider command", async () => {
  let calls = 0;
  let complete;
  const registry = createOpencodeModelCapabilityRegistry({
    resolvePath: () => "/opt/homebrew/bin/opencode",
    execFile: (_path, _args, _options, callback) => {
      calls += 1;
      complete = () => callback(undefined, `opencode-go/gpt-5.6-luna\n{"id":"gpt-5.6-luna","providerID":"opencode-go","variants":{}}`);
    },
  });

  const first = registry.list();
  const second = registry.list({ forceRefresh: true });
  assert.equal(calls, 1);
  complete();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("returns historical entries when no local OpenCode catalog is available", async () => {
  const registry = createOpencodeModelCapabilityRegistry({ resolvePath: () => undefined });
  const result = await registry.list({ historicalModelIds: ["old-provider/old-model"] });

  assert.deepEqual(result, {
    ok: false,
    source: "unavailable",
    models: [
      {
        id: "old-provider/old-model",
        providerId: "old-provider",
        modelId: "old-model",
        name: "old-provider/old-model",
        availability: "historical",
        status: "unknown",
        capabilities: { reasoning: false },
        variants: [],
      },
    ],
    error: "opencode_model_catalog_unavailable",
  });
});
