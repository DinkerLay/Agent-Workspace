# Workspace Session Dispatch Layer Implementation Plan

> **Status: Superseded / Deprecated after completion.** This plan implemented the previous Workspace Session Message approach. It is retained as historical execution evidence, but it is no longer the active implementation direction. The active product spec is `docs/superworks/spec/conductor-session-communication.md`, which replaces worker protocol injection with Conductor-centric MCP tools and provider-native worker sessions. Do not use this plan for new implementation work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the fragile Agent Dispatch wording and terminal-repair loop with a Workspace Session routing model that dispatches work across independently managed PTY sessions while still allowing each provider session to use its own internal agents, subagents, tools, and modes.

**Architecture:** Keep the existing `Agent` data type as a compatibility record for now, but introduce Workspace Session semantics at the protocol, routing, template, and prompt-injection layers. The shell owns cross-session routing; provider-native OpenCode or Claude Code subagents remain internal implementation tools inside the current session and must not be treated as delivery targets for another Workspace Session. Routing policy is task-template owned and enforced by the shell before any message is delivered.

**Tech Stack:** Vite, React, TypeScript, Vitest, Electron PTY bridge, OpenCode adapter, Claude Code adapter.

---

## Current Problem

The current implementation uses `Agent` and `AgentDispatch` for two different concepts:

- Workspace-managed PTY sessions, such as Conductor, Researcher, and Reviewer.
- Provider-native agents or subagents inside OpenCode or Claude Code.

That name collision causes the Conductor session to misunderstand "dispatch to Researcher" as "activate a provider-native subagent inside the current OpenCode process." The current protocol also routes by `fromAgentId` and `toAgentId`, has no task-template routing graph, and auto-writes repair prompts into visible worker TUI sessions. The visible TUI write path caused `[Pasted ~22 lines]` / `QUEUED` terminal pollution in `/Users/dinker/CODES/TEMP_project/Agent_Test`.

## Target Model

```text
Task
  -> Task Session Group
    -> Conductor Workspace Session
    -> Researcher Workspace Session
    -> Reviewer Workspace Session

Workspace Session
  -> may use provider-native OpenCode / Claude Code subagents internally
  -> must use Workspace Session Message for cross-session routing
```

Research task routing:

```text
Conductor Session -> Researcher Session
Researcher Session -> Reviewer Session
Reviewer Session -> Conductor Session
Conductor Session -> Researcher Session
```

Reviewer must not directly dispatch new work to Researcher. Reviewer reports gaps to Conductor; Conductor decides whether to send Researcher another round.

## File Structure

### Create

- `src/orchestration/session-communication/protocol.ts`  
  Owns Workspace Session message parsing, validation, transcript analysis, and compatibility conversion from the old agent message fields.

- `src/orchestration/session-communication/routingPolicy.ts`  
  Owns allowed route checks for a task session group.

- `src/orchestration/session-communication/index.ts`  
  Public exports for the session communication layer.

- `src/orchestration/session-communication/*.test.ts`  
  Tests for message parsing, route validation, and invalid route diagnostics.

- `src/orchestration/session-dispatch/sessionDispatch.ts`  
  Builds session assignments, Conductor prompts, worker prompts, and structured prompts from routed messages.

- `src/orchestration/session-dispatch/sessionDispatch.test.ts`  
  Tests for research session graph, prompt semantics, and handoff routing.

### Modify

- `src/types.ts`  
  Add `templateId` to `Task` so runtime routing can resolve the task template without guessing from labels. Keep the existing `Agent` type as the temporary runtime record; do not add unused session fields in this plan.

- `src/runtime/opencode/taskTemplates.ts`  
  Add per-template role prompts and routing policy. The research template must define Conductor, Researcher, and Reviewer route rules.

- `src/runtime/adapters/scopedInjection.ts`  
  Inject Workspace Session rules: provider-native subagents are allowed only inside the current session; cross-session work must be emitted as Workspace Session Messages.

- `src/runtime/adapters/opencode/injection.ts`  
  Keep OpenCode config generation, but source its session prompt from the new Workspace Session bundle.

- `src/runtime/adapters/claude-code/injection.ts`  
  Keep Claude Code scoped injection, but source its session prompt from the new Workspace Session bundle.

- `src/App.tsx`  
  Replace `createAgentDispatchPlan` usage with `createSessionDispatchPlan`. Disable automatic repair writes into worker TUI sessions. Route valid session messages through the shell only after policy validation.

- `src/App.test.tsx`  
  Update end-to-end tests to assert session dispatch, valid routing, no automatic repair write, and route rejection.

- `docs/superworks/spec/product-interaction-map.md`  
  Update the Agent Communication section to Workspace Session Communication. Preserve the distinction between shell-owned session routing and provider-native subagents.

### Keep As Compatibility During This Plan

- `src/orchestration/agent-communication/*`  
  Keep exports as compatibility shims if existing tests/pages still import them. The shim should re-export the new session communication layer or convert old names to new names.

- `src/orchestration/agent-dispatch/*`  
  Keep compatibility wrappers during the migration if needed. New code should import from `session-dispatch`.

---

## Task 1: Add Workspace Session Message Protocol

**Files:**
- Create: `src/orchestration/session-communication/protocol.ts`
- Create: `src/orchestration/session-communication/index.ts`
- Create: `src/orchestration/session-communication/protocol.test.ts`

- [x] **Step 1: Write failing protocol tests**

Create `src/orchestration/session-communication/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SESSION_MESSAGE_TAG,
  WORKSPACE_SESSION_PROTOCOL_VERSION,
  analyzeSessionTranscript,
  buildWorkspaceSessionProtocolPrompt,
  buildWorkspaceSessionMessageBlock,
  parseWorkspaceSessionMessages,
} from "./protocol";

describe("workspace session protocol", () => {
  it("parses a valid session handoff block", () => {
    const block = buildWorkspaceSessionMessageBlock({
      protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
      type: "handoff",
      taskId: "task-intake-001",
      fromSessionId: "task-intake-001-researcher",
      toSessionId: "task-intake-001-reviewer",
      round: 1,
      status: "done",
      summary: "Research notes are ready for source challenge.",
      body: "Evidence lives in docs/research/claude-dynamic-workflow.md.",
      evidenceRefs: ["docs/research/claude-dynamic-workflow.md"],
      nextAction: "Review source quality and identify missing evidence.",
    });

    expect(parseWorkspaceSessionMessages(block)).toEqual([
      {
        protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
        type: "handoff",
        taskId: "task-intake-001",
        fromSessionId: "task-intake-001-researcher",
        toSessionId: "task-intake-001-reviewer",
        round: 1,
        status: "done",
        summary: "Research notes are ready for source challenge.",
        body: "Evidence lives in docs/research/claude-dynamic-workflow.md.",
        evidenceRefs: ["docs/research/claude-dynamic-workflow.md"],
        nextAction: "Review source quality and identify missing evidence.",
      },
    ]);
  });

  it("accepts old agent field names as compatibility input", () => {
    const text = [
      `<${WORKSPACE_SESSION_MESSAGE_TAG}>`,
      JSON.stringify({
        protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
        type: "handoff",
        taskId: "task-intake-001",
        fromAgentId: "task-intake-001-researcher",
        toAgentId: "task-intake-001-reviewer",
        round: 1,
        status: "done",
        summary: "Research complete.",
        body: "Evidence path recorded.",
        evidenceRefs: ["docs/research/example.md"],
        nextAction: "Review this evidence.",
      }),
      `</${WORKSPACE_SESSION_MESSAGE_TAG}>`,
    ].join("\n");

    expect(parseWorkspaceSessionMessages(text)[0]).toMatchObject({
      fromSessionId: "task-intake-001-researcher",
      toSessionId: "task-intake-001-reviewer",
    });
  });

  it("does not create a violation while the terminal is not ready", () => {
    const analysis = analyzeSessionTranscript({
      expectedSessionId: "task-intake-001-researcher",
      expectedTaskId: "task-intake-001",
      text: "Working through evidence collection...",
      terminalReady: false,
    });

    expect(analysis.messages).toEqual([]);
    expect(analysis.violation).toBeUndefined();
  });

  it("reports missing structured message only after terminal readiness is explicit", () => {
    const analysis = analyzeSessionTranscript({
      expectedSessionId: "task-intake-001-researcher",
      expectedTaskId: "task-intake-001",
      text: "Research complete without a structured block.",
      terminalReady: true,
    });

    expect(analysis.violation).toMatchObject({
      reason: "missing-protocol-message",
      sessionId: "task-intake-001-researcher",
      taskId: "task-intake-001",
    });
  });

  it("builds an explicit session protocol prompt with the required block shape", () => {
    const prompt = buildWorkspaceSessionProtocolPrompt({
      taskId: "task-intake-001",
      sessionId: "task-intake-001-researcher",
      toSessionId: "task-intake-001-reviewer",
      role: "worker",
    });

    expect(prompt).toContain("Workspace Session runtime communication protocol");
    expect(prompt).toContain("Provider-native agents/subagents are allowed inside this current session");
    expect(prompt).toContain("Do not use a provider-native subagent to represent another Workspace Session");
    expect(prompt).toContain("workspace-session-message");
    expect(prompt).toContain('"fromSessionId": "task-intake-001-researcher"');
    expect(prompt).toContain('"toSessionId": "task-intake-001-reviewer"');
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/orchestration/session-communication/protocol.test.ts
```

Expected: fail because `src/orchestration/session-communication/protocol.ts` does not exist.

- [x] **Step 3: Implement the protocol module**

Create `src/orchestration/session-communication/protocol.ts`:

```ts
export const WORKSPACE_SESSION_PROTOCOL_VERSION = "workspace-session/v1";
export const WORKSPACE_SESSION_MESSAGE_TAG = "workspace-session-message";

export type WorkspaceSessionMessageType = "assignment" | "question" | "handoff" | "decision" | "blocked";

export type WorkspaceSessionMessage = {
  protocol: typeof WORKSPACE_SESSION_PROTOCOL_VERSION;
  type: WorkspaceSessionMessageType;
  taskId: string;
  fromSessionId: string;
  toSessionId: string;
  round: number;
  status: string;
  summary: string;
  body: string;
  evidenceRefs: string[];
  nextAction: string;
};

export type SessionProtocolViolationReason =
  | "missing-protocol-message"
  | "invalid-protocol-message"
  | "message-scope-mismatch";

export type SessionProtocolViolation = {
  reason: SessionProtocolViolationReason;
  sessionId: string;
  taskId: string;
  excerpt: string;
};

export type SessionTranscriptAnalysis = {
  messages: WorkspaceSessionMessage[];
  violation?: SessionProtocolViolation;
};

export function buildWorkspaceSessionMessageBlock(message: WorkspaceSessionMessage) {
  return [
    `<${WORKSPACE_SESSION_MESSAGE_TAG}>`,
    JSON.stringify(message, null, 2),
    `</${WORKSPACE_SESSION_MESSAGE_TAG}>`,
  ].join("\n");
}

export function buildWorkspaceSessionProtocolPrompt(input: {
  taskId: string;
  sessionId: string;
  toSessionId: string;
  role: "conductor" | "worker";
}) {
  return [
    "Workspace Session runtime communication protocol:",
    `- This session is scoped to task ${input.taskId}.`,
    `- Your current Workspace Session id is ${input.sessionId}.`,
    `- Route cross-session messages to ${input.toSessionId} unless the shell prompt explicitly names another allowed target.`,
    "- Provider-native agents/subagents are allowed inside this current session as implementation tools.",
    "- Do not use a provider-native subagent to represent another Workspace Session.",
    "- When another Workspace Session must act, emit exactly one structured message block and let the shell router deliver it.",
    "- Free-form terminal text is visible evidence, but it is not a reliable cross-session message.",
    "- Do not claim task completion unless evidence paths or review requirements are named.",
    `- Role mode: ${input.role}.`,
    "",
    "Required block shape:",
    buildWorkspaceSessionMessageBlock({
      protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
      type: "handoff",
      taskId: input.taskId,
      fromSessionId: input.sessionId,
      toSessionId: input.toSessionId,
      round: 1,
      status: "done|blocked|question|needs-review",
      summary: "short summary",
      body: "facts, evidence, output paths, unresolved issues",
      evidenceRefs: ["docs/research/example.md"],
      nextAction: "what the receiving Workspace Session should do next",
    }),
  ].join("\n");
}

export function parseWorkspaceSessionMessages(text: string): WorkspaceSessionMessage[] {
  const messages: WorkspaceSessionMessage[] = [];
  const cleaned = stripTerminalControls(text);
  const sessionPattern = new RegExp(
    `<${WORKSPACE_SESSION_MESSAGE_TAG}>\\s*([\\s\\S]*?)\\s*</${WORKSPACE_SESSION_MESSAGE_TAG}>`,
    "g",
  );
  const legacyPattern = /<agent-workspace-message>\s*([\s\S]*?)\s*<\/agent-workspace-message>/g;

  for (const pattern of [sessionPattern, legacyPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned)) !== null) {
      const parsed = parseJsonObject(match[1]);
      const normalized = normalizeWorkspaceSessionMessage(parsed);
      if (normalized) messages.push(normalized);
    }
  }

  return messages;
}

export function analyzeSessionTranscript(input: {
  expectedSessionId: string;
  expectedTaskId: string;
  text: string;
  terminalReady: boolean;
}): SessionTranscriptAnalysis {
  const messages = parseWorkspaceSessionMessages(input.text);
  const scopedMessages = messages.filter(
    (message) => message.taskId === input.expectedTaskId && message.fromSessionId === input.expectedSessionId,
  );

  if (scopedMessages.length > 0) return { messages: scopedMessages };
  if (!input.terminalReady) return { messages: [] };

  if (messages.length > 0) {
    return {
      messages: [],
      violation: {
        reason: "message-scope-mismatch",
        sessionId: input.expectedSessionId,
        taskId: input.expectedTaskId,
        excerpt: terminalExcerpt(input.text),
      },
    };
  }

  const stripped = stripTerminalControls(input.text);
  const hasEnvelope =
    stripped.includes(`<${WORKSPACE_SESSION_MESSAGE_TAG}>`) || stripped.includes("<agent-workspace-message>");

  return {
    messages: [],
    violation: {
      reason: hasEnvelope ? "invalid-protocol-message" : "missing-protocol-message",
      sessionId: input.expectedSessionId,
      taskId: input.expectedTaskId,
      excerpt: terminalExcerpt(input.text),
    },
  };
}

function normalizeWorkspaceSessionMessage(value: unknown): WorkspaceSessionMessage | undefined {
  if (!isRecord(value)) return undefined;
  const fromSessionId = value.fromSessionId ?? value.fromAgentId;
  const toSessionId = value.toSessionId ?? value.toAgentId;
  const protocol = value.protocol === "agent-workspace/v1" ? WORKSPACE_SESSION_PROTOCOL_VERSION : value.protocol;

  const normalized = { ...value, protocol, fromSessionId, toSessionId };
  return isWorkspaceSessionMessage(normalized) ? normalized : undefined;
}

function isWorkspaceSessionMessage(value: unknown): value is WorkspaceSessionMessage {
  if (!isRecord(value)) return false;
  return (
    value.protocol === WORKSPACE_SESSION_PROTOCOL_VERSION &&
    isMessageType(value.type) &&
    isNonEmptyString(value.taskId) &&
    isNonEmptyString(value.fromSessionId) &&
    isNonEmptyString(value.toSessionId) &&
    typeof value.round === "number" &&
    Number.isInteger(value.round) &&
    value.round > 0 &&
    isNonEmptyString(value.status) &&
    isNonEmptyString(value.summary) &&
    typeof value.body === "string" &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every((item) => typeof item === "string") &&
    typeof value.nextAction === "string"
  );
}

export function stripTerminalControls(text: string) {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "\n");
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function terminalExcerpt(text: string) {
  return stripTerminalControls(text).trim().slice(-2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isMessageType(value: unknown): value is WorkspaceSessionMessageType {
  return (
    value === "assignment" ||
    value === "question" ||
    value === "handoff" ||
    value === "decision" ||
    value === "blocked"
  );
}
```

Create `src/orchestration/session-communication/index.ts`:

```ts
export * from "./protocol";
```

- [x] **Step 4: Verify protocol tests pass**

Run:

```bash
npm test -- src/orchestration/session-communication/protocol.test.ts
```

Expected: pass.

---

## Task 2: Add Task Template Routing Policy

**Files:**
- Create: `src/orchestration/session-communication/routingPolicy.ts`
- Create: `src/orchestration/session-communication/routingPolicy.test.ts`
- Modify: `src/orchestration/session-communication/index.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/taskMachine.ts`
- Modify: `src/lib/taskMachine.test.ts`
- Modify: `src/runtime/opencode/taskTemplates.ts`
- Modify: `src/runtime/opencode/taskTemplates.test.ts`

- [x] **Step 1: Write failing routing tests**

Create `src/orchestration/session-communication/routingPolicy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertWorkspaceSessionRoute, buildRouteMap } from "./routingPolicy";

const routes = buildRouteMap([
  { fromRole: "Conductor", toRole: "Researcher" },
  { fromRole: "Researcher", toRole: "Reviewer" },
  { fromRole: "Reviewer", toRole: "Conductor" },
]);

const sessions = [
  { id: "task-1-conductor", name: "Conductor" },
  { id: "task-1-researcher", name: "Researcher" },
  { id: "task-1-reviewer", name: "Reviewer" },
];

describe("workspace session routing policy", () => {
  it("allows the research template route from Researcher to Reviewer", () => {
    expect(
      assertWorkspaceSessionRoute({
        routes,
        sessions,
        fromSessionId: "task-1-researcher",
        toSessionId: "task-1-reviewer",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects Reviewer dispatching directly to Researcher", () => {
    expect(
      assertWorkspaceSessionRoute({
        routes,
        sessions,
        fromSessionId: "task-1-reviewer",
        toSessionId: "task-1-researcher",
      }),
    ).toMatchObject({
      ok: false,
      reason: "route-not-allowed",
      fromRole: "Reviewer",
      toRole: "Researcher",
    });
  });

  it("rejects unknown target sessions", () => {
    expect(
      assertWorkspaceSessionRoute({
        routes,
        sessions,
        fromSessionId: "task-1-conductor",
        toSessionId: "task-1-missing",
      }),
    ).toMatchObject({
      ok: false,
      reason: "unknown-session",
    });
  });
});
```

- [x] **Step 2: Run the failing routing tests**

Run:

```bash
npm test -- src/orchestration/session-communication/routingPolicy.test.ts
```

Expected: fail because `routingPolicy.ts` does not exist.

- [x] **Step 3: Implement route policy helpers**

Create `src/orchestration/session-communication/routingPolicy.ts`:

```ts
export type WorkspaceSessionRoute = {
  fromRole: string;
  toRole: string;
};

export type WorkspaceSessionRouteMap = Record<string, string[]>;

export type WorkspaceSessionRouteCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown-session" | "route-not-allowed";
      fromSessionId: string;
      toSessionId: string;
      fromRole?: string;
      toRole?: string;
    };

export function buildRouteMap(routes: WorkspaceSessionRoute[]): WorkspaceSessionRouteMap {
  return routes.reduce<WorkspaceSessionRouteMap>((map, route) => {
    map[route.fromRole] = [...(map[route.fromRole] ?? []), route.toRole];
    return map;
  }, {});
}

export function assertWorkspaceSessionRoute(input: {
  routes: WorkspaceSessionRouteMap;
  sessions: Array<{ id: string; name: string }>;
  fromSessionId: string;
  toSessionId: string;
}): WorkspaceSessionRouteCheck {
  const fromSession = input.sessions.find((session) => session.id === input.fromSessionId);
  const toSession = input.sessions.find((session) => session.id === input.toSessionId);

  if (!fromSession || !toSession) {
    return {
      ok: false,
      reason: "unknown-session",
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      fromRole: fromSession?.name,
      toRole: toSession?.name,
    };
  }

  const allowedTargets = input.routes[fromSession.name] ?? [];
  if (!allowedTargets.includes(toSession.name)) {
    return {
      ok: false,
      reason: "route-not-allowed",
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      fromRole: fromSession.name,
      toRole: toSession.name,
    };
  }

  return { ok: true };
}
```

Modify `src/orchestration/session-communication/index.ts`:

```ts
export * from "./protocol";
export * from "./routingPolicy";
```

- [x] **Step 4: Add routing policy to task templates**

Modify `src/types.ts` so `Task` preserves its template:

```ts
export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  source: string;
  owner: string;
  risk: string;
  verification: string;
  summary: string;
  labels?: string[];
  templateId?: string;
};
```

Modify `src/lib/taskMachine.ts` so `createTaskFromIntake()` writes the selected template id onto the task. Move the existing template lookup above the `task` object and set `templateId: template.id`:

```ts
const template = opencodeTaskTemplates.find((item) => item.id === action.templateId) ?? opencodeTaskTemplates[0];
const task: Task = {
  id: taskId,
  title,
  status: "running",
  source: intakeSourceLabels[action.intakeSource],
  owner,
  risk: "Conductor auto-started; execution evidence must come from the real PTY session",
  verification: "Conductor terminal starts from intake and records task context",
  summary,
  labels,
  templateId: template.id,
};
```

Update `src/lib/taskMachine.test.ts` so the intake task assertion includes:

```ts
templateId: "implementation",
```

For the research intake test, include:

```ts
templateId: "research",
```

Modify `src/runtime/opencode/taskTemplates.ts`:

```ts
import type { Agent, TaskIntakeSource } from "../../types";
import type { WorkspaceSessionRoute } from "../../orchestration/session-communication";
import { safeSegment } from "./sessionKey";

export type OpencodeTaskTemplateId = "research" | "product-logic" | "spec-plan" | "implementation" | "debug-fix";

export type OpencodeTaskTemplateRole = Pick<Agent, "name" | "role" | "accent"> & {
  sessionPrompt: string;
};

export type OpencodeTaskTemplate = {
  id: OpencodeTaskTemplateId;
  label: string;
  intakeSource: TaskIntakeSource;
  roles: OpencodeTaskTemplateRole[];
  routes: WorkspaceSessionRoute[];
};
```

For the `research` template, use:

```ts
{
  id: "research",
  label: "调研任务",
  intakeSource: "manual-brief",
  roles: [
    {
      name: "Conductor",
      role: "Research coordinator",
      accent: "#111827",
      sessionPrompt:
        "You coordinate research rounds, decide when evidence is sufficient, and dispatch follow-up work through Workspace Session Messages.",
    },
    {
      name: "Researcher",
      role: "Evidence collector",
      accent: "#2563eb",
      sessionPrompt:
        "You collect evidence, cite durable sources, write research artifacts, and route completed evidence to Reviewer for source challenge.",
    },
    {
      name: "Reviewer",
      role: "Source challenge",
      accent: "#be123c",
      sessionPrompt:
        "You challenge evidence quality, identify gaps, and route review verdicts only to Conductor for the next decision.",
    },
  ],
  routes: [
    { fromRole: "Conductor", toRole: "Researcher" },
    { fromRole: "Researcher", toRole: "Reviewer" },
    { fromRole: "Reviewer", toRole: "Conductor" },
  ],
}
```

For existing non-research templates, add routes that preserve current behavior:

```ts
routes: [
  { fromRole: "Conductor", toRole: "Planner" },
  { fromRole: "Planner", toRole: "Reviewer" },
  { fromRole: "Reviewer", toRole: "Conductor" },
]
```

For implementation/debug templates with `Executor` and `QA`, use:

```ts
routes: [
  { fromRole: "Conductor", toRole: "Executor" },
  { fromRole: "Executor", toRole: "QA" },
  { fromRole: "QA", toRole: "Conductor" },
]
```

- [x] **Step 5: Add task template tests**

Extend `src/runtime/opencode/taskTemplates.test.ts` with:

```ts
it("defines a research routing graph through Conductor, Researcher, and Reviewer", () => {
  const template = opencodeTaskTemplates.find((item) => item.id === "research");

  expect(template?.routes).toEqual([
    { fromRole: "Conductor", toRole: "Researcher" },
    { fromRole: "Researcher", toRole: "Reviewer" },
    { fromRole: "Reviewer", toRole: "Conductor" },
  ]);
  expect(template?.roles.find((role) => role.name === "Researcher")?.sessionPrompt).toContain("route completed evidence");
  expect(template?.roles.find((role) => role.name === "Reviewer")?.sessionPrompt).toContain("only to Conductor");
});
```

- [x] **Step 6: Verify routing and template tests pass**

Run:

```bash
npm test -- src/orchestration/session-communication/routingPolicy.test.ts src/runtime/opencode/taskTemplates.test.ts
```

Expected: pass.

---

## Task 3: Build Session Dispatch Layer

**Files:**
- Create: `src/orchestration/session-dispatch/sessionDispatch.ts`
- Create: `src/orchestration/session-dispatch/index.ts`
- Create: `src/orchestration/session-dispatch/sessionDispatch.test.ts`
- Modify: `src/orchestration/agent-dispatch/agentDispatch.ts`
- Modify: `src/orchestration/agent-dispatch/agentDispatch.test.ts`

- [x] **Step 1: Write failing session dispatch tests**

Create `src/orchestration/session-dispatch/sessionDispatch.test.ts` with tests that mirror existing `agentDispatch.test.ts`, but assert session wording:

```ts
import { describe, expect, it } from "vitest";
import type { Agent, Project, Task } from "../../types";
import { WORKSPACE_SESSION_PROTOCOL_VERSION, buildWorkspaceSessionMessageBlock } from "../session-communication";
import {
  buildConductorSessionHandoffPrompt,
  createSessionDispatchPlan,
  detectSessionHandoff,
} from "./sessionDispatch";

const project: Project = {
  id: "project-runtime-current",
  name: "Agent_Test",
  zone: "work",
  path: "/Users/dinker/CODES/TEMP_project/Agent_Test",
  status: "active",
  defaultAgentClusterId: "cluster-default",
  agentClusterIds: ["cluster-task"],
  agentIds: [],
  taskIds: ["task-intake-001"],
  commandIds: [],
  browserProfile: "default",
};

const task: Task = {
  id: "task-intake-001",
  title: "调研 claude dynamic workflow 的机制",
  status: "running",
  source: "Manual brief",
  owner: "Conductor",
  risk: "unknown",
  verification: "research report",
  summary: "调研 Claude Dynamic Workflow 的工作原理，并产出 research / spec / plan 线索。",
  labels: ["research", "claude"],
  templateId: "research",
};

const sessions: Agent[] = [
  {
    id: "task-intake-001-conductor",
    projectId: project.id,
    clusterId: "cluster-task",
    taskId: task.id,
    name: "Conductor",
    role: "Research coordinator",
    provider: "opencode",
    model: "opencode/deepseek-v4-flash-free",
    status: "idle",
    accent: "#111827",
    lastActive: "not started",
  },
  {
    id: "task-intake-001-researcher",
    projectId: project.id,
    clusterId: "cluster-task",
    taskId: task.id,
    name: "Researcher",
    role: "Evidence collector",
    provider: "opencode",
    model: "opencode/deepseek-v4-flash-free",
    status: "idle",
    accent: "#2563eb",
    lastActive: "not started",
  },
  {
    id: "task-intake-001-reviewer",
    projectId: project.id,
    clusterId: "cluster-task",
    taskId: task.id,
    name: "Reviewer",
    role: "Source challenge",
    provider: "opencode",
    model: "opencode/deepseek-v4-flash-free",
    status: "idle",
    accent: "#be123c",
    lastActive: "not started",
  },
];

describe("session dispatch layer", () => {
  it("builds research session assignments with explicit cross-session wording", () => {
    const plan = createSessionDispatchPlan({
      project,
      task,
      conductorSession: sessions[0],
      sessions,
      routes: [
        { fromRole: "Conductor", toRole: "Researcher" },
        { fromRole: "Researcher", toRole: "Reviewer" },
        { fromRole: "Reviewer", toRole: "Conductor" },
      ],
    });

    expect(plan.conductorSessionId).toBe("task-intake-001-conductor");
    expect(plan.assignments.map((assignment) => assignment.sessionId)).toEqual([
      "task-intake-001-researcher",
      "task-intake-001-reviewer",
    ]);
    expect(plan.conductorPrompt).toContain("Workspace Session");
    expect(plan.conductorPrompt).toContain("Do not use provider-native subagents to represent another Workspace Session");
    expect(plan.conductorPrompt).toContain("Workspace Session runtime communication protocol");
    expect(plan.assignments[0].prompt).toContain("You are the Workspace Session named Researcher");
    expect(plan.assignments[0].prompt).toContain("Provider-native agents/subagents are allowed inside this current session");
    expect(plan.assignments[0].prompt).toContain("workspace-session-message");
  });

  it("detects a structured session handoff only when terminal is ready", () => {
    const text = [
      buildWorkspaceSessionMessageBlock({
        protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
        type: "handoff",
        taskId: task.id,
        fromSessionId: sessions[1].id,
        toSessionId: sessions[2].id,
        round: 1,
        status: "done",
        summary: "Evidence collection complete.",
        body: "Research artifact exists.",
        evidenceRefs: ["docs/research/claude-dynamic-workflow.md"],
        nextAction: "Review source quality.",
      }),
      "Ask anything...",
      "tab agents ctrl+p commands",
    ].join("\n");

    expect(detectSessionHandoff({ session: sessions[1], task, text })).toMatchObject({
      sessionId: sessions[1].id,
      toSessionId: sessions[2].id,
    });
  });

  it("builds a Conductor prompt from a routed session handoff", () => {
    const prompt = buildConductorSessionHandoffPrompt({
      project,
      task,
      fromSession: sessions[2],
      messageText: "<workspace-session-message>{}</workspace-session-message>",
    });

    expect(prompt).toContain("[Agent Workspace] Session handoff");
    expect(prompt).toContain("Reviewer");
    expect(prompt).toContain("decide whether another session should receive a follow-up dispatch");
  });
});
```

- [x] **Step 2: Run the failing session dispatch tests**

Run:

```bash
npm test -- src/orchestration/session-dispatch/sessionDispatch.test.ts
```

Expected: fail because `sessionDispatch.ts` does not exist.

- [x] **Step 3: Implement session dispatch**

Create `src/orchestration/session-dispatch/sessionDispatch.ts` with:

```ts
import type { Agent, Project, Task } from "../../types";
import {
  analyzeSessionTranscript,
  buildWorkspaceSessionProtocolPrompt,
  buildWorkspaceSessionMessageBlock,
  buildRouteMap,
  type WorkspaceSessionRoute,
} from "../session-communication";

export type SessionDispatchAssignment = {
  taskId: string;
  sessionId: string;
  sessionName: string;
  sessionRole: string;
  prompt: string;
};

export type SessionDispatchPlan = {
  taskId: string;
  conductorSessionId: string;
  conductorPrompt: string;
  assignments: SessionDispatchAssignment[];
};

export type SessionHandoff = {
  sessionId: string;
  sessionName: string;
  sessionRole: string;
  toSessionId: string;
  text: string;
  digest: string;
};

export function createSessionDispatchPlan(input: {
  project: Project;
  task: Task;
  conductorSession: Agent;
  sessions: Agent[];
  routes: WorkspaceSessionRoute[];
}): SessionDispatchPlan {
  const workerSessions = input.sessions.filter(
    (session) => session.taskId === input.task.id && session.id !== input.conductorSession.id,
  );
  const routeMap = buildRouteMap(input.routes);

  return {
    taskId: input.task.id,
    conductorSessionId: input.conductorSession.id,
    conductorPrompt: buildConductorSessionInitialPrompt({
      project: input.project,
      task: input.task,
      conductorSession: input.conductorSession,
      sessions: workerSessions,
      routeMap,
    }),
    assignments: workerSessions.map((session) => ({
      taskId: input.task.id,
      sessionId: session.id,
      sessionName: session.name,
      sessionRole: session.role,
      prompt: buildWorkerSessionAssignmentPrompt({
        project: input.project,
        task: input.task,
        session,
        conductorSession: input.conductorSession,
        sessions: input.sessions,
        routeMap,
      }),
    })),
  };
}

export function detectSessionHandoff(input: { session: Agent; task: Task; text: string }): SessionHandoff | undefined {
  if (!terminalReturnedToPrompt(input.text)) return undefined;
  const analysis = analyzeSessionTranscript({
    expectedSessionId: input.session.id,
    expectedTaskId: input.task.id,
    text: input.text,
    terminalReady: true,
  });
  const message = analysis.messages.find((candidate) => candidate.type === "handoff" || candidate.type === "blocked");
  if (!message) return undefined;

  const excerpt = buildWorkspaceSessionMessageBlock(message);
  return {
    sessionId: input.session.id,
    sessionName: input.session.name,
    sessionRole: input.session.role,
    toSessionId: message.toSessionId,
    text: excerpt,
    digest: stableDigest(`${input.session.id}:${excerpt}`),
  };
}

export function buildConductorSessionHandoffPrompt(input: {
  project: Project;
  task: Task;
  fromSession: Agent;
  messageText: string;
}) {
  return [
    "[Agent Workspace] Session handoff",
    `Project: ${input.project.path}`,
    `Task: ${input.task.title}`,
    `From session: ${input.fromSession.name} (${input.fromSession.role})`,
    "",
    "A Workspace Session produced a routed handoff. Inspect it and decide whether another session should receive a follow-up dispatch, whether evidence is sufficient, or whether user input is required.",
    "",
    input.messageText.trim(),
  ].join("\n");
}

function buildConductorSessionInitialPrompt(input: {
  project: Project;
  task: Task;
  conductorSession: Agent;
  sessions: Agent[];
  routeMap: Record<string, string[]>;
}) {
  const sessionLines = input.sessions.map((session) => `- ${session.name}: ${session.role}`).join("\n");
  const routeLines = Object.entries(input.routeMap)
    .map(([fromRole, toRoles]) => `- ${fromRole} -> ${toRoles.join(", ")}`)
    .join("\n");
  const defaultTargetName = input.routeMap[input.conductorSession.name]?.[0];
  const defaultTargetSession =
    input.sessions.find((session) => session.name === defaultTargetName) ?? input.sessions[0] ?? input.conductorSession;
  const protocolPrompt = buildWorkspaceSessionProtocolPrompt({
    taskId: input.task.id,
    sessionId: input.conductorSession.id,
    toSessionId: defaultTargetSession.id,
    role: "conductor",
  });

  return [
    `You are the Workspace Session named ${input.conductorSession.name}.`,
    "You coordinate task progress across Workspace Sessions.",
    "You may use provider-native OpenCode or Claude Code agents/subagents/tools inside this current session to support your own reasoning.",
    "Do not use provider-native subagents to represent another Workspace Session. Cross-session work must be emitted as Workspace Session Messages and delivered by the shell router.",
    `Project directory: ${input.project.path}`,
    `Task: ${input.task.title}`,
    `Goal: ${input.task.summary}`,
    "Available Workspace Sessions:",
    sessionLines || "- No worker sessions.",
    "Allowed Workspace Session routes:",
    routeLines || "- No routes.",
    "When you need another session to act, emit a Workspace Session Message with the target session id.",
    "",
    protocolPrompt,
  ].join("\n");
}

function buildWorkerSessionAssignmentPrompt(input: {
  project: Project;
  task: Task;
  session: Agent;
  conductorSession: Agent;
  sessions: Agent[];
  routeMap: Record<string, string[]>;
}) {
  const allowedTargets = input.routeMap[input.session.name] ?? [input.conductorSession.name];
  const defaultTargetName = allowedTargets[0] ?? input.conductorSession.name;
  const defaultTargetSession =
    input.sessions.find((session) => session.name === defaultTargetName) ?? input.conductorSession;
  const protocolPrompt = buildWorkspaceSessionProtocolPrompt({
    taskId: input.task.id,
    sessionId: input.session.id,
    toSessionId: defaultTargetSession.id,
    role: "worker",
  });

  return [
    `You are the Workspace Session named ${input.session.name}.`,
    `Role: ${input.session.role}`,
    `Conductor Session: ${input.conductorSession.name} (${input.conductorSession.role})`,
    `Project directory: ${input.project.path}`,
    `Task: ${input.task.title}`,
    `Goal: ${input.task.summary}`,
    "Provider-native agents/subagents are allowed inside this current session as implementation tools.",
    "If another Workspace Session must act, do not start a provider-native subagent for that role. Emit a Workspace Session Message and let the shell router deliver it.",
    `Allowed target Workspace Session roles from this session: ${allowedTargets.join(", ")}`,
    "Complete your assigned work with durable evidence paths before handoff.",
    "",
    protocolPrompt,
  ].join("\n");
}

function terminalReturnedToPrompt(text: string) {
  return text.includes("Ask anything") || text.includes("tab agents") || text.includes("ctrl+p commands");
}

function stableDigest(text: string) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
```

Create `src/orchestration/session-dispatch/index.ts`:

```ts
export * from "./sessionDispatch";
```

- [x] **Step 4: Keep agent dispatch compatibility wrappers**

Modify `src/orchestration/agent-dispatch/agentDispatch.ts` so exported functions call the new session dispatch functions where possible. Keep old type exports if tests still need them. The wrapper must not reintroduce automatic repair behavior.

- [x] **Step 5: Verify dispatch tests pass**

Run:

```bash
npm test -- src/orchestration/session-dispatch/sessionDispatch.test.ts src/orchestration/agent-dispatch/agentDispatch.test.ts
```

Expected: pass.

---

## Task 4: Inject Workspace Session Rules Into Runtime Sessions

**Files:**
- Modify: `src/runtime/adapters/scopedInjection.ts`
- Modify: `src/runtime/adapters/opencode/injection.test.ts`
- Modify: `src/runtime/adapters/claude-code/injection.test.ts`

- [x] **Step 1: Add failing injection tests**

In `src/runtime/adapters/opencode/injection.test.ts`, add:

```ts
it("injects Workspace Session rules without banning provider-native subagents", () => {
  const injection = buildOpenCodeScopedInjection({
    project,
    task,
    agents,
    agent: agents[1],
  });

  const promptText = injection.files.map((file) => file.contents).join("\n");

  expect(promptText).toContain("Workspace Session");
  expect(promptText).toContain("Provider-native agents/subagents are allowed inside this current session");
  expect(promptText).toContain("do not start a provider-native subagent for that role");
  expect(promptText).toContain("Workspace Session Message");
});
```

In `src/runtime/adapters/claude-code/injection.test.ts`, add the same assertion against `buildClaudeCodeScopedInjection`.

- [x] **Step 2: Run failing injection tests**

Run:

```bash
npm test -- src/runtime/adapters/opencode/injection.test.ts src/runtime/adapters/claude-code/injection.test.ts
```

Expected: fail because current scoped injection still says one project, one task, and one agent, and does not explain provider-native subagent boundaries.

- [x] **Step 3: Update scoped injection prompt text**

Modify `buildWorkspaceSystemPrompt()` in `src/runtime/adapters/scopedInjection.ts` to say:

```ts
"This session was started by Agent Workspace and is scoped to one project, one task, and one Workspace Session.",
"Provider-native agents/subagents/tools are allowed inside the current session as implementation details.",
"If work must be performed by another Workspace Session, do not start a provider-native subagent for that role. Emit a Workspace Session Message and let the shell router deliver it.",
```

Modify `buildAgentRolePrompt()` to include:

```ts
input.agentMode === "primary"
  ? "You coordinate task progress across Workspace Sessions and decide what cross-session dispatch is needed."
  : "You execute your assigned part independently and hand results to the next allowed Workspace Session through the protocol.",
"Provider-native agents/subagents are allowed inside this current session as implementation tools.",
"Cross-session dispatch is owned by the Agent Workspace shell router.",
```

- [x] **Step 4: Verify injection tests pass**

Run:

```bash
npm test -- src/runtime/adapters/opencode/injection.test.ts src/runtime/adapters/claude-code/injection.test.ts
```

Expected: pass.

---

## Task 5: Stop Automatic TUI Repair Writes

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

- [x] **Step 1: Write failing App test for no automatic repair write**

Add a test to `src/App.test.tsx`:

```ts
it("does not write protocol repair prompts into a busy worker TUI", async () => {
  const writePtyInputs: Array<{ id: string; text: string }> = [];
  const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];

  window.agentWorkspace = {
    native: {
      getRuntimeStatus: async () => ({
        available: true,
        mode: "desktop",
        opencodePath: "opencode",
        ptyAvailable: true,
        ptyBackend: "node-pty+process-fallback",
        message: "ready",
      }),
      runOpencode: async (input) => ({
        ok: true,
        command: "opencode",
        cwd: input.cwd,
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      }),
      listOpencodeAgents: async () => ({ ok: true, agents: [] }),
      startPty: async (input) => {
        queueMicrotask(() => {
          ptyEventCallbacks.forEach((callback) =>
            callback({
              type: "data",
              id: input.id ?? "native-session",
              chunk: 'Ask anything... "Describe the next action"\ntab agents ctrl+p commands\n',
              cursor: 2,
            }),
          );
        });
        return {
          id: input.id ?? "native-session",
          command: input.command,
          args: input.args ?? [],
          cwd: input.cwd,
          model: input.model,
          backend: "pty",
          status: "running",
          cols: input.cols ?? 100,
          rows: input.rows ?? 30,
          transcript: [],
          cursor: 1,
        };
      },
      writePty: async (input) => {
        writePtyInputs.push(input);
        if (input.id.endsWith("task-intake-001-researcher")) {
          queueMicrotask(() => {
            ptyEventCallbacks.forEach((callback) =>
              callback({
                type: "data",
                id: input.id,
                chunk: "Research complete without structured message.\nAsk anything...\ntab agents ctrl+p commands\n",
                cursor: 8,
              }),
            );
          });
        }
        return {
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: [],
          cursor: 1,
        };
      },
      onPtyEvent: (callback) => {
        ptyEventCallbacks.push(callback);
        return () => {
          ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
        };
      },
    },
  };

  render(<App />);

  createRuntimeTask({
    title: "Claude Dynamic Workflow 机制调研",
    summary: "调研 Claude Dynamic Workflow 并输出 research/spec/plan 线索。",
    templateId: "research",
    labels: "research, claude",
  });

  await waitFor(() => expect(writePtyInputs.length).toBeGreaterThanOrEqual(3));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(writePtyInputs.some((input) => input.text.includes("[Agent Workspace] Protocol repair"))).toBe(false);
  expect(writePtyInputs.some((input) => input.text.includes("上一段无效输出摘录"))).toBe(false);
});
```

- [x] **Step 2: Run failing App test**

Run:

```bash
npm test -- src/App.test.tsx -t "does not write protocol repair prompts into a busy worker TUI"
```

Expected: fail because the current App writes repair prompts into worker PTYs.

- [x] **Step 3: Remove automatic repair writes**

Modify `src/App.tsx`:

- Remove the import of `buildProtocolRepairPrompt`.
- Remove `repairWorkerProtocolIfNeeded()` from the visible TUI path.
- In `forwardWorkerHandoffIfReady()`, when no handoff is found, do not write to the worker PTY.

The replacement behavior for this task is:

```ts
if (!handoff) {
  return;
}
```

If a missing or malformed structured message needs visibility, leave it for the route failure handling in Task 6 or a later UI state task. Do not write a long repair prompt into OpenCode TUI, and do not paste protocol repair text into a provider-native terminal session.

- [x] **Step 4: Verify no-repair test passes**

Run:

```bash
npm test -- src/App.test.tsx -t "does not write protocol repair prompts into a busy worker TUI"
```

Expected: pass.

---

## Task 6: Route Allowed Session Handoffs And Reject Disallowed Routes

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/orchestration/session-dispatch/sessionDispatch.ts`
- Modify: `src/orchestration/session-dispatch/sessionDispatch.test.ts`

- [x] **Step 1: Add failing dispatch helper tests**

Add these tests to `src/orchestration/session-dispatch/sessionDispatch.test.ts`:

```ts
it("detects a Researcher handoff addressed to Reviewer", () => {
  const handoffBlock = buildWorkspaceSessionMessageBlock({
    protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
    type: "handoff",
    taskId: task.id,
    fromSessionId: sessions[1].id,
    toSessionId: sessions[2].id,
    round: 1,
    status: "done",
    summary: "Evidence collection complete.",
    body: "Evidence lives in docs/research/claude-dynamic-workflow.md.",
    evidenceRefs: ["docs/research/claude-dynamic-workflow.md"],
    nextAction: "Review source quality.",
  });
  const text = [handoffBlock, "Ask anything...", "tab agents ctrl+p commands"].join("\n");

  const handoff = detectSessionHandoff({ session: sessions[1], task, text });

  expect(handoff).toMatchObject({
    sessionId: sessions[1].id,
    toSessionId: sessions[2].id,
    text: handoffBlock,
  });
});

it("detects a Reviewer handoff addressed directly to Researcher so the router can reject it", () => {
  const text = [
    buildWorkspaceSessionMessageBlock({
      protocol: WORKSPACE_SESSION_PROTOCOL_VERSION,
      type: "handoff",
      taskId: task.id,
      fromSessionId: sessions[2].id,
      toSessionId: sessions[1].id,
      round: 1,
      status: "done",
      summary: "Researcher should redo this.",
      body: "This is not an allowed route.",
      evidenceRefs: [],
      nextAction: "Researcher should repeat the search.",
    }),
    "Ask anything...",
    "tab agents ctrl+p commands",
  ].join("\n");

  const handoff = detectSessionHandoff({ session: sessions[2], task, text });
  expect(handoff?.toSessionId).toBe(sessions[1].id);
});
```

Add a prompt builder test for target-session delivery:

```ts
it("builds a compact prompt for the target Workspace Session", () => {
  const prompt = buildSessionRoutePrompt({
    project,
    task,
    fromSession: sessions[1],
    toSession: sessions[2],
    messageText: "<workspace-session-message>{}</workspace-session-message>",
  });

  expect(prompt).toContain("[Agent Workspace] Session route");
  expect(prompt).toContain("From session: Researcher");
  expect(prompt).toContain("To session: Reviewer");
  expect(prompt).toContain("Act on this message only if it is addressed to your Workspace Session");
});
```

- [x] **Step 2: Add failing App tests for allowed and rejected routes**

Add an App test that simulates Researcher returning `toSessionId: reviewer`, then assert the handoff is delivered to the Reviewer PTY and not converted into a Conductor-only summary:

```ts
expect(
  writePtyInputs.some(
    (input) =>
      input.id.endsWith("task-intake-001-reviewer") &&
      input.text.includes("[Agent Workspace] Session route") &&
      input.text.includes("Evidence collection complete"),
  ),
).toBe(true);
expect(
  writePtyInputs.some(
    (input) =>
      input.id.endsWith("task-intake-001-conductor") &&
      input.text.includes("Evidence collection complete") &&
      input.text.includes("route-not-allowed"),
  ),
).toBe(false);
```

Add an App test that simulates Reviewer returning `toSessionId: researcher`, then assert no write is made to the Researcher PTY and a compact diagnostic is written to Conductor instead:

```ts
expect(
  writePtyInputs.some(
    (input) => input.id.endsWith("task-intake-001-researcher") && input.text.includes("Researcher should repeat"),
  ),
).toBe(false);
expect(
  writePtyInputs.some(
    (input) => input.id.endsWith("task-intake-001-conductor") && input.text.includes("route-not-allowed"),
  ),
).toBe(true);
```

- [x] **Step 3: Run failing routing tests**

Run:

```bash
npm test -- src/orchestration/session-dispatch/sessionDispatch.test.ts src/App.test.tsx -t "Session route|route-not-allowed"
```

Expected: fail because App does not route allowed session handoffs to the target session and does not enforce a route policy yet.

- [x] **Step 4: Add target-session prompt builder**

Modify `src/orchestration/session-dispatch/sessionDispatch.ts`:

```ts
export function buildSessionRoutePrompt(input: {
  project: Project;
  task: Task;
  fromSession: Agent;
  toSession: Agent;
  messageText: string;
}) {
  return [
    "[Agent Workspace] Session route",
    `Project: ${input.project.path}`,
    `Task: ${input.task.title}`,
    `From session: ${input.fromSession.name} (${input.fromSession.role})`,
    `To session: ${input.toSession.name} (${input.toSession.role})`,
    "",
    "Act on this message only if it is addressed to your Workspace Session.",
    "Do not treat provider-native subagents as Workspace Session targets.",
    "When finished, emit the next Workspace Session Message according to the task template route policy.",
    "",
    input.messageText.trim(),
  ].join("\n");
}
```

Keep `buildConductorSessionHandoffPrompt()` only for diagnostics sent to Conductor. Do not use it for every valid handoff.

- [x] **Step 5: Add routing policy lookup in App**

Modify `src/App.tsx` where task sessions and template are available:

- Resolve the selected task template from `selectedTask.templateId`.
- If `selectedTask.templateId` is missing because the task predates this migration, fall back to the research template only when the task has a `research` label; otherwise fall back to the first opencode template and record no route rejection.
- Use the selected template `routes`.
- Before forwarding a parsed handoff, call `assertWorkspaceSessionRoute()`.
- If the route is allowed, find the target session from the selected task sessions and write `buildSessionRoutePrompt()` to that target PTY.
- If the target session belongs to the task but no PTY session exists, write a compact diagnostic to Conductor:

```text
[Agent Workspace] Session route pending
reason: target-session-not-running
from: Researcher
to: Reviewer
Action required: start the target Workspace Session or retry dispatch.
```

- If the route is not allowed, write a compact diagnostic only to Conductor:

```text
[Agent Workspace] Session route rejected
reason: route-not-allowed
from: Reviewer
to: Researcher
Action required: Conductor must decide whether Researcher gets another round.
```

Do not write this diagnostic to the rejected target session.

Use a de-duplication key with task id, source session id, target session id, and handoff digest:

```ts
const routeKey = `${selectedTask.id}:${handoff.sessionId}:${handoff.toSessionId}:${handoff.digest}`;
```

This prevents repeated terminal events from sending the same handoff more than once.

- [x] **Step 6: Verify routing tests pass**

Run:

```bash
npm test -- src/orchestration/session-dispatch/sessionDispatch.test.ts src/App.test.tsx -t "Session route|route-not-allowed"
```

Expected: pass.

---

## Task 7: Verify Product Spec And Add Compatibility Names

**Files:**
- Modify: `docs/superworks/spec/product-interaction-map.md`
- Modify: `src/lib/productIntentDocs.test.ts`
- Modify: `src/orchestration/agent-communication/index.ts`
- Modify: `src/orchestration/agent-communication/protocol.ts`
- Modify: `src/orchestration/agent-communication/protocol.test.ts`

- [x] **Step 1: Verify product spec language is already aligned**

Open `docs/superworks/spec/product-interaction-map.md` and verify the `## Workspace Session Communication Layer` section contains these decisions:

- Agent Workspace owns cross-session routing.
- The workbench-managed delivery target is a Workspace Session, not a provider-native agent.
- OpenCode and Claude Code may use provider-native agents, subagents, tools, or modes inside the current session.
- Conductor must not use a provider-native subagent as a substitute for another Workspace Session.
- Research routing is `Conductor -> Researcher -> Reviewer -> Conductor`.
- Reviewer reports gaps to Conductor and does not directly command Researcher.
- The shell must validate task id, sender session id, receiver session id, and route policy before forwarding.
- The shell must not auto-write long repair prompts into busy visible TUI sessions.

If any item is missing, update only the `## Workspace Session Communication Layer` section with:

````markdown
## Workspace Session Communication Layer

Agent Workspace owns cross-session routing. The workbench-managed unit is a Workspace Session, not a provider-native agent. OpenCode and Claude Code may still use their own agents, subagents, tools, or modes inside the current session; those provider-native mechanisms are implementation details and are allowed.

Cross-session work must be routed through Workspace Session Messages. If Conductor needs Researcher to act, Conductor emits a message addressed to the Researcher Workspace Session and the shell router delivers it. Conductor must not use a provider-native subagent inside its own process as a substitute for the Researcher Workspace Session.

Research task routing is template-owned:

```text
Conductor Session -> Researcher Session
Researcher Session -> Reviewer Session
Reviewer Session -> Conductor Session
```

Reviewer reports gaps to Conductor. Reviewer does not directly command Researcher. Conductor decides whether to send Researcher another round.

The shell validates message task id, sender session id, receiver session id, and route policy before forwarding. Invalid or disallowed routes are recorded as routing failures and shown to Conductor; the shell must not auto-write repair prompts into busy visible TUI sessions.
````

- [x] **Step 2: Add or verify durable spec test**

Add or keep this test in `src/lib/productIntentDocs.test.ts`:

```ts
it("records Workspace Session routing as separate from provider-native subagents", async () => {
  const text = await readProductIntentDoc("docs/superworks/spec/product-interaction-map.md");

  expect(text).toContain("## Workspace Session Communication Layer");
  expect(text).toContain("workbench-managed unit is a Workspace Session");
  expect(text).toContain("provider-native mechanisms are implementation details and are allowed");
  expect(text).toContain("Conductor Session -> Researcher Session");
  expect(text).toContain("Researcher Session -> Reviewer Session");
  expect(text).toContain("Reviewer Session -> Conductor Session");
  expect(text).toContain("Reviewer does not directly command Researcher");
  expect(text).toContain("must not auto-write repair prompts into busy visible TUI sessions");
});
```

Run:

```bash
npm test -- src/lib/productIntentDocs.test.ts -t "Workspace Session routing"
```

Expected: pass. If it fails, adjust the spec wording without changing the product decision.

- [x] **Step 3: Add compatibility wrappers**

Modify `src/orchestration/agent-communication/protocol.ts` to re-export or wrap the new session protocol so older imports still work during migration. Keep old names mapped to new semantics:

```ts
import {
  analyzeSessionTranscript,
  buildWorkspaceSessionProtocolPrompt,
  parseWorkspaceSessionMessages,
  type SessionProtocolViolationReason,
  type WorkspaceSessionMessage,
  type WorkspaceSessionMessageType,
} from "../session-communication";

export const AGENT_WORKSPACE_PROTOCOL_VERSION = "agent-workspace/v1";
export const AGENT_WORKSPACE_MESSAGE_TAG = "agent-workspace-message";

export type AgentWorkspaceMessageType = WorkspaceSessionMessageType | "repair";
export type AgentWorkspaceMessage = Omit<
  WorkspaceSessionMessage,
  "protocol" | "type" | "fromSessionId" | "toSessionId"
> & {
  protocol: typeof AGENT_WORKSPACE_PROTOCOL_VERSION;
  type: AgentWorkspaceMessageType;
  fromAgentId: string;
  toAgentId: string;
  fromSessionId?: string;
  toSessionId?: string;
};
export type AgentProtocolViolationReason = SessionProtocolViolationReason;
export type AgentProtocolViolation = {
  reason: AgentProtocolViolationReason;
  agentId: string;
  sessionId: string;
  taskId: string;
  excerpt: string;
};
export type AgentTranscriptAnalysis = {
  messages: AgentWorkspaceMessage[];
  violation?: AgentProtocolViolation;
};

export function parseAgentWorkspaceMessages(text: string) {
  return parseWorkspaceSessionMessages(text).map(toAgentWorkspaceMessage);
}

export function analyzeAgentTranscript(input: {
  expectedAgentId: string;
  expectedTaskId: string;
  text: string;
  terminalReady: boolean;
}): AgentTranscriptAnalysis {
  const analysis = analyzeSessionTranscript({
    expectedSessionId: input.expectedAgentId,
    expectedTaskId: input.expectedTaskId,
    text: input.text,
    terminalReady: input.terminalReady,
  });

  return {
    messages: analysis.messages.map(toAgentWorkspaceMessage),
    violation: analysis.violation
      ? {
          reason: analysis.violation.reason,
          agentId: analysis.violation.sessionId,
          sessionId: analysis.violation.sessionId,
          taskId: analysis.violation.taskId,
          excerpt: analysis.violation.excerpt,
        }
      : undefined,
  };
}

export function buildAgentWorkspaceMessageBlock(message: AgentWorkspaceMessage) {
  return [
    `<${AGENT_WORKSPACE_MESSAGE_TAG}>`,
    JSON.stringify(
      {
        ...message,
        protocol: AGENT_WORKSPACE_PROTOCOL_VERSION,
        fromAgentId: message.fromAgentId ?? message.fromSessionId,
        toAgentId: message.toAgentId ?? message.toSessionId,
      },
      null,
      2,
    ),
    `</${AGENT_WORKSPACE_MESSAGE_TAG}>`,
  ].join("\n");
}

export function buildAgentWorkspaceProtocolPrompt(input: {
  taskId: string;
  agentId: string;
  toAgentId: string;
  role: "conductor" | "worker";
}) {
  return buildWorkspaceSessionProtocolPrompt({
    taskId: input.taskId,
    sessionId: input.agentId,
    toSessionId: input.toAgentId,
    role: input.role,
  });
}

function toAgentWorkspaceMessage(message: WorkspaceSessionMessage): AgentWorkspaceMessage {
  return {
    ...message,
    protocol: AGENT_WORKSPACE_PROTOCOL_VERSION,
    fromAgentId: message.fromSessionId,
    toAgentId: message.toSessionId,
    fromSessionId: message.fromSessionId,
    toSessionId: message.toSessionId,
  };
}
```

Keep `buildProtocolRepairPrompt()` exported because current tests import it, but do not call it from `src/App.tsx`. Mark it as manual/headless-only in code comments and keep the old repair shape for compatibility tests:

```ts
export function buildProtocolRepairPrompt(input: {
  agentId: string;
  taskId: string;
  toAgentId: string;
  invalidExcerpt: string;
}) {
  const example = buildAgentWorkspaceMessageBlock({
    protocol: AGENT_WORKSPACE_PROTOCOL_VERSION,
    type: "handoff",
    taskId: input.taskId,
    fromAgentId: input.agentId,
    toAgentId: input.toAgentId,
    round: 1,
    status: "done",
    summary: "用一句话总结当前阶段结果。",
    body: "写清楚事实、证据、产物路径、未解决问题。",
    evidenceRefs: [],
    nextAction: "写清楚建议 Conductor 下一步怎么处理。",
  });

  return [
    "[Agent Workspace] Protocol repair",
    "Manual/headless only. Visible provider-native TUI sessions must not receive automatic repair paste.",
    "不要继续执行新任务，不要补做额外调研，只把当前结果整理成下面这种结构化消息。",
    "",
    example,
    "",
    "上一段无效输出摘录：",
    input.invalidExcerpt.trim().slice(-1_200),
  ].join("\n");
}
```

- [x] **Step 4: Update compatibility tests**

Update `src/orchestration/agent-communication/protocol.test.ts` so compatibility tests assert the old import path still parses old `fromAgentId/toAgentId` blocks and normalizes to session semantics:

```ts
it("keeps old agent message imports compatible with Workspace Session parsing", () => {
  const block = [
    `<${AGENT_WORKSPACE_MESSAGE_TAG}>`,
    JSON.stringify({
      protocol: "agent-workspace/v1",
      type: "handoff",
      taskId: "task-intake-001",
      fromAgentId: "task-intake-001-researcher",
      toAgentId: "task-intake-001-reviewer",
      round: 1,
      status: "done",
      summary: "Research complete.",
      body: "Evidence path recorded.",
      evidenceRefs: ["docs/research/example.md"],
      nextAction: "Review source quality.",
    }),
    `</${AGENT_WORKSPACE_MESSAGE_TAG}>`,
  ].join("\n");

  expect(parseAgentWorkspaceMessages(block)[0]).toMatchObject({
    fromAgentId: "task-intake-001-researcher",
    toAgentId: "task-intake-001-reviewer",
    fromSessionId: "task-intake-001-researcher",
    toSessionId: "task-intake-001-reviewer",
  });
});

it("adapts old analyzeAgentTranscript parameters to session transcript analysis", () => {
  const analysis = analyzeAgentTranscript({
    expectedAgentId: "task-intake-001-researcher",
    expectedTaskId: "task-intake-001",
    text: "Research complete without a structured block.",
    terminalReady: true,
  });

  expect(analysis.violation).toMatchObject({
    reason: "missing-protocol-message",
    agentId: "task-intake-001-researcher",
    sessionId: "task-intake-001-researcher",
  });
});
```

- [x] **Step 5: Verify compatibility tests pass**

Run:

```bash
npm test -- src/lib/productIntentDocs.test.ts src/orchestration/agent-communication/protocol.test.ts src/orchestration/session-communication/protocol.test.ts
```

Expected: pass.

---

## Task 8: Full Verification

**Files:**
- No code edits unless a verification failure points to a specific defect.

- [x] **Step 1: Run focused orchestration tests**

Run:

```bash
npm test -- src/orchestration/session-communication src/orchestration/session-dispatch src/runtime/opencode/taskTemplates.test.ts
```

Expected: pass.

- [x] **Step 2: Run runtime adapter tests**

Run:

```bash
npm test -- src/runtime/adapters/opencode/injection.test.ts src/runtime/adapters/claude-code/injection.test.ts
```

Expected: pass.

- [x] **Step 3: Run App tests**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected: pass.

- [x] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: pass.

- [x] **Step 5: Build**

Run:

```bash
npm run build
```

Expected: pass.

- [ ] **Step 6: Manual desktop smoke**

Run the app with the existing startup script, create a research task in `/Users/dinker/CODES/TEMP_project/Agent_Test`, and verify:

- Conductor, Researcher, and Reviewer are separate PTY sessions.
- The prompt text says Workspace Session and does not confuse cross-session routing with provider-native subagents.
- Provider-native subagents are not globally banned.
- Researcher can hand off to Reviewer.
- Reviewer handoff goes to Conductor.
- Reviewer cannot dispatch directly to Researcher.
- No `[Agent Workspace] Protocol repair` prompt is written into a worker TUI automatically.
- No repeated `[Pasted ~22 lines]` / `QUEUED` pollution appears from shell repair logic.

Status: automated tests and build have passed; this manual desktop smoke remains the only unchecked verification item.

---

## Self-Review

- Spec coverage: The plan covers naming boundary, provider-native subagent allowance, session routing, research-specific route policy, prompt injection, route validation, removal of automatic repair writes, and product spec updates.
- Placeholder scan: No implementation step depends on an unspecified placeholder. Each code task lists concrete file paths, commands, and expected behavior.
- Type consistency: New names use `WorkspaceSessionMessage`, `fromSessionId`, `toSessionId`, `SessionDispatch`, and compatibility wrappers for existing `Agent` imports.
- Scope check: UI copy migration is intentionally limited to prompt/protocol-visible names. Full visual rename from Agent to Session is not included here because it should be a separate UX copy/layout pass after routing works.
