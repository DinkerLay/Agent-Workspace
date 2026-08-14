import type { LogicalSessionRecord } from "@agent-workspace/runtime-contracts";
import { templateDefinitionFixture } from "@agent-workspace/test-kit";
import { describe, expect, it } from "vitest";
import { compileProviderSessionBootstrap } from "./session-bootstrap.js";

const createdAt = "2026-08-06T00:00:00.000Z";

describe("compileProviderSessionBootstrap", () => {
  it("gives the Conductor dispatch metadata but never a Worker system prompt", () => {
    const definition = templateDefinitionFixture();
    const worker = definition.agentCards[0]!;
    const bootstrap = compileProviderSessionBootstrap({
      architecture: { definition },
      session: session({
        logicalSessionId: "logical_session_conductor",
        kind: "conductor",
        agentCardId: definition.conductor.agentCardId,
        executionProfileId: definition.conductor.executionProfileId,
      }),
    });

    expect(bootstrap).toMatchObject({
      purpose: "task_conductor",
      agentCardId: definition.conductor.agentCardId,
      kind: "conductor",
      title: definition.conductor.title,
      ...(definition.conductor.role ? { role: definition.conductor.role } : {}),
      systemPrompt: definition.conductor.systemPrompt,
      dispatchRegistry: [{
        agentCardId: worker.agentCardId,
        title: worker.dispatchProfile!.title,
        description: worker.dispatchProfile!.description,
      }],
    });
    expect(JSON.stringify(bootstrap)).not.toContain(worker.systemPrompt);
  });

  it("gives a Worker only its own system prompt and capability scope", () => {
    const base = templateDefinitionFixture();
    const definition = {
      ...base,
      conductor: { ...base.conductor, capabilityRefs: [{ kind: "mcp" as const, id: "conductor-only" }] },
      agentCards: [{ ...base.agentCards[0]!, capabilityRefs: [{ kind: "skill" as const, id: "worker-only" }] }],
    };
    const worker = definition.agentCards[0]!;
    const bootstrap = compileProviderSessionBootstrap({
      architecture: { definition },
      session: session({
        logicalSessionId: "logical_session_worker",
        kind: "card",
        agentCardId: worker.agentCardId,
        executionProfileId: worker.executionProfileId,
      }),
    });

    expect(bootstrap).toEqual({
      purpose: "task_worker",
      agentCardId: worker.agentCardId,
      kind: worker.kind,
      title: worker.title,
      ...(worker.role ? { role: worker.role } : {}),
      systemPrompt: worker.systemPrompt,
      capabilityRefs: [{ kind: "skill", id: "worker-only" }],
    });
    expect(JSON.stringify(bootstrap)).not.toContain(definition.conductor.systemPrompt);
    expect(JSON.stringify(bootstrap)).not.toContain("conductor-only");
  });
});

function session(overrides: Pick<LogicalSessionRecord, "logicalSessionId" | "kind" | "agentCardId" | "executionProfileId">): LogicalSessionRecord {
  return {
    ...overrides,
    taskId: "task_bootstrap",
    runId: "run_bootstrap",
    status: "active",
    ordinal: 1,
    createdAt,
    updatedAt: createdAt,
  };
}
