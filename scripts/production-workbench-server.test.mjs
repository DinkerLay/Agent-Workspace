import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startProductionWorkbenchServer } from "./production-workbench-server.mjs";

test("serves frozen dist bytes, injects only in memory and proxies Runtime HTTP/WebSocket", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "production-workbench-server-"));
  const build = path.join(root, "dist", "workbench");
  await mkdir(path.join(build, "assets"), { recursive: true });
  const original = [
    '<meta name="agent-workspace-runtime-bridge-token" content="" />',
    '<meta name="agent-workspace-owner-id" content="" />',
    '<script src="./assets/app.js"></script>',
  ].join("\n");
  await writeFile(path.join(build, "index.html"), original, "utf8");
  await writeFile(path.join(build, "assets", "app.js"), "frozen-build-byte", "utf8");
  await writeFile(path.join(root, "outside.txt"), "must-not-serve", "utf8");
  await symlink(path.join(root, "outside.txt"), path.join(build, "assets", "escape.txt"));
  const runtime = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ authorization: request.headers.authorization }));
  });
  const runtimeSockets = new WebSocketServer({ noServer: true });
  runtime.on("upgrade", (request, socket, head) => {
    runtimeSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.send(`proxied:${request.url}`);
    });
  });
  await new Promise((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  const runtimeAddress = runtime.address();
  const server = await startProductionWorkbenchServer({
    repositoryRoot: root,
    host: "127.0.0.1",
    port: await reservePort(),
    runtimeUrl: `http://127.0.0.1:${runtimeAddress.port}/`,
    rendererToken: 'renderer<&"\'-token',
    ownerId: 'owner<&"\'-id',
  });
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /content="renderer&lt;&amp;&quot;&#39;-token"/u);
    assert.match(html, /content="owner&lt;&amp;&quot;&#39;-id"/u);
    const normalized = html
      .replace('<meta name="agent-workspace-runtime-bridge-token" content="renderer&lt;&amp;&quot;&#39;-token" />',
        '<meta name="agent-workspace-runtime-bridge-token" content="" />')
      .replace('<meta name="agent-workspace-owner-id" content="owner&lt;&amp;&quot;&#39;-id" />',
        '<meta name="agent-workspace-owner-id" content="" />');
    assert.equal(normalized, original);
    assert.equal(await (await fetch(`${server.url}assets/app.js`)).text(), "frozen-build-byte");
    assert.equal((await fetch(`${server.url}assets/escape.txt`)).status, 404);
    assert.equal(await rawStatus(server.url, "/%2e%2e/outside.txt"), 404);
    assert.equal(await readFile(path.join(build, "index.html"), "utf8"), original);
    const proxied = await (await fetch(`${server.url}runtime/test`, {
      method: "POST",
      headers: { authorization: "renderer-token" },
    })).json();
    assert.equal(proxied.authorization, "renderer-token");
    const webSocket = new WebSocket(server.url.replace(/^http/u, "ws") + "runtime/socket", ["runtime-test"]);
    assert.equal(await firstMessage(webSocket), "proxied:/runtime/socket");
    webSocket.close();
  } finally {
    await server.close();
    runtimeSockets.close();
    await new Promise((resolve) => runtime.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a production index whose bootstrap marker is not exact-one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "production-workbench-marker-"));
  const build = path.join(root, "dist", "workbench");
  await mkdir(build, { recursive: true });
  await writeFile(path.join(build, "index.html"), [
    '<meta name="agent-workspace-runtime-bridge-token" content="" />',
    '<meta name="agent-workspace-runtime-bridge-token" content="" />',
    '<meta name="agent-workspace-owner-id" content="" />',
  ].join("\n"), "utf8");
  try {
    await assert.rejects(startProductionWorkbenchServer({
      repositoryRoot: root,
      host: "127.0.0.1",
      port: await reservePort(),
      runtimeUrl: "http://127.0.0.1:9/",
      rendererToken: "renderer-token",
      ownerId: "user_local",
    }), /production_workbench_bootstrap_marker_cardinality_invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function rawStatus(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: url.hostname,
      port: url.port,
      method: "GET",
      path: requestPath,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function firstMessage(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (value) => resolve(value.toString("utf8")));
    webSocket.once("error", reject);
  });
}
