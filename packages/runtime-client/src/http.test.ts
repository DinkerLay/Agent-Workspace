import { describe, expect, it } from "vitest";
import { createHttpRuntimeClient } from "./http.js";

describe("HTTP RuntimeClient errors", () => {
  it("throws the Host's stable typed code instead of a generic HTTP status", async () => {
    const client = createHttpRuntimeClient({
      baseUrl: "https://runtime.example.test",
      fetchImpl: (async () => new Response(JSON.stringify({
        error: { code: "provider_version_mismatch" },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });

    await expect(client.command({ type: "task.start" } as never)).rejects.toMatchObject({
      message: "provider_version_mismatch",
    });
  });

  it("fails closed when an HTTP error is not a typed envelope", async () => {
    const client = createHttpRuntimeClient({
      baseUrl: "https://runtime.example.test",
      fetchImpl: (async () => new Response("token=host-secret", { status: 500 })) as typeof fetch,
    });

    await expect(client.command({ type: "task.start" } as never)).rejects.toMatchObject({
      message: "runtime_command_failed",
    });
  });
});
