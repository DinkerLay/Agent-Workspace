import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenCodeServerSessionPageResolver,
  encodeOpenCodeDirectory,
  normalizeLoopbackOrigin,
} from "./server-session-page.cjs";

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("returns one version-pinned official Session page handle", async () => {
  const calls = [];
  const resolver = createOpenCodeServerSessionPageResolver({
    serverOrigin: "http://127.0.0.1:4099",
    expectedProviderVersion: "1.18.11",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/global/health")) return response({ healthy: true, version: "1.18.11" });
      return response({ openapi: "3.1.0" });
    },
  });

  const page = await resolver.openSessionPage({
    providerSessionId: "ses_03fb4c341ffelYLtT4FZALRE6A",
    cwd: "/private/tmp/opencode-webui-preview.IFL6Q8",
  });

  assert.deepEqual(calls, ["http://127.0.0.1:4099/global/health", "http://127.0.0.1:4099/doc"]);
  assert.equal(page.presentation, "direct_url");
  assert.equal(page.providerVersion, "1.18.11");
  assert.equal(
    page.url,
    "http://127.0.0.1:4099/L3ByaXZhdGUvdG1wL29wZW5jb2RlLXdlYnVpLXByZXZpZXcuSUZMNlE4/session/ses_03fb4c341ffelYLtT4FZALRE6A",
  );
});

test("does not hand off an unavailable host or malformed provider session", async () => {
  const resolver = createOpenCodeServerSessionPageResolver({
    serverOrigin: "http://127.0.0.1:4099",
    fetchImpl: async () => response({}, false),
  });
  assert.deepEqual(await resolver.openSessionPage({ providerSessionId: "not-a-session", cwd: "/tmp/project" }), {
    presentation: "unavailable",
    reason: "provider_session_id_invalid",
  });
  assert.deepEqual(await resolver.openSessionPage({ providerSessionId: "ses_0123", cwd: "/tmp/project" }), {
    presentation: "unavailable",
    providerSessionId: "ses_0123",
    reason: "opencode_server_unavailable",
  });
});

test("uses a scoped presentation gateway only for a Session with a preflight callback", async () => {
  const registrations = [];
  const beforeProviderUserMessage = async () => undefined;
  const resolver = createOpenCodeServerSessionPageResolver({
    serverOrigin: "http://127.0.0.1:4099",
    expectedProviderVersion: "1.18.11",
    fetchImpl: async (url) => url.endsWith("/global/health")
      ? response({ healthy: true, version: "1.18.11" })
      : response({ openapi: "3.1.0" }),
    presentationGateway: {
      async registerPresentation(input) {
        registrations.push(input);
        return { origin: "http://127.0.0.1:4999", pathPrefix: "/_agent-workspace/presentation/opaque-lease" };
      },
    },
  });

  const page = await resolver.openSessionPage({
    providerSessionId: "ses_03fb4c341ffelYLtT4FZALRE6A",
    cwd: "/private/tmp/opencode-webui-preview.IFL6Q8",
    presentationLeaseId: "presentation-run-1",
    beforeProviderUserMessage,
  });

  assert.equal(page.presentation, "direct_url");
  assert.equal(
    page.url,
    "http://127.0.0.1:4999/_agent-workspace/presentation/opaque-lease/L3ByaXZhdGUvdG1wL29wZW5jb2RlLXdlYnVpLXByZXZpZXcuSUZMNlE4/session/ses_03fb4c341ffelYLtT4FZALRE6A",
  );
  assert.deepEqual(registrations, [{
    providerSessionId: "ses_03fb4c341ffelYLtT4FZALRE6A",
    cwd: "/private/tmp/opencode-webui-preview.IFL6Q8",
    leaseId: "presentation-run-1",
    beforeProviderUserMessage,
  }]);
});

test("does not bypass a requested Task preflight when its presentation gateway is unavailable", async () => {
  const resolver = createOpenCodeServerSessionPageResolver({
    serverOrigin: "http://127.0.0.1:4099",
    expectedProviderVersion: "1.18.11",
    fetchImpl: async (url) => url.endsWith("/global/health")
      ? response({ healthy: true, version: "1.18.11" })
      : response({ openapi: "3.1.0" }),
  });
  const page = await resolver.openSessionPage({
    providerSessionId: "ses_03fb4c341ffelYLtT4FZALRE6A",
    cwd: "/private/tmp/project",
    presentationLeaseId: "presentation-run-1",
    beforeProviderUserMessage: async () => undefined,
  });
  assert.deepEqual(page, {
    presentation: "unavailable",
    providerSessionId: "ses_03fb4c341ffelYLtT4FZALRE6A",
    reason: "opencode_presentation_gateway_unavailable",
  });
});

test("accepts only loopback HTTP origins and owns directory encoding", () => {
  assert.equal(normalizeLoopbackOrigin("http://localhost:4099"), "http://localhost:4099");
  assert.equal(encodeOpenCodeDirectory("/private/tmp/project"), "L3ByaXZhdGUvdG1wL3Byb2plY3Q");
  assert.throws(() => normalizeLoopbackOrigin("https://opencode.example.com"), /loopback/);
  assert.throws(() => normalizeLoopbackOrigin("http://127.0.0.1:4099/root"), /must_not_contain/);
});
