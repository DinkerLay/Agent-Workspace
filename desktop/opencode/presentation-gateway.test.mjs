import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodePresentationGateway } = require("./presentation-gateway.cjs");

test("gates only a registered Conductor WebUI composer before proxying and revokes its lease", async () => {
  const upstreamRequests = [];
  const upstream = await listen(http.createServer(async (request, response) => {
    const body = await readBody(request);
    upstreamRequests.push({
      method: request.method,
      url: request.url,
      body: body.toString("utf8"),
      directoryHeader: request.headers["x-opencode-directory"],
      callbackComplete,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }));
  let callbackComplete = false;
  let releaseCallback;
  let markCallbackStarted;
  const callbackStarted = new Promise((resolve) => { markCallbackStarted = resolve; });
  const observed = [];
  const gateway = createOpenCodePresentationGateway({ upstreamOrigin: upstream.origin });
  const conductor = await gateway.registerPresentation({
    ownerId: "task-run:task-1:run-1",
    leaseId: "presentation-conductor",
    providerSessionId: "ses_conductor",
    cwd: "/private/tmp/presentation-gateway",
    beforeProviderUserMessage: async (input) => {
      observed.push(input);
      markCallbackStarted();
      if (observed.length === 1) await new Promise((resolve) => { releaseCallback = resolve; });
      callbackComplete = true;
    },
  });
  const keepAlive = await gateway.registerPresentation({
    ownerId: "task-run:task-1:run-1",
    leaseId: "presentation-keepalive",
    providerSessionId: "ses_other",
    cwd: "/private/tmp/presentation-gateway",
    beforeProviderUserMessage: async () => undefined,
  });

  try {
    const page = await fetch(`${conductor.origin}${conductor.pathPrefix}/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5/session/ses_conductor`);
    assert.equal(page.status, 200);
    assert.equal(upstreamRequests[0].url, "/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5/session/ses_conductor");
    const cookie = `agent_workspace_presentation_${conductor.token}=1`;

    const cwd = "/private/tmp/presentation-gateway";
    const wrongBootstrapDirectory = await fetch(
      `${conductor.origin}${conductor.pathPrefix}/L3ByaXZhdGUvdG1wL2Fub3RoZXItcHJvamVjdA/session/ses_conductor`,
    );
    assert.equal(wrongBootstrapDirectory.status, 403, "the opaque bootstrap route is bound to its registered project directory");
    const wrongBootstrapSession = await fetch(
      `${conductor.origin}${conductor.pathPrefix}/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5/session/ses_worker`,
    );
    assert.equal(wrongBootstrapSession.status, 403, "the opaque bootstrap route is bound to its registered Provider Session");

    const prompt = fetch(`${conductor.origin}/session/ses_conductor/prompt_async`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-opencode-directory": encodeURIComponent(cwd),
      },
      body: JSON.stringify({ messageID: "msg_direct_1", parts: [{ type: "text", text: "Re-evaluate the thesis." }] }),
    });
    await callbackStarted;
    assert.equal(upstreamRequests.filter((item) => item.method === "POST").length, 0, "the Provider must not see the composer body before Runtime commits its input fact");
    releaseCallback();
    assert.equal((await prompt).status, 200);
    assert.deepEqual(observed[0], {
      providerSessionId: "ses_conductor",
      inputId: "msg_direct_1",
      text: "Re-evaluate the thesis.",
    });
    assert.equal(upstreamRequests.at(-1).callbackComplete, true);
    assert.equal(upstreamRequests.at(-1).directoryHeader, encodeURIComponent(cwd), "the gateway preserves the official WebUI directory header");

    const message = await fetch(`${conductor.origin}/session/ses_conductor/message?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ parts: [{ type: "text", text: "And check downside risk." }] }),
    });
    assert.equal(message.status, 200);
    assert.equal(observed[1]?.inputId.startsWith("webui:"), true, "an opaque gateway input id is created when the official request has no messageID");

    const missingDirectory = await fetch(`${conductor.origin}/session/ses_conductor/message`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ messageID: "msg_missing_directory", parts: [{ type: "text", text: "Missing directory is rejected." }] }),
    });
    assert.equal(missingDirectory.status, 403, "a composer mutation without directory context fails closed");

    const wrongHeader = await fetch(`${conductor.origin}/session/ses_conductor/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-opencode-directory": encodeURIComponent("/private/tmp/another-project"),
      },
      body: JSON.stringify({ messageID: "msg_wrong_directory", parts: [{ type: "text", text: "Wrong directory is rejected." }] }),
    });
    assert.equal(wrongHeader.status, 403, "a mismatched official WebUI header fails closed");

    const malformedHeader = await fetch(`${conductor.origin}/session/ses_conductor/message`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-opencode-directory": "%" },
      body: JSON.stringify({ messageID: "msg_malformed_directory", parts: [{ type: "text", text: "Malformed directory is rejected." }] }),
    });
    assert.equal(malformedHeader.status, 403, "a malformed official WebUI header fails closed");

    const mismatchedDirectory = await fetch(`${conductor.origin}/session/ses_conductor/message?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-opencode-directory": encodeURIComponent("/private/tmp/another-project"),
      },
      body: JSON.stringify({ messageID: "msg_mismatched_directory", parts: [{ type: "text", text: "Conflicting directory is rejected." }] }),
    });
    assert.equal(mismatchedDirectory.status, 403, "query and header disagreement fails closed");

    const duplicateDirectory = await fetch(
      `${conductor.origin}/session/ses_conductor/message?directory=${encodeURIComponent(cwd)}&directory=${encodeURIComponent(cwd)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ messageID: "msg_duplicate_directory", parts: [{ type: "text", text: "Ambiguous directory is rejected." }] }),
      },
    );
    assert.equal(duplicateDirectory.status, 403, "multiple directory parameters cannot create an ambiguous Provider target");

    const wrongSession = await fetch(`${conductor.origin}/session/ses_worker/message?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ messageID: "msg_worker_1", parts: [{ type: "text", text: "Other Session is rejected." }] }),
    });
    assert.equal(wrongSession.status, 403, "a presentation lease cannot mutate another Provider Session");

    const wrongSessionPage = await fetch(`${conductor.origin}/session/ses_worker?directory=${encodeURIComponent(cwd)}`, {
      headers: { cookie },
    });
    assert.equal(wrongSessionPage.status, 403, "a presentation lease cannot read another Provider Session page");

    const sessionStatus = await fetch(`${conductor.origin}/session/status?directory=${encodeURIComponent(cwd)}`, {
      headers: { cookie },
    });
    assert.equal(sessionStatus.status, 200, "the official WebUI may refresh directory-scoped Session status through its bound lease");
    assert.equal(upstreamRequests.at(-1)?.url, `/session/status?directory=${encodeURIComponent(cwd)}`);

    const wrongStatusDirectory = await fetch(`${conductor.origin}/session/status?directory=${encodeURIComponent("/private/tmp/another-project")}`, {
      headers: { cookie },
    });
    assert.equal(wrongStatusDirectory.status, 403, "the directory-scoped status read remains bound to the presentation cwd");

    const nonComposerMutation = await fetch(`${conductor.origin}/session/ses_conductor/abort?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(nonComposerMutation.status, 403, "only documented composer writes can cross a Conductor presentation lease");
    assert.equal(observed.length, 2, "rejected requests must not invoke the Conductor lifecycle callback");

    const unknown = await fetch(`${conductor.origin}/_agent-workspace/presentation/not-a-lease/anything`);
    assert.equal(unknown.status, 404, "an opaque presentation lease is required before the Host proxies anything");

    assert.equal(await gateway.releasePresentation({ ownerId: "task-run:task-1:run-1", leaseId: "presentation-conductor" }), true);
    const revoked = await fetch(`${conductor.origin}${conductor.pathPrefix}/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5/session/ses_conductor`);
    assert.equal(revoked.status, 404, "the released page URL can no longer reach the upstream Server");
    assert.equal(await gateway.releasePresentation({ ownerId: "task-run:task-1:run-1", leaseId: "presentation-keepalive" }), true);
    assert.equal(gateway.registrationCount, 0);
    assert.equal(gateway.origin, undefined);
    assert.ok(keepAlive.token);
  } finally {
    await gateway.close();
    await close(upstream.server);
  }
});

test("does not proxy a composer after its presentation lease is released during Task/Run preflight", async () => {
  const upstreamRequests = [];
  const upstream = await listen(http.createServer(async (request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url, body: (await readBody(request)).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }));
  const gateway = createOpenCodePresentationGateway({ upstreamOrigin: upstream.origin });
  let allowPreflight;
  let preflightStarted;
  const preflight = new Promise((resolve) => { allowPreflight = resolve; });
  const preflightReady = new Promise((resolve) => { preflightStarted = resolve; });
  const presentation = await gateway.registerPresentation({
    ownerId: "task-run:task-race:run-1",
    leaseId: "presentation-conductor",
    providerSessionId: "ses_conductor",
    cwd: "/private/tmp/presentation-gateway-race",
    beforeProviderUserMessage: async () => {
      preflightStarted();
      await preflight;
    },
  });
  // Keep the gateway socket alive after the target lease is revoked so this
  // test verifies a deliberate fail-closed response rather than a TCP reset.
  await gateway.registerPresentation({
    ownerId: "task-run:task-race:run-1",
    leaseId: "presentation-keepalive",
    providerSessionId: "ses_keepalive",
    cwd: "/private/tmp/presentation-gateway-race",
    beforeProviderUserMessage: async () => undefined,
  });

  try {
    const bootstrap = await fetch(
      `${presentation.origin}${presentation.pathPrefix}/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5LXJhY2U/session/ses_conductor`,
    );
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);

    const request = fetch(`${presentation.origin}/session/ses_conductor/prompt_async`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-opencode-directory": encodeURIComponent("/private/tmp/presentation-gateway-race"),
      },
      body: JSON.stringify({ messageID: "msg_race_1", parts: [{ type: "text", text: "Do not proxy after release." }] }),
    });
    await preflightReady;
    assert.equal(await gateway.releasePresentation({
      ownerId: "task-run:task-race:run-1",
      leaseId: "presentation-conductor",
    }), true);
    allowPreflight();
    assert.equal((await request).status, 404, "a revoked lease cannot proxy after preflight returns");
    assert.equal(upstreamRequests.filter((item) => item.method === "POST").length, 0);
  } finally {
    await gateway.close();
    await close(upstream.server);
  }
});

test("redirects the initial Conductor document to OpenCode's canonical Session route after seeding its lease", async () => {
  const upstreamRequests = [];
  const upstream = await listen(http.createServer(async (request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>OpenCode Session</main>");
  }));
  const gateway = createOpenCodePresentationGateway({ upstreamOrigin: upstream.origin });
  const presentation = await gateway.registerPresentation({
    ownerId: "task-run:task-2:run-1",
    leaseId: "presentation-conductor",
    providerSessionId: "ses_conductor",
    cwd: "/private/tmp/presentation-gateway",
    beforeProviderUserMessage: async () => undefined,
  });
  const pagePath = "/L3ByaXZhdGUvdG1wL3ByZXNlbnRhdGlvbi1nYXRld2F5/session/ses_conductor";

  try {
    const bootstrap = await fetch(`${presentation.origin}${presentation.pathPrefix}${pagePath}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(bootstrap.status, 302);
    assert.equal(bootstrap.headers.get("location"), pagePath);
    assert.match(bootstrap.headers.get("set-cookie") ?? "", new RegExp(`agent_workspace_presentation_${presentation.token}=1`));

    const page = await fetch(`${presentation.origin}${pagePath}`, {
      headers: {
        accept: "text/html",
        cookie: `agent_workspace_presentation_${presentation.token}=1`,
      },
    });
    assert.equal(page.status, 200);
    assert.equal(upstreamRequests.at(-1)?.url, pagePath);
  } finally {
    await gateway.close();
    await close(upstream.server);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks)));
  });
}
