import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenCodeHookService } from "./opencode-hook-service.cjs";

const services = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("OpenCode hook service", () => {
  it("installs an isolated plugin and accepts only the registered session token", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-hook-"));
    const service = createOpenCodeHookService({ randomBytes: () => Buffer.alloc(24, 7) });
    services.push(service);
    const received = [];
    const launch = await service.registerSession({
      sessionId: "opencode:project:task:research",
      cwd,
      onEvent: async (event) => received.push(event),
    });
    const pluginPath = path.join(launch.env.OPENCODE_CONFIG_DIR, "plugins", "agent-workspace-hook.js");

    expect(fs.readFileSync(pluginPath, "utf8")).toContain("permission.asked");
    expect(fs.readFileSync(pluginPath, "utf8")).toContain("permission.replied");
    expect(fs.readFileSync(pluginPath, "utf8")).toContain("client.postSessionIdPermissionsPermissionId");
    expect(fs.readFileSync(pluginPath, "utf8")).toContain("new URL('/permission/reply', permissionReplyServer.url.href).href");
    expect(fs.readFileSync(pluginPath, "utf8")).toContain("question.asked");

    const event = {
      sessionId: launch.env.AGENT_WORKSPACE_HOOK_SESSION_ID,
      kind: "question",
      payload: { question: "Which file should I change?" },
    };
    const rejected = await fetch(launch.env.AGENT_WORKSPACE_HOOK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-workspace-hook-token": "wrong" },
      body: JSON.stringify(event),
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(launch.env.AGENT_WORKSPACE_HOOK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-workspace-hook-token": launch.env.AGENT_WORKSPACE_HOOK_TOKEN },
      body: JSON.stringify(event),
    });
    expect(accepted.status).toBe(202);
    expect(received).toEqual([expect.objectContaining({ kind: "question", payload: event.payload })]);
  });
});
