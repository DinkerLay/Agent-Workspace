import { describe, expect, it } from "vitest";
import {
  AcpBoundaryError,
  createManagedAcpV1Client,
  type AcpBindingCommand,
  type AcpExtensionPredicate,
  type AcpOpaqueIdKind,
  type AcpV1ReverseRpcHandlers,
  type AcpSessionObservation,
  type ManagedAcpV1Client,
} from "./index.js";
import { FakeAcpV1Agent, deferred } from "./fake-agent.js";

const bindingHandle = "binding_handle_workspace-1";
const attemptId = "session_execution_attempt_workspace-1";
const workspaceDirectory = "/private/workspace/agent-one";
const additionalDirectory = "/private/additional/agent-shared";
const configuration = {
  model: "fake-model",
  options: [],
} as const;

function opaqueIds(): (kind: AcpOpaqueIdKind) => string {
  let sequence = 0;
  return (kind) => `${kind}_${++sequence}`;
}

function createClient(
  agent: FakeAcpV1Agent,
  onObservation?: (observation: AcpSessionObservation) => void | Promise<void>,
  reverseRpcHandlers?: AcpV1ReverseRpcHandlers,
  extensionPredicates?: Readonly<Record<string, AcpExtensionPredicate>>,
): ManagedAcpV1Client {
  return createManagedAcpV1Client({
    connect: (handlers) => agent.connect(handlers),
    generationId: "host_generation_1",
    createOpaqueId: opaqueIds(),
    onObservation,
    reverseRpcHandlers,
    extensionPredicates,
  });
}

async function initialize(client: ManagedAcpV1Client) {
  return client.initialize({
    protocolMajor: 1,
    requiredCapabilities: [
      "session_new",
      "session_prompt",
      "session_cancel",
      "session_update",
      "session_load",
      "session_resume",
    ],
    requiredExtensions: [],
  });
}

describe("managed ACP v1 client", () => {
  it("does not let a caller mutate initialize observations into internal authority", async () => {
    const unavailable = createClient(new FakeAcpV1Agent({
      capabilities: { loadSession: false, resumeSession: true },
    }));
    const observation = await initialize(unavailable);

    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.capabilities)).toBe(true);
    expect(Object.isFrozen(observation.extensions)).toBe(true);
    expect(Object.isFrozen(observation.unavailableReasons)).toBe(true);
    expect(() => {
      (observation as { available: boolean }).available = true;
    }).toThrow(TypeError);
    expect(() => {
      (observation.capabilities as string[]).push("session_load");
    }).toThrow(TypeError);
    expect(() => {
      (observation.unavailableReasons as string[]).splice(0);
    }).toThrow(TypeError);
    await expect(unavailable.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_not_qualified" });

    const available = createClient(new FakeAcpV1Agent({
      agentInfo: { name: "current-agent", version: "1.0.0" },
    }));
    const availableObservation = await initialize(available);
    expect(Object.isFrozen(availableObservation.agent)).toBe(true);
    expect(() => {
      (availableObservation.agent as { version?: string }).version = "forged";
    }).toThrow(TypeError);
    expect((await initialize(available)).agent?.version).toBe("1.0.0");
  });

  it("fails qualification closed on protocol-major or required-capability mismatch", async () => {
    const wrongMajor = createClient(new FakeAcpV1Agent({ protocolVersion: 2 }));
    await expect(initialize(wrongMajor)).resolves.toMatchObject({
      available: false,
      protocolMajor: 2,
      unavailableReasons: ["acp_protocol_major_mismatch"],
    });

    const missingLoad = createClient(new FakeAcpV1Agent({
      capabilities: { loadSession: false, resumeSession: true },
    }));
    await expect(initialize(missingLoad)).resolves.toMatchObject({
      available: false,
      protocolMajor: 1,
      unavailableReasons: ["acp_capability_missing:session_load"],
    });
  });

  it("qualifies the current connection without a Provider or SDK version allowlist", async () => {
    const client = createClient(new FakeAcpV1Agent({
      agentInfo: { name: "future-agent", version: "999.0.0-nightly" },
    }));

    const observation = await initialize(client);

    expect(observation.available).toBe(true);
    expect(observation.agent).toEqual({
      name: "future-agent",
      version: "999.0.0-nightly",
    });
    expect(Object.keys(observation)).not.toContain("supportedVersions");
    const otherVersion = await initialize(createClient(new FakeAcpV1Agent({
      agentInfo: { name: "future-agent", version: "1.0.0" },
    })));
    expect(otherVersion.capabilityFingerprint).toBe(observation.capabilityFingerprint);

    const versionGate = createClient(new FakeAcpV1Agent({
      agentInfo: { name: "future-agent", version: "999.0.0-nightly" },
    }), undefined, undefined, {
      "vendor/version-gate": (proof) => "agentInfo" in (proof as object),
    });
    await expect(versionGate.initialize({
      protocolMajor: 1,
      requiredCapabilities: [],
      requiredExtensions: ["vendor/version-gate"],
    })).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_extension_missing:vendor/version-gate"],
    });
  });

  it("matches standard extensions and exact Host-registered predicates", async () => {
    const client = createClient(new FakeAcpV1Agent({
      agentCapabilityExtensions: {
        promptCapabilities: { image: true },
      },
      initializeMeta: {
        codex: { steering: { protocol: "v1", enabled: true } },
      },
    }), undefined, undefined, {
      "codex/steering": (response) => {
        const root = response as Record<string, unknown>;
        const meta = root._meta as Record<string, unknown> | undefined;
        const codex = meta?.codex as Record<string, unknown> | undefined;
        const steering = codex?.steering as Record<string, unknown> | undefined;
        return steering?.protocol === "v1" && steering.enabled === true;
      },
    });
    const observation = await client.initialize({
      protocolMajor: 1,
      requiredCapabilities: ["session_new"],
      requiredExtensions: [
        "session/load",
        "prompt/image",
        "codex/steering",
      ],
    });

    expect(observation.available).toBe(true);
    expect(observation.extensions).toEqual(expect.arrayContaining([
      "session/load",
      "prompt/image",
      "codex/steering",
    ]));

    const missing = createClient(new FakeAcpV1Agent({
      initializeMeta: { codex: { steering: { protocol: "v1", enabled: true } } },
    }));
    await expect(missing.initialize({
      protocolMajor: 1,
      requiredCapabilities: [],
      requiredExtensions: ["codex/steering"],
    })).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_extension_missing:codex/steering"],
    });
  });

  it("fingerprints bounded top-level initialize _meta without exposing it", async () => {
    const left = await initialize(createClient(new FakeAcpV1Agent({
      initializeMeta: { futureNegotiation: "extension-left-secret", revision: 1 },
    })));
    const right = await initialize(createClient(new FakeAcpV1Agent({
      initializeMeta: { futureNegotiation: "extension-right-secret", revision: 2 },
    })));

    expect(left.capabilities).toEqual(right.capabilities);
    expect(left.extensions).toEqual(right.extensions);
    expect(left.capabilityFingerprint).not.toBe(right.capabilityFingerprint);
    expect(JSON.stringify({ left, right })).not.toContain("extension-left-secret");
    expect(JSON.stringify({ left, right })).not.toContain("extension-right-secret");

    const oversized = createClient(new FakeAcpV1Agent({
      initializeMeta: { value: "x".repeat(70 * 1024) },
    }));
    await expect(initialize(oversized)).rejects.toMatchObject({
      code: "acp_agent_capabilities_snapshot_too_large",
    });

    const capabilityLeft = await initialize(createClient(new FakeAcpV1Agent({
      agentCapabilityExtensions: { futurePromptShape: { revision: 1 } },
    })));
    const capabilityRight = await initialize(createClient(new FakeAcpV1Agent({
      agentCapabilityExtensions: { futurePromptShape: { revision: 2 } },
    })));
    expect(capabilityLeft.capabilities).toEqual(capabilityRight.capabilities);
    expect(capabilityLeft.extensions).toEqual(capabilityRight.extensions);
    expect(capabilityLeft.capabilityFingerprint)
      .not.toBe(capabilityRight.capabilityFingerprint);
  });

  it.each([
    { agentInfo: { name: "/private/agent", version: "1.0.0" }, code: "acp_agent_info_name_invalid" },
    { agentInfo: { name: `agent-${"x".repeat(200)}`, version: "1.0.0" }, code: "acp_agent_info_name_invalid" },
    { agentInfo: { name: "agent\u0000control", version: "1.0.0" }, code: "acp_agent_info_name_invalid" },
    { agentInfo: { name: "agent", version: "/private/version" }, code: "acp_agent_info_version_invalid" },
    { agentInfo: { name: "agent", version: "v\n1" }, code: "acp_agent_info_version_invalid" },
    { agentInfo: { name: "agent", version: `v${"1".repeat(140)}` }, code: "acp_agent_info_version_invalid" },
  ])("rejects unsafe initialize agentInfo ($code)", async ({ agentInfo, code }) => {
    await expect(initialize(createClient(new FakeAcpV1Agent({ agentInfo }))))
      .rejects.toMatchObject({ code });
  });

  it("rejects non-Workspace correlation IDs at the public boundary", async () => {
    const agent = new FakeAcpV1Agent();
    const client = createClient(agent);
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "raw-session-secret",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_binding_handle_invalid" });
    expect(agent.setConfigRequests).toEqual([]);

    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });
    await expect(client.submitPrompt({
      bindingHandle,
      attemptId: "raw-request-secret",
      content: "must not cross the boundary",
    })).rejects.toMatchObject({ code: "acp_attempt_id_invalid" });
  });

  it("rejects an unknown binding disposition before any ACP session effect", async () => {
    const agent = new FakeAcpV1Agent();
    let newSessionCalls = 0;
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => {
            newSessionCalls += 1;
            return connection.newSession(params);
          },
        };
      },
      generationId: "host_generation_invalid-disposition",
      createOpaqueId: opaqueIds(),
    });
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_invalid-disposition",
      disposition: "future-mode",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    } as unknown as AcpBindingCommand)).rejects.toMatchObject({
      code: "acp_binding_disposition_invalid",
    });
    expect(newSessionCalls).toBe(0);
  });

  it("accepts only the exact session/new startup notification before the raw session is mapped", async () => {
    const rawSessionId = "raw-pre-binding-startup-session";
    const agent = new FakeAcpV1Agent({ rawSessionId });
    const observations: AcpSessionObservation[] = [];
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => {
            await handlers.sessionUpdate({
              sessionId: rawSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "raw-mcp-startup-call",
                title: "Starting scoped MCP",
                status: "in_progress",
              },
            });
            return connection.newSession(params);
          },
        };
      },
      generationId: "host_generation_pre-binding-startup",
      createOpaqueId: opaqueIds(),
      onObservation: (observation) => { observations.push(observation); },
    });
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_pre-binding-startup",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).resolves.toMatchObject({
      kind: "binding_ready",
      bindingHandle: "binding_handle_pre-binding-startup",
    });
    expect(observations).toEqual([]);
    await expect(client.requestInterrupt({
      bindingHandle: "binding_handle_pre-binding-startup",
    })).resolves.toMatchObject({ acceptance: "accepted" });
    expect(JSON.stringify(observations)).not.toContain(rawSessionId);
  });

  it("poisons a create generation when a pre-binding notification names another raw session", async () => {
    const rawSessionId = "raw-pre-binding-expected-session";
    const agent = new FakeAcpV1Agent({ rawSessionId });
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => {
            await handlers.sessionUpdate({
              sessionId: "raw-pre-binding-conflicting-session",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "raw-conflicting-startup-call",
                status: "in_progress",
              },
            });
            return connection.newSession(params);
          },
        };
      },
      generationId: "host_generation_pre-binding-conflict",
      createOpaqueId: opaqueIds(),
    });
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_pre-binding-conflict",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_pre_binding_session_update_mismatch" });
    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_after-pre-binding-conflict",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_generation_inactive" });
  });

  it("uses one immutable binding command snapshot across asynchronous create and configuration", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const observations: AcpSessionObservation[] = [];
    let observedNewSessionParams: unknown;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Observed ${workspaceDirectory}` },
        },
      });
      return { stopReason: "end_turn" };
    });
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => {
            observedNewSessionParams = structuredClone(params);
            entered.resolve();
            await release.promise;
            return connection.newSession(params);
          },
        };
      },
      generationId: "host_generation_command-snapshot",
      createOpaqueId: opaqueIds(),
      onObservation: (observation) => {
        observations.push(observation);
      },
    });
    await initialize(client);
    const command = {
      bindingHandle: "binding_handle_command-snapshot",
      disposition: "create",
      workspaceDirectory,
      additionalDirectories: [additionalDirectory],
      mcpServers: [{ type: "http", name: "scoped", url: "http://127.0.0.1/original" }],
      configuration: { model: "fake-model", options: [] },
    } as unknown as AcpBindingCommand;
    const pending = client.ensureBinding(command);
    await entered.promise;
    const mutable = command as unknown as {
      workspaceDirectory: string;
      additionalDirectories: string[];
      mcpServers: Array<Record<string, string>>;
      configuration: { model: string; options: unknown[] };
    };
    mutable.workspaceDirectory = "/private/mutated-workspace";
    mutable.additionalDirectories[0] = "/private/mutated-additional";
    mutable.mcpServers[0]!.url = "http://127.0.0.1/mutated";
    mutable.configuration.model = "mutated-model";
    mutable.configuration.options.push({
      configId: "mutated",
      category: "model",
      type: "select",
      value: "mutated-model",
    });
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      bindingHandle: "binding_handle_command-snapshot",
      model: "fake-model",
    });
    expect(observedNewSessionParams).toEqual({
      cwd: workspaceDirectory,
      additionalDirectories: [additionalDirectory],
      mcpServers: [{ type: "http", name: "scoped", url: "http://127.0.0.1/original" }],
    });
    await expect(client.submitPrompt({
      bindingHandle: "binding_handle_command-snapshot",
      attemptId: "session_execution_attempt_command-snapshot",
      content: "return the observed directory",
    })).resolves.toMatchObject({ finalCandidate: "Observed <workspace>" });
    expect(JSON.stringify(observations)).not.toContain(workspaceDirectory);
    expect(JSON.stringify(observations)).not.toContain("mutated-workspace");
  });

  it("pairs a final candidate with the exact prompt terminal and never exposes raw ACP IDs or cwd", async () => {
    const raw = {
      sessionId: "raw-session-secret",
      messageId: "raw-message-secret",
      thoughtMessageId: "raw-thought-secret",
      toolCallId: "raw-tool-secret",
    };
    const agent = new FakeAcpV1Agent({ rawSessionId: raw.sessionId });
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: raw.thoughtMessageId,
          content: {
            type: "text",
            text: "Compare the evidence before returning the answer.",
          },
        },
      });
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: raw.messageId,
          content: {
            type: "text",
            text: `done in ${workspaceDirectory} and ${additionalDirectory}`,
          },
        },
      });
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: raw.toolCallId,
          title: `Inspect ${additionalDirectory}`,
          status: "completed",
        },
      });
      return { stopReason: "end_turn" };
    });
    const observations: AcpSessionObservation[] = [];
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      additionalDirectories: [additionalDirectory],
      mcpServers: [],
      configuration,
    });

    const settlement = await client.submitPrompt({
      bindingHandle,
      attemptId,
      content: "finish the task",
    });

    expect(settlement).toMatchObject({
      bindingHandle,
      attemptId,
      stopReason: "end_turn",
      finalCandidate: "done in <workspace> and <workspace>",
      finalCandidateGroupCount: 1,
    });
    expect(Object.isFrozen(settlement)).toBe(true);
    expect(() => {
      (settlement as { finalCandidateGroupCount: number }).finalCandidateGroupCount = 99;
    }).toThrow(TypeError);
    expect(settlement.finalCandidateGroupCount).toBe(1);
    expect(observations.map((entry) => entry.kind)).toEqual([
      "delivery_receipt",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_status",
      "final_candidate",
      "prompt_terminal",
    ]);
    expect(observations.at(-2)).toMatchObject({
      kind: "final_candidate",
      text: "done in <workspace> and <workspace>",
    });
    expect(observations.find((entry) => entry.kind === "agent_thought_chunk")).toMatchObject({
      kind: "agent_thought_chunk",
      text: "Compare the evidence before returning the answer.",
    });
    expect(observations.at(-1)).toMatchObject({
      kind: "prompt_terminal",
      stopReason: "end_turn",
    });
    const receipt = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "delivery_receipt" }> =>
        entry.kind === "delivery_receipt",
    );
    const terminal = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "prompt_terminal" }> =>
        entry.kind === "prompt_terminal",
    );
    expect(receipt?.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(terminal?.receiptDigest).toBe(receipt?.receiptDigest);
    expect(settlement.receiptDigest).toBe(receipt?.receiptDigest);

    const serialized = JSON.stringify({ settlement, observations });
    for (const forbidden of Object.values(raw).concat(
      workspaceDirectory,
      additionalDirectory,
    )) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("uses only the latest messageId group as the terminal final candidate", async () => {
    const rawMessageIds = ["raw-message-old-secret", "raw-message-latest-secret"] as const;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      for (const [messageId, text] of [
        [rawMessageIds[0], "obsolete "],
        [rawMessageIds[0], "candidate"],
        [rawMessageIds[1], "latest "],
        [rawMessageIds[1], "answer"],
      ] as const) {
        await handlers.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text },
          },
        });
      }
      return { stopReason: "end_turn" };
    });
    const observations: AcpSessionObservation[] = [];
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    const settlement = await client.submitPrompt({ bindingHandle, attemptId, content: "latest" });

    expect(settlement.finalCandidate).toBe("latest answer");
    expect(settlement.finalCandidateGroupCount).toBe(2);
    expect(observations.find((entry) => entry.kind === "final_candidate"))
      .toMatchObject({ text: "latest answer" });
    for (const rawMessageId of rawMessageIds) {
      expect(JSON.stringify({ observations, settlement })).not.toContain(rawMessageId);
    }
  });

  it("treats consistently missing messageId chunks as one candidate group", async () => {
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      for (const text of ["anonymous ", "answer"]) {
        await handlers.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "anonymous" }))
      .resolves.toMatchObject({
        finalCandidate: "anonymous answer",
        finalCandidateGroupCount: 1,
      });
  });

  it("counts empty observed text groups conservatively and reports zero when none were observed", async () => {
    const rawMessageIds = ["raw-message-incomplete", "raw-message-empty"] as const;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async () => ({ stopReason: "end_turn" }));
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: rawMessageIds[0],
          content: { type: "text", text: "incomplete earlier candidate" },
        },
      });
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: rawMessageIds[1],
          content: { type: "text", text: "" },
        },
      });
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    const noCandidate = await client.submitPrompt({
      bindingHandle,
      attemptId: "session_execution_attempt_no-candidate",
      content: "no candidate",
    });
    expect(noCandidate).toMatchObject({ finalCandidateGroupCount: 0 });
    expect(noCandidate).not.toHaveProperty("finalCandidate");

    const emptyLatest = await client.submitPrompt({
      bindingHandle,
      attemptId: "session_execution_attempt_empty-latest",
      content: "empty latest",
    });
    expect(emptyLatest).toMatchObject({ finalCandidateGroupCount: 2 });
    expect(emptyLatest).not.toHaveProperty("finalCandidate");
    for (const rawMessageId of rawMessageIds) {
      expect(JSON.stringify(emptyLatest)).not.toContain(rawMessageId);
    }
  });

  it("isolates candidate-group counts by attempt and ignores an update arriving after settlement", async () => {
    const rawMessageIds = ["raw-message-first", "raw-message-late", "raw-message-second"] as const;
    let sendLateUpdate!: () => Promise<void>;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: rawMessageIds[0],
          content: { type: "text", text: "first answer" },
        },
      });
      sendLateUpdate = () => handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: rawMessageIds[1],
          content: { type: "text", text: "late answer" },
        },
      });
      return { stopReason: "end_turn" };
    });
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: rawMessageIds[2],
          content: { type: "text", text: "second answer" },
        },
      });
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    const first = await client.submitPrompt({
      bindingHandle,
      attemptId: "session_execution_attempt_first",
      content: "first",
    });
    expect(first).toMatchObject({
      finalCandidate: "first answer",
      finalCandidateGroupCount: 1,
    });

    await expect(sendLateUpdate()).resolves.toBeUndefined();

    const second = await client.submitPrompt({
      bindingHandle,
      attemptId: "session_execution_attempt_second",
      content: "second",
    });
    expect(second).toMatchObject({
      finalCandidate: "second answer",
      finalCandidateGroupCount: 1,
    });
    const serialized = JSON.stringify({ first, second });
    for (const rawMessageId of rawMessageIds) {
      expect(serialized).not.toContain(rawMessageId);
    }
    expect(serialized).not.toContain(workspaceDirectory);
  });

  it.each([
    { label: "identified then missing", ids: ["raw-message-a", undefined] },
    { label: "missing then identified", ids: [undefined, "raw-message-a"] },
    { label: "return to retired ID", ids: ["raw-message-a", "raw-message-b", "raw-message-a"] },
  ] as const)("fails ambiguous for $label message grouping", async ({ ids }) => {
    const observations: AcpSessionObservation[] = [];
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      for (const [index, messageId] of ids.entries()) {
        await handlers.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            ...(messageId ? { messageId } : {}),
            content: { type: "text", text: `chunk-${index}` },
          },
        });
      }
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "ambiguous" }))
      .rejects.toMatchObject({ code: "acp_agent_message_sequence_ambiguous" });
    expect(observations.some((entry) => entry.kind === "prompt_terminal")).toBe(false);
    for (const messageId of ids) {
      if (messageId) expect(JSON.stringify(observations)).not.toContain(messageId);
    }
  });

  it("enforces one active prompt per Binding", async () => {
    const promptGate = deferred<{ stopReason: "end_turn" }>();
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async () => promptGate.promise);
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({ bindingHandle, disposition: "create", workspaceDirectory, mcpServers: [], configuration });

    const first = client.submitPrompt({ bindingHandle, attemptId, content: "first" });
    await agent.waitForPromptCount(1);
    await expect(client.submitPrompt({
      bindingHandle,
      attemptId: "session_execution_attempt_workspace-2",
      content: "second",
    })).rejects.toMatchObject({ code: "acp_prompt_already_active" });

    promptGate.resolve({ stopReason: "end_turn" });
    await first;
  });

  it("does not claim an Agent receipt while prompt is pending with no Agent evidence", async () => {
    const promptGate = deferred<{ stopReason: "end_turn" }>();
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async () => promptGate.promise);
    const observations: AcpSessionObservation[] = [];
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({ bindingHandle, disposition: "create", workspaceDirectory, mcpServers: [], configuration });

    const prompt = client.submitPrompt({ bindingHandle, attemptId, content: "wait" });
    await agent.waitForPromptCount(1);
    expect(observations).toEqual([]);

    promptGate.resolve({ stopReason: "end_turn" });
    await prompt;
    expect(observations.map((entry) => entry.kind)).toEqual([
      "delivery_receipt",
      "prompt_terminal",
    ]);
  });

  it("reports a prompt transport failure as terminal ambiguity without inventing a terminal", async () => {
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      await handlers.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "candidate before crash" },
        },
      });
      throw new Error("raw transport diagnostic raw-session-secret");
    });
    const observations: AcpSessionObservation[] = [];
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({ bindingHandle, disposition: "create", workspaceDirectory, mcpServers: [], configuration });

    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "crash" }))
      .rejects.toMatchObject({ code: "acp_prompt_terminal_ambiguous" });
    expect(observations.map((entry) => entry.kind)).toEqual([
      "delivery_receipt",
      "agent_message_chunk",
    ]);
    expect(JSON.stringify(observations)).not.toContain("raw-session-secret");
  });

  it("preserves a safe prompt rejection diagnostic without weakening terminal ambiguity", async () => {
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async () => {
      throw Object.assign(
        new Error("Authentication failed at /private/agent-secret"),
        { code: "acp_stdio_prompt_auth_required" },
      );
    });
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    const failure = await client.submitPrompt({
      bindingHandle,
      attemptId,
      content: "diagnose safely",
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({
      code: "acp_prompt_terminal_ambiguous",
      diagnosticCode: "acp_stdio_prompt_auth_required",
    });
    expect(JSON.stringify(failure)).not.toContain("/private/agent-secret");
  });

  it.each(["delivery_receipt", "agent_message_chunk"] as const)(
    "fails terminal closed when the %s observation callback fails even if the Agent swallows it",
    async (failedObservationKind) => {
      const observations: AcpSessionObservation[] = [];
      const agent = new FakeAcpV1Agent();
      agent.queuePrompt(async ({ handlers, request }) => {
        try {
          await handlers.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "raw-message-observer-failure",
              content: { type: "text", text: "unsafe-to-settle" },
            },
          });
        } catch {
          // A reverse-RPC callback failure may be swallowed by the Agent.
        }
        return { stopReason: "end_turn" };
      });
      const client = createClient(agent, (observation) => {
        observations.push(observation);
        if (observation.kind === failedObservationKind) {
          throw new Error("observation sink unavailable");
        }
      });
      await initialize(client);
      await client.ensureBinding({
        bindingHandle,
        disposition: "create",
        workspaceDirectory,
        mcpServers: [],
        configuration,
      });

      await expect(client.submitPrompt({
        bindingHandle,
        attemptId,
        content: "observe exactly",
      })).rejects.toMatchObject({ code: "acp_prompt_terminal_ambiguous" });
      expect(observations.some((entry) => entry.kind === "final_candidate")).toBe(false);
      expect(observations.some((entry) => entry.kind === "prompt_terminal")).toBe(false);
    },
  );

  it("keeps permission choices fenced to the exact Binding and attempt", async () => {
    const rawSessionId = "raw-permission-session-secret";
    const rawOptionIds = [
      "raw-option-allow-secret",
      "raw-option-reject-secret",
    ] as const;
    const rawToolCallId = "raw-tool-permission-secret";
    const observations: AcpSessionObservation[] = [];
    const agent = new FakeAcpV1Agent({ rawSessionId });
    agent.queuePrompt(async ({ handlers, request }) => {
      const response = await handlers.requestPermission({
        sessionId: request.sessionId,
        toolCall: {
          toolCallId: rawToolCallId,
          title: `Inspect ${rawSessionId} ${rawToolCallId} ${rawOptionIds.join(" ")} ${workspaceDirectory} ${additionalDirectory}`,
          status: "pending",
        },
        options: [
          {
            optionId: rawOptionIds[0],
            name: `Allow ${rawSessionId} ${rawToolCallId} ${rawOptionIds[0]} ${rawOptionIds[1]} ${workspaceDirectory}`,
            kind: "allow_once",
          },
          {
            optionId: rawOptionIds[1],
            name: `Reject ${rawOptionIds[1]} ${rawOptionIds[0]} ${rawToolCallId} ${additionalDirectory}`,
            kind: "reject_once",
          },
        ],
      });
      expect(response).toEqual({ outcome: { outcome: "selected", optionId: rawOptionIds[0] } });
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      additionalDirectories: [additionalDirectory],
      mcpServers: [],
      configuration,
    });

    const prompt = client.submitPrompt({ bindingHandle, attemptId, content: "needs permission" });
    const interaction = await waitForInteraction(observations);
    expect(interaction.promptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await expect(client.respondToInteraction({
      bindingHandle,
      attemptId: "session_execution_attempt_wrong",
      interactionId: interaction.interactionId,
      choiceId: interaction.choices[0].choiceId,
    })).rejects.toMatchObject({ code: "acp_interaction_fence_mismatch" });

    await client.respondToInteraction({
      bindingHandle,
      attemptId,
      interactionId: interaction.interactionId,
      choiceId: interaction.choices[0].choiceId,
    });
    const settlement = await prompt;

    const serialized = JSON.stringify({ observations, settlement });
    for (const forbidden of [
      rawSessionId,
      rawToolCallId,
      ...rawOptionIds,
      workspaceDirectory,
      additionalDirectory,
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("cancels a pending permission on generation crash and rejects the late terminal", async () => {
    let rawPermissionResponse: unknown;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      rawPermissionResponse = await handlers.requestPermission({
        sessionId: request.sessionId,
        toolCall: { toolCallId: "raw-tool-crash", title: "Apply change" },
        options: [{ optionId: "raw-choice-crash", name: "Allow", kind: "allow_once" }],
      });
      return { stopReason: "end_turn" };
    });
    const observations: AcpSessionObservation[] = [];
    const client = createClient(agent, (observation) => {
      observations.push(observation);
    });
    await initialize(client);
    await client.ensureBinding({ bindingHandle, disposition: "create", workspaceDirectory, mcpServers: [], configuration });

    const prompt = client.submitPrompt({ bindingHandle, attemptId, content: "permission then crash" });
    await waitForInteraction(observations);
    client.invalidateGeneration();

    await expect(prompt).rejects.toMatchObject({ code: "acp_generation_inactive" });
    expect(rawPermissionResponse).toEqual({ outcome: { outcome: "cancelled" } });
    expect(observations.some((entry) => entry.kind === "prompt_terminal")).toBe(false);
  });

  it("cleans a pending permission when observation delivery throws", async () => {
    let interaction: Extract<AcpSessionObservation, { kind: "interaction_requested" }> | undefined;
    const agent = new FakeAcpV1Agent();
    agent.queuePrompt(async ({ handlers, request }) => {
      try {
        await handlers.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: "raw-tool-observer-failure" },
          options: [{
            optionId: "raw-option-observer-failure",
            name: "Allow",
            kind: "allow_once",
          }],
        });
      } catch {
        // Even an Agent that swallows the reverse-RPC error cannot create a safe terminal.
      }
      return { stopReason: "end_turn" };
    });
    const client = createClient(agent, (observation) => {
      if (observation.kind === "interaction_requested") {
        interaction = observation;
        throw new Error("observation sink unavailable");
      }
    });
    await initialize(client);
    await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    });

    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "permission" }))
      .rejects.toMatchObject({ code: "acp_prompt_terminal_ambiguous" });
    if (!interaction) throw new Error("interaction_not_captured");
    await expect(client.respondToInteraction({
      bindingHandle,
      attemptId,
      interactionId: interaction.interactionId,
      choiceId: interaction.choices[0].choiceId,
    })).rejects.toMatchObject({ code: "acp_interaction_not_pending" });
  });

  it("passes optional reverse RPC handlers through without interpreting wire values and fails closed when absent", async () => {
    const unavailableAgent = new FakeAcpV1Agent();
    const unavailableClient = createClient(unavailableAgent);
    await initialize(unavailableClient);
    expect(unavailableAgent.initializeRequests[0]).toMatchObject({ clientCapabilities: {} });
    await expect(unavailableAgent.invokeReverseRpc("readTextFile", { path: "/private/file" }))
      .rejects.toMatchObject({ code: "fake_acp_reverse_rpc_unavailable" });

    const agent = new FakeAcpV1Agent();
    const client = createClient(agent, undefined, {
      readTextFile: async (params) => ({ echoed: params }),
    });
    await initialize(client);
    expect(agent.initializeRequests[0]).toMatchObject({
      clientCapabilities: { fs: { readTextFile: true } },
    });
    await expect(agent.invokeReverseRpc("readTextFile", { opaqueLease: "lease_1" }))
      .resolves.toEqual({ echoed: { opaqueLease: "lease_1" } });

    expect(() => createClient(new FakeAcpV1Agent(), undefined, {
      createTerminal: async () => ({}),
    })).toThrowError("acp_terminal_reverse_rpc_handlers_incomplete");
    expect(() => createManagedAcpV1Client({
      connect: (handlers) => new FakeAcpV1Agent().connect(handlers),
      generationId: "host_generation_invalid-handler",
      reverseRpcHandlers: {
        sessionUpdate: async () => undefined,
      } as unknown as AcpV1ReverseRpcHandlers,
    })).toThrowError("acp_reverse_rpc_handlers_invalid");

    const terminalAgent = new FakeAcpV1Agent();
    const terminalClient = createClient(terminalAgent, undefined, {
      createTerminal: async () => ({}),
      terminalOutput: async () => ({}),
      waitForTerminalExit: async () => ({}),
      killTerminal: async () => ({}),
      releaseTerminal: async () => ({}),
    });
    await initialize(terminalClient);
    expect(terminalAgent.initializeRequests[0]).toMatchObject({
      clientCapabilities: { terminal: true },
    });
  });

  it("invalidates all raw mappings when the process generation ends", async () => {
    const agent = new FakeAcpV1Agent();
    const client = createClient(agent);
    await initialize(client);
    await client.ensureBinding({ bindingHandle, disposition: "create", workspaceDirectory, mcpServers: [], configuration });

    client.invalidateGeneration();

    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "stale" }))
      .rejects.toBeInstanceOf(AcpBoundaryError);
    await expect(client.submitPrompt({ bindingHandle, attemptId, content: "stale" }))
      .rejects.toMatchObject({ code: "acp_generation_inactive" });
  });

  it("selects exact model/config IDs and verifies each full config response", async () => {
    const agent = new FakeAcpV1Agent({
      configOptions: [
        {
          id: "config-model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "A" },
            { value: "model-b", name: "B" },
          ],
        },
        {
          id: "config-thought",
          name: "Thought",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "review", name: "Review" },
        ],
      },
    });
    const client = createClient(agent);
    await initialize(client);

    const result = await client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: {
        model: "model-b",
        options: [{
          configId: "config-thought",
          category: "thought_level",
          type: "select",
          value: "high",
        }],
        legacyModeId: "review",
      },
    });

    expect(agent.setConfigRequests).toEqual([
      { sessionId: "raw-fake-session", configId: "config-model", value: "model-b" },
      { sessionId: "raw-fake-session", configId: "config-thought", value: "high" },
    ]);
    expect(agent.setModeRequests).toEqual([
      { sessionId: "raw-fake-session", modeId: "review" },
    ]);
    expect(result).toMatchObject({
      model: "model-b",
      modelCatalog: [
        { modelId: "model-a", label: "A" },
        { modelId: "model-b", label: "B" },
      ],
      configurationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("config-model");
  });

  it("reads the ACP model selector through a temporary session without selecting a model", async () => {
    const agent = new FakeAcpV1Agent({
      configOptions: [{
        id: "config-model-private",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: [
          { value: "model-a", name: "Model A" },
          { value: "model-b", name: "Model B" },
        ],
      }],
    });
    const client = createClient(agent);
    await initialize(client);

    await expect(client.inspectModelCatalog({
      bindingHandle: "binding_handle_settings_catalog",
      workspaceDirectory,
      mcpServers: [],
    })).resolves.toEqual({
      kind: "model_catalog_observed",
      bindingHandle: "binding_handle_settings_catalog",
      currentModel: "model-a",
      modelCatalog: [
        { modelId: "model-a", label: "Model A" },
        { modelId: "model-b", label: "Model B" },
      ],
    });
    expect(agent.setConfigRequests).toEqual([]);
    expect(agent.closeSessionRequests).toEqual([{ sessionId: "raw-fake-session" }]);
  });

  it("fails closed for missing, ambiguous, or stale model configuration", async () => {
    const missingAgent = new FakeAcpV1Agent({ configOptions: [] });
    const missing = createClient(missingAgent);
    await initialize(missing);
    await expect(missing.ensureBinding({
      bindingHandle: "binding_handle_missing",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: { model: "wanted", options: [] },
    })).rejects.toMatchObject({ code: "acp_model_option_missing" });
    expect(missingAgent.closeSessionRequests).toEqual([
      { sessionId: "raw-fake-session" },
    ]);

    const duplicateModelOption = {
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "wanted",
      options: [{ value: "wanted", name: "Wanted" }],
    } as const;
    const ambiguous = createClient(new FakeAcpV1Agent({
      configOptions: [
        { id: "model-one", ...duplicateModelOption },
        { id: "model-two", ...duplicateModelOption },
      ],
    }));
    await initialize(ambiguous);
    await expect(ambiguous.ensureBinding({
      bindingHandle: "binding_handle_ambiguous",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: { model: "wanted", options: [] },
    })).rejects.toMatchObject({ code: "acp_model_option_ambiguous" });

    const stale = createClient(new FakeAcpV1Agent({
      staleConfigConfirmation: true,
      configOptions: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "old",
        options: [
          { value: "old", name: "Old" },
          { value: "wanted", name: "Wanted" },
        ],
      }],
    }));
    await initialize(stale);
    await expect(stale.ensureBinding({
      bindingHandle: "binding_handle_stale",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: { model: "wanted", options: [] },
    })).rejects.toMatchObject({ code: "acp_session_config_confirmation_invalid" });
  });

  it("poisons the generation when a failed create cannot close its new raw session", async () => {
    const agent = new FakeAcpV1Agent({ configOptions: [], failClose: true });
    const client = createClient(agent);
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_cleanup",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: { model: "missing", options: [] },
    })).rejects.toMatchObject({ code: "acp_binding_cleanup_required" });
    expect(agent.closeSessionRequests).toEqual([{ sessionId: "raw-fake-session" }]);
    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_after-cleanup-failure",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_generation_inactive" });
  });

  it("poisons the generation when session/new rejects after native creation became ambiguous", async () => {
    const rawSessionId = "raw-created-before-rejection";
    const agent = new FakeAcpV1Agent({ rawSessionId });
    const observations: AcpSessionObservation[] = [];
    let newSessionCalls = 0;
    let nativeSessionCreated = false;
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => {
            newSessionCalls += 1;
            await connection.newSession(params);
            nativeSessionCreated = true;
            throw Object.assign(
              new Error("transport rejected after creating the native session"),
              { code: "acp_stdio_session_new_resource_not_found" },
            );
          },
        };
      },
      generationId: "host_generation_rejected-create",
      createOpaqueId: opaqueIds(),
      onObservation: (observation) => {
        observations.push(observation);
      },
    });
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_rejected-create",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({
      code: "acp_binding_effect_failed",
      diagnosticCode: "acp_stdio_session_new_resource_not_found",
    });
    expect(nativeSessionCreated).toBe(true);
    expect(observations).toEqual([]);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_after-rejected-create",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_generation_inactive" });
    expect(newSessionCalls).toBe(1);
    await expect(client.submitPrompt({
      bindingHandle: "binding_handle_after-rejected-create",
      attemptId: "session_execution_attempt_after-rejected-create",
      content: "must not reuse an ambiguous create generation",
    })).rejects.toMatchObject({ code: "acp_generation_inactive" });
    expect(JSON.stringify(observations)).not.toContain(rawSessionId);
  });

  it("classifies an otherwise opaque session/new rejection by its safe binding stage", async () => {
    const agent = new FakeAcpV1Agent();
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async () => {
            throw new Error("unsafe Provider detail /private/native/session");
          },
        };
      },
      generationId: "host_generation_opaque-create-rejection",
      createOpaqueId: opaqueIds(),
    });
    await initialize(client);

    const observed = await client.ensureBinding({
      bindingHandle: "binding_handle_opaque-create-rejection",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    }).then(() => undefined, (error: unknown) => error);

    expect(observed).toMatchObject({
      code: "acp_binding_effect_failed",
      diagnosticCode: "acp_binding_session_create_failed",
    });
    expect(JSON.stringify(observed)).not.toContain("/private/native/session");
  });

  it("poisons the generation when session/new returns no usable raw session ID", async () => {
    const agent = new FakeAcpV1Agent();
    const client = createManagedAcpV1Client({
      connect: (handlers) => {
        const connection = agent.connect(handlers);
        return {
          ...connection,
          newSession: async (params: unknown) => ({
            ...(await connection.newSession(params) as Record<string, unknown>),
            sessionId: undefined,
          }),
        };
      },
      generationId: "host_generation_malformed-create",
      createOpaqueId: opaqueIds(),
    });
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_malformed-create",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_binding_session_id_invalid" });
    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_after-malformed-create",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_generation_inactive" });
  });

  it("rejects a conflicting explicit model config before any Provider config effect", async () => {
    const agent = new FakeAcpV1Agent({
      configOptions: [{
        id: "model-config",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: [
          { value: "model-a", name: "A" },
          { value: "model-b", name: "B" },
        ],
      }],
    });
    const client = createClient(agent);
    await initialize(client);

    await expect(client.ensureBinding({
      bindingHandle: "binding_handle_conflict",
      disposition: "create",
      workspaceDirectory,
      mcpServers: [],
      configuration: {
        model: "model-b",
        options: [{
          configId: "model-config",
          category: "model",
          type: "select",
          value: "model-b",
        }],
      },
    })).rejects.toMatchObject({ code: "acp_session_config_intent_conflict" });
    expect(agent.setConfigRequests).toEqual([]);
  });
});

async function waitForInteraction(
  observations: AcpSessionObservation[],
): Promise<Extract<AcpSessionObservation, { kind: "interaction_requested" }>> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const interaction = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "interaction_requested" }> =>
        entry.kind === "interaction_requested",
    );
    if (interaction) return interaction;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("interaction_not_observed");
}
