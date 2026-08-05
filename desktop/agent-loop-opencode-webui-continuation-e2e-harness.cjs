const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createOpenCodePresentationGateway } = require("./opencode/presentation-gateway.cjs");
const { createOpenCodeServerSessionPageResolver } = require("./opencode/server-session-page.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionStoreCapabilities } = require("./runtime/session-store-capabilities.cjs");
const { createSessionStore } = require("./session-store.cjs");

/**
 * Deterministic official-WebUI continuation proof.
 *
 * It composes the real Runtime page opener, official Session page resolver,
 * scoped HTTP presentation gateway, and Conductor tool bridge. The only fake
 * is the upstream OpenCode Server, which lets the test inspect the exact
 * instant a composer POST first reaches the Provider.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-webui-continuation-e2e-"));
  let runtime;
  let gateway;
  let upstream;
  try {
    const calls = {
      ensure: [],
      create: [],
      getSession: [],
      prompt: [],
      release: [],
    };
    const upstreamPosts = [];
    let taskId = "";
    let runId = "";
    let conductorSessionId = "";
    let publisherSessionId = "";
    let conductorProviderSessionId = "";
    let server;

    upstream = await listen(http.createServer(async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url, "http://mock-opencode.invalid");
      if (url.pathname === "/global/health") {
        return json(response, { healthy: true, version: "1.18.11" });
      }
      if (url.pathname === "/doc") return json(response, { openapi: "3.1.0" });
      if (request.method === "POST") {
        // This is the causal assertion: no Provider request may arrive until
        // Runtime recorded the new decision epoch for this same Run/session.
        upstreamPosts.push({
          url: request.url,
          body: body.toString("utf8"),
          directoryHeader: request.headers["x-opencode-directory"],
          taskStatus: runtime.readTask({ taskId }).status,
          run: runtime.readRun({ runId }).run,
          dispatch: runtime.validateDispatch({ taskId, agentId: "publisher", toSessionId: publisherSessionId }),
        });
        return json(response, { accepted: true });
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Mock OpenCode Web UI</title>");
    }));

    const manager = {
      async ensureRun(input) {
        calls.ensure.push(input);
        return (server ??= {
          taskId: input.taskId,
          runId: input.runId,
          cwd: input.cwd,
          origin: upstream.origin,
          providerVersion: "1.18.11",
        });
      },
      getRun() { return server; },
      subscribeRun() { return () => undefined; },
      clientForRun() {
        return {
          async createSession(input) {
            calls.create.push(input);
            if (calls.create.length === 1) return { id: "ses_webuiconductor001" };
            if (calls.create.length === 2) return { id: "ses_webuipublisher001" };
            throw new Error("unexpected_provider_session_create");
          },
          async getSession(input) {
            calls.getSession.push(input);
            return { id: input.providerSessionId, title: "existing bound Session" };
          },
          async promptAsync(input) {
            calls.prompt.push(input);
            return { accepted: true };
          },
          async sendMessage() {
            throw new Error("direct_webui_input_must_not_trigger_runtime_send_message");
          },
        };
      },
      async releaseRun(input) {
        calls.release.push(input);
        return true;
      },
    };

    const sessionStore = createSessionStore({
      root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime"),
    });
    const capabilities = createSessionStoreCapabilities(sessionStore);
    gateway = createOpenCodePresentationGateway({ upstreamOrigin: upstream.origin });

    runtime = createAgentLoopV1Runtime({
      openCodeServerManager: manager,
      sessionStoreCapabilities: capabilities,
      opencodePath: "/fixture/opencode",
      databasePath: path.join(root, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: "http://127.0.0.1:5288",
        conductorToolBridgeToken: "webui-e2e-token",
        conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
      }),
      resolveOpenCodeSessionPage: (input) => {
        const runServer = manager.getRun({ taskId: input.taskId, runId: input.runId });
        return createOpenCodeServerSessionPageResolver({
          serverOrigin: runServer.origin,
          expectedProviderVersion: "1.18.11",
          presentationGateway: {
            registerPresentation: (presentation) => gateway.registerPresentation({
              ownerId: `task-run:${input.taskId}:${input.runId}`,
              ...presentation,
            }),
          },
        }).openSessionPage(input);
      },
      releaseOpenCodeSessionPage: ({ taskId: releaseTaskId, runId: releaseRunId, leaseId }) =>
        gateway.releasePresentation({
          ownerId: `task-run:${releaseTaskId}:${releaseRunId}`,
          leaseId,
        }),
    });

    const template = runtime.saveTemplate({
      id: "webui-continuation-template",
      name: "WebUI continuation template",
      source: "manual",
      conductor: {
        role: "Conductor",
        model: "opencode-go/gpt-5.6-luna",
        charter: "Decide the next bounded Session Agent dispatch from durable inputs.",
      },
      agents: [{
        id: "publisher",
        name: "Publisher",
        kind: "publisher",
        model: "opencode-go/gpt-5.6-luna",
        dispatchProfile: {
          title: "Evidence-backed delivery",
          description: "Use when a requested artifact is ready to be produced from verified context.",
        },
        workerSystemPrompt: "Create the requested deliverable only from supplied verified material.",
      }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "report.html", ownerAgentId: "publisher" },
    });
    const task = runtime.createTask({
      taskId: "task-webui-continuation-e2e",
      cwd: root,
      title: "Official WebUI delivery-ready continuation",
      goal: "Continue an existing Conductor Session without starting a new Run.",
      templateId: template.id,
    });
    taskId = task.taskId;
    const started = await runtime.startRun({ taskId, commandId: "command-webui-continuation-start" });
    runId = started.run.runId;
    conductorSessionId = started.run.conductorSessionId;
    publisherSessionId = runtime.resolveAgentSession({ taskId, agentId: "publisher" }).sessionId;
    conductorProviderSessionId = "ses_webuiconductor001";

    runtime.recordCompletionClaim({
      taskId,
      sessionId: conductorSessionId,
      message: "The initial deliverable is ready for the user to inspect.",
    });
    assert.equal(runtime.readTask({ taskId }).status, "delivery_ready");
    assert.deepEqual(
      runtime.validateDispatch({ taskId, agentId: "publisher", toSessionId: publisherSessionId }),
      { ok: false, reason: "loop_task_not_dispatchable" },
      "the closed decision epoch cannot dispatch before a new user turn",
    );

    const page = await runtime.openOpenCodeSessionPage({ runId, sessionId: conductorSessionId });
    assert.equal(page.presentation, "direct_url");
    assert.equal(page.providerSessionId, conductorProviderSessionId);
    assert.ok(page.url.includes("/_agent-workspace/presentation/"), "Conductor receives a scoped gateway URL, never the upstream URL");
    assert.ok(page.presentationLeaseId);

    // Match a real iframe document navigation: the opaque bootstrap URL only
    // seeds its HttpOnly lease, then redirects the official Web UI to its
    // canonical exact-Session route at the gateway origin.
    const bootstrap = await fetch(page.url, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(bootstrap.status, 302);
    const sessionRoute = bootstrap.headers.get("location");
    assert.match(String(sessionRoute), new RegExp(`/session/${conductorProviderSessionId}$`));
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie, "the scoped gateway bootstraps its revocable presentation cookie");
    const cookie = setCookie.split(";", 1)[0];
    const officialPage = await fetch(`${gateway.origin}${sessionRoute}`, {
      headers: { accept: "text/html", cookie },
    });
    assert.equal(officialPage.status, 200, "the cookie-bound canonical route opens the exact official Conductor Session");

    const exactMessageId = "msgOfficialWebUiContinuation42";
    const text = "继续：请调用 Publisher 生成可打开的 HTML 投资研究说明。";
    const composerResponse = await fetch(
      `${gateway.origin}/session/${conductorProviderSessionId}/prompt_async`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-opencode-directory": encodeURIComponent(root),
        },
        body: JSON.stringify({
          messageID: exactMessageId,
          parts: [{ type: "text", text }],
        }),
      },
    );
    assert.equal(composerResponse.status, 200);
    assert.equal(upstreamPosts.length, 1, "the exact official-WebUI composer request reaches the Provider once");
    assert.equal(upstreamPosts[0].url, `/session/${conductorProviderSessionId}/prompt_async`);
    assert.equal(upstreamPosts[0].directoryHeader, encodeURIComponent(root), "the official WebUI's directory header reaches the Provider unchanged");
    assert.equal(JSON.parse(upstreamPosts[0].body).messageID, exactMessageId, "the original Provider messageID is never replaced");
    assert.equal(upstreamPosts[0].taskStatus, "running", "Runtime reopens delivery_ready before forwarding the Provider request");
    assert.equal(upstreamPosts[0].run.runId, runId, "the HTTP turn retains the same logical Run");
    assert.equal(upstreamPosts[0].run.conductorSessionId, conductorSessionId, "the HTTP turn retains the same Conductor logical Session");
    assert.deepEqual(upstreamPosts[0].dispatch, { ok: true }, "Publisher dispatch is legal at the first Provider-visible instant");

    const continued = runtime.readRun({ runId });
    assert.equal(continued.task.status, "running");
    assert.equal(continued.run.runId, runId);
    assert.equal(continued.run.conductorSessionId, conductorSessionId);
    const inputEvent = continued.events.find((event) => event.type === "conductor.provider_user_input_attempting");
    assert.equal(inputEvent?.data?.inputId, exactMessageId, "the durable Runtime intent uses the exact original messageID");
    assert.equal(inputEvent?.data?.providerSessionId, conductorProviderSessionId);

    const bridge = createConductorToolBridge({
      sessionStore,
      ptyManager: {},
      validateDispatch: (input) => runtime.validateDispatch(input),
      resolveAgentSession: (input) => runtime.resolveAgentSession(input),
      prepareDispatchContext: (input) => runtime.prepareDispatchContext(input),
      deliverProviderAssignment: (input) => runtime.deliverOpenCodeWorkerAssignment(input),
      resolveConductorSessionId: () => conductorSessionId,
    });
    const publisher = await bridge.callSession({
      taskId,
      agentId: "publisher",
      assignment: "Create report.html explaining the updated investment analysis.",
      expectedOutput: "report.html",
    });
    assert.equal(publisher.ok, true);
    assert.equal(publisher.status, "accepted");
    assert.equal(calls.create.length, 2, "the accepted Publisher dispatch creates only its own Provider Session");
    assert.equal(calls.create[1].metadata.agentWorkspaceRunId, runId);
    assert.equal(calls.prompt.at(-1).providerSessionId, "ses_webuipublisher001");
    assert.equal(calls.prompt.at(-1).agent, "build");

    assert.equal(await runtime.releaseOpenCodeSessionPage({
      runId,
      sessionId: conductorSessionId,
      leaseId: page.presentationLeaseId,
    }), true);
    assert.equal(gateway.registrationCount, 0, "releasing the page revokes its scoped WebUI route without touching the Task Run");
    assert.equal(gateway.origin, undefined);

    console.log("Official OpenCode WebUI delivery-ready continuation E2E harness passed");
  } finally {
    runtime?.close();
    await gateway?.close();
    if (upstream?.server) await close(upstream.server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

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

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
