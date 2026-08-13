#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONTROL_PATHS = Object.freeze({
  restart: "/control/restart",
  shutdown: "/control/shutdown",
  providerClockPrefix: "/control/provider-clock/",
});

export async function invokeControlledJourneyControl({
  controlFile,
  action,
  stage,
  fetchImpl = globalThis.fetch,
}) {
  const config = await readPrivateControlFile(controlFile);
  const pathname = action === "restart"
    ? CONTROL_PATHS.restart
    : action === "shutdown"
      ? CONTROL_PATHS.shutdown
      : action === "provider-stage" && typeof stage === "string" && stage
        ? `${CONTROL_PATHS.providerClockPrefix}${encodeURIComponent(stage)}`
        : undefined;
  if (!pathname) throw new Error("controlled_journey_control_action_invalid");
  const response = await fetchImpl(`${config.serviceUrl}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(await publicError(response, `controlled_journey_control_${response.status}`));
  }
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled_journey_control_response_invalid");
  }
  return value;
}

export async function readPrivateControlFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("controlled_journey_control_file_absolute_required");
  }
  const metadata = await stat(value);
  if (!metadata.isFile()) throw new Error("controlled_journey_control_file_invalid");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("controlled_journey_control_file_permissions_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(value, "utf8"));
  } catch {
    throw new Error("controlled_journey_control_file_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "controlToken,schemaVersion,serviceUrl"
    || parsed.schemaVersion !== 1
    || typeof parsed.controlToken !== "string" || parsed.controlToken.length < 16) {
    throw new Error("controlled_journey_control_file_invalid");
  }
  const serviceUrl = new URL(parsed.serviceUrl);
  if (serviceUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(serviceUrl.hostname)
    || serviceUrl.username || serviceUrl.password || serviceUrl.pathname !== "/" || serviceUrl.search || serviceUrl.hash) {
    throw new Error("controlled_journey_control_service_must_be_loopback");
  }
  return Object.freeze({
    serviceUrl: serviceUrl.origin,
    controlToken: parsed.controlToken,
  });
}

async function publicError(response, fallback) {
  try {
    const value = await response.json();
    const code = value?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{2,159}$/.test(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function parseCli(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || args.has(name)) {
      throw new Error("controlled_journey_control_usage");
    }
    args.set(name, value);
  }
  const controlFile = args.get("--control-file");
  const action = args.get("--action");
  const stage = args.get("--stage");
  if (typeof controlFile !== "string" || typeof action !== "string"
    || [...args.keys()].some((key) => !["--control-file", "--action", "--stage"].includes(key))) {
    throw new Error("controlled_journey_control_usage");
  }
  return Object.freeze({ controlFile, action, ...(stage ? { stage } : {}) });
}

function isEntryModule() {
  return typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  void invokeControlledJourneyControl(parseCli(process.argv.slice(2))).then((value) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
