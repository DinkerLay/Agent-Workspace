# Conductor-Centric Session Communication Implementation Plan

> **Status: Implemented / Deprecated after completion.** This plan is retained as historical execution evidence. Current product truth lives in `docs/superworks/spec/conductor-session-communication.md` and `docs/superworks/spec/product-interaction-map.md`. Later implementation removed the old `src/orchestration/session-communication` route helper and template `routes` field in favor of Conductor worker target allowlists plus provider adapter result extraction.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the worker protocol/message-router implementation with a Conductor-centric tool model where only Conductor receives Agent Workspace MCP tools, worker sessions stay provider-native, and Shell-owned Session Store becomes the source for `read_session`.

**Architecture:** Electron Shell owns PTY lifecycle, transcript recording, status events, session store, and a local tool bridge. The Conductor PTY launches with Agent Workspace MCP tools and task-owner prompt; worker PTYs launch as normal provider-native sessions without Workspace protocol prompts or Agent Workspace MCP tools. Conductor uses `call_session`, `read_session`, `continue_session`, `read_session_events`, `ask_user`, and `finish_task_claim` to drive work.

**Tech Stack:** Vite, React, TypeScript, Electron, node-pty, Node IPC/HTTP bridge, minimal stdio MCP server, Vitest, existing `NativeRuntimeBridge`.

**Implementation correction 2026-06-30:** `read_session` remains Shell Session Store based, but dispatch results must be populated by provider adapters when available. For opencode, Shell reads opencode session `message`/`part` storage to extract the latest effective assistant text answer after a dispatch. Terminal transcript is retained for UI/status/evidence only and must not be treated as the worker's final answer body.

---

## Spec Review

Reviewed sources:

- `docs/superworks/spec/conductor-session-communication.md`
- `docs/superworks/spec/product-interaction-map.md`
- `docs/research/session-communication-mechanisms-2026-06-28.zh.md`
- `docs/superworks/plans/deprecated/session-dispatch-layer.plan.md`

Spec is internally coherent after the latest edits:

- Conductor is the only session with Agent Workspace orchestration tools.
- Worker sessions remain provider-native and are not required to load MCP tools or emit structured handoff messages.
- `read_session` reads Shell-owned Session Store, not provider internals or frontend terminal DOM.
- `call_session` is async and returns a dispatch id, not the worker's final result.
- `call_session` must start or wake the target worker as a provider-native PTY before writing the assignment when that worker is not already running.
- Research template routing is Conductor-mediated: workers do not call each other or report through Agent Workspace tools in the first version.
- Review remains the gate for Done.

Resolved conflict:

- The previous `session-dispatch-layer.plan.md` still described Workspace Session Message routing and worker protocol injection. It has been moved to `docs/superworks/plans/deprecated/session-dispatch-layer.plan.md` and marked superseded.

Current code conflicts that this plan removes:

- `src/runtime/adapters/scopedInjection.ts` injects Workspace Session protocol into every agent.
- `src/runtime/adapters/opencode/injection.ts` generates opencode agent prompts for worker sessions.
- `src/runtime/adapters/claude-code/injection.ts` adds workspace prompt and custom agents to worker sessions.
- `src/orchestration/session-dispatch/sessionDispatch.ts` builds worker assignment prompts and parses structured handoffs.
- `src/orchestration/session-communication/protocol.ts` treats structured terminal messages as the primary protocol.
- `src/App.tsx` auto-dispatches worker prompts and forwards parsed handoffs.
- `src/pages/TaskBoard.tsx` previews system prompts for every session instead of Conductor-only runtime prompt and MCP scope.

## Target File Structure

Create:

- `src/orchestration/conductor-tools/types.ts`
  Shared TypeScript contract for Conductor tools, session store views, dispatch records, and status events.

- `src/orchestration/conductor-tools/conductorPrompt.ts`
  Builds the Conductor task-owner prompt used by opencode and Claude Code.

- `src/runtime/adapters/conductorRuntime.ts`
  Provider-neutral runtime bundle for Conductor-only injection.

- `src/runtime/adapters/opencode/conductorInjection.ts`
  Builds opencode Conductor runtime files/env/MCP config.

- `src/runtime/adapters/claude-code/conductorInjection.ts`
  Builds Claude Code Conductor args/runtime files/MCP config.

- `desktop/session-store.cjs`
  Shell-owned session store for raw transcript, clean transcript, events, state, snapshots, and dispatches.

- `desktop/session-store.test.mjs`
  Tests session store writes, reads, cursors, and clean transcript output.

- `desktop/session-status-monitor.cjs`
  Low-level status classifier for idle, waiting, blocked, timeout, exited.

- `desktop/session-status-monitor.test.mjs`
  Tests status classifier behavior.

- `desktop/conductor-tool-bridge.cjs`
  Local HTTP bridge owned by Electron main. MCP server forwards tool calls here.

- `desktop/conductor-tool-bridge.test.mjs`
  Tests `call_session`, `read_session`, `continue_session`, and event reads against fake PTY manager/session store.

- `desktop/conductor-mcp-server.cjs`
  Minimal stdio MCP server exposing Conductor tools and forwarding calls to the bridge.

- `desktop/conductor-mcp-server.test.mjs`
  Tests MCP `initialize`, `tools/list`, and `tools/call` JSON-RPC behavior.

- `desktop/opencode-conductor-config-smoke.cjs`
  Focused local validation that documents the selected opencode Conductor MCP/config injection path before App runtime relies on it.

Modify:

- `src/types.ts`
  Add native session store and Conductor tool bridge types if shared UI state needs them.

- `src/runtime/nativeBridge.ts`
  Add native APIs for `readSession`, `callSession`, `continueSession`, and `readSessionEvents`.

- `desktop/main.cjs`
  Start the local Conductor tool bridge, pass bridge env into Conductor runtime, register new IPC handlers, and provide the worker session launch callback used by `call_session`.

- `desktop/preload.cjs`
  Expose new native bridge methods.

- `desktop/pty-manager.cjs`
  Write Session Store records and accept task/session metadata when starting PTYs.

- `src/runtime/opencode/taskTemplates.ts`
  Rename `sessionPrompt` intent to Conductor-facing role descriptions and remove worker protocol language.

- `src/App.tsx`
  Remove worker protocol dispatch and handoff parsing. Launch Conductor with Conductor-only injection. Worker sessions start only from explicit user action or Conductor `call_session`.

- `src/pages/TaskBoard.tsx`
  Show Conductor runtime prompt and MCP scope preview only. Worker sessions are shown as provider-native.

- `src/orchestration/session-dispatch/sessionDispatch.ts`
  Remove from App path or replace with compatibility exports that are not used by runtime.

- `src/orchestration/session-communication/protocol.ts`
  Keep only diagnostic parser if still needed by tests; do not use it for primary routing.

- Existing tests under `src/App.test.tsx`, `src/pages/TaskBoard.test.tsx`, `src/runtime/adapters/*`, and `src/runtime/opencode/taskTemplates.test.ts`.

Do not delete `docs/superworks/plans/deprecated/session-dispatch-layer.plan.md`; it is historical evidence.

---

## Task 1: Add Product Intent Guards

**Files:**

- Modify: `src/lib/productIntentDocs.test.ts`

- [x] **Step 1: Add failing spec guard for Conductor-centric communication**

Add this test to `src/lib/productIntentDocs.test.ts` near the existing Workspace Session routing test:

```ts
it("records Conductor-centric session communication as the active direction", async () => {
  const [productSpec, conductorSpec, deprecatedPlan] = await Promise.all([
    readWorkspaceFile("docs/superworks/spec/product-interaction-map.md"),
    readWorkspaceFile("docs/superworks/spec/conductor-session-communication.md"),
    readWorkspaceFile("docs/superworks/plans/deprecated/session-dispatch-layer.plan.md"),
  ]);

  expect(productSpec).toContain("docs/superworks/spec/conductor-session-communication.md");
  expect(productSpec).toContain("only Conductor is modified with Agent Workspace MCP tools");
  expect(productSpec).toContain("worker sessions remain provider-native");
  expect(productSpec).toContain("The previous structured Workspace Session Message block in terminal output is deprecated");

  expect(conductorSpec).toContain("Conductor session is the only session that receives Agent Workspace orchestration tools");
  expect(conductorSpec).toContain("Worker sessions do not get Agent Workspace protocol injection");
  expect(conductorSpec).toContain("call_session");
  expect(conductorSpec).toContain("read_session");

  expect(deprecatedPlan).toContain("Status: Superseded / Deprecated after completion");
});
```

- [x] **Step 2: Run the failing guard test**

Run:

```bash
npm test -- src/lib/productIntentDocs.test.ts -t "Conductor-centric session communication"
```

Expected before implementation if the guard is missing: fail because the test is new.

- [x] **Step 3: Confirm current docs satisfy the guard**

Run the same command after adding the test:

```bash
npm test -- src/lib/productIntentDocs.test.ts -t "Conductor-centric session communication"
```

Expected: pass.

---

## Task 2: Add Conductor Tool Contracts

**Files:**

- Create: `src/orchestration/conductor-tools/types.ts`
- Create: `src/orchestration/conductor-tools/types.test.ts`
- Create: `src/orchestration/conductor-tools/index.ts`

- [x] **Step 1: Write failing contract tests**

Create `src/orchestration/conductor-tools/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createDispatchId,
  normalizeSessionStoreCursor,
  type CallSessionInput,
  type ReadSessionResult,
} from "./types";

describe("Conductor tool contracts", () => {
  it("creates stable dispatch ids from task and target session", () => {
    expect(createDispatchId("task-1", "task-1-researcher", 1)).toBe("dispatch-task-1-task-1-researcher-1");
  });

  it("normalizes invalid read cursors to zero", () => {
    expect(normalizeSessionStoreCursor(undefined)).toBe(0);
    expect(normalizeSessionStoreCursor(-1)).toBe(0);
    expect(normalizeSessionStoreCursor(3.8)).toBe(3);
  });

  it("expresses async call_session input and read_session output shapes", () => {
    const input: CallSessionInput = {
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research dynamic workflow behavior.",
      contextRefs: ["docs/research/session-communication-mechanisms-2026-06-28.zh.md"],
      expectedOutput: "Research report",
      priority: "normal",
    };
    const result: ReadSessionResult = {
      sessionId: "task-1-researcher",
      state: "idle",
      cursor: 2,
      cleanTranscriptTail: "done",
      events: [],
      dispatches: [],
      permissions: [],
      artifacts: [],
      snapshotRef: ".agent-workspace/runtime/task-1/sessions/task-1-researcher/snapshots/latest.txt",
    };

    expect(input.priority).toBe("normal");
    expect(result.state).toBe("idle");
  });
});
```

- [x] **Step 2: Run the failing contract tests**

Run:

```bash
npm test -- src/orchestration/conductor-tools/types.test.ts
```

Expected: fail because `types.ts` does not exist.

- [x] **Step 3: Implement contracts**

Create `src/orchestration/conductor-tools/types.ts`:

```ts
export type SessionStoreState = "running" | "idle" | "waiting" | "blocked" | "timeout" | "exited";

export type SessionEventType =
  | "session.started"
  | "session.output"
  | "session.idle"
  | "session.waiting"
  | "session.blocked"
  | "session.timeout"
  | "session.exited"
  | "dispatch.created"
  | "dispatch.delivered"
  | "permission.requested"
  | "permission.resolved";

export type SessionStoreEvent = {
  id: string;
  taskId: string;
  sessionId: string;
  type: SessionEventType;
  createdAt: string;
  cursor: number;
  summary: string;
  data?: Record<string, unknown>;
};

export type SessionDispatchRecord = {
  dispatchId: string;
  taskId: string;
  toSessionId: string;
  assignment: string;
  contextRefs: string[];
  expectedOutput: string;
  priority: "low" | "normal" | "high";
  status: "queued" | "delivered" | "failed";
  createdAt: string;
  deliveredAt?: string;
};

export type CallSessionInput = {
  taskId: string;
  toSessionId: string;
  assignment: string;
  contextRefs?: string[];
  expectedOutput?: string;
  priority?: "low" | "normal" | "high";
};

export type CallSessionResult = {
  dispatchId: string;
  status: "queued" | "delivered" | "failed";
  error?: string;
};

export type ReadSessionInput = {
  taskId: string;
  sessionId: string;
  sinceCursor?: number;
  maxChars?: number;
};

export type ReadSessionResult = {
  sessionId: string;
  state: SessionStoreState;
  cursor: number;
  cleanTranscriptTail: string;
  events: SessionStoreEvent[];
  dispatches: SessionDispatchRecord[];
  permissions: unknown[];
  artifacts: unknown[];
  snapshotRef?: string;
};

export type ContinueSessionInput = {
  taskId: string;
  sessionId: string;
  message: string;
};

export type ReadSessionEventsInput = {
  taskId: string;
  sessionId?: string;
  sinceCursor?: number;
};

export type AskUserInput = {
  taskId: string;
  question: string;
  reason: string;
  options?: string[];
};

export type FinishTaskClaimInput = {
  taskId: string;
  summary: string;
  evidenceRefs: string[];
  nextRecommendedTask?: string;
};

export function normalizeSessionStoreCursor(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

export function createDispatchId(taskId: string, toSessionId: string, round: number) {
  return `dispatch-${safeId(taskId)}-${safeId(toSessionId)}-${Math.max(1, Math.floor(round))}`;
}

function safeId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
}
```

Create `src/orchestration/conductor-tools/index.ts`:

```ts
export * from "./types";
```

- [x] **Step 4: Run contract tests**

Run:

```bash
npm test -- src/orchestration/conductor-tools/types.test.ts
```

Expected: pass.

---

## Task 3: Add Shell Session Store

**Files:**

- Create: `desktop/session-store.cjs`
- Create: `desktop/session-store.test.mjs`
- Modify: `desktop/pty-manager.cjs`
- Modify: `desktop/pty-manager.test.mjs`

- [x] **Step 1: Write failing Session Store tests**

Create `desktop/session-store.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore } from "./session-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toContain(expected) {
      assert.ok(actual.includes(expected));
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("Shell Session Store", () => {
  it("records raw transcript, clean transcript, events, snapshots, and state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode/deepseek-v4-flash-free",
    };

    store.startSession(session);
    store.recordOutput(session, "\u001b[31mhello\u001b[0m\n");
    store.recordState(session, "idle", "Prompt visible and output quiet.");

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher", sinceCursor: 0, maxChars: 1000 });

    expect(view.state).toBe("idle");
    expect(view.cleanTranscriptTail).toContain("hello");
    expect(view.cleanTranscriptTail.includes("\u001b[31m")).toBe(false);
    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.output", "session.idle"]);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "transcript.raw.log"))).toBe(true);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "snapshots", "latest.txt"))).toBe(true);
  });

  it("records dispatches without waiting for worker completion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-store-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research output.",
      contextRefs: ["docs/research/result.md"],
      expectedOutput: "Review notes",
      priority: "normal",
    });

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });

    expect(dispatch.status).toBe("queued");
    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      toSessionId: "task-1-reviewer",
      status: "queued",
    });
  });

  it("mirrors session events into a task-level event index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-task-events-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode/deepseek-v4-flash-free",
    };

    store.startSession(session);
    store.recordState(session, "idle", "Prompt visible.");

    const events = store.readEvents({ taskId: "task-1", sinceCursor: 0 });

    expect(events.map((event) => event.type)).toEqual(["session.started", "session.idle"]);
  });
});
```

- [x] **Step 2: Run failing Session Store tests**

Run:

```bash
npm test -- desktop/session-store.test.mjs
```

Expected: fail because `desktop/session-store.cjs` does not exist.

- [x] **Step 3: Implement Session Store**

Create `desktop/session-store.cjs`:

```js
const fs = require("node:fs");
const path = require("node:path");

function createSessionStore({ root }) {
  const dispatchCounts = new Map();

  function startSession(session) {
    ensureSessionDir(session);
    appendEvent(session, "session.started", undefined, `Started ${session.command}`);
    writeState(session, {
      state: "running",
      command: session.command,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordOutput(session, chunk) {
    const dir = ensureSessionDir(session);
    fs.appendFileSync(path.join(dir, "transcript.raw.log"), chunk);
    fs.appendFileSync(path.join(dir, "transcript.clean.log"), stripTerminalControls(chunk));
    const cursor = appendEvent(session, "session.output", undefined, "PTY output received");
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshots", "latest.txt"), readTail(path.join(dir, "transcript.clean.log"), 20_000));
    writeState(session, {
      state: "running",
      lastOutputAt: new Date().toISOString(),
      cursor,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordState(session, state, summary, data = {}) {
    const cursor = appendEvent(session, `session.${state}`, undefined, summary, data);
    writeState(session, {
      state,
      cursor,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordDispatch(input) {
    const key = `${input.taskId}:${input.toSessionId}`;
    const next = (dispatchCounts.get(key) ?? 0) + 1;
    dispatchCounts.set(key, next);
    const dispatchId = `dispatch-${safeSegment(input.taskId)}-${safeSegment(input.toSessionId)}-${next}`;
    const record = {
      dispatchId,
      taskId: input.taskId,
      toSessionId: input.toSessionId,
      assignment: input.assignment,
      contextRefs: input.contextRefs ?? [],
      expectedOutput: input.expectedOutput ?? "",
      priority: input.priority ?? "normal",
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    const session = { taskId: input.taskId, sessionId: input.toSessionId };
    ensureSessionDir(session);
    appendJsonLine(pathFor(session, "dispatches.jsonl"), record);
    appendEvent(session, "dispatch.created", undefined, `Dispatch ${dispatchId} created`, { dispatchId });
    return record;
  }

  function markDispatchDelivered(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    appendEvent(session, "dispatch.delivered", undefined, `Dispatch ${input.dispatchId} delivered`, {
      dispatchId: input.dispatchId,
    });
  }

  function readSession(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dir = ensureSessionDir(session);
    const state = readJson(path.join(dir, "state.json")) ?? { state: "idle", cursor: 0 };
    const events = readJsonLines(path.join(dir, "events.jsonl")).filter(
      (event) => event.cursor > Number(input.sinceCursor ?? 0),
    );
    return {
      sessionId: input.sessionId,
      state: state.state ?? "idle",
      cursor: state.cursor ?? events.at(-1)?.cursor ?? 0,
      cleanTranscriptTail: readTail(path.join(dir, "transcript.clean.log"), input.maxChars ?? 12_000),
      events,
      dispatches: readJsonLines(path.join(dir, "dispatches.jsonl")),
      permissions: readJsonLines(path.join(dir, "permissions.jsonl")),
      artifacts: readJsonLines(path.join(dir, "artifacts.jsonl")),
      snapshotRef: path.join(dir, "snapshots", "latest.txt"),
    };
  }

  function appendEvent(session, type, cursor, summary, data = {}) {
    const taskEventsPath = path.join(root, safeSegment(session.taskId), "events.jsonl");
    fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
    if (!fs.existsSync(taskEventsPath)) fs.writeFileSync(taskEventsPath, "");

    const taskEvents = readJsonLines(taskEventsPath);
    const nextCursor = Number.isFinite(cursor) ? cursor : taskEvents.length + 1;
    const event = {
      id: `event-${nextCursor}`,
      taskId: session.taskId,
      sessionId: session.sessionId,
      type,
      createdAt: new Date().toISOString(),
      cursor: nextCursor,
      summary,
      data,
    };
    appendJsonLine(pathFor(session, "events.jsonl"), event);
    appendJsonLine(taskEventsPath, event);
    return nextCursor;
  }

  function readEvents(input) {
    const events = readJsonLines(path.join(root, safeSegment(input.taskId), "events.jsonl"));
    return events.filter((event) => event.cursor > Number(input.sinceCursor ?? 0));
  }

  function writeState(session, patch) {
    const file = pathFor(session, "state.json");
    const current = readJson(file) ?? {};
    fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  }

  function ensureSessionDir(session) {
    const dir = path.join(root, safeSegment(session.taskId), "sessions", safeSegment(session.sessionId));
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ["transcript.raw.log", "transcript.clean.log", "events.jsonl", "dispatches.jsonl", "permissions.jsonl", "artifacts.jsonl"]) {
      const target = path.join(dir, file);
      if (!fs.existsSync(target)) fs.writeFileSync(target, "");
    }
    if (!fs.existsSync(path.join(dir, "state.json"))) fs.writeFileSync(path.join(dir, "state.json"), "{}\n");
    return dir;
  }

  function pathFor(session, file) {
    return path.join(ensureSessionDir(session), file);
  }

  return {
    startSession,
    recordOutput,
    recordState,
    recordDispatch,
    markDispatchDelivered,
    readSession,
    readEvents,
  };
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readTail(file, maxChars) {
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  return text.slice(-maxChars);
}

function stripTerminalControls(text) {
  return String(text)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "\n");
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
}

module.exports = { createSessionStore, stripTerminalControls };
```

- [x] **Step 4: Wire PTY manager to Session Store**

Modify `desktop/pty-manager.cjs`:

- Accept optional `sessionStore` in `createPtyManager({ pty, spawn, sessionStoreRoot, sessionStore })`.
- In `start(input)`, after creating the session, call:

```js
sessionStore?.startSession({
  taskId: input.taskId ?? "unscoped-task",
  sessionId: input.id,
  command: input.command,
  cwd: input.cwd,
  provider: input.provider ?? "opencode",
  model: input.model,
});
```

- In `recordTranscriptChunk`, call:

```js
session.sessionStore?.recordOutput(
  {
    taskId: session.taskId ?? "unscoped-task",
    sessionId: session.id,
  },
  text,
);
```

- In `emitExitEvent`, call:

```js
session.sessionStore?.recordState(
  {
    taskId: session.taskId ?? "unscoped-task",
    sessionId: session.id,
  },
  "exited",
  "PTY process exited",
);
```

- Include `taskId`, `provider`, and `sessionStore` in the internal session object.

- [x] **Step 5: Extend PTY manager tests**

Add this test to `desktop/pty-manager.test.mjs`:

```js
it("writes Shell Session Store records for PTY output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-store-"));
  const fake = createFakePty();
  const { createSessionStore } = require("./session-store.cjs");
  const sessionStore = createSessionStore({ root: tempDir });
  const manager = createPtyManager({ pty: fake.pty, sessionStore });

  const session = manager.start({
    id: "task-1-researcher",
    taskId: "task-1",
    command: "opencode",
    cwd: tempDir,
    model: "opencode/deepseek-v4-flash-free",
  });
  fake.emitData("research output\n");

  const view = sessionStore.readSession({ taskId: "task-1", sessionId: session.id });

  expect(view.cleanTranscriptTail).toContain("research output");
  expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.output"]);
});
```

- [x] **Step 6: Run Session Store tests**

Run:

```bash
npm test -- desktop/session-store.test.mjs desktop/pty-manager.test.mjs
```

Expected: pass.

---

## Task 4: Add Status Monitor

**Files:**

- Create: `desktop/session-status-monitor.cjs`
- Create: `desktop/session-status-monitor.test.mjs`
- Modify: `desktop/pty-manager.cjs`

- [x] **Step 1: Write failing status monitor tests**

Create `desktop/session-status-monitor.test.mjs`:

```js
import assert from "node:assert/strict";
import { classifySessionStatus } from "./session-status-monitor.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("session status monitor", () => {
  it("detects idle opencode prompt", () => {
    const result = classifySessionStatus({
      processAlive: true,
      cleanText: 'Ask anything... "Fix a TODO in the codebase"\ntab agents ctrl+p commands',
      lastOutputAgeMs: 3000,
      idleThresholdMs: 1500,
    });

    expect(result).toMatchObject({ state: "idle" });
  });

  it("detects waiting choice or permission prompts", () => {
    const result = classifySessionStatus({
      processAlive: true,
      cleanText: "Do you want to continue? yes / no",
      lastOutputAgeMs: 200,
      idleThresholdMs: 1500,
    });

    expect(result.state).toBe("waiting");
  });

  it("detects timeout only when process is alive and no output arrives", () => {
    const result = classifySessionStatus({
      processAlive: true,
      cleanText: "Working...",
      lastOutputAgeMs: 660000,
      idleThresholdMs: 1500,
      timeoutMs: 600000,
    });

    expect(result.state).toBe("timeout");
  });

  it("detects exited process", () => {
    expect(
      classifySessionStatus({
        processAlive: false,
        cleanText: "",
        lastOutputAgeMs: 0,
        idleThresholdMs: 1500,
      }).state,
    ).toBe("exited");
  });
});
```

- [x] **Step 2: Run failing status monitor tests**

Run:

```bash
npm test -- desktop/session-status-monitor.test.mjs
```

Expected: fail because implementation does not exist.

- [x] **Step 3: Implement status classifier**

Create `desktop/session-status-monitor.cjs`:

```js
function classifySessionStatus(input) {
  if (!input.processAlive) {
    return { state: "exited", summary: "Process exited." };
  }

  const text = String(input.cleanText ?? "");
  const lower = text.toLowerCase();
  const lastOutputAgeMs = Number(input.lastOutputAgeMs ?? 0);
  const idleThresholdMs = Number(input.idleThresholdMs ?? 1500);
  const timeoutMs = Number(input.timeoutMs ?? 600000);

  if (/permission|approve|deny|continue\?|yes \/ no|do you want to continue|waiting for user/i.test(text)) {
    return { state: "waiting", summary: "Session appears to be waiting for input." };
  }

  if (/error:|failed|permission denied|command not found|no handler registered/i.test(text)) {
    return { state: "blocked", summary: "Session output contains an error or blocked state." };
  }

  if (lastOutputAgeMs >= timeoutMs) {
    return { state: "timeout", summary: "Session exceeded output inactivity timeout." };
  }

  if (
    lastOutputAgeMs >= idleThresholdMs &&
    (lower.includes("ask anything") || lower.includes("tab agents") || lower.includes("ctrl+p commands"))
  ) {
    return { state: "idle", summary: "Provider prompt is visible and output is quiet." };
  }

  return { state: "running", summary: "Session is still running or output has not stabilized." };
}

module.exports = { classifySessionStatus };
```

- [x] **Step 4: Record status events from PTY manager**

Modify `desktop/pty-manager.cjs` to:

- import `classifySessionStatus`,
- update `session.lastOutputAt` in `recordTranscriptChunk`,
- expose a `sampleStatus(id)` function on the manager,
- use Session Store `recordState` when `sampleStatus` detects a state different from the last stored state.

The returned manager shape becomes:

```js
return { start, get, read, write, resize, stop, onEvent, sampleStatus };
```

- [x] **Step 5: Run status monitor tests**

Run:

```bash
npm test -- desktop/session-status-monitor.test.mjs desktop/pty-manager.test.mjs
```

Expected: pass.

---

## Task 5: Add Native Bridge APIs For Session Tools

**Files:**

- Modify: `src/runtime/nativeBridge.ts`
- Modify: `desktop/main.cjs`
- Modify: `src/runtime/opencode/taskTemplates.ts`
- Modify: `src/orchestration/session-communication/routingPolicy.ts`
- Modify: `desktop/preload.cjs`
- Modify: `src/App.test.tsx`

- [x] **Step 1: Add failing native bridge type test through App test harness**

Add a test in `src/App.test.tsx` that stubs native methods and asserts they are callable from `window.agentWorkspace.native`:

```ts
it("exposes Conductor session tool bridge methods", async () => {
  window.agentWorkspace = {
    native: {
      ...createUnavailableNativeBridge(),
      callSession: async () => ({ dispatchId: "dispatch-task-1-researcher-1", status: "queued" }),
      readSession: async () => ({
        sessionId: "task-1-researcher",
        state: "idle",
        cursor: 1,
        cleanTranscriptTail: "research done",
        events: [],
        dispatches: [],
        permissions: [],
        artifacts: [],
      }),
      continueSession: async () => ({ ok: true }),
      readSessionEvents: async () => ({ events: [] }),
    },
  };

  await expect(window.agentWorkspace.native.callSession?.({
    taskId: "task-1",
    toSessionId: "task-1-researcher",
    assignment: "research",
  })).resolves.toMatchObject({ status: "queued" });
});
```

If `createUnavailableNativeBridge` does not exist in the test file, define a local helper returning the existing required native bridge stubs used by nearby tests.

- [x] **Step 2: Extend `NativeRuntimeBridge` types**

In `src/runtime/nativeBridge.ts`, import or mirror the conductor tool types and add:

```ts
callSession?(input: CallSessionInput): Promise<CallSessionResult>;
readSession?(input: ReadSessionInput): Promise<ReadSessionResult>;
continueSession?(input: ContinueSessionInput): Promise<{ ok: boolean; error?: string }>;
readSessionEvents?(input: ReadSessionEventsInput): Promise<{ events: SessionStoreEvent[] }>;
```

Also export wrapper functions:

```ts
export async function callNativeSession(input: CallSessionInput) {
  return window.agentWorkspace?.native.callSession?.(input) ?? {
    dispatchId: "",
    status: "failed" as const,
  };
}

export async function readNativeSession(input: ReadSessionInput) {
  return window.agentWorkspace?.native.readSession?.(input);
}

export async function continueNativeSession(input: ContinueSessionInput) {
  return window.agentWorkspace?.native.continueSession?.(input) ?? { ok: false, error: browserRuntimeStatus.message };
}
```

- [x] **Step 3: Add IPC handlers**

In `desktop/preload.cjs`, expose:

```js
callSession: (input) => ipcRenderer.invoke("native:call-session", input),
readSession: (input) => ipcRenderer.invoke("native:read-session", input),
continueSession: (input) => ipcRenderer.invoke("native:continue-session", input),
readSessionEvents: (input) => ipcRenderer.invoke("native:read-session-events", input),
```

In `desktop/main.cjs`, register handlers that call the tool bridge implementation created in Task 6. Until Task 6 is complete, return safe failure objects:

```js
ipcMain.handle("native:call-session", () => ({ dispatchId: "", status: "failed" }));
ipcMain.handle("native:read-session", () => undefined);
ipcMain.handle("native:continue-session", () => ({ ok: false, error: "Conductor tool bridge is not initialized." }));
ipcMain.handle("native:read-session-events", () => ({ events: [] }));
```

- [x] **Step 4: Run bridge typing tests**

Run:

```bash
npm test -- src/App.test.tsx -t "Conductor session tool bridge methods"
npm run build
```

Expected: pass.

---

## Task 6: Add Local Conductor Tool Bridge

**Files:**

- Create: `desktop/conductor-tool-bridge.cjs`
- Create: `desktop/conductor-tool-bridge.test.mjs`
- Modify: `desktop/main.cjs`

- [x] **Step 1: Write failing tool bridge tests**

Create `desktop/conductor-tool-bridge.test.mjs`:

```js
import assert from "node:assert/strict";
import { createConductorToolBridge } from "./conductor-tool-bridge.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toContain(expected) {
      assert.ok(actual.includes(expected));
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("Conductor tool bridge", () => {
  it("queues call_session and writes a normal assignment to the target PTY", async () => {
    const writes = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "dispatch-task-1-task-1-researcher-1",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: input.contextRefs ?? [],
          expectedOutput: input.expectedOutput ?? "",
          priority: input.priority ?? "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
      readSession() {
        return { sessionId: "task-1-researcher", state: "idle", cursor: 1, cleanTranscriptTail: "", events: [], dispatches: [], permissions: [], artifacts: [] };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", status: "running" }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research dynamic workflow.",
      expectedOutput: "Research note",
    });

    expect(result).toMatchObject({ dispatchId: "dispatch-task-1-task-1-researcher-1", status: "delivered" });
    expect(writes[0].id).toBe("task-1-researcher");
    expect(writes[0].text).toContain("Research dynamic workflow.");
    expect(writes[0].text).not.toContain("Workspace Session Message");
  });

  it("starts a provider-native worker before writing when the target PTY is not running", async () => {
    const writes = [];
    const starts = [];
    const sessions = new Map();
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "dispatch-task-1-task-1-reviewer-1",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: input.contextRefs ?? [],
          expectedOutput: input.expectedOutput ?? "",
          priority: input.priority ?? "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
      readSession() {
        return { sessionId: "task-1-reviewer", state: "idle", cursor: 1, cleanTranscriptTail: "", events: [], dispatches: [], permissions: [], artifacts: [] };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: (id) => sessions.get(id),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      startWorkerSession: async (input) => {
        starts.push(input);
        const session = { id: input.sessionId, status: "running" };
        sessions.set(input.sessionId, session);
        return session;
      },
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research note.",
      expectedOutput: "Review gaps",
    });

    expect(result).toMatchObject({ dispatchId: "dispatch-task-1-task-1-reviewer-1", status: "delivered" });
    expect(starts[0]).toMatchObject({ taskId: "task-1", sessionId: "task-1-reviewer" });
    expect(writes[0].text).toContain("Review the research note.");
    expect(writes[0].text).not.toContain("Workspace Session Message");
  });

  it("reads session data from Shell Session Store", async () => {
    const bridge = createConductorToolBridge({
      sessionStore: {
        readSession: () => ({
          sessionId: "task-1-researcher",
          state: "idle",
          cursor: 2,
          cleanTranscriptTail: "research done",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        }),
      },
      ptyManager: {},
    });

    await expect(bridge.readSession({ taskId: "task-1", sessionId: "task-1-researcher" })).resolves.toMatchObject({
      state: "idle",
      cleanTranscriptTail: "research done",
    });
  });

  it("rejects dispatch targets outside the Conductor route policy", async () => {
    const writes = [];
    const bridge = createConductorToolBridge({
      sessionStore: {
        recordDispatchFailure() {},
      },
      ptyManager: {
        get: () => ({ id: "task-1-reviewer", status: "running" }),
        write: (id, text) => writes.push({ id, text }),
      },
      validateDispatch: () => ({ ok: false, reason: "route-not-allowed" }),
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Bypass the route policy.",
    });

    expect(result).toMatchObject({ dispatchId: "", status: "failed", error: "route-not-allowed" });
    expect(writes.length).toBe(0);
  });
});
```

- [x] **Step 2: Run failing bridge tests**

Run:

```bash
npm test -- desktop/conductor-tool-bridge.test.mjs
```

Expected: fail because implementation does not exist.

- [x] **Step 3: Implement bridge**

Create `desktop/conductor-tool-bridge.cjs`:

```js
function createConductorToolBridge({ sessionStore, ptyManager, startWorkerSession, validateDispatch }) {
  async function callSession(input) {
    const validation = validateDispatch?.({
      taskId: String(input.taskId),
      toSessionId: String(input.toSessionId),
    }) ?? { ok: true };
    if (!validation.ok) {
      sessionStore.recordDispatchFailure?.({
        taskId: String(input.taskId),
        toSessionId: String(input.toSessionId),
        assignment: String(input.assignment),
        reason: validation.reason,
      });
      return { dispatchId: "", status: "failed", error: validation.reason };
    }

    const dispatch = sessionStore.recordDispatch({
      taskId: String(input.taskId),
      toSessionId: String(input.toSessionId),
      assignment: String(input.assignment),
      contextRefs: Array.isArray(input.contextRefs) ? input.contextRefs.map(String) : [],
      expectedOutput: input.expectedOutput ? String(input.expectedOutput) : "",
      priority: input.priority === "high" || input.priority === "low" ? input.priority : "normal",
    });

    let target = ptyManager.get?.(dispatch.toSessionId);
    if (!target || target.status !== "running") {
      target = await startWorkerSession?.({
        taskId: dispatch.taskId,
        sessionId: dispatch.toSessionId,
      });
    }

    if (!target || target.status !== "running") {
      return { dispatchId: dispatch.dispatchId, status: "queued" };
    }

    const text = formatWorkerAssignment(dispatch);
    ptyManager.write(dispatch.toSessionId, text);
    sessionStore.markDispatchDelivered?.({
      taskId: dispatch.taskId,
      sessionId: dispatch.toSessionId,
      dispatchId: dispatch.dispatchId,
    });
    return { dispatchId: dispatch.dispatchId, status: "delivered" };
  }

  async function readSession(input) {
    return sessionStore.readSession({
      taskId: String(input.taskId),
      sessionId: String(input.sessionId),
      sinceCursor: Number(input.sinceCursor ?? 0),
      maxChars: Number(input.maxChars ?? 12_000),
    });
  }

  async function continueSession(input) {
    const session = ptyManager.get?.(String(input.sessionId));
    if (!session || session.status !== "running") {
      return { ok: false, error: "Target session is not running." };
    }
    ptyManager.write(String(input.sessionId), `${String(input.message).trim()}\n`);
    return { ok: true };
  }

  async function readSessionEvents(input) {
    if (input.sessionId) {
      const view = sessionStore.readSession({
        taskId: String(input.taskId),
        sessionId: String(input.sessionId),
        sinceCursor: Number(input.sinceCursor ?? 0),
        maxChars: 0,
      });
      return { events: view.events ?? [] };
    }

    return {
      events: sessionStore.readEvents({
        taskId: String(input.taskId),
        sinceCursor: Number(input.sinceCursor ?? 0),
      }),
    };
  }

  async function askUser(input) {
    return {
      requestId: `ask-${Date.now()}`,
      status: "queued",
      question: String(input.question ?? ""),
      reason: String(input.reason ?? ""),
    };
  }

  async function finishTaskClaim(input) {
    return {
      reviewId: `review-${String(input.taskId)}-${Date.now()}`,
      status: "pending_review",
      summary: String(input.summary ?? ""),
      evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String) : [],
    };
  }

  return {
    callSession,
    readSession,
    continueSession,
    readSessionEvents,
    askUser,
    finishTaskClaim,
  };
}

function formatWorkerAssignment(dispatch) {
  return [
    `[Agent Workspace] Assignment ${dispatch.dispatchId}`,
    "",
    dispatch.assignment,
    "",
    dispatch.expectedOutput ? `Expected output: ${dispatch.expectedOutput}` : "",
    dispatch.contextRefs.length > 0 ? `Context refs: ${dispatch.contextRefs.join(", ")}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

module.exports = { createConductorToolBridge, formatWorkerAssignment };
```

- [x] **Step 4: Wire bridge into Electron main**

In `desktop/main.cjs`:

- import `createSessionStore` and `createConductorToolBridge`,
- create `sessionStore` rooted at `.agent-workspace/runtime`,
- pass `sessionStore` into `createPtyManager`,
- create `conductorToolBridge`,
- pass a `validateDispatch` callback that loads the task template route policy and allows only Conductor-to-worker targets defined by the selected task template,
- pass a `startWorkerSession` callback that resolves the worker launch profile from the selected task/session group and starts a provider-native PTY with no Agent Workspace MCP env or protocol runtime files,
- update IPC handlers from Task 5 to call bridge methods.

Use:

```js
const { createSessionStore } = require("./session-store.cjs");
const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");

const sessionStoreRoot = ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime");
const sessionStore = createSessionStore({ root: sessionStoreRoot({ cwd: process.cwd() }) });
```

If project-specific roots are required, Task 3 Session Store still stores by `taskId`, so the first version can use the selected PTY cwd root when starting sessions.

- [x] **Step 5: Run bridge tests**

Run:

```bash
npm test -- desktop/conductor-tool-bridge.test.mjs desktop/pty-manager.test.mjs
```

Expected: pass.

---

## Task 7: Add Minimal Conductor MCP Server

**Files:**

- Create: `desktop/conductor-mcp-server.cjs`
- Create: `desktop/conductor-mcp-server.test.mjs`

- [x] **Step 1: Write failing MCP server tests**

Create `desktop/conductor-mcp-server.test.mjs`:

```js
import assert from "node:assert/strict";
import { handleMcpMessage } from "./conductor-mcp-server.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("Conductor MCP server", () => {
  it("lists Conductor tools", async () => {
    const result = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }, {
      callTool: async () => ({}),
    });

    expect(result.id).toBe(1);
    expect(result.result.tools.map((tool) => tool.name)).toEqual([
      "call_session",
      "read_session",
      "continue_session",
      "read_session_events",
      "ask_user",
      "finish_task_claim",
    ]);
  });

  it("forwards tools/call to the bridge client", async () => {
    const result = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "call_session",
        arguments: {
          taskId: "task-1",
          toSessionId: "task-1-researcher",
          assignment: "research",
        },
      },
    }, {
      callTool: async (name, args) => ({ name, args, status: "queued" }),
    });

    expect(result.result.content[0].text).toContain('"status":"queued"');
  });

  it("does not respond to MCP notifications without ids", async () => {
    const result = await handleMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, {
      callTool: async () => ({}),
    });

    expect(result).toBe(undefined);
  });
});
```

- [x] **Step 2: Run failing MCP server tests**

Run:

```bash
npm test -- desktop/conductor-mcp-server.test.mjs
```

Expected: fail because implementation does not exist.

- [x] **Step 3: Implement minimal MCP server**

Create `desktop/conductor-mcp-server.cjs`:

```js
const readline = require("node:readline");

const tools = [
  {
    name: "call_session",
    description: "Asynchronously send an assignment to a provider-native worker session.",
    inputSchema: objectSchema(["taskId", "toSessionId", "assignment"]),
  },
  {
    name: "read_session",
    description: "Read Shell-owned transcript, events, and state for a session.",
    inputSchema: objectSchema(["taskId", "sessionId"]),
  },
  {
    name: "continue_session",
    description: "Send a follow-up message to a worker session.",
    inputSchema: objectSchema(["taskId", "sessionId", "message"]),
  },
  {
    name: "read_session_events",
    description: "Read Shell-owned session status events.",
    inputSchema: objectSchema(["taskId"]),
  },
  {
    name: "ask_user",
    description: "Ask the human user for a decision.",
    inputSchema: objectSchema(["taskId", "question", "reason"]),
  },
  {
    name: "finish_task_claim",
    description: "Create a review-ready finish claim. This does not mark Done.",
    inputSchema: objectSchema(["taskId", "summary", "evidenceRefs"]),
  },
];

async function handleMcpMessage(message, bridgeClient = createBridgeClientFromEnv()) {
  if (message.id === undefined || message.id === null) {
    return undefined;
  }

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-workspace-conductor", version: "0.1.0" },
      },
    };
  }

  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools } };
  }

  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = message.params?.arguments ?? {};
    const result = await bridgeClient.callTool(name, args);
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unsupported method ${message.method}` },
  };
}

function createBridgeClientFromEnv() {
  const url = process.env.AGENT_WORKSPACE_TOOL_BRIDGE_URL;
  const token = process.env.AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN;
  return {
    async callTool(name, args) {
      if (!url || !token) throw new Error("Agent Workspace tool bridge env is missing.");
      const response = await fetch(`${url}/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error(`Tool bridge request failed: ${response.status}`);
      return response.json();
    },
  };
}

function objectSchema(required) {
  return {
    type: "object",
    properties: {},
    required,
  };
}

async function runStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const response = await handleMcpMessage(JSON.parse(line));
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (require.main === module) {
  runStdio().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { handleMcpMessage, tools };
```

- [x] **Step 4: Run MCP tests**

Run:

```bash
npm test -- desktop/conductor-mcp-server.test.mjs
```

Expected: pass.

---

## Task 8: Validate Provider Injection And Build Conductor-Only Runtime Injection

**Files:**

- Create: `src/orchestration/conductor-tools/conductorPrompt.ts`
- Create: `src/orchestration/conductor-tools/conductorPrompt.test.ts`
- Create: `src/runtime/adapters/conductorRuntime.ts`
- Create: `src/runtime/adapters/opencode/conductorInjection.ts`
- Create: `src/runtime/adapters/opencode/conductorInjection.test.ts`
- Create: `src/runtime/adapters/claude-code/conductorInjection.ts`
- Create: `src/runtime/adapters/claude-code/conductorInjection.test.ts`
- Create: `desktop/opencode-conductor-config-smoke.cjs`

- [x] **Step 1: Add opencode inline-config smoke**

Create `desktop/opencode-conductor-config-smoke.cjs`:

```js
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const opencodePath = process.env.OPENCODE_PATH || "/opt/homebrew/bin/opencode";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-opencode-config-"));
const mcpServerPath = path.resolve(__dirname, "conductor-mcp-server.cjs");
const systemPromptPath = path.join(tempRoot, ".agent-workspace", "runtime", "task-smoke", "conductor", "system.md");
fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
fs.writeFileSync(systemPromptPath, "You are the task owner Conductor for Agent Workspace.\n");

const inlineConfig = {
  $schema: "https://opencode.ai/config.json",
  instructions: [systemPromptPath],
  mcp: {
    agent_workspace_conductor: {
      type: "local",
      command: ["node", mcpServerPath],
      enabled: true,
      environment: {
        AGENT_WORKSPACE_TOOL_BRIDGE_URL: "http://127.0.0.1:9",
        AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: "smoke-token",
      },
    },
  },
  tools: {
    "agent_workspace_conductor_*": true,
  },
};

assert.ok(fs.existsSync(mcpServerPath), "conductor MCP server must exist before running this smoke");
assert.ok(inlineConfig.instructions.includes(systemPromptPath));
assert.equal(inlineConfig.mcp.agent_workspace_conductor.type, "local");

const result = spawnSync(opencodePath, ["mcp", "list"], {
  cwd: tempRoot,
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  },
  encoding: "utf8",
  timeout: 10_000,
});

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(`${result.stdout}\n${result.stderr}`, /agent_workspace_conductor|MCP|mcp/i);
assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /failed/i);
console.log("opencode inline Conductor config smoke passed");
```

This smoke does not ask a model to reason. It verifies the local opencode binary accepts process-scoped `OPENCODE_CONFIG_CONTENT`, sees the Conductor MCP declaration, and does not require writing project/global `opencode.json`.

- [x] **Step 2: Run opencode inline-config smoke after MCP server exists**

Run this after Task 7 creates `desktop/conductor-mcp-server.cjs`:

```bash
node desktop/opencode-conductor-config-smoke.cjs
```

Expected: exit 0 and print `opencode inline Conductor config smoke passed`.

- [x] **Step 3: Write failing Conductor prompt test**

Create `src/orchestration/conductor-tools/conductorPrompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildConductorSystemPrompt } from "./conductorPrompt";

describe("Conductor system prompt", () => {
  it("describes Conductor as task owner and workers as provider-native sessions", () => {
    const prompt = buildConductorSystemPrompt({
      projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      taskId: "task-1",
      taskTitle: "Research Claude Dynamic Workflow",
      taskGoal: "Write research and spec/plan clues.",
      routes: [{ fromRole: "Conductor", toRole: "Researcher" }],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
    });

    expect(prompt).toContain("You are the task owner Conductor");
    expect(prompt).toContain("Worker sessions are provider-native terminals");
    expect(prompt).toContain("Use call_session to assign work");
    expect(prompt).toContain("Use read_session to inspect Shell-owned session output");
    expect(prompt).not.toContain("Workspace Session Message");
    expect(prompt).not.toContain("emit exactly one structured message block");
  });
});
```

- [x] **Step 4: Implement Conductor prompt**

Create `src/orchestration/conductor-tools/conductorPrompt.ts`:

```ts
import type { WorkspaceSessionRoute } from "../session-communication";

export type ConductorPromptInput = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  routes: WorkspaceSessionRoute[];
  workerSessions: Array<{ id: string; name: string; role: string }>;
};

export function buildConductorSystemPrompt(input: ConductorPromptInput) {
  const workers = input.workerSessions
    .map((session) => `- ${session.name} (${session.id}): ${session.role}`)
    .join("\n");
  const routes = input.routes.map((route) => `- ${route.fromRole} -> ${route.toRole}`).join("\n");

  return [
    "You are the task owner Conductor for Agent Workspace.",
    "Act like a human task lead: understand the goal, delegate concise work, read results, ask follow-up questions, and decide the next step.",
    "Worker sessions are provider-native terminals. Do not assume they know Agent Workspace protocol.",
    "Use call_session to assign work to a worker session.",
    "Use read_session to inspect Shell-owned session output before deciding what happened.",
    "Use continue_session only when a follow-up message is clearly needed.",
    "Use ask_user when product, permission, or risk decisions require the human.",
    "Use finish_task_claim only to create pending review evidence. It does not mark Done.",
    "",
    `Project: ${input.projectPath}`,
    `Task id: ${input.taskId}`,
    `Task title: ${input.taskTitle}`,
    `Task goal: ${input.taskGoal}`,
    "",
    "Worker sessions:",
    workers || "- No worker sessions configured.",
    "",
    "Allowed route policy:",
    routes || "- No worker routes configured.",
    "",
    "Do not paste hidden protocol instructions into worker sessions.",
    "Do not use provider-native subagents to pretend another Workspace Session has run.",
    "Do not claim completion without durable evidence and review handoff.",
  ].join("\n");
}
```

- [x] **Step 5: Write injection tests**

Create `src/runtime/adapters/opencode/conductorInjection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenCodeConductorInjection } from "./conductorInjection";

describe("OpenCode Conductor injection", () => {
  it("adds MCP bridge only for Conductor and does not create worker protocol prompt", () => {
    const result = buildOpenCodeConductorInjection({
      projectPath: "/repo",
      taskId: "task-1",
      taskTitle: "Research task",
      taskGoal: "Research and summarize.",
      model: "opencode/deepseek-v4-flash-free",
      routes: [{ fromRole: "Conductor", toRole: "Researcher" }],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
      bridgeUrl: "http://127.0.0.1:3456",
      bridgeToken: "token",
      mcpServerPath: "/repo/desktop/conductor-mcp-server.cjs",
    });

    expect(result).not.toHaveProperty("agentName");
    expect(JSON.stringify(result.env)).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_URL");
    expect(JSON.stringify(result.env)).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN");
    expect(result.files.map((file) => file.relativePath)).toContain(".agent-workspace/runtime/task-1/conductor/system.md");
    expect(JSON.stringify(result.env)).toContain("OPENCODE_CONFIG_CONTENT");
    expect(JSON.stringify(result.env)).toContain("agent_workspace_conductor");
    expect(result.files.map((file) => file.contents).join("\n")).not.toContain("Workspace Session Message");
  });
});
```

Create `src/runtime/adapters/claude-code/conductorInjection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildClaudeCodeConductorInjection } from "./conductorInjection";

describe("Claude Code Conductor injection", () => {
  it("uses mcp config and append-system-prompt for Conductor", () => {
    const result = buildClaudeCodeConductorInjection({
      projectPath: "/repo",
      taskId: "task-1",
      taskTitle: "Research task",
      taskGoal: "Research and summarize.",
      model: "sonnet",
      routes: [{ fromRole: "Conductor", toRole: "Researcher" }],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
      bridgeUrl: "http://127.0.0.1:3456",
      bridgeToken: "token",
      mcpServerPath: "/repo/desktop/conductor-mcp-server.cjs",
    });

    expect(result.args).toContain("--append-system-prompt");
    expect(result.args).toContain("--mcp-config");
    expect(result.files.map((file) => file.relativePath)).toContain(".agent-workspace/runtime/task-1/conductor/claude-mcp.json");
    expect(result.args.join(" ")).not.toContain("Researcher");
  });
});
```

- [x] **Step 6: Implement provider-neutral and provider-specific injection**

Create `src/runtime/adapters/conductorRuntime.ts`:

```ts
import type { WorkspaceSessionRoute } from "../../orchestration/session-communication";
import { buildConductorSystemPrompt } from "../../orchestration/conductor-tools/conductorPrompt";
import type { NativeRuntimeFile } from "../nativeBridge";

export type ConductorRuntimeInput = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  model: string;
  routes: WorkspaceSessionRoute[];
  workerSessions: Array<{ id: string; name: string; role: string }>;
  bridgeUrl: string;
  bridgeToken: string;
  mcpServerPath: string;
};

export type ConductorRuntimeBundle = {
  systemPrompt: string;
  runtimeRoot: string;
  files: NativeRuntimeFile[];
};

export function buildConductorRuntimeBundle(input: ConductorRuntimeInput): ConductorRuntimeBundle {
  const runtimeRoot = `.agent-workspace/runtime/${safeSegment(input.taskId)}/conductor`;
  const systemPrompt = buildConductorSystemPrompt(input);
  return {
    systemPrompt,
    runtimeRoot,
    files: [{ relativePath: `${runtimeRoot}/system.md`, contents: systemPrompt }],
  };
}

export function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
```

Create provider files using this bundle:

- opencode returns `{ env, files, agentName: "conductor" }`. `env.OPENCODE_CONFIG_CONTENT` contains task-scoped `instructions`, local `mcp.agent_workspace_conductor`, and tool enablement. Do not write or mutate project/global `opencode.json`.
- Claude Code returns `{ args, files, agentName: "conductor" }`. Include `--append-system-prompt` with the prompt and `--mcp-config` pointing to `.agent-workspace/runtime/<task>/conductor/claude-mcp.json`.

- [x] **Step 7: Run injection tests and opencode config smoke**

Run:

```bash
npm test -- src/orchestration/conductor-tools/conductorPrompt.test.ts src/runtime/adapters/opencode/conductorInjection.test.ts src/runtime/adapters/claude-code/conductorInjection.test.ts
node desktop/opencode-conductor-config-smoke.cjs
```

Expected: pass.

---

## Task 9: Remove Worker Protocol Injection From Templates And Task Intake Preview

**Files:**

- Modify: `src/runtime/opencode/taskTemplates.ts`
- Modify: `src/runtime/opencode/taskTemplates.test.ts`
- Modify: `src/pages/TaskBoard.tsx`
- Modify: `src/pages/TaskBoard.test.tsx`
- Modify: `src/styles.css`

- [x] **Step 1: Write failing template tests**

Modify `src/runtime/opencode/taskTemplates.test.ts` to assert:

```ts
it("does not put Workspace protocol requirements in worker role descriptions", () => {
  for (const template of opencodeTaskTemplates) {
    for (const role of template.roles) {
      expect(role.sessionPrompt).not.toContain("Workspace Session Message");
      expect(role.sessionPrompt).not.toContain("route completed");
      expect(role.sessionPrompt).not.toContain("emit");
    }
  }
});

it("keeps template routes Conductor-mediated", () => {
  for (const template of opencodeTaskTemplates) {
    expect(template.routes.length).toBeGreaterThan(0);
    for (const route of template.routes) {
      expect(route.fromRole).toBe("Conductor");
      expect(route.toRole).not.toBe("Conductor");
    }
  }
});
```

- [x] **Step 2: Update templates**

In `src/runtime/opencode/taskTemplates.ts`, change role prompts:

- Conductor prompts describe coordination through Conductor MCP tools.
- Worker prompts describe plain provider-native work expectations only.
- Template `routes` describe only Conductor-to-worker dispatch permissions. Remove worker-to-worker and worker-to-Conductor routes.

Example for research:

```ts
sessionPrompt:
  "You coordinate research rounds as Conductor by using Agent Workspace tools to assign, read, and continue provider-native worker sessions.",
```

Worker example:

```ts
sessionPrompt:
  "Collect evidence, cite durable sources, and write research artifacts when assigned in the terminal.",
```

Research routes example:

```ts
routes: [
  { fromRole: "Conductor", toRole: "Researcher" },
  { fromRole: "Conductor", toRole: "Reviewer" },
],
```

Implementation routes example:

```ts
routes: [
  { fromRole: "Conductor", toRole: "Executor" },
  { fromRole: "Conductor", toRole: "QA" },
],
```

- [x] **Step 3: Update Task Intake prompt preview test**

In `src/pages/TaskBoard.test.tsx`, add or update a test:

```ts
it("previews only Conductor runtime prompt and MCP scope", () => {
  renderTaskBoardWithEmptyTaskHome();

  expect(screen.getByText("Conductor Runtime 预览")).toBeTruthy();
  expect(screen.getByText("MCP tools")).toBeTruthy();
  expect(screen.queryByText("Researcher", { selector: "summary strong" })).toBeNull();
  expect(screen.queryByText("Workspace Session Message")).toBeNull();
});
```

Use the existing TaskBoard test helper if present; otherwise render `TaskBoard` with the smallest valid props used in nearby tests.

- [x] **Step 4: Update TaskBoard preview implementation**

In `src/pages/TaskBoard.tsx`:

- replace `buildTaskSystemPromptPreviews` with `buildConductorRuntimePreview`,
- remove worker prompt preview list,
- render one Conductor prompt preview card and a small tool list: `call_session`, `read_session`, `continue_session`, `read_session_events`, `ask_user`, `finish_task_claim`,
- label worker sessions as "原生 session，不注入 Agent Workspace 协议".

- [x] **Step 5: Run preview/template tests**

Run:

```bash
npm test -- src/runtime/opencode/taskTemplates.test.ts src/pages/TaskBoard.test.tsx
```

Expected: pass.

---

## Task 10: Refactor App Runtime Flow To Conductor-Only

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

- [x] **Step 1: Write failing App test for Conductor-only startup**

Add a test to `src/App.test.tsx`:

```ts
it("starts only Conductor with Agent Workspace MCP injection and leaves workers provider-native", async () => {
  const startPtyInputs: Array<{ id?: string; args?: string[]; env?: Record<string, string>; runtimeFiles?: Array<{ relativePath: string; contents: string }> }> = [];
  const writePtyInputs: Array<{ id: string; text: string }> = [];
  installNativeBridge({
    startPty: async (input) => {
      startPtyInputs.push(input);
      return {
        id: input.id ?? "session",
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd,
        backend: "pty",
        status: "running",
        cols: input.cols ?? 100,
        rows: input.rows ?? 30,
        transcript: ['Ask anything... "Fix a TODO in the codebase"\ntab agents ctrl+p commands\n'],
        cursor: 1,
      };
    },
    writePty: async (input) => {
      writePtyInputs.push(input);
      return undefined;
    },
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));

  await waitFor(() => expect(startPtyInputs.length).toBeGreaterThanOrEqual(1));
  expect(startPtyInputs[0].id).toContain("conductor");
  expect(JSON.stringify(startPtyInputs[0].env ?? {})).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_URL");
  expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).toContain("Conductor");
  expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).not.toContain("Workspace Session Message");
  expect(writePtyInputs.some((input) => input.id.includes("researcher"))).toBe(false);
  expect(writePtyInputs.some((input) => input.text.includes("Workspace Session Message"))).toBe(false);
});
```

Use the existing test helper names in `src/App.test.tsx`; adapt only helper names, not test assertions.

- [x] **Step 2: Remove old App routing imports**

In `src/App.tsx`, remove imports from:

```ts
./orchestration/session-dispatch
./orchestration/session-communication
./runtime/adapters/opencode/injection
```

Replace them with:

```ts
import { buildOpenCodeConductorInjection } from "./runtime/adapters/opencode/conductorInjection";
```

- [x] **Step 3: Remove old worker dispatch refs and functions**

Delete or stop using:

- `dispatchedWorkerTaskIdsRef`
- `forwardedWorkerHandoffDigestsRef`
- `dispatchWorkerAgentsForCurrentTask`
- `forwardWorkerHandoffIfReady`
- all code that scans worker transcript for structured handoff.

- [x] **Step 4: Start Conductor with Conductor injection**

When starting a Conductor PTY:

- build Conductor injection with selected project/task/routes/workers,
- pass `runtimeFiles` and bridge env only to Conductor start,
- do not call worker assignment prompt generation,
- do not write structured protocol prompts into any worker.

- [x] **Step 5: Keep worker terminal manual startup provider-native**

When the user clicks a worker agent card in Workbench:

- start opencode/Claude Code with selected provider/model/agent launch command,
- do not pass Agent Workspace protocol runtime files,
- do not pass Agent Workspace MCP env,
- allow Conductor `call_session` to write normal assignment text through the bridge later.

- [x] **Step 6: Run App tests**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected: pass.

---

## Task 11: Remove Old Runtime Injection From Worker Paths

**Files:**

- Modify: `src/runtime/adapters/scopedInjection.ts`
- Modify: `src/runtime/adapters/opencode/injection.ts`
- Modify: `src/runtime/adapters/claude-code/injection.ts`
- Modify: existing injection tests

- [x] **Step 1: Write failing tests for provider-native worker launch**

Update existing injection tests so they assert:

```ts
expect(promptText).not.toContain("Workspace Session Message");
expect(promptText).not.toContain("emit exactly one structured message block");
expect(promptText).not.toContain("Agent Workspace runtime communication protocol");
```

Add a specific test:

```ts
it("does not build Agent Workspace injection for worker sessions", () => {
  const worker = agents.find((agent) => agent.name === "Researcher")!;
  const result = buildOpenCodeWorkerLaunch({
    project,
    task,
    agent: worker,
  });

  expect(result.runtimeFiles).toEqual([]);
  expect(JSON.stringify(result.env ?? {})).not.toContain("AGENT_WORKSPACE");
});
```

If `buildOpenCodeWorkerLaunch` does not exist, create it in Task 11 Step 2.

- [x] **Step 2: Split conductor and worker builders**

Replace all use of `buildOpenCodeScopedInjection` in runtime startup with:

- `buildOpenCodeConductorInjection` for Conductor,
- `buildOpenCodeWorkerLaunch` for workers.

Create `buildOpenCodeWorkerLaunch` returning only provider-native command fields:

```ts
export function buildOpenCodeWorkerLaunch(input: { agent: Agent }) {
  return {
    env: {},
    runtimeFiles: [],
    agentName: "",
    args: input.agent.model ? ["--model", input.agent.model] : [],
  };
}
```

For Claude Code, create an equivalent worker launch helper with no Agent Workspace prompt or MCP config.

- [x] **Step 3: Keep deprecated protocol parser diagnostic-only**

Leave `src/orchestration/session-communication/protocol.ts` in place only if tests or UI diagnostics still import it. Add a top-level comment:

```ts
// Deprecated diagnostic parser. The active runtime path is Conductor MCP tools plus Shell Session Store.
```

Do not call this parser from `src/App.tsx`.

- [x] **Step 4: Run injection tests**

Run:

```bash
npm test -- src/runtime/adapters/opencode src/runtime/adapters/claude-code src/orchestration/session-communication
```

Expected: pass.

---

## Task 12: Add Conductor Tool UI Evidence

**Files:**

- Modify: `src/pages/Workbench.tsx`
- Modify: `src/pages/Workbench.test.tsx`
- Modify: `src/styles.css`

- [x] **Step 1: Add failing Workbench evidence test**

Add a test:

```ts
it("labels Conductor as orchestration center and workers as provider-native terminals", () => {
  renderWorkbenchWithConductorAndWorkers();

  expect(screen.getByText("Conductor 工具")).toBeTruthy();
  expect(screen.getByText("call_session")).toBeTruthy();
  expect(screen.getByText("read_session")).toBeTruthy();
  expect(screen.getByText("Worker sessions 保持原生")).toBeTruthy();
});
```

Use existing Workbench test fixtures; if there is no helper, build a minimal `agents` array with Conductor and Researcher.

- [x] **Step 2: Update Workbench copy**

In `src/pages/Workbench.tsx`, replace worker protocol language with:

- Conductor: "任务负责人，通过 MCP tools 调度和读取其他 session"
- Worker: "原生 provider terminal，Shell 只记录 transcript/status"

Show a compact tool list only for selected Conductor.

- [x] **Step 3: Run Workbench tests**

Run:

```bash
npm test -- src/pages/Workbench.test.tsx
```

Expected: pass.

---

## Task 13: Desktop Smoke For Conductor Tool Flow

**Files:**

- Create: `desktop/conductor-tool-flow-smoke.cjs`
- Modify: `package.json`

- [x] **Step 1: Add smoke script**

Create `desktop/conductor-tool-flow-smoke.cjs` that:

1. Creates a fake project directory under OS temp.
2. Creates a Session Store.
3. Creates a fake PTY manager with `get` and `write`.
4. Creates a Conductor tool bridge.
5. Calls `callSession`.
6. Calls `readSession`.
7. Asserts the worker write does not contain `Workspace Session Message`.

Use Node `assert/strict`.

- [x] **Step 2: Add package script**

In `package.json`:

```json
"desktop:conductor-tool-smoke": "node desktop/conductor-tool-flow-smoke.cjs"
```

- [x] **Step 3: Run smoke**

Run:

```bash
npm run desktop:conductor-tool-smoke
```

Expected: exit 0.

---

## Task 14: Final Verification And Cleanup

**Files:**

- Review all changed files.

- [x] **Step 1: Search for active old protocol usage**

Run:

```bash
rg -n "Workspace Session Message|emit exactly one structured message block|buildOpenCodeScopedInjection|createSessionDispatchPlan|detectSessionHandoff|forwardWorkerHandoff|dispatchWorkerAgentsForCurrentTask|Protocol repair" src desktop docs/superworks/spec docs/superworks/plans
```

Expected:

- Allowed hits only in deprecated plan, migration notes, diagnostic parser comments/tests, and spec text saying the previous path is deprecated.
- No hits in active App runtime startup path that inject worker protocol.

Verification record:

- 2026-06-29: active source no longer contains old `session-dispatch`, `agent-dispatch`, `scopedInjection`, protocol repair, or worker protocol injection implementation. Remaining scan hits are specs, deprecated plan text, this plan, smoke/negative assertions, and product intent guards.

- [x] **Step 2: Run focused tests**

Run:

```bash
npm test -- \
  src/lib/productIntentDocs.test.ts \
  src/orchestration/conductor-tools \
  src/runtime/adapters/opencode \
  src/runtime/adapters/claude-code \
  src/runtime/opencode/taskTemplates.test.ts \
  src/pages/TaskBoard.test.tsx \
  src/pages/Workbench.test.tsx \
  src/App.test.tsx \
  desktop/session-store.test.mjs \
  desktop/session-status-monitor.test.mjs \
  desktop/conductor-tool-bridge.test.mjs \
  desktop/conductor-mcp-server.test.mjs \
  desktop/pty-manager.test.mjs
```

Expected: all selected tests pass.

Verification record:

- 2026-06-29: `16 passed (16)`, `135 passed (135)`.

- [x] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

Verification record:

- 2026-06-29: `48 passed (48)`, `303 passed (303)`.

- [x] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite build pass.

Verification record:

- 2026-06-29: `npm run build` passed.
- 2026-06-29: `npm run desktop:conductor-tool-smoke` passed and verified `call_session -> worker PTY write -> read_session`.

- [x] **Step 5: Manual desktop validation**

Run:

```bash
./start.sh
```

Manual checks:

- Task Home preview shows Conductor runtime prompt and MCP tool scope only.
- Creating a task starts Conductor first.
- Worker cards do not show injected system prompt previews.
- Starting a worker opens a provider-native terminal.
- No worker terminal receives `Workspace Session Message` or protocol repair prompt.
- Conductor terminal has Agent Workspace MCP tools available before first user turn.
- `read_session` reads Shell-owned transcript data after worker output exists.

Expected: pass all manual checks before marking the plan fully complete.

Verification record:

- 2026-06-29: `npm run desktop:task-home-native-smoke` passed. It validated Task Home Conductor preview, Conductor-only auto-start, MCP bridge config/env, no worker auto-start, no old protocol copy, IDE manual Researcher start as provider-native PTY, no worker Agent Workspace env/runtime files, xterm mount, and no raw ANSI leakage.
- 2026-06-29: `node desktop/opencode-conductor-config-smoke.cjs` passed. It validated opencode accepts the process-scoped Conductor MCP config through `OPENCODE_CONFIG_CONTENT`.

---

## Execution Notes

- This workspace currently has no `.git` repository at `/Users/dinker/CODES/Agent-Workspace`; commit steps are intentionally omitted. If this plan is executed in a git checkout, commit after each task with a message that includes the task number and verification command.
- Keep `docs/superworks/spec/conductor-session-communication.md` stable unless the user changes product requirements.
- Runtime state must stay under `.agent-workspace/`; do not write task runtime events into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`.
- Worker sessions must remain provider-native in this plan. Do not add worker MCP tools, worker `report_result`, worker `send_conductor`, or worker Workspace protocol prompts.
