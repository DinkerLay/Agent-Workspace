import { describe, expect, it, vi } from "vitest";
import { createRuntimeClient } from "./index";

describe("RuntimeClient", () => {
  it("only delegates typed read, command, and semantic subscriptions", async () => {
    const transport = {
      read: vi.fn(async () => ({ revision: 2 })),
      command: vi.fn(async () => ({ accepted: true })),
      subscribe: vi.fn(async () => () => undefined),
    };
    const client = createRuntimeClient(transport as never);

    await client.read({ taskId: "task_a" });
    await client.read({ templateId: "template_a" });
    await client.command({ type: "task.start", commandId: "command_a", taskId: "task_a", expectedRevision: 1 } as never);
    await client.subscribe({ taskId: "task_a" }, () => undefined);

    expect(transport.read).toHaveBeenCalledWith({ taskId: "task_a" });
    expect(transport.read).toHaveBeenCalledWith({ templateId: "template_a" });
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect("pty" in client).toBe(false);
    expect("provider" in client).toBe(false);
  });
});
