import { describe, expect, it } from "vitest";
import {
  AcpReverseRpcError,
  createAcpReverseRpcBroker,
  type AcpReverseRpcGenerationFence,
} from "./acp-reverse-rpc-broker.js";

function generation(): AcpReverseRpcGenerationFence & { active: boolean } {
  return {
    active: true,
    isActive() {
      return this.active;
    },
  };
}

describe("ACP reverse-RPC lease broker", () => {
  it("fences filesystem, MCP, terminal, and interaction calls to one Binding/generation/attempt", async () => {
    const generationA = generation();
    const generationB = generation();
    const filesystemCalls: unknown[] = [];
    const mcpCalls: unknown[] = [];
    const terminalCalls: unknown[] = [];
    let privateTerminal = 0;
    const broker = createAcpReverseRpcBroker({
      createPrivateId: () => `acp_terminal_private_${++privateTerminal}`,
    });
    const leaseA = broker.register({
      bindingHandle: "binding_handle_a",
      generation: generationA,
      workspace: {
        workspaceId: "workspace_a",
        workspaceRoot: "/private/workspaces/a",
        readTextFile: async (request) => {
          filesystemCalls.push(request);
          return { content: "ok" };
        },
        writeTextFile: async (request) => {
          filesystemCalls.push(request);
          return {};
        },
      },
      mcp: {
        leaseId: "mcp_lease_a",
        allowedServerNames: ["conductor-runtime"],
        dispatch: async (request) => {
          mcpCalls.push(request);
          return { ok: true };
        },
      },
      terminal: {
        leaseId: "terminal_lease_a",
        create: async (request) => {
          terminalCalls.push(request);
          return { terminalHandle: "host_terminal_a" };
        },
        output: async (request) => {
          terminalCalls.push(request);
          return { output: "done", truncated: false };
        },
        waitForExit: async (request) => {
          terminalCalls.push(request);
          return { exitCode: 0 };
        },
        kill: async (request) => { terminalCalls.push(request); },
        release: async (request) => { terminalCalls.push(request); },
      },
    });
    const leaseB = broker.register({
      bindingHandle: "binding_handle_b",
      generation: generationB,
      workspace: {
        workspaceId: "workspace_b",
        workspaceRoot: "/private/workspaces/b",
        readTextFile: async () => ({ content: "b" }),
        writeTextFile: async () => ({}),
      },
      terminal: {
        leaseId: "terminal_lease_b",
        create: async () => ({ terminalHandle: "host_terminal_b" }),
        output: async () => ({}),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async () => undefined,
      },
    });
    await expect(async () => broker.register({
      bindingHandle: "binding_handle_cross",
      generation: generationA,
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_generation_already_leased" });

    leaseA.activateAttempt({
      attemptId: "session_execution_attempt_a",
      mcpLeaseId: "mcp_lease_a",
      terminalLeaseId: "terminal_lease_a",
      interactionRevision: 4,
    });
    leaseB.activateAttempt({
      attemptId: "session_execution_attempt_b",
      terminalLeaseId: "terminal_lease_b",
      interactionRevision: 1,
    });
    const handlersA = leaseA.reverseRpcHandlers();
    await expect(handlersA.readTextFile!({
      sessionId: "raw-session-ignored",
      path: "/private/workspaces/a/docs/readme.md",
      line: 2,
      limit: 10,
    })).resolves.toEqual({ content: "ok" });
    expect(filesystemCalls).toEqual([{
      attemptId: "session_execution_attempt_a",
      workspaceId: "workspace_a",
      workspaceRelativePath: "docs/readme.md",
      line: 2,
      limit: 10,
    }]);
    await expect(handlersA.readTextFile!({
      sessionId: "raw-session-ignored",
      path: "/private/workspaces/b/private.txt",
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_workspace_crossing" });

    await expect(leaseA.dispatchMcp({
      attemptId: "session_execution_attempt_wrong",
      leaseId: "mcp_lease_a",
      serverName: "conductor-runtime",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_attempt_mismatch" });
    await expect(leaseA.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_wrong",
      serverName: "conductor-runtime",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_mcp_lease_mismatch" });
    await expect(leaseA.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_a",
      serverName: "publisher-workspace",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_mcp_server_forbidden" });
    await expect(leaseA.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_a",
      serverName: "conductor-runtime",
      method: "tools/call",
      params: { name: "send_to_session" },
    })).resolves.toEqual({ ok: true });
    expect(mcpCalls).toHaveLength(1);

    const created = await handlersA.createTerminal!({
      sessionId: "raw-session-ignored",
      command: "node",
      args: ["--version"],
      cwd: "/private/workspaces/a",
    }) as { terminalId: string };
    expect(created.terminalId).toBe("acp_terminal_private_1");
    await expect(leaseB.reverseRpcHandlers().terminalOutput?.({ terminalId: created.terminalId }))
      .rejects.toBeInstanceOf(AcpReverseRpcError);
    await expect(handlersA.terminalOutput!({
      sessionId: "raw-session-ignored",
      terminalId: created.terminalId,
    })).resolves.toEqual({ output: "done", truncated: false });

    leaseA.registerInteraction({
      attemptId: "session_execution_attempt_a",
      interactionId: "interaction_a",
      choiceIds: ["choice_allow", "choice_reject"],
      revision: 4,
    });
    expect(() => leaseA.consumeInteraction({
      attemptId: "session_execution_attempt_wrong",
      interactionId: "interaction_a",
      choiceId: "choice_allow",
      revision: 4,
    })).toThrowError("acp_reverse_rpc_attempt_mismatch");
    expect(() => leaseA.consumeInteraction({
      attemptId: "session_execution_attempt_a",
      interactionId: "interaction_a",
      choiceId: "choice_allow",
      revision: 3,
    })).toThrowError("acp_reverse_rpc_interaction_revision_mismatch");
    expect(leaseA.consumeInteraction({
      attemptId: "session_execution_attempt_a",
      interactionId: "interaction_a",
      choiceId: "choice_allow",
      revision: 4,
    })).toEqual({ interactionId: "interaction_a", choiceId: "choice_allow" });
    expect(() => leaseA.consumeInteraction({
      attemptId: "session_execution_attempt_a",
      interactionId: "interaction_a",
      choiceId: "choice_allow",
      revision: 4,
    })).toThrowError("acp_reverse_rpc_interaction_not_pending");

    const safe = JSON.stringify(leaseA.safeObservation());
    for (const secret of [
      "/private/workspaces/a",
      "mcp_lease_a",
      "terminal_lease_a",
      created.terminalId,
      "raw-session-ignored",
      "host_terminal_a",
    ]) expect(safe).not.toContain(secret);

    generationA.active = false;
    await expect(leaseA.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_a",
      serverName: "conductor-runtime",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_generation_inactive" });

    await leaseA.close();
    await leaseB.close();
    await broker.close();
  });

  it("revokes attempt and lease authority before awaiting terminal cleanup", async () => {
    const buildLease = (release: () => Promise<void>) => {
      const broker = createAcpReverseRpcBroker({ cleanupTimeoutMs: 50 });
      const lease = broker.register({
        bindingHandle: `binding_handle_cleanup_${Math.random().toString(16).slice(2)}`,
        generation: generation(),
        terminal: {
          leaseId: "terminal_lease_cleanup",
          create: async () => ({ terminalHandle: "host_terminal_cleanup" }),
          output: async () => ({ output: "must-not-be-reachable" }),
          waitForExit: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
          release: async () => release(),
        },
      });
      lease.activateAttempt({
        attemptId: "session_execution_attempt_cleanup",
        terminalLeaseId: "terminal_lease_cleanup",
        interactionRevision: 1,
      });
      return { broker, lease };
    };

    let rejectDeactivate!: (error: Error) => void;
    const deactivateRelease = new Promise<void>((_resolve, reject) => { rejectDeactivate = reject; });
    let firstDeactivateRelease = true;
    const deactivating = buildLease(() => {
      if (firstDeactivateRelease) {
        firstDeactivateRelease = false;
        return deactivateRelease;
      }
      return Promise.resolve();
    });
    const deactivatingHandlers = deactivating.lease.reverseRpcHandlers();
    const terminal = await deactivatingHandlers.createTerminal!({ command: "node", args: [] }) as {
      terminalId: string;
    };
    const deactivate = deactivating.lease.deactivateAttempt();
    await expect(deactivatingHandlers.terminalOutput!({ terminalId: terminal.terminalId }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_attempt_inactive" });
    rejectDeactivate(new Error("private cleanup detail"));
    await expect(deactivate).rejects.toMatchObject({
      code: "acp_reverse_rpc_terminal_cleanup_unconfirmed",
    });
    await expect(deactivating.lease.close()).resolves.toBeUndefined();
    await deactivating.broker.close();

    let rejectClose!: (error: Error) => void;
    const closeRelease = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
    const closing = buildLease(() => closeRelease);
    const closingHandlers = closing.lease.reverseRpcHandlers();
    const closingTerminal = await closingHandlers.createTerminal!({ command: "node", args: [] }) as {
      terminalId: string;
    };
    const close = closing.lease.close();
    await expect(closingHandlers.terminalOutput!({ terminalId: closingTerminal.terminalId }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_lease_closed" });
    rejectClose(new Error("private cleanup detail"));
    await expect(close).rejects.toMatchObject({
      code: "acp_reverse_rpc_terminal_cleanup_unconfirmed",
    });
    expect(JSON.stringify(closing.lease.safeObservation())).not.toContain("private cleanup detail");
  });

  it("releases a terminal created after its attempt was revoked", async () => {
    const broker = createAcpReverseRpcBroker({ cleanupTimeoutMs: 50 });
    let finishCreate!: (value: Readonly<{ terminalHandle: string }>) => void;
    const createGate = new Promise<Readonly<{ terminalHandle: string }>>((resolve) => {
      finishCreate = resolve;
    });
    const releases: unknown[] = [];
    const lease = broker.register({
      bindingHandle: "binding_handle_late_terminal",
      generation: generation(),
      terminal: {
        leaseId: "terminal_lease_late",
        create: async () => createGate,
        output: async () => ({}),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async (request) => { releases.push(request); },
      },
    });
    lease.activateAttempt({
      attemptId: "session_execution_attempt_late",
      terminalLeaseId: "terminal_lease_late",
      interactionRevision: 1,
    });
    const create = lease.reverseRpcHandlers().createTerminal!({ command: "node", args: [] });
    const deactivate = lease.deactivateAttempt();
    finishCreate({ terminalHandle: "host_terminal_late" });

    await expect(deactivate).resolves.toBeUndefined();
    await expect(create).rejects.toMatchObject({ code: "acp_reverse_rpc_attempt_inactive" });
    expect(releases).toEqual([{
      attemptId: "session_execution_attempt_late",
      terminalHandle: "host_terminal_late",
    }]);
    await lease.close();
    await broker.close();
  });

  it("releases post-create validation failures and retains failed explicit releases for cleanup", async () => {
    const released: string[] = [];
    let created = 0;
    let failExplicitRelease = true;
    const broker = createAcpReverseRpcBroker({
      createPrivateId: () => "acp_terminal_duplicate",
      cleanupTimeoutMs: 50,
    });
    const lease = broker.register({
      bindingHandle: "binding_handle_terminal_validation",
      generation: generation(),
      terminal: {
        leaseId: "terminal_lease_validation",
        create: async () => ({
          terminalHandle: ++created === 1
            ? "host_terminal_first"
            : created === 2
              ? "host_terminal_duplicate"
              : "host terminal invalid",
        }),
        output: async () => ({}),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async ({ terminalHandle }) => {
          released.push(terminalHandle);
          if (terminalHandle === "host_terminal_first" && failExplicitRelease) {
            failExplicitRelease = false;
            throw new Error("injected first release failure");
          }
        },
      },
    });
    lease.activateAttempt({
      attemptId: "session_execution_attempt_validation",
      terminalLeaseId: "terminal_lease_validation",
      interactionRevision: 1,
    });
    const handlers = lease.reverseRpcHandlers();
    const first = await handlers.createTerminal!({ command: "node", args: [] }) as {
      terminalId: string;
    };
    await expect(handlers.createTerminal!({ command: "node", args: [] }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_private_terminal_id_duplicate" });
    await expect(handlers.createTerminal!({ command: "node", args: [] }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_terminal_handle_invalid" });
    await expect(handlers.releaseTerminal!({ terminalId: first.terminalId }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_terminal_release_failed" });

    await lease.close();
    expect(released).toEqual([
      "host_terminal_duplicate",
      "host terminal invalid",
      "host_terminal_first",
      "host_terminal_first",
    ]);
    await broker.close();
  });

  it("poisons authority and retains a post-create cleanup failure until close confirms retry", async () => {
    const releases: string[] = [];
    let created = 0;
    let failDuplicateCleanup = true;
    const broker = createAcpReverseRpcBroker({
      createPrivateId: () => "acp_terminal_duplicate_cleanup",
      cleanupTimeoutMs: 50,
    });
    const lease = broker.register({
      bindingHandle: "binding_handle_terminal_cleanup_retry",
      generation: generation(),
      terminal: {
        leaseId: "terminal_lease_cleanup_retry",
        create: async () => ({
          terminalHandle: ++created === 1
            ? "host_terminal_kept"
            : "host_terminal_cleanup_retry",
        }),
        output: async () => ({}),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async ({ terminalHandle }) => {
          releases.push(terminalHandle);
          if (terminalHandle === "host_terminal_cleanup_retry" && failDuplicateCleanup) {
            failDuplicateCleanup = false;
            throw new Error("injected post-create cleanup failure");
          }
        },
      },
    });
    lease.activateAttempt({
      attemptId: "session_execution_attempt_cleanup_retry",
      terminalLeaseId: "terminal_lease_cleanup_retry",
      interactionRevision: 1,
    });
    const handlers = lease.reverseRpcHandlers();
    await handlers.createTerminal!({ command: "node", args: [] });
    await expect(handlers.createTerminal!({ command: "node", args: [] }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_terminal_cleanup_unconfirmed" });

    expect(lease.safeObservation()).toMatchObject({ availability: "unavailable" });
    await expect(handlers.createTerminal!({ command: "node", args: [] }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_terminal_cleanup_unconfirmed" });
    await expect(lease.close()).resolves.toBeUndefined();
    expect(lease.safeObservation()).toMatchObject({ availability: "closed" });
    expect(releases).toEqual([
      "host_terminal_cleanup_retry",
      "host_terminal_kept",
      "host_terminal_cleanup_retry",
    ]);
    await broker.close();
  });

  it("cannot report closed when a successful create returns no releasable terminal handle", async () => {
    const broker = createAcpReverseRpcBroker({ cleanupTimeoutMs: 50 });
    const lease = broker.register({
      bindingHandle: "binding_handle_terminal_unknown_cleanup",
      generation: generation(),
      terminal: {
        leaseId: "terminal_lease_unknown_cleanup",
        create: async () => ({}) as { terminalHandle: string },
        output: async () => ({}),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async () => undefined,
      },
    });
    lease.activateAttempt({
      attemptId: "session_execution_attempt_unknown_cleanup",
      terminalLeaseId: "terminal_lease_unknown_cleanup",
      interactionRevision: 1,
    });

    await expect(lease.reverseRpcHandlers().createTerminal!({ command: "node", args: [] }))
      .rejects.toMatchObject({ code: "acp_reverse_rpc_terminal_cleanup_unconfirmed" });
    expect(lease.safeObservation()).toMatchObject({ availability: "unavailable" });
    await expect(lease.close()).rejects.toMatchObject({
      code: "acp_reverse_rpc_terminal_cleanup_unconfirmed",
    });
    expect(lease.safeObservation()).toMatchObject({ availability: "unavailable" });
    await expect(broker.close()).rejects.toMatchObject({
      code: "acp_reverse_rpc_terminal_cleanup_unconfirmed",
    });
  });
});
