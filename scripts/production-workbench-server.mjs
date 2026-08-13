import { createServer, request as requestHttp } from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import path from "node:path";

const TOKEN_MARKER = '<meta name="agent-workspace-runtime-bridge-token" content="" />';
const OWNER_MARKER = '<meta name="agent-workspace-owner-id" content="" />';

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

/** Serves only the frozen production build and proxies the typed Runtime bridge. */
export async function startProductionWorkbenchServer(input) {
  const repositoryRoot = path.resolve(requiredText(input?.repositoryRoot, "production_workbench_repository_root_required"));
  const buildRoot = path.join(repositoryRoot, "dist", "workbench");
  const host = input?.host === "127.0.0.1" ? input.host : fail("production_workbench_loopback_host_required");
  const port = validPort(input?.port);
  const target = runtimeTarget(input?.runtimeUrl);
  const rendererToken = requiredText(input?.rendererToken, "production_workbench_renderer_token_required");
  const ownerId = requiredText(input?.ownerId, "production_workbench_owner_required");
  const buildStatus = await lstat(buildRoot).catch(() => undefined);
  if (!buildStatus?.isDirectory() || buildStatus.isSymbolicLink()) {
    throw new Error("production_workbench_build_root_invalid");
  }
  const realBuildRoot = await realpath(buildRoot);
  const sourceIndex = await readStaticFile(buildRoot, realBuildRoot, "index.html");
  if (!sourceIndex) throw new Error("production_workbench_index_invalid");
  const renderedIndex = injectBootstrap(sourceIndex.toString("utf8"), rendererToken, ownerId);
  const upgradedSockets = new Set();
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => respond(response, 500, "text/plain; charset=utf-8", "internal error"));
  });
  server.on("upgrade", (request, socket, head) => {
    const pathname = strictRequestPath(request.url);
    if (!pathname || !isRuntimePath(pathname)) {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, target, upgradedSockets);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return Object.freeze({
    url: `http://${host}:${port}/`,
    async close() {
      for (const socket of upgradedSockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });

  async function handleRequest(request, response) {
    const pathname = strictRequestPath(request.url);
    if (!pathname) {
      respond(response, 404, "text/plain; charset=utf-8", "not found");
      return;
    }
    if (isRuntimePath(pathname)) {
      proxyHttp(request, response, target);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }
    const relative = staticRelativePath(pathname);
    if (!relative) {
      respond(response, 404, "text/plain; charset=utf-8", "not found");
      return;
    }
    const bytes = relative === "index.html"
      ? renderedIndex
      : await readStaticFile(buildRoot, realBuildRoot, relative);
    if (!bytes) return respond(response, 404, "text/plain; charset=utf-8", "not found");
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(relative)] ?? "application/octet-stream",
      "content-length": bytes.byteLength,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  }
}

function proxyHttp(request, response, target) {
  const upstream = requestHttp({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: target.host },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => respond(response, 502, "text/plain; charset=utf-8", "runtime unavailable"));
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, target, sockets) {
  const port = Number(target.port || 80);
  const upstream = connectTcp({ host: target.hostname, port });
  sockets.add(socket);
  sockets.add(upstream);
  const cleanup = () => { sockets.delete(socket); sockets.delete(upstream); };
  socket.once("close", cleanup);
  upstream.once("close", cleanup);
  socket.once("error", () => upstream.destroy());
  upstream.once("error", () => socket.destroy());
  upstream.once("connect", () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name?.toLowerCase() !== "host") upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write(`Host: ${target.host}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
}

function runtimeTarget(value) {
  const target = new URL(requiredText(value, "production_workbench_runtime_url_required"));
  if (target.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(target.hostname)
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("production_workbench_runtime_url_invalid");
  }
  return target;
}

function strictRequestPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("#")) return undefined;
  const raw = value.split("?", 1)[0];
  if (/%(?:2f|5c)/iu.test(raw)) return undefined;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  return decoded;
}

function staticRelativePath(pathname) {
  if (pathname === "/") return "index.html";
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(pathname)) return undefined;
  return pathname.slice(1);
}

function isRuntimePath(pathname) {
  return pathname === "/runtime" || pathname.startsWith("/runtime/");
}

async function readStaticFile(buildRoot, realBuildRoot, relative) {
  const absolute = path.resolve(buildRoot, relative);
  if (!isWithin(buildRoot, absolute)) return undefined;
  let cursor = buildRoot;
  for (const [index, segment] of relative.split(path.sep).entries()) {
    cursor = path.join(cursor, segment);
    const status = await lstat(cursor).catch(() => undefined);
    const final = index === relative.split(path.sep).length - 1;
    if (!status || status.isSymbolicLink() || (final ? !status.isFile() : !status.isDirectory())) return undefined;
  }
  const resolved = await realpath(absolute).catch(() => undefined);
  if (!resolved || !isWithin(realBuildRoot, resolved)) return undefined;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = await handle.stat();
    if (!status.isFile()) return undefined;
    return await handle.readFile();
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function injectBootstrap(source, rendererToken, ownerId) {
  const replacements = [
    [TOKEN_MARKER, `<meta name="agent-workspace-runtime-bridge-token" content="${escapeHtmlAttribute(rendererToken)}" />`],
    [OWNER_MARKER, `<meta name="agent-workspace-owner-id" content="${escapeHtmlAttribute(ownerId)}" />`],
  ];
  let result = source;
  for (const [marker, replacement] of replacements) {
    const first = result.indexOf(marker);
    if (first < 0 || result.indexOf(marker, first + marker.length) >= 0) {
      throw new Error("production_workbench_bootstrap_marker_cardinality_invalid");
    }
    result = `${result.slice(0, first)}${replacement}${result.slice(first + marker.length)}`;
  }
  return Buffer.from(result, "utf8");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function respond(response, status, type, body) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, { "content-type": type, "content-length": bytes.byteLength, "cache-control": "no-store" });
  response.end(bytes);
}

function escapeHtmlAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function validPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("production_workbench_port_invalid");
  return value;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function fail(code) {
  throw new Error(code);
}
