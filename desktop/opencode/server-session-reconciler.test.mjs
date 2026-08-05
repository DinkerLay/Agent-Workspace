import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reconcileOpenCodeSessionBindings } = require("./server-session-reconciler.cjs");
const { test } = await import("node:test");

test("reconciles only explicitly bound Provider Sessions without creating or guessing one", async () => {
  const requested = [];
  const client = {
    async getSession({ cwd, providerSessionId }) {
      requested.push({ cwd, providerSessionId });
      if (providerSessionId === "ses_missing") throw new Error("opencode_server_request_failed:404");
      return { id: providerSessionId, title: "Bound Session" };
    },
  };

  const results = await reconcileOpenCodeSessionBindings({
    client,
    cwd: "/tmp/project",
    bindings: [
      { sessionId: "logical-conductor", providerSessionId: "ses_conductor" },
      { sessionId: "logical-worker", providerSessionId: "ses_missing" },
    ],
  });

  assert.deepEqual(requested, [
    { cwd: "/tmp/project", providerSessionId: "ses_conductor" },
    { cwd: "/tmp/project", providerSessionId: "ses_missing" },
  ]);
  assert.deepEqual(results, [
    { sessionId: "logical-conductor", providerSessionId: "ses_conductor", status: "available", providerSession: { id: "ses_conductor", title: "Bound Session" } },
    { sessionId: "logical-worker", providerSessionId: "ses_missing", status: "missing", reason: "opencode_server_request_failed:404" },
  ]);
});
