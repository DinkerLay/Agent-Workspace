# Opencode Adapter And Real Task Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace runtime mock agent/task flows with a real opencode-backed task creation and session launch path.

**Architecture:** Split opencode concerns into a focused adapter layer. The React app starts from an empty real workspace, creates tasks through Task Home, creates task-scoped agent session records from task templates, and launches real opencode PTY sessions only through the opencode adapter. Existing mock prototype files remain as design assets and test fixtures; the runtime App must not import mock data or mock adapters.

**Tech Stack:** Vite, React, TypeScript, Electron preload IPC, node-pty/process fallback, opencode CLI.

---

## Success Criteria

- `src/App.tsx` does not import `src/mock/*` or `src/runtime/mockAdapters`.
- The runtime UI has no preloaded agent cards, tasks, runs, or fake transcripts.
- Task Home shows a real empty state and a new-task form.
- Creating a task creates a runtime task record plus a task-scoped agent cluster from the selected template.
- Task Home can switch the active project path before task creation.
- Creating a task in the selected project auto-starts the task Conductor PTY in that project cwd and writes the initial task context.
- Starting Conductor launches a real opencode PTY through the desktop bridge.
- Agent cards represent opencode session records and process status, not permanent TUI processes.
- No runtime action creates `mock-run-*`, fake transcript lines, or fake agent progress.
- Tests can still import fixture data from `src/mock/*`, but production app code cannot.
- Existing prototype/mockup files are preserved. Do not delete `public/mockups/*`, `src/mock/*`, research assets, or historical prototype fixtures as part of this plan.

## Scope Clarification

“去 mock” means runtime-path de-mocking, not deleting prototype assets.

Allowed to remain:

- `public/mockups/*` visual prototype pages, including `public/mockups/task-home-playground.html`.
- `src/mock/*` fixture data used by tests, archived prototype pages, or product-map examples.
- Research images and historical design references.
- Test-only fixtures that intentionally exercise old or synthetic states.

Not allowed in the real runtime path:

- `src/App.tsx` importing `src/mock/prototypeData.ts`.
- `src/App.tsx` creating `createMockRuntimeAdapters()`.
- Runtime Task Home showing preloaded fake agents, fake tasks, fake runs, or fake transcripts.
- Runtime actions that create `mock-run-*` ids or fake adapter evidence.

When the real App needs a UI pattern from a mockup, port the interaction design into the real React page and wire it to real runtime state. Do not delete or mutate the original mockup file to make the runtime App pass.

## Execution Order And Gates

- Tasks 1-3 create the isolated opencode adapter and can land before any UI changes.
- Task 4 must pass before removing `initialPrototypeState`; it creates a complete `PrototypeState` replacement with every required field from `src/types.ts`.
- Task 5 must pass before Task 8; Task Home can only render real task-created agents after the reducer can create them.
- Task 6 removes mock imports from the runtime App and updates reducer/audit tests that previously assumed mock-backed Browser, MCP, Team, and Library fixtures were available at runtime. Mock-backed pages may be hidden from runtime navigation instead of deleted.
- Task 7 owns real PTY launch from `src/App.tsx` and Electron IPC. Current code already uses opencode adapter command builders for agent PTY start; Task 7 is not complete until final verification/review passes. Do not call native bridge methods from reducers or pure runtime modules.
- Task 8 owns the real Task Home empty state and new-task interaction. Current code already has the first implementation; remaining work is UX label/copy cleanup and visual verification without editing the mockup file.
- Task 9 cleans runtime-visible mock text and updates the durable spec. It must not delete `public/mockups/*`, `src/mock/*`, research assets, or fixture files.
- Task 10 verifies the complete runtime flow in browser and desktop.
- Task 11 closes the project-aware Task Home flow: select a project path, create a task, auto-start Conductor, and verify the PTY cwd/argv.
- Task 12 adds the opencode-backed Task Draft Assistant: one natural-language request generates or patches the visible task configuration draft before creation.

## Implementation Status Snapshot 2026-06-27

- Tasks 1-6 are complete in the current codebase.
- Task 7 is complete in the current codebase. Real opencode PTY launch, process inspection, Conductor-vs-Workbench session routing, read-only command preview, and duplicate same-key PTY start protection have passed focused/full verification and subagent review.
- Task 8 is complete in the current codebase. `desktop:layout-smoke` verifies the real Task Home empty state, task creation, Conductor terminal, worker cards, no runtime mock text, and no horizontal/internal overflow at desktop and narrow widths.
- Task 9 is complete in the current codebase. Runtime-visible mock wording was removed from `src/App.tsx`, `src/lib/taskMachine.ts`, and `src/pages/CapabilityMap.tsx`; the runtime mock-text guard, focused tests, full tests, and build have passed.
- Task 10 is complete in the current codebase. Dev-server marker, Electron bridge smoke, real Task Home native UI start/stop smoke, opencode process-count smoke, full tests, and build have passed.
- Task 11 is complete in the current codebase. Task Home now has a project switch control, task creation auto-starts the task Conductor, and the Agent_Test E2E smoke verifies cwd, argv, session id, process count, and clean stop behavior.
- Task 12 is complete in the current codebase. Task Home has an AI task configuration assistant, the desktop backend calls opencode headless through `native:generate-task-draft`, assistant JSON fills the new-task form, follow-up messages patch the draft, and task creation still starts Conductor only after user confirmation.
- Task 13's previous structured Agent Workspace communication protocol path is superseded by `docs/superworks/spec/conductor-session-communication.md`. Worker sessions stay provider-native; Shell dispatches normal assignments through PTY, records terminal evidence, and uses provider adapters such as `desktop/opencode/session-adapter.cjs` for final answer extraction instead of worker protocol injection or terminal handoff parsing.

## Remaining Execution Path

All gates in this plan are complete. If a later verification fails, add a new task with exact failing evidence, target files, reproduction command, fix steps, and verification commands before editing code.

## Current Code Alignment Notes

This plan is being executed against the current React/Electron codebase, not a greenfield branch. Before continuing from any task, inspect these files:

- `src/App.tsx` boots from `createRuntimeWorkspaceState()` and defines empty runtime arrays for capability, MCP, browser, library, and team data.
- `src/App.tsx` starts task agents through `createOpencodeSessionKey()`, `buildOpencodeTuiCommand()`, and `startNativePtySession()`. Do not reintroduce `parseAgentLaunchCommand()` into the agent PTY start path.
- `src/App.tsx` keeps the Task Home Conductor session separate from the globally selected Workbench agent through `selectedTaskConductorAgent`, `conductorNativeConversationKey`, conductor-specific polling, and conductor-specific write handlers.
- `src/App.tsx` exposes `openRuntimeProject()` for Task Home project switching and clears native PTY/session UI state before replacing the runtime workspace.
- `src/App.tsx` passes `generateNativeTaskDraft()` into Task Home; this calls the desktop backend but does not start PTY or create tasks.
- `src/pages/Workbench.tsx` shows `Agent 启动命令预览` as a read-only preview. Do not add a freeform command textarea unless launch execution is wired to that exact user-edited command.
- `src/pages/TaskBoard.tsx` already renders an empty state, project switch control, `TaskDraftAssistantPanel`, controlled `TaskIntakePanel`, task-level `Conductor Terminal`, worker agent cards, and Enter-to-send / Shift+Enter-to-newline behavior for Conductor input.
- `src/lib/taskMachine.ts` keeps Browser, MCP, Team, and Library helper sources as empty arrays. Tests should assert the no-op boundary until real adapters exist. `sendPrompt()` records only the local user input line; native model I/O is handled through PTY write handlers in `src/App.tsx`.
- `desktop/main.cjs` currently routes runtime status, one-shot opencode run, opencode agent listing, process inspection, and PTY lifecycle through `desktop/opencode-runner.cjs`, `desktop/opencode/process-inspector.cjs`, and `desktop/pty-manager.cjs`.
- `src/orchestration/conductor-tools/*` owns the Conductor tool contract and task-owner prompt. Worker sessions must not receive Agent Workspace message-envelope prompts or repair prompts.
- `desktop/opencode/session-adapter.cjs` owns opencode provider-result extraction for worker answers. Do not derive final worker answers from visible terminal transcript tails when provider message storage is available.
- `src/runtime/adapters/opencode/conductorInjection.ts` and `src/runtime/adapters/claude-code/conductorInjection.ts` create Conductor-only task-scoped runtime injection descriptors. Worker launch adapters stay provider-native. Do not write these rules into global `AGENTS.md` or `CLAUDE.md`; write generated injection files only under `.agent-workspace/runtime/<task-id>/conductor/`.
- `desktop/pty-manager.cjs` accepts `runtimeFiles` and `env` on PTY start, writes runtime files inside the project directory, and starts the CLI with scoped environment overrides. Keep this as the boundary for process-specific injection.
- `public/mockups/*`, `src/mock/*`, `src/runtime/mockAdapters.ts`, and their tests are preserved prototype/fixture assets. They are not runtime App dependencies once `src/App.tsx` and runtime reducers stop importing them.

## File Structure

### Create

- `src/runtime/opencode/types.ts`  
  Type definitions for opencode command specs, session keys, process stats, and resource policy.

- `src/runtime/opencode/sessionKey.ts`  
  Pure helpers for deterministic project/task/agent session ids.

- `src/runtime/opencode/command.ts`  
  Pure command builders for TUI, attach, run, and serve modes. These builders return `command + args + cwd` arrays, not shell strings.

- `src/runtime/opencode/resourcePolicy.ts`  
  Policy for max live TUI sessions per project/task and idle release thresholds.

- `src/runtime/opencode/taskTemplates.ts`  
  Real task templates that decide which agent session records are created for a new task.

- `src/runtime/opencode/workspaceState.ts`  
  Runtime initial state and task/agent creation helpers with no mock imports.

- `src/runtime/opencode/index.ts`  
  Public exports for the opencode adapter boundary.

- `src/runtime/opencode/*.test.ts`  
  Unit tests for command builders, session keys, resource policy, task templates, and real initial state.

- `desktop/opencode/process-inspector.cjs`  
  Inspect live opencode processes and RSS memory.

- `desktop/opencode/*.test.mjs`  
  Node tests for process parsing. Current one-shot opencode runner tests live in `desktop/opencode-runner.test.mjs`.

### Modify

- `src/App.tsx`  
  Remove runtime imports from `src/mock/*` and `src/runtime/mockAdapters`. Use `createRuntimeWorkspaceState()` and opencode task creation helpers. Do not delete `src/mock/*`.

- `src/pages/TaskBoard.tsx`  
  Port the new-task interaction from the mockup design into the real page. Make the new-task form the primary empty-state action. Render agent cards only after a task creates agent session records.

- `src/pages/Workbench.tsx`  
  Treat selected agent as an opencode session target. If no native session exists, show a start/attach state instead of transcript fallback.

- `src/runtime/nativeBridge.ts`  
  Add opencode process inspection types and desktop bridge calls.

- `desktop/main.cjs`  
  Route opencode runtime status, process inspection, and PTY startup through `desktop/opencode-runner.cjs`, `desktop/opencode/process-inspector.cjs`, and `desktop/pty-manager.cjs`.

- `desktop/preload.cjs`  
  Expose opencode process inspection to the renderer.

- `desktop/opencode-runner.cjs`  
  Existing CommonJS runner for opencode binary resolution, one-shot `opencode run`, and native agent listing.

- `src/lib/taskMachine.ts`  
  Remove fake runtime transition text and make task creation/agent creation usable without fixture state.

- `src/runtime/taskOrchestrator.ts`  
  Remove from the runtime App path, or refactor it into a pure action-intent helper only. Do not call native bridge methods from this module; real PTY launch stays in `src/App.tsx` through `src/runtime/nativeBridge.ts`.

- `src/App.test.tsx`, `src/pages/TaskBoard.test.tsx`, `src/pages/Workbench.test.tsx`  
  Update runtime tests to expect empty initial state, real task creation, and real bridge calls.

---

## Task 1: Add Opencode Adapter Types And Session Keys

**Files:**
- Create: `src/runtime/opencode/types.ts`
- Create: `src/runtime/opencode/sessionKey.ts`
- Create: `src/runtime/opencode/sessionKey.test.ts`
- Create: `src/runtime/opencode/index.ts`

- [x] **Step 1: Write failing tests for session keys**

Create `src/runtime/opencode/sessionKey.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpencodeSessionKey, createOpencodeTaskClusterId, safeSegment } from "./sessionKey";

describe("opencode session keys", () => {
  it("creates stable task-scoped session ids", () => {
    expect(
      createOpencodeSessionKey({
        projectId: "project-agent-workspace",
        taskId: "task-research",
        agentId: "conductor",
      }),
    ).toBe("opencode:project-agent-workspace:task-research:conductor");
  });

  it("encodes path-like and spaced ids without collisions", () => {
    expect(
      createOpencodeSessionKey({
        projectId: "/Users/dinker/CODES/Agent Workspace",
        taskId: "Plan Loop #1",
        agentId: "QA Reviewer",
      }),
    ).toBe("opencode:~2f~Users~2f~dinker~2f~CODES~2f~Agent~20~Workspace:Plan~20~Loop~20~~23~1:QA~20~Reviewer");
  });

  it("keeps distinct raw ids distinct after encoding", () => {
    expect(createOpencodeSessionKey({ projectId: "a-b", taskId: "c", agentId: "x" })).not.toBe(
      createOpencodeSessionKey({ projectId: "a/b", taskId: "c", agentId: "x" }),
    );
    expect(createOpencodeTaskClusterId("a-b", "c")).not.toBe(createOpencodeTaskClusterId("a", "b-c"));
  });

  it("creates task cluster ids without runtime process state", () => {
    expect(createOpencodeTaskClusterId("project-agent-workspace", "task-research")).toBe(
      "cluster-project-agent-workspace:task-research",
    );
  });

  it("uses an explicit empty segment for blank ids", () => {
    expect(safeSegment(" \t\n")).toBe("empty");
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/runtime/opencode/sessionKey.test.ts
```

Expected: fail because `src/runtime/opencode/sessionKey.ts` does not exist.

- [x] **Step 3: Implement types and key helpers**

Create `src/runtime/opencode/types.ts`:

```ts
export type OpencodeLaunchMode = "tui" | "run" | "serve" | "attach";

export type OpencodeCommandSpec = {
  command: string;
  args: string[];
  cwd: string;
  display: string;
  mode: OpencodeLaunchMode;
};

export type OpencodeSessionKeyInput = {
  projectId: string;
  taskId: string;
  agentId: string;
};

export type OpencodeProcessStat = {
  pid: number;
  ppid: number;
  rssKb: number;
  rssMb: number;
  percentMemory: number;
  elapsed: string;
  command: string;
  args: string;
};

export type OpencodeResourcePolicy = {
  maxLiveTuiPerTask: number;
  maxLiveTuiPerProject: number;
  idleReleaseMinutes: number;
};
```

Create `src/runtime/opencode/sessionKey.ts`:

```ts
import type { OpencodeSessionKeyInput } from "./types";

export function createOpencodeSessionKey(input: OpencodeSessionKeyInput) {
  return `opencode:${safeSegment(input.projectId)}:${safeSegment(input.taskId)}:${safeSegment(input.agentId)}`;
}

export function createOpencodeTaskClusterId(projectId: string, taskId: string) {
  return `cluster-${safeSegment(projectId)}:${safeSegment(taskId)}`;
}

export function safeSegment(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  return Array.from(trimmed)
    .map((char) => (/^[a-zA-Z0-9._-]$/.test(char) ? char : `~${char.codePointAt(0)?.toString(16) ?? "0"}~`))
    .join("");
}
```

Create `src/runtime/opencode/index.ts`:

```ts
export * from "./types";
export * from "./sessionKey";
```

- [x] **Step 4: Verify**

Run:

```bash
npm test -- src/runtime/opencode/sessionKey.test.ts
```

Expected: pass.

---

## Task 2: Add Opencode Command Builders

**Files:**
- Create: `src/runtime/opencode/command.ts`
- Create: `src/runtime/opencode/command.test.ts`
- Modify: `src/runtime/opencode/index.ts`

- [x] **Step 1: Write failing command tests**

Create `src/runtime/opencode/command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildOpencodeAttachCommand,
  buildOpencodeRunCommand,
  buildOpencodeServeCommand,
  buildOpencodeTuiCommand,
} from "./command";

describe("opencode command builders", () => {
  it("builds a real TUI command without shell interpolation", () => {
    expect(
      buildOpencodeTuiCommand({
        binaryPath: "/opt/homebrew/bin/opencode",
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        model: "opencode/deepseek-v4-flash-free",
        agentName: "planner",
      }),
    ).toEqual({
      command: "/opt/homebrew/bin/opencode",
      args: ["--model", "opencode/deepseek-v4-flash-free", "--agent", "planner"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      display: "/opt/homebrew/bin/opencode --model opencode/deepseek-v4-flash-free --agent planner",
      mode: "tui",
    });
  });

  it("builds run command for non-interactive execution", () => {
    expect(
      buildOpencodeRunCommand({
        binaryPath: "opencode",
        cwd: "/repo",
        message: "summarize",
        model: "opencode/deepseek-v4-flash-free",
        agentName: "qa",
      }),
    ).toMatchObject({
      command: "opencode",
      args: ["run", "--format", "json", "--model", "opencode/deepseek-v4-flash-free", "--agent", "qa", "summarize"],
      cwd: "/repo",
      mode: "run",
    });
  });

  it("keeps shell-sensitive messages as a single argv item and quotes display only", () => {
    expect(
      buildOpencodeRunCommand({
        cwd: "/repo",
        message: "say \"hello world\" && rm -rf /",
        attachUrl: "http://127.0.0.1:4096",
      }),
    ).toEqual({
      command: "opencode",
      args: ["run", "--format", "json", "--attach", "http://127.0.0.1:4096", "say \"hello world\" && rm -rf /"],
      cwd: "/repo",
      display: "opencode run --format json --attach http://127.0.0.1:4096 'say \"hello world\" && rm -rf /'",
      mode: "run",
    });
  });

  it("omits optional TUI flags when no model or agent is provided", () => {
    expect(buildOpencodeTuiCommand({ cwd: "/repo" })).toEqual({
      command: "opencode",
      args: [],
      cwd: "/repo",
      display: "opencode",
      mode: "tui",
    });
  });

  it("builds serve and attach commands", () => {
    expect(buildOpencodeServeCommand({ binaryPath: "opencode", cwd: "/repo", port: 4096 })).toMatchObject({
      args: ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
      mode: "serve",
    });
    expect(buildOpencodeAttachCommand({ binaryPath: "opencode", cwd: "/repo", url: "http://127.0.0.1:4096" })).toMatchObject({
      args: ["attach", "http://127.0.0.1:4096"],
      mode: "attach",
    });
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/runtime/opencode/command.test.ts
```

Expected: fail because command builders do not exist.

- [x] **Step 3: Implement command builders**

Create `src/runtime/opencode/command.ts`:

```ts
import type { OpencodeCommandSpec } from "./types";

type BaseCommandInput = {
  binaryPath?: string;
  cwd: string;
  model?: string;
  agentName?: string;
};

export function buildOpencodeTuiCommand(input: BaseCommandInput): OpencodeCommandSpec {
  const command = input.binaryPath ?? "opencode";
  const args = compact([
    input.model ? ["--model", input.model] : [],
    input.agentName ? ["--agent", input.agentName] : [],
  ]);
  return commandSpec("tui", command, args, input.cwd);
}

export function buildOpencodeRunCommand(
  input: BaseCommandInput & { message: string; attachUrl?: string },
): OpencodeCommandSpec {
  const command = input.binaryPath ?? "opencode";
  const args = compact([
    ["run", "--format", "json"],
    input.model ? ["--model", input.model] : [],
    input.agentName ? ["--agent", input.agentName] : [],
    input.attachUrl ? ["--attach", input.attachUrl] : [],
    [input.message],
  ]);
  return commandSpec("run", command, args, input.cwd);
}

export function buildOpencodeServeCommand(input: { binaryPath?: string; cwd: string; port: number }): OpencodeCommandSpec {
  const command = input.binaryPath ?? "opencode";
  return commandSpec("serve", command, ["serve", "--port", String(input.port), "--hostname", "127.0.0.1"], input.cwd);
}

export function buildOpencodeAttachCommand(input: { binaryPath?: string; cwd: string; url: string }): OpencodeCommandSpec {
  const command = input.binaryPath ?? "opencode";
  return commandSpec("attach", command, ["attach", input.url], input.cwd);
}

function commandSpec(mode: OpencodeCommandSpec["mode"], command: string, args: string[], cwd: string): OpencodeCommandSpec {
  return {
    command,
    args,
    cwd,
    display: [command, ...args].map(displayArg).join(" "),
    mode,
  };
}

function compact(parts: string[][]) {
  return parts.flat().filter((part) => part.length > 0);
}

function displayArg(arg: string) {
  return /^[a-zA-Z0-9._/:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
```

Modify `src/runtime/opencode/index.ts`:

```ts
export * from "./types";
export * from "./sessionKey";
export * from "./command";
```

- [x] **Step 4: Verify**

Run:

```bash
npm test -- src/runtime/opencode/command.test.ts
```

Expected: pass.

---

## Task 3: Add Resource Policy And Process Inspection

**Files:**
- Create: `src/runtime/opencode/resourcePolicy.ts`
- Create: `src/runtime/opencode/resourcePolicy.test.ts`
- Create: `desktop/opencode/process-inspector.cjs`
- Create: `desktop/opencode/process-inspector.test.mjs`
- Modify: `src/runtime/opencode/index.ts`

- [x] **Step 1: Write resource policy tests**

Create `src/runtime/opencode/resourcePolicy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultOpencodeResourcePolicy, summarizeOpencodeMemory } from "./resourcePolicy";

describe("opencode resource policy", () => {
  it("limits live TUI sessions by task and project", () => {
    expect(defaultOpencodeResourcePolicy).toEqual({
      maxLiveTuiPerTask: 2,
      maxLiveTuiPerProject: 3,
      idleReleaseMinutes: 15,
    });
  });

  it("summarizes opencode process memory", () => {
    expect(
      summarizeOpencodeMemory([
        { pid: 1, ppid: 0, rssKb: 150000, rssMb: 146.48, percentMemory: 0.9, elapsed: "01:00", command: "opencode", args: "opencode" },
        { pid: 2, ppid: 0, rssKb: 450000, rssMb: 439.45, percentMemory: 2.8, elapsed: "01:00", command: "opencode", args: "opencode" },
      ]),
    ).toEqual({
      count: 2,
      totalRssMb: 585.93,
      averageRssMb: 292.96,
      maxRssMb: 439.45,
    });
  });

  it("summarizes an empty opencode process list", () => {
    expect(summarizeOpencodeMemory([])).toEqual({
      count: 0,
      totalRssMb: 0,
      averageRssMb: 0,
      maxRssMb: 0,
    });
  });
});
```

- [x] **Step 2: Implement resource policy**

Create `src/runtime/opencode/resourcePolicy.ts`:

```ts
import type { OpencodeProcessStat, OpencodeResourcePolicy } from "./types";

export const defaultOpencodeResourcePolicy: OpencodeResourcePolicy = {
  maxLiveTuiPerTask: 2,
  maxLiveTuiPerProject: 3,
  idleReleaseMinutes: 15,
};

export function summarizeOpencodeMemory(processes: OpencodeProcessStat[]) {
  const count = processes.length;
  const totalRssMb = round2(processes.reduce((sum, process) => sum + process.rssMb, 0));
  const averageRssMb = count === 0 ? 0 : round2(totalRssMb / count);
  const maxRssMb = count === 0 ? 0 : round2(Math.max(...processes.map((process) => process.rssMb)));
  return { count, totalRssMb, averageRssMb, maxRssMb };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
```

- [x] **Step 3: Add desktop process parser**

Create `desktop/opencode/process-inspector.cjs`:

```js
const { execFileSync } = require("node:child_process");

function inspectOpencodeProcesses({ exec = execFileSync } = {}) {
  const output = exec("ps", ["-axo", "pid,ppid,rss,%mem,etime,comm,args"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return parseOpencodeProcessList(output);
}

function parseOpencodeProcessList(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseProcessLine)
    .filter((item) => item && isOpencodeProcess(item));
}

function parseProcessLine(line) {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
  if (!match) return undefined;
  const rssKb = Number(match[3]);
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rssKb,
    rssMb: Math.round((rssKb / 1024) * 100) / 100,
    percentMemory: Number(match[4]),
    elapsed: match[5],
    command: match[6],
    args: match[7],
  };
}

function isOpencodeProcess(item) {
  const commandName = item.command.split(/[\\/]/).pop();
  const firstArg = item.args.trim().split(/\s+/)[0] || "";
  const firstArgName = firstArg.split(/[\\/]/).pop();
  return commandName === "opencode" || firstArgName === "opencode";
}

module.exports = { inspectOpencodeProcesses, parseOpencodeProcessList, isOpencodeProcess };
```

Create `desktop/opencode/process-inspector.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { parseOpencodeProcessList } from "./process-inspector.cjs";

describe("opencode process inspector", () => {
  it("parses opencode ps output and ignores non-opencode rows", () => {
    const output = [
      "PID PPID RSS %MEM ELAPSED COMM ARGS",
      "81076 80891 150256 0.9 02:46 opencode opencode",
      "3936 1 27552 0.2 04-08:57 Terminal /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ].join("\\n");

    expect(parseOpencodeProcessList(output)).toEqual([
      {
        pid: 81076,
        ppid: 80891,
        rssKb: 150256,
        rssMb: 146.73,
        percentMemory: 0.9,
        elapsed: "02:46",
        command: "opencode",
        args: "opencode",
      },
    ]);
  });

  it("accepts path-like opencode commands and rejects false positives", () => {
    const output = [
      "PID PPID RSS %MEM ELAPSED COMM ARGS",
      "81076 80891 150256 0.9 02:46 /opt/homebrew/bin/opencode /opt/homebrew/bin/opencode",
      "81077 80891 150256 0.9 02:46 node /opt/homebrew/bin/opencode",
      "81078 80891 150256 0.9 02:46 opencode-helper opencode-helper",
      "81079 80891 150256 0.9 02:46 node node /tmp/opencode-helper.js",
    ].join("\\n");

    expect(parseOpencodeProcessList(output).map((process) => process.pid)).toEqual([81076, 81077]);
  });
});
```

- [x] **Step 4: Verify**

Run:

```bash
npm test -- src/runtime/opencode/resourcePolicy.test.ts desktop/opencode/process-inspector.test.mjs
```

Expected: pass.

---

## Task 4: Add Real Runtime Workspace State

**Files:**
- Create: `src/runtime/opencode/workspaceState.ts`
- Create: `src/runtime/opencode/workspaceState.test.ts`
- Modify: `src/runtime/opencode/index.ts`

- [x] **Step 1: Write failing tests for empty runtime state**

Create `src/runtime/opencode/workspaceState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRuntimeWorkspaceState } from "./workspaceState";

describe("runtime workspace state", () => {
  it("starts without mock tasks, runs, agents, or transcripts", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    expect(state.tasks).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.agentClusters).toHaveLength(1);
    expect(state.agentClusters[0]).toMatchObject({
      level: "project-default",
      agentIds: [],
    });
    expect(state.terminalLines).toEqual([]);
  });

  it("keeps project and cluster selections internally consistent without task or agent selections", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId);
    const selectedCluster = state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId);

    expect(selectedProject).toMatchObject({
      id: "project-runtime-current",
      name: "Agent Workspace",
      path: "/Users/dinker/CODES/Agent-Workspace",
      defaultAgentClusterId: "cluster-runtime-default",
      agentClusterIds: ["cluster-runtime-default"],
      agentIds: [],
      taskIds: [],
    });
    expect(selectedCluster).toMatchObject({
      id: "cluster-runtime-default",
      projectId: "project-runtime-current",
      level: "project-default",
      agentIds: [],
    });
    expect(state.selectedTaskId).toBe("");
    expect(state.selectedAgentId).toBe("");
  });

  it("starts every runtime evidence collection empty", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    expect({
      projectContextEvents: state.projectContextEvents,
      agentProfileEvents: state.agentProfileEvents,
      reviewFileSelections: state.reviewFileSelections,
      commitRedactionScans: state.commitRedactionScans,
      commitStagingEvents: state.commitStagingEvents,
      reviewApprovalEvents: state.reviewApprovalEvents,
      reviewGateEvents: state.reviewGateEvents,
      pullRequestHandoffEvents: state.pullRequestHandoffEvents,
      verificationEvents: state.verificationEvents,
      taskIntakeEvents: state.taskIntakeEvents,
      taskTransitionEvents: state.taskTransitionEvents,
      taskArtifacts: state.taskArtifacts,
      runtimeEvents: state.runtimeEvents,
      terminalEvents: state.terminalEvents,
      loopScheduleEvents: state.loopScheduleEvents,
      browserEvidence: state.browserEvidence,
      notificationEvents: state.notificationEvents,
      watchSources: state.watchSources,
      watchEvents: state.watchEvents,
    }).toEqual({
      projectContextEvents: [],
      agentProfileEvents: [],
      reviewFileSelections: [],
      commitRedactionScans: [],
      commitStagingEvents: [],
      reviewApprovalEvents: [],
      reviewGateEvents: [],
      pullRequestHandoffEvents: [],
      verificationEvents: [],
      taskIntakeEvents: [],
      taskTransitionEvents: [],
      taskArtifacts: [],
      runtimeEvents: [],
      terminalEvents: [],
      loopScheduleEvents: [],
      browserEvidence: [],
      notificationEvents: [],
      watchSources: [],
      watchEvents: [],
    });
  });
});
```

- [x] **Step 2: Implement real empty state factory**

Create `src/runtime/opencode/workspaceState.ts` with this complete `PrototypeState` factory. Import types from `../../types`, but do not import `../../mock/*`.

```ts
import type { AgentCluster, Project, PrototypeState } from "../../types";

export type RuntimeWorkspaceStateInput = {
  projectPath: string;
  projectName: string;
};

const runtimeProjectId = "project-runtime-current";
const runtimeDefaultClusterId = "cluster-runtime-default";

export function createRuntimeWorkspaceState(input: RuntimeWorkspaceStateInput): PrototypeState {
  const project: Project = {
    id: runtimeProjectId,
    name: input.projectName,
    zone: "work",
    path: input.projectPath,
    status: "active",
    defaultAgentClusterId: runtimeDefaultClusterId,
    agentClusterIds: [runtimeDefaultClusterId],
    agentIds: [],
    taskIds: [],
    commandIds: [],
    browserProfile: ".agent-workspace/browser/project-runtime-current/",
  };

  const defaultCluster: AgentCluster = {
    id: runtimeDefaultClusterId,
    projectId: project.id,
    name: "FirstTask",
    level: "project-default",
    agentIds: [],
    evidencePath: ".agent-workspace/clusters/project-runtime-current/cluster-runtime-default.json",
  };

  return {
    activeView: "backlog",
    projects: [project],
    selectedProjectId: project.id,
    projectContextEvents: [],
    agentClusters: [defaultCluster],
    selectedAgentClusterId: defaultCluster.id,
    agents: [],
    agentTemplates: [],
    agentProfileEvents: [],
    selectedAgentId: "",
    reviewAgentId: "",
    reviewFileSelections: [],
    commitConversationIncluded: false,
    commitRedactionScans: [],
    commitStagingEvents: [],
    reviewApprovalEvents: [],
    reviewGateEvents: [],
    pullRequestHandoffEvents: [],
    verificationEvents: [],
    tasks: [],
    taskIntakeEvents: [],
    taskTransitionEvents: [],
    taskArtifacts: [],
    runs: [],
    devCommands: [],
    devCommandEvents: [],
    selectedMcpServerId: "",
    mcpToolEvents: [],
    selectedTeamWorkflowId: "",
    teamRuns: [],
    activePromptTemplateId: undefined,
    attachedSkillIds: [],
    promptLibrarySaves: [],
    activeBrowserToolName: "",
    browserEvidence: [],
    notificationEvents: [],
    watchSources: [],
    watchEvents: [],
    restoreManifest: undefined,
    runtimeEvents: [],
    terminalEvents: [],
    loopScheduleEvents: [],
    selectedTaskId: "",
    terminalLines: [],
    prompt: "",
    scratchpadItems: [],
    scratchpadAttachmentIds: [],
    scratchpadDraftPath: ".agent-workspace/scratchpad/current.md",
    scratchpadSavedAt: "",
  };
}
```

- [x] **Step 3: Export**

Modify `src/runtime/opencode/index.ts`:

```ts
export * from "./types";
export * from "./sessionKey";
export * from "./command";
export * from "./resourcePolicy";
export * from "./workspaceState";
```

- [x] **Step 4: Verify**

Run:

```bash
npm test -- src/runtime/opencode/workspaceState.test.ts
```

Expected: pass.

---

## Task 5: Add Real Task Templates And Task-Created Agents

**Files:**
- Create: `src/runtime/opencode/taskTemplates.ts`
- Create: `src/runtime/opencode/taskTemplates.test.ts`
- Modify: `src/runtime/opencode/index.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/taskMachine.ts`
- Modify: `src/pages/TaskBoard.tsx`
- Modify: `src/lib/taskMachine.test.ts`
- Modify: `src/pages/TaskBoard.test.tsx`

- [x] **Step 1: Write task template tests**

Create `src/runtime/opencode/taskTemplates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTaskAgentsFromTemplate, opencodeTaskTemplates } from "./taskTemplates";

describe("opencode task templates", () => {
  it("contains the first real task templates", () => {
    expect(opencodeTaskTemplates.map((template) => template.id)).toEqual([
      "research",
      "product-logic",
      "spec-plan",
      "implementation",
      "debug-fix",
    ]);
  });

  it("creates a conductor agent and template workers for a new task", () => {
    const agents = createTaskAgentsFromTemplate({
      templateId: "spec-plan",
      projectId: "project-runtime-current",
      taskId: "task-real-spec",
      clusterId: "cluster-project-runtime-current-task-real-spec",
      model: "opencode/deepseek-v4-flash-free",
    });

    expect(agents.map((agent) => agent.name)).toEqual(["Conductor", "Planner", "Reviewer"]);
    expect(agents.every((agent) => agent.provider === "opencode")).toBe(true);
    expect(agents.every((agent) => agent.taskId === "task-real-spec")).toBe(true);
  });
});
```

- [x] **Step 2: Implement task templates**

Create `src/runtime/opencode/taskTemplates.ts`:

```ts
import type { Agent, TaskIntakeSource } from "../../types";
import { safeSegment } from "./sessionKey";

export type OpencodeTaskTemplateId = "research" | "product-logic" | "spec-plan" | "implementation" | "debug-fix";

export type OpencodeTaskTemplate = {
  id: OpencodeTaskTemplateId;
  label: string;
  intakeSource: TaskIntakeSource;
  roles: Array<Pick<Agent, "name" | "role" | "accent">>;
};

export const opencodeTaskTemplates: OpencodeTaskTemplate[] = [
  {
    id: "research",
    label: "调研任务",
    intakeSource: "manual-brief",
    roles: [
      { name: "Conductor", role: "Research coordinator", accent: "#111827" },
      { name: "Researcher", role: "Evidence collector", accent: "#2563eb" },
      { name: "Reviewer", role: "Source challenge", accent: "#be123c" },
    ],
  },
  {
    id: "product-logic",
    label: "产品逻辑任务",
    intakeSource: "manual-brief",
    roles: [
      { name: "Conductor", role: "Product coordinator", accent: "#111827" },
      { name: "Planner", role: "Interaction logic", accent: "#2563eb" },
      { name: "Reviewer", role: "Contradiction review", accent: "#be123c" },
    ],
  },
  {
    id: "spec-plan",
    label: "Spec-Plan 任务",
    intakeSource: "watcher",
    roles: [
      { name: "Conductor", role: "Spec coordinator", accent: "#111827" },
      { name: "Planner", role: "Plan author", accent: "#2563eb" },
      { name: "Reviewer", role: "Technical challenge", accent: "#be123c" },
    ],
  },
  {
    id: "implementation",
    label: "代码实现任务",
    intakeSource: "prompt-context",
    roles: [
      { name: "Conductor", role: "Implementation coordinator", accent: "#111827" },
      { name: "Executor", role: "Code implementation", accent: "#0f766e" },
      { name: "QA", role: "Verification", accent: "#b45309" },
    ],
  },
  {
    id: "debug-fix",
    label: "Debug 修复任务",
    intakeSource: "screenshot-prototype",
    roles: [
      { name: "Conductor", role: "Debug coordinator", accent: "#111827" },
      { name: "Executor", role: "Fix implementation", accent: "#0f766e" },
      { name: "QA", role: "Reproduction check", accent: "#b45309" },
    ],
  },
];

export function createTaskAgentsFromTemplate(input: {
  templateId: OpencodeTaskTemplateId;
  projectId: string;
  taskId: string;
  clusterId: string;
  model: string;
}): Agent[] {
  const template = opencodeTaskTemplates.find((item) => item.id === input.templateId) ?? opencodeTaskTemplates[0];
  const roleCounts = new Map<string, number>();
  return template.roles.map((role) => {
    const baseRoleId = safeSegment(role.name.toLowerCase());
    const count = roleCounts.get(baseRoleId) ?? 0;
    roleCounts.set(baseRoleId, count + 1);
    const roleId = count === 0 ? baseRoleId : `${baseRoleId}-${count + 1}`;
    return {
      id: `${input.taskId}-${roleId}`,
      projectId: input.projectId,
      clusterId: input.clusterId,
      taskId: input.taskId,
      name: role.name,
      role: role.role,
      provider: "opencode",
      model: input.model,
      status: "idle",
      accent: role.accent,
      lastActive: "not started",
    };
  });
}
```

- [x] **Step 3: Update Task Home template values**

Modify `src/runtime/opencode/index.ts`:

```ts
export * from "./types";
export * from "./sessionKey";
export * from "./command";
export * from "./resourcePolicy";
export * from "./workspaceState";
export * from "./taskTemplates";
```

Modify `src/pages/TaskBoard.tsx` so the new-task form uses these template ids for user intent.

Use `opencodeTaskTemplates` as the source for template options. Keep `owner` for the current `Task` type, but default it to `Conductor` for task-created agent clusters; do not keep the current misleading `Conductor` select with Planner/Executor/QA/Reviewer options. The Conductor model field should submit `model`, defaulting to `opencode/deepseek-v4-flash-free`.

Derive `intakeSource` from the selected template at submit time instead of storing a separate hidden `intakeSource` state that can drift from `templateId`.

Update the local submit/input type in `TaskBoard.tsx`:

```ts
type TaskIntakeInput = {
  title: string;
  summary: string;
  labels: string[];
  intakeSource: TaskIntakeSource;
  owner: string;
  templateId: string;
  model: string;
  artifactPath?: string;
};
```

Update the `PrototypeAction` branch in `src/types.ts`:

```ts
  | {
      type: "create-task-from-intake";
      title: string;
      summary: string;
      labels: string[];
      intakeSource: TaskIntakeSource;
      owner: string;
      templateId: string;
      model: string;
      artifactPath?: string;
    }
```

- [x] **Step 4: Modify reducer task creation**

Modify `src/lib/taskMachine.ts` `createTaskFromIntake()` so it:

- creates the task,
- creates a task cluster with `createOpencodeTaskClusterId(project.id, task.id)`,
- creates agents with `createTaskAgentsFromTemplate()`,
- resolves `action.templateId` against `opencodeTaskTemplates` and falls back to `opencodeTaskTemplates[0]`,
- trims `action.model` and falls back to the project default opencode model if it is blank,
- derives the next `task-intake-###` suffix by scanning existing task ids and intake event ids, not by trusting `taskIntakeEvents.length + 1`,
- appends the task id, task cluster id, and agent ids to the selected project,
- selects the Conductor agent,
- sets new task `owner` to `Conductor` unless the submit payload explicitly provides another owner,
- does not create any run or PTY session.

Use this reducer shape:

```ts
import {
  createOpencodeTaskClusterId,
  createTaskAgentsFromTemplate,
  opencodeTaskTemplates,
} from "../runtime/opencode";

// inside createTaskFromIntake(), after task and intakeEvent are built:
const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
if (!selectedProject) return state;

const template = opencodeTaskTemplates.find((item) => item.id === action.templateId) ?? opencodeTaskTemplates[0];
const clusterId = createOpencodeTaskClusterId(selectedProject.id, task.id);
const taskCluster = {
  id: clusterId,
  projectId: selectedProject.id,
  name: task.title,
  level: "task" as const,
  taskId: task.id,
  parentClusterId: selectedProject.defaultAgentClusterId,
  agentIds: [],
  evidencePath: `.agent-workspace/tasks/${task.id}/cluster.json`,
};
const agents = createTaskAgentsFromTemplate({
  templateId: template.id,
  projectId: selectedProject.id,
  taskId: task.id,
  clusterId,
  model: action.model,
});
const conductor = agents.find((agent) => agent.name === "Conductor") ?? agents[0];
const agentIds = agents.map((agent) => agent.id);
const populatedTaskCluster = { ...taskCluster, agentIds };

return {
  ...state,
  activeView: "backlog",
  selectedTaskId: task.id,
  selectedAgentClusterId: populatedTaskCluster.id,
  selectedAgentId: conductor?.id ?? "",
  projects: state.projects.map((project) =>
    project.id === selectedProject.id
      ? {
          ...project,
          taskIds: [...project.taskIds, task.id],
          agentClusterIds: [...project.agentClusterIds, populatedTaskCluster.id],
          agentIds: [...project.agentIds, ...agentIds],
        }
      : project,
  ),
  agentClusters: [...state.agentClusters, populatedTaskCluster],
  agents: [...state.agents, ...agents],
  tasks: [...state.tasks, task],
  taskIntakeEvents: [...state.taskIntakeEvents, intakeEvent],
  terminalLines: [
    ...state.terminalLines,
    `task intake: captured ${task.id} from ${action.intakeSource}; created ${template.label} agent sessions`,
  ],
};
```

- [x] **Step 5: Verify**

Run:

```bash
npm test -- src/runtime/opencode/taskTemplates.test.ts src/pages/TaskBoard.test.tsx src/lib/taskMachine.test.ts
```

Expected:

- `taskTemplates.test.ts` passes with five template ids and Conductor-first agent creation.
- `TaskBoard.test.tsx` passes with real template/model submit payload. Full empty-state and visual polish belong to Task 8 closure.
- `taskMachine.test.ts` passes with no created `AgentRun`, no `mock-run-*` ids, selected Conductor agent, and selected task cluster.

---

## Task 6: Remove Runtime App Imports From Mock Data

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/lib/taskMachine.ts`
- Modify: `src/lib/taskMachine.test.ts`
- Modify: `src/lib/auditTrail.test.ts`
- Modify: `src/runtime/taskOrchestrator.ts`
- Modify: `src/pages/TaskBoard.tsx` only if needed to prevent empty runtime boot crashes.
- Modify: `src/pages/Workbench.tsx` only if needed to prevent empty runtime boot crashes.

- [x] **Step 1: Write runtime import guard test**

Add this test to `src/App.test.tsx`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

it("does not import mock data or mock adapters in runtime entry files", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeFiles = ["App.tsx", "lib/taskMachine.ts", "runtime/taskOrchestrator.ts"];

  for (const file of runtimeFiles) {
    const source = readFileSync(resolve(here, file), "utf8");
    expect(source).not.toMatch(/from ["']\.{1,2}\/mock\//);
    expect(source).not.toContain("createMockRuntimeAdapters");
    expect(source).not.toContain("initialPrototypeState");
  }
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected on an unmodified branch: fail because `App.tsx` imports mock state. If earlier partial Task 6 work already removed those imports, this test may pass; continue with the full Task 6 verification below because reducer and audit tests can still fail from stale mock-backed expectations.

- [x] **Step 3: Replace App runtime boot**

Modify `src/App.tsx`:

- remove `changedFiles` and `initialPrototypeState` imports,
- remove `createMockRuntimeAdapters` and `startTaskRun` usage from the App runtime path,
- initialize reducer with `createRuntimeWorkspaceState({ projectPath: "/Users/dinker/CODES/Agent-Workspace", projectName: "Agent Workspace" })`,
- add empty-selection guards before runtime App can boot from that state:
  - `selectedProject` and `selectedAgentCluster` must resolve from the runtime project/default cluster,
  - `selectedTask`, `selectedAgent`, and `selectedRun` must be allowed to be `undefined`,
  - handlers that need a task or agent must return early or render disabled actions when those values are missing,
  - do not dereference `state.tasks[0].id`, `state.agents[0].id`, or `selectedAgent.model` without a guard,
- pass `changedFiles={[]}` to Review until real git adapter wiring is added,
- remove the `./mock/capabilityData` import from `App.tsx`,
- replace capability/mock-backed props in `App.tsx` with runtime empty constants:

```ts
import type {
  BrowserTool,
  LibraryItem,
  McpServer,
  ProductCapability,
  RuntimeContract,
  TeamWorkflow,
  View,
} from "./types";

const runtimeProductCapabilities: ProductCapability[] = [];
const runtimeContracts: RuntimeContract[] = [];
const runtimeMcpServers: McpServer[] = [];
const runtimeBrowserTools: BrowserTool[] = [];
const runtimeLibraryItems: LibraryItem[] = [];
const runtimeTeamWorkflows: TeamWorkflow[] = [];
```

- hide nav entries and cards that only exist to browse mock capability data. Keep the component files unchanged; they are not part of runtime boot if `App.tsx` no longer imports mock data.
- remove `../mock/capabilityData` from `src/lib/taskMachine.ts` by using runtime empty arrays for MCP/library/team/browser helper lookups until those real adapters exist.
- remove runtime use of `src/runtime/taskOrchestrator.ts` from `App.tsx`; keep `taskOrchestrator.ts` pure and free of mock imports. If it remains unused, do not delete it in this task.
- the default runtime App must show a usable no-task Task Home shell when no task exists. Full Task Home label/copy/visual polish belongs to Task 8 closure.

Do not delete or edit `public/mockups/*` or `src/mock/*` in this task. They are design/test assets and are outside the runtime import path.

- [x] **Step 4: Update stale reducer and audit tests for the real empty-adapter boundary**

Update `src/lib/taskMachine.test.ts` so tests that previously depended on mock-backed helper arrays assert the new runtime boundary:

- `inject-library-prompt` and `attach-library-skill` return the same state when `libraryItems` is empty.
- `select-browser-tool` and `capture-browser-evidence` return the same state when `browserTools` is empty.
- `select-team-workflow`, `start-team-run`, and `advance-team-run` return the same state when `teamWorkflows` is empty.
- `select-mcp-server`, `request-mcp-tool-call`, and `resolve-mcp-tool-call` return the same state when `mcpServers` is empty.
- Existing tests for `create-task-from-intake`, project selection, task selection, native session evidence, verification, and review gates should continue to assert real task state behavior.

Update `src/lib/auditTrail.test.ts` so the audit trail test does not rely on `capture-browser-evidence` creating fixture-backed evidence. Inject explicit browser evidence state before calling `buildWorkspaceAuditTrail()`:

```ts
const withBrowserEvidence = {
  ...withTransition,
  browserEvidence: [
    ...withTransition.browserEvidence,
    {
      id: "browser-evidence-task-browser-001",
      taskId: "task-browser",
      toolName: "browser_screenshot",
      summary: "Captured browser_screenshot for task-browser.",
      artifactPath: ".agent-workspace/browser/task-browser/browser_screenshot-001.json",
      capturedAt: "2026-06-24T14:20:00Z",
    },
  ],
};
```

Keep the browser evidence assertion in this audit test. The reducer should no-op without a real Browser adapter, but `buildWorkspaceAuditTrail()` should still prove it can normalize browser evidence when a real Browser adapter later writes it.

- [x] **Step 5: Verify no runtime mock imports and no stale tests**

Run:

```bash
if rg -n "from \"\\./mock|from \"\\.\\./mock|createMockRuntimeAdapters|initialPrototypeState" src/App.tsx src/lib/taskMachine.ts src/runtime/taskOrchestrator.ts; then
  echo "unexpected runtime mock import"
  exit 1
fi
npm test -- src/App.test.tsx src/lib/taskMachine.test.ts src/lib/auditTrail.test.ts
npm test
npm run build
```

Expected:

- `rg` returns no matches in the checked runtime entry files,
- focused tests pass with empty runtime initial state and real empty-adapter no-op expectations,
- full test suite passes,
- production build passes.

---

## Task 7: Route Agent Start Through Real Opencode PTY

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/runtime/nativeBridge.ts`
- Modify: `src/runtime/opencode/command.ts` only if the command builder needs a missing TUI option.
- Modify: `desktop/main.cjs`
- Modify: `desktop/preload.cjs`
- Modify: `desktop/opencode-runner.cjs` only if opencode binary resolution or one-shot runner behavior changes.
- Modify: `desktop/opencode/process-inspector.cjs` only if process inspection behavior changes.
- Test: `src/App.test.tsx`
- Test: `src/pages/Workbench.test.tsx`
- Test: `src/runtime/nativeBridge.test.ts`
- Test: `desktop/opencode/*.test.mjs`
- Test: `desktop/opencode-runner.test.mjs`

Current code already contains the Task 7 implementation. Treat this task as an acceptance/closure task, not a fresh rewrite.

- [x] **Step 1: Cover new task to real PTY start**

`src/App.test.tsx` must keep coverage for these cases:

- empty runtime boot,
- task creation creates task-scoped Conductor/worker agents,
- selecting Executor and returning to Task Home still starts the current task Conductor,
- bound native opencode agent names change the `--agent` argument without changing product agent ids,
- stopped PTY deltas attach merged transcript evidence instead of raw delta-only evidence.

The expected `startPty()` input shape for Conductor remains:

```ts
expect(startPtyInput).toMatchObject({
  id: "opencode:project-runtime-current:<created-task-id>:<conductor-agent-id>",
  command: expect.stringMatching(/opencode$/),
  args: ["--model", "opencode/deepseek-v4-flash-free", "--agent", "conductor"],
  cwd: "/Users/dinker/CODES/Agent-Workspace",
  model: "opencode/deepseek-v4-flash-free",
  requirePty: true,
});
```

Important boundary: the `id` above is the Agent Workspace PTY session id. Do not pass that id to `opencode --session` for a new TUI. A real smoke test showed arbitrary `--session <workspace-key>` makes opencode exit with `Invalid session ID`; opencode session restore must be implemented separately from new TUI launch.

- [x] **Step 2: Keep App start handler on the opencode adapter boundary**

`src/App.tsx` must keep this boundary:

- `startNativePtyForTaskAgent(agent)` derives the session key through `createOpencodeSessionKey()`.
- `startNativePtyForTaskAgent(agent)` builds argv through `buildOpencodeTuiCommand()`.
- `startNativePtyForTaskAgent(agent)` passes `command`, `args`, `cwd`, model, terminal size, `stdin: "pipe"`, and `requirePty: true` to `startNativePtySession()`.
- `startNativePtyForSelectedTask()` starts the globally selected Workbench agent.
- `startNativePtyForSelectedTaskConductor()` starts `selectedTaskConductorAgent`, even when the Workbench selected agent is Executor/QA/Reviewer.
- `storeNativePtySession()` and `storeNativePtyDelta()` update `nativePtySessionsRef` and `nativePtySessionsByKey` with a merged `NativePtySession` before attaching evidence.
- `src/lib/taskMachine.ts` only receives `attach-native-session-evidence` or `runtime-start-failed`; reducers and pure runtime modules do not call the native bridge.

Do not restore a freeform editable Workbench command input unless `startNativePtySession()` actually launches the user-edited command. The current honest UI is a read-only `Agent 启动命令预览`.

- [x] **Step 3: Keep process inspection bridge wired**

`src/runtime/nativeBridge.ts` must expose:

```ts
import type { OpencodeProcessStat } from "./opencode";

export type NativeOpencodeProcessInspection = {
  ok: boolean;
  processes: OpencodeProcessStat[];
  error?: string;
};
```

`window.agentWorkspace.native` must include:

```ts
inspectOpencodeProcesses?(): Promise<NativeOpencodeProcessInspection>;
```

Renderer helper:

```ts
export async function inspectNativeOpencodeProcesses(): Promise<NativeOpencodeProcessInspection> {
  return window.agentWorkspace?.native.inspectOpencodeProcesses?.() ?? {
    ok: false,
    processes: [],
    error: browserRuntimeStatus.message,
  };
}
```

`desktop/preload.cjs` exposes `inspectOpencodeProcesses()`. `desktop/main.cjs` handles `native:inspect-opencode-processes` through `desktop/opencode/process-inspector.cjs`.

- [x] **Step 4: Final acceptance verification**

Before checking Task 7 complete, run these commands and request one final quality review:

Run:

```bash
npm test -- src/App.test.tsx src/pages/Workbench.test.tsx src/runtime/nativeBridge.test.ts
node --test desktop/opencode/*.test.mjs
npm test
npm run build
```

Completed evidence:

- `npm test -- src/App.test.tsx src/pages/TaskBoard.test.tsx src/pages/Workbench.test.tsx src/runtime/nativeBridge.test.ts`: passed, 32 tests.
- `node --test desktop/pty-manager.test.mjs desktop/opencode/*.test.mjs`: passed, 11 tests.
- Task 7 checkpoint `npm test`: passed, 36 files / 247 tests. The later Task 9 documentation test raises the current full-suite count to 248 tests.
- `npm run build`: passed.
- Spec review approved Task 7.
- Quality review initially found duplicate same-key PTY start risk. The fix added desktop idempotent live-session start, `stopping` lifecycle handling, renderer duplicate-start guards, disabled/relabelled start buttons for live sessions, and regression tests. Quality re-review approved.

---

## Task 8: Update Task Home Empty State And New Task UX

**Files:**
- Modify: `src/pages/TaskBoard.tsx`
- Modify: `src/pages/TaskBoard.test.tsx`
- Modify: `src/styles.css`

Current code already contains the first real Task Home implementation. Treat this task as UX closure and verification, not a full rewrite.

- [x] **Step 1: Keep Task Home empty-state and intake tests**

`src/App.test.tsx` and `src/pages/TaskBoard.test.tsx` must continue to cover:

- empty runtime boot shows `还没有任务`,
- `Conductor Terminal` and `Task Conductor` are absent before task creation,
- new-task form includes template, model, labels, and artifact path,
- submitting task calls `onCreateTaskFromIntake` with `templateId`, derived `intakeSource`, `owner: "Conductor"`, model, labels, and artifact path,
- Conductor input sends through PTY handlers with Enter,
- Shift+Enter remains newline,
- worker agent terminal buttons route into IDE Workbench.

- [x] **Step 2: Keep implemented empty and selected-task states**

`src/pages/TaskBoard.tsx` currently has:

- empty-state sidebar and main panel,
- `TaskIntakePanel`,
- selected-task `Conductor Terminal`,
- worker agent cards,
- `Conductor 进展`,
- task context/evidence panel.

- [x] **Step 3: Finish copy, labels, and layout polish**

Do not modify or delete `public/mockups/task-home-playground.html`. Update only the real React page and tests.

Required Task Home form labels:

- `任务标题`,
- `任务目标`,
- `任务模板`,
- `Conductor 模型`,
- `标签`,
- `附件路径`.

Completed label change: `Conductor model` was changed to `Conductor 模型` in both visible text and `aria-label`, with tests updated from `screen.getByLabelText("Conductor model")` to `screen.getByLabelText("Conductor 模型")`.

Template options:

- `调研任务`,
- `产品逻辑任务`,
- `Spec-Plan 任务`,
- `代码实现任务`,
- `Debug 修复任务`.

Copy rule: keep this page operational. Avoid explanatory product-strategy copy that reads like a presentation. Empty copy should tell the user what action is available, not explain the prototype.

Completed evidence:

- `src/pages/TaskBoard.tsx` now uses `任务模板` and `Conductor 模型`.
- Empty state copy was changed from product/prototype explanation to action-oriented task creation copy.
- `src/pages/TaskBoard.test.tsx` now targets `Conductor 模型`.
- `npm test -- src/pages/TaskBoard.test.tsx src/App.test.tsx`: passed, 19 tests.

- [x] **Step 4: Verify Task Home UX**

Run:

```bash
npm test -- src/pages/TaskBoard.test.tsx
npm test -- src/App.test.tsx
npm run build
```

Expected:

- focused Task Home tests pass,
- App integration tests pass,
- build passes,
- no visible horizontal overflow at desktop width 1360 and mobile/narrow browser widths,
- no internal scrollbar appears for the current template-generated Conductor plus worker cards.

Current evidence:

- `npm test`: passed, 36 files / 248 tests after Task 9 documentation coverage was added.
- `npm run build`: passed.
- Static CSS review shows `.task-home-layout` uses `minmax(0, 1fr)` responsive grids, switches to one column under 860px, and `.worker-agent-grid` uses `repeat(auto-fit, minmax(min(230px, 100%), 1fr))`.
- `npm run desktop:layout-smoke`: passed. Evidence: real Electron/Chromium loaded `http://127.0.0.1:5188/`, empty state had `还没有任务` and the new-task form, task creation with the `implementation` template produced `Conductor Terminal`, `Executor`, and `QA`, no visible `mock|mocked|mock-run` text, no horizontal overflow at 1360px or 430px widths, and no internal scrollbar in the worker card grid.

---

## Task 9: Remove Runtime Mock Flow Text And Guardrails

**Files:**
- Modify: `src/lib/taskMachine.ts`
- Modify: `src/runtime/taskOrchestrator.ts`
- Modify: `src/pages/CapabilityMap.tsx`
- Modify: `src/App.tsx`
- Modify: `src/runtime/contracts.ts` only if the fixture adapter contract is promoted into the runtime App path.
- Modify: `src/lib/productIntentDocs.test.ts`

Do not remove mockup or fixture files in this task. The target is runtime-visible text and runtime imports only. `src/runtime/mockAdapters.ts` and `src/runtime/contracts.ts` may remain as fixture-support modules if no runtime App path imports them. If `src/runtime/contracts.ts` becomes a runtime App dependency, rename its `mode: "mocked"` vocabulary in the same task.

- [x] **Step 1: Search runtime-visible mock text**

Run:

```bash
if rg -n "mock|mocked|mock-run|shell mock|fake|prototypeData|mockAdapters" src/App.tsx src/pages src/lib src/runtime \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  --glob '!src/mock/**' \
  --glob '!src/runtime/mockAdapters.ts' \
  --glob '!src/runtime/contracts.ts'; then
  echo "unexpected runtime-visible mock text"
  exit 1
fi
```

Expected: no matches in runtime-visible source files. Matches in test files, `src/mock/*`, `src/runtime/mockAdapters.ts`, `src/runtime/contracts.ts`, and product documentation tests are allowed because they are intentionally excluded or fixture-only.

Do not run this search against `public/mockups/*`; those files intentionally preserve prototype states.

- [x] **Step 2: Remove runtime mock text**

Update runtime-visible strings:

- `mock-to-native` -> `runtime readiness`,
- `mocked` adapter cards -> hidden from runtime app,
- `mock run created` -> removed from reducer terminal lines,
- `mock 不能暗示已经真实启动 CLI` -> removed from runtime task data by removing fixture boot.

In `src/lib/taskMachine.ts`, replace `sendPrompt()` fake agent response with a real terminal-bound behavior:

```ts
export function sendPrompt(state: PrototypeState): PrototypeState {
  const cleaned = state.prompt.trim();
  if (!cleaned) return state;

  return {
    ...state,
    prompt: "",
    terminalLines: [...state.terminalLines, `> ${cleaned}`],
  };
}
```

Actual model I/O is handled by `writeNativePtySession()` in `src/App.tsx`; the reducer only records local user input text.

Source hits removed or re-scoped:

- `src/App.tsx`: `mock-to-native` product-map copy.
- `src/lib/taskMachine.ts`: `${selectedAgent.name}: mock run created, baseline captured, verification gate pending.`
- `src/pages/CapabilityMap.tsx`: `replace mock ...` and `replace mocked ...` capability-map copy.

Completed changes:

- `src/App.tsx` uses `runtime readiness` copy instead of `mock-to-native`.
- `src/lib/taskMachine.ts` `sendPrompt()` now records only the user input line and does not create fake run/progress text.
- `src/pages/CapabilityMap.tsx` uses native/runtime readiness wording instead of replace-mock wording.
- Tests were updated to assert the new copy and terminal-bound prompt behavior.

- [x] **Step 3: Keep design docs accurate**

Update `docs/superworks/spec/product-interaction-map.md` with a new section:

```md
## Opencode Runtime Boundary

The runtime app no longer boots from prototype mock state. Task Home creates real task records, task-scoped opencode agent session records, and launches real opencode PTY sessions through the desktop bridge. The shell manages session identity, process bounds, transcript evidence, and review handoff. Opencode owns the interactive TUI behavior.
```

Completed documentation:

- `docs/superworks/spec/product-interaction-map.md` now has `## Opencode Runtime Boundary`.
- The section records real Task Home sessions, desktop PTY launch, duplicate-start protection, and opencode-owned TUI behavior.
- `src/lib/productIntentDocs.test.ts` verifies the new section.

- [x] **Step 4: Verify**

Run:

```bash
if rg -n "mock|mocked|mock-run|shell mock|fake|prototypeData|mockAdapters" src/App.tsx src/pages src/lib src/runtime \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  --glob '!src/mock/**' \
  --glob '!src/runtime/mockAdapters.ts' \
  --glob '!src/runtime/contracts.ts'; then
  echo "unexpected runtime-visible mock text"
  exit 1
fi
npm test
npm run build
```

Expected: pass.

Completed evidence:

- Runtime mock-text guard passed with no matches in checked runtime-visible files.
- `npm test -- src/lib/taskMachine.test.ts src/pages/CapabilityMap.test.tsx src/lib/productIntentDocs.test.ts`: passed, 117 tests.
- `npm test`: passed, 36 files / 248 tests.
- `npm run build`: passed.

---

## Task 10: Browser And Desktop Smoke Verification

**Files:**
- Modify when smoke reveals a real bug: `src/runtime/opencode/command.ts`, `src/runtime/opencode/command.test.ts`, `src/App.tsx`, `src/App.test.tsx`.
- Create: `desktop/task-home-layout-smoke.cjs`
- Create: `desktop/task-home-native-smoke.cjs`
- Modify: `package.json`

Current completed smoke-driven fix:

- Removed arbitrary `--session <workspace-key>` from new opencode TUI argv.
- Kept `createOpencodeSessionKey()` as the internal Agent Workspace PTY session id passed to `startNativePtySession({ id })`.
- Verified that direct `opencode --model opencode/deepseek-v4-flash-free --agent plan` under `node-pty` starts a live TUI process, while the previous `--session <workspace-key>` path exited with `Invalid session ID`.

- [x] **Step 1: Start or verify the dev server**

Run:

```bash
npm run dev
```

Expected:

```text
Local: http://127.0.0.1:5188/
```

If a server is already running on `5188`, verify it is serving the current app instead of starting a second server:

```bash
node -e "fetch('http://127.0.0.1:5188/').then(async (r) => { const text = await r.text(); console.log(r.status, text.includes('root') || text.includes('Agent Workspace')); process.exit(r.ok ? 0 : 1); }).catch((error) => { console.error(error); process.exit(1); })"
```

Expected: status `200` and a truthy app marker.

Completed evidence:

- Dev server was already listening on `http://127.0.0.1:5188/`.
- `node -e "fetch('http://127.0.0.1:5188/')..."`: passed with `{"status":200,"ok":true,"hasRoot":true,"hasAgentWorkspace":true}`.

- [x] **Step 2: Browser smoke**

Open `http://127.0.0.1:5188/` and verify:

- no preloaded tasks,
- no preloaded agents,
- new task form is visible,
- creating a task shows Conductor and template worker cards,
- no visible `mock`, `mocked`, or `mock-run` strings.

Minimum acceptable evidence:

- record the browser URL used,
- record the selected template,
- record that the first task creates one Conductor plus the template worker agents,
- record that the current template-generated Conductor plus worker cards have no internal scrollbar,
- record whether desktop-width and narrow-width layouts have horizontal overflow.

Completed evidence:

- `npm run desktop:layout-smoke`: passed.
- URL used: `http://127.0.0.1:5188/`.
- Selected template: `implementation`.
- Created task showed `Conductor Terminal`, `Executor`, and `QA`.
- Worker grid: `cardCount: 2`, `internalScrollbar: false`.
- Desktop width 1360: `horizontalOverflow: false`.
- Narrow width 430: `horizontalOverflow: false`.
- Visible runtime mock text: `false`.

- [x] **Step 3: Electron bridge smoke**

Run:

```bash
npm run desktop:smoke
```

Expected JSON fields:

- `ok: true`,
- `status.available: true`,
- `status.ptyAvailable: true`,
- `session.backend: "pty"`,
- `session.transcript` contains `electron-write-ok`.

Completed evidence:

- `npm run desktop:smoke`: passed with `ok: true`.
- Runtime status: `available: true`, `ptyAvailable: true`, `ptyBackend: "node-pty+process-fallback"`, `opencodePath: "/opt/homebrew/bin/opencode"`, `opencodeVersion: "1.17.11"`.
- PTY bridge session: `backend: "pty"`, transcript contained `electron-write-ok`.

- [x] **Step 4: Desktop UI smoke**

Run:

```bash
npm run desktop:start
```

Verify:

- native runtime status finds opencode,
- creating a task works,
- starting Conductor opens a real opencode TUI,
- stopping the session updates native session state without writing PTY evidence files.

Completed evidence:

- `npm run desktop:task-home-native-smoke`: passed.
- The smoke loaded the real Task Home with Electron preload, created an `implementation` task, clicked the UI `启动 Conductor PTY` button, observed opencode process count `0 -> 1`, stopped the session through the desktop bridge, and observed process count `1 -> 0`.
- Session id: `opencode:project-runtime-current:task-intake-001:task-intake-001-conductor`.
- Running session: `status: "running"`, `backend: "pty"`.
- Stopped session: `status: "stopped"`.

- [x] **Step 5: Resource smoke**

Record the baseline count through the project process inspector:

```bash
before=$(node -e "const { inspectOpencodeProcesses } = require('./desktop/opencode/process-inspector.cjs'); console.log(inspectOpencodeProcesses().length)")
printf '%s' "$before" > /tmp/agent-workspace-opencode-baseline-count
echo "before=$before"
```

Then start one Conductor session and verify the count increases by one, not by number of agent cards.

Run:

```bash
before=$(cat /tmp/agent-workspace-opencode-baseline-count)
after=$(node -e "const { inspectOpencodeProcesses } = require('./desktop/opencode/process-inspector.cjs'); console.log(inspectOpencodeProcesses().length)")
echo "after=$after"
test "$after" -eq "$((before + 1))"
```

Expected:

```text
Agent card count can be greater than live opencode process count.
```

After stopping the Conductor session, run:

```bash
before=$(cat /tmp/agent-workspace-opencode-baseline-count)
stopped=$(node -e "const { inspectOpencodeProcesses } = require('./desktop/opencode/process-inspector.cjs'); console.log(inspectOpencodeProcesses().length)")
echo "stopped=$stopped"
test "$stopped" -le "$before"
```

Expected: stopping the Task Home Conductor session returns to the baseline opencode process count and does not leave an additional long-lived process.

Completed evidence:

- Direct PTY resource smoke after removing arbitrary `--session`: passed with `before: 0`, `after: 1`, `stopped: 0`.
- `npm run desktop:task-home-native-smoke`: passed with `before: 0`, `after: 1`, `stopped: 0`.

---

## Task 11: Project-Aware Task Creation Auto-Starts Conductor

**Files:**
- Modify: `src/types.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/taskMachine.ts`
- Modify: `src/pages/TaskBoard.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`
- Modify: `src/pages/TaskBoard.test.tsx`
- Modify: `src/pages/CapabilityMap.tsx`
- Modify: `src/pages/CapabilityMap.test.tsx`
- Modify: `src/lib/productIntentDocs.test.ts`
- Modify: `src/mock/capabilityData.ts`
- Modify: `docs/superworks/spec/product-interaction-map.md`

The user-facing scenario:

```text
Project path: /Users/dinker/CODES/TEMP_project/Agent_Test
Task: 调研claude dynamic workflow 的机制
Expected: creating the task starts the task Conductor in that project folder.
```

- [x] **Step 1: Add project switch action**

Add a reducer action that replaces the current runtime workspace from a selected project path/name. Keep the action pure; native PTY cleanup and bridge calls stay in `src/App.tsx`.

Completed changes:

- `PrototypeAction` now includes `open-runtime-project`.
- `taskMachine.ts` routes `open-runtime-project` to `createRuntimeWorkspaceState({ projectPath, projectName })`.
- `App.tsx` exposes `openRuntimeProject()` and clears renderer-held native PTY/session UI state before dispatching the project switch.

- [x] **Step 2: Add Task Home project control**

Add a compact project control to the Task Home sidebar. It must show the active project, allow typing a project path and optional display name, derive the display name from the folder basename when omitted, and avoid changing `public/mockups/*`.

Completed changes:

- `TaskBoard.tsx` renders `ProjectControl` in the Task Home sidebar.
- The control uses labels `项目路径` and `项目名称`.
- Submitting calls `onOpenRuntimeProject({ projectPath, projectName })`.
- The control resets its form state when the selected project changes.

- [x] **Step 3: Make task creation start Conductor**

Task intake is no longer queued-only. It records a running task, creates task-scoped Conductor/worker records, selects the task, and lets `App.tsx` auto-start the task Conductor PTY when desktop runtime is available.

Completed changes:

- `TaskIntakePanel` copy now says `创建任务并启动 Conductor` and the submit button says `创建并启动`.
- `taskMachine.ts` continues to create task-scoped agents from the selected template and records intake evidence before PTY evidence.
- `App.tsx` auto-starts the selected task Conductor once per task id and writes the initial task context into the PTY.

- [x] **Step 4: Align product intent and capability map**

Update the durable product map so it no longer claims Task Intake is queued-only or forbidden from starting PTY. The correct boundary is: Task Intake may start the task Conductor, but must not fabricate `AgentRun`, bypass Review, mark Done, or write runtime state into product-intent files.

Completed changes:

- `docs/superworks/spec/product-interaction-map.md` records Task Intake as executable work with Conductor auto-start evidence.
- `CapabilityMap.tsx` and capability fixture data use `Create and start task`, running task status, and no fabricated run/review guardrails.
- Product intent tests assert the new boundary.

- [x] **Step 5: Verify with the Agent_Test scenario**

Run:

```bash
npm test -- --run src/pages/CapabilityMap.test.tsx src/lib/productIntentDocs.test.ts src/pages/TaskBoard.test.tsx src/App.test.tsx src/lib/taskMachine.test.ts src/lib/capabilityMap.test.ts
npm test
npm run build
npm run desktop:layout-smoke
AGENT_WORKSPACE_PROJECT_PATH='/Users/dinker/CODES/TEMP_project/Agent_Test' \
AGENT_WORKSPACE_PROJECT_NAME='Agent_Test' \
AGENT_WORKSPACE_TASK_TITLE='调研claude dynamic workflow 的机制' \
AGENT_WORKSPACE_TASK_SUMMARY='调研 claude dynamic workflow 的机制，并输出可读的机制说明和后续 spec/plan 线索。' \
AGENT_WORKSPACE_TASK_TEMPLATE='research' \
npm run desktop:task-home-native-smoke
```

Completed evidence:

- Focused tests passed: 6 files / 149 tests.
- Full tests passed: 36 files / 252 tests.
- `npm run build`: passed.
- `npm run desktop:layout-smoke`: passed with no horizontal overflow and no worker-card internal scrollbar at desktop or narrow widths.
- Agent_Test native smoke passed with `before: 0`, `after: 1`, `stopped: 0`.
- Started session id: `opencode:project-runtime-current:task-intake-001:task-intake-001-conductor`.
- Started session cwd: `/Users/dinker/CODES/TEMP_project/Agent_Test`.
- Started argv: `--model opencode/deepseek-v4-flash-free --agent conductor`.
- The smoke stopped the PTY and returned the opencode process count to baseline.

---

## Task 12: Opencode-Backed Task Draft Assistant

**Files:**
- Modify: `src/runtime/nativeBridge.ts`
- Modify: `desktop/main.cjs`
- Modify: `desktop/preload.cjs`
- Create: `desktop/task-draft-assistant.cjs`
- Create: `desktop/task-draft-assistant.test.mjs`
- Create: `desktop/task-draft-native-smoke.cjs`
- Create: `src/components/PtyTerminal.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/pages/TaskBoard.tsx`
- Modify: `src/pages/TaskBoard.test.tsx`
- Modify: `src/pages/Workbench.tsx`
- Modify: `src/styles.css`
- Modify: `src/lib/productIntentDocs.test.ts`
- Modify: `desktop/task-home-native-smoke.cjs`
- Modify: `package.json`
- Modify: `docs/superworks/spec/product-interaction-map.md`

The user-facing scenario:

```text
User says one sentence in the Task Home assistant panel.
Backend calls opencode headless.
Returned JSON fills the new-task form on the right.
Follow-up messages patch the same visible draft.
Only the final Create and Start button creates the task and starts Conductor.
```

- [x] **Step 1: Add native Task Draft bridge**

Add `generateTaskDraft` to the desktop preload bridge and expose it through `generateNativeTaskDraft()` in `src/runtime/nativeBridge.ts`.

Completed changes:

- `NativeTaskDraft`, `NativeTaskDraftInput`, and `NativeTaskDraftResult` describe the headless draft boundary.
- `desktop/main.cjs` registers `native:generate-task-draft`.
- `desktop/preload.cjs` exposes `generateTaskDraft`.
- Browser fallback returns an unavailable result instead of starting terminal state.

- [x] **Step 2: Implement opencode headless adapter**

Task Draft Assistant uses opencode as a one-shot backend call, not PTY/TUI.

Completed changes:

- `desktop/task-draft-assistant.cjs` builds a schema-bound prompt for opencode.
- It calls existing `runOpencode()` so the path remains normal child-process headless execution.
- It parses strict JSON, fenced JSON, JSON lines, and simple nested opencode message shapes.
- It validates supported `templateId` values and normalizes draft fields.

- [x] **Step 3: Wire Task Home AI panel to the intake draft**

The left panel owns assistant dialogue. The right panel owns editable executable configuration.

Completed changes:

- `TaskBoard.tsx` renders `TaskDraftAssistantPanel` beside a controlled `TaskIntakePanel`.
- AI generation fills task title, summary, template, model, labels, and artifact path.
- AI generation can switch the active project if the draft includes `projectPath`.
- Follow-up messages send `currentDraft` and patch the same visible form.
- The final submit still calls `create-task-from-intake`; assistant generation itself does not create tasks.

- [x] **Step 4: Verify**

Run:

```bash
npm test -- --run src/pages/TaskBoard.test.tsx src/App.test.tsx src/runtime/nativeBridge.test.ts desktop/task-draft-assistant.test.mjs
npm test -- --run src/lib/productIntentDocs.test.ts
npm test
npm run build
npm run desktop:layout-smoke
npm run desktop:task-draft-native-smoke
AGENT_WORKSPACE_PROJECT_PATH='/Users/dinker/CODES/TEMP_project/Agent_Test' \
AGENT_WORKSPACE_PROJECT_NAME='Agent_Test' \
AGENT_WORKSPACE_TASK_TITLE='调研claude dynamic workflow 的机制' \
AGENT_WORKSPACE_TASK_SUMMARY='调研 claude dynamic workflow 的机制，并输出可读的机制说明和后续 spec/plan 线索。' \
AGENT_WORKSPACE_TASK_TEMPLATE='research' \
npm run desktop:task-home-native-smoke
```

Expected:

- AI assistant focused tests pass.
- Product intent docs record Task Draft Assistant as a pre-intake headless configuration layer.
- Full tests and build pass.
- Layout smoke shows no horizontal overflow after adding the assistant panel.
- Existing Agent_Test native smoke still starts only the task Conductor after user-confirmed task creation.
- Task Draft native smoke proves page button -> preload -> IPC -> opencode headless -> right-side form fill.
- Task Home native smoke proves Conductor PTY output is rendered by xterm and does not leak raw ANSI control sequences into page text.

Completed evidence:

- Focused AI assistant tests passed: 4 files / 35 tests, then `desktop/task-draft-assistant.test.mjs` passed with 4 parser/adapter tests after adding real opencode JSONL `part.text` coverage.
- Focused Task Home/Workbench terminal tests passed: 2 files / 14 tests.
- Product intent doc test passed: 1 file / 55 tests.
- A direct local `generateTaskDraft()` call against opencode returned `ok: true` for `/Users/dinker/CODES/TEMP_project/Agent_Test`, with title `Claude Dynamic Workflow 机制调研`, template `research`, model `opencode/deepseek-v4-flash-free`, and labels `research`, `dynamic-workflow`, `claude`.
- Full test suite passed: 37 files / 260 tests.
- `npm run build`: passed.
- `npm run desktop:layout-smoke`: passed with no horizontal overflow at desktop or narrow widths after adding the assistant panel.
- Agent_Test native smoke passed with `before: 0`, `after: 1`, `stopped: 0`, cwd `/Users/dinker/CODES/TEMP_project/Agent_Test`, and argv `--model opencode/deepseek-v4-flash-free --agent conductor`.
- `npm run desktop:task-draft-native-smoke`: passed. The visible Task Home assistant button invoked `native:generate-task-draft`, opencode filled title `Claude Dynamic Workflow 机制调研`, template `research`, labels `research, workflow, claude`, and preserved the `/Users/dinker/CODES/TEMP_project/Agent_Test` project path.
- Agent_Test native smoke passed again after the terminal renderer fix with `before: 1`, `after: 2`, `stopped: 1`, cwd `/Users/dinker/CODES/TEMP_project/Agent_Test`, argv `--model opencode/deepseek-v4-flash-free --agent conductor`, `terminalTextCheck.hasXterm: true`, and `terminalTextCheck.leaksAnsi: false`.
- Runtime mock-text guard passed with no matches in checked runtime-visible files.

---

## Self-Review

**Spec coverage:** The plan covers opencode adapter isolation, runtime mock removal, real task creation from Task Home, opencode-backed task draft generation, project-aware task intake, task-scoped agent session creation, real opencode PTY launch, Task Home Conductor terminal behavior, and the browser/desktop smoke checks needed before calling the runtime path complete.

**Placeholder scan:** The plan avoids open-ended placeholders and gives exact files, tests, commands, and expected outcomes. Existing unchecked steps now represent remaining closure work, not vague future intentions.

**Code alignment:** The plan accounts for the current `src/types.ts` `PrototypeState` shape through `createRuntimeWorkspaceState()`. It records the current implementation state: `src/App.tsx` boots from the real runtime workspace, agent PTY launch uses `createOpencodeSessionKey()` as the internal PTY id and `buildOpencodeTuiCommand()` for opencode argv, Task Home Conductor is separated from Workbench selected agent state, Workbench launch command is a read-only preview, duplicate same-key PTY starts are guarded in renderer and desktop lifecycle code, `TaskBoard.tsx` has empty-state/new-task/Conductor-terminal behavior, and Task Home plus Workbench share `src/components/PtyTerminal.tsx` so opencode TUI output is handled by xterm rather than raw `<pre>` text. The final visual and runtime smoke gates now have recorded evidence.

**Type consistency:** `OpencodeCommandSpec`, `OpencodeProcessStat`, `OpencodeResourcePolicy`, `createOpencodeSessionKey`, `createOpencodeTaskClusterId`, `safeSegment`, `createRuntimeWorkspaceState`, and `createTaskAgentsFromTemplate` are introduced before later tasks use them. `PrototypeAction` carries `templateId: string` so `src/types.ts` does not depend on opencode runtime modules; `src/lib/taskMachine.ts` resolves that string against `opencodeTaskTemplates`.

**Scope control:** This plan does not implement Review, Runs, Browser, MCP, or Git as real adapters. Runtime `App.tsx` must hide unsupported mock-backed surfaces or feed them explicit empty runtime arrays until real adapters exist. Runtime de-mocking must not delete `public/mockups/*`, `src/mock/*`, `src/runtime/mockAdapters.ts`, `src/runtime/contracts.ts`, or research/design assets.

**Execution readiness:** This plan is complete. Future work should start from a new plan task or a new bug entry if any recorded smoke command regresses.
