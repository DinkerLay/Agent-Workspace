import type { AgentRun, VerificationEvidence } from "../types";
import { createRunWorktreeContext } from "../lib/worktreeContext";
import { createRunRuntimePolicy } from "../lib/runtimePolicy";
import type {
  CommitProposalInput,
  FilesystemWatchAdapter,
  GitBaseline,
  GitServiceAdapter,
  IntentChangeKind,
  PtyServiceAdapter,
  PtySession,
  RunFileAttribution,
  RunStoreAdapter,
  RuntimeAdapterCard,
  RuntimeAdapters,
} from "./contracts";

export function createMockRuntimeAdapters(): RuntimeAdapters {
  const runStore = createMockRunStore();
  const ptyService = createMockPtyService();
  const gitService = createMockGitService();
  const filesystemWatch = createMockFilesystemWatch();

  return {
    runStore,
    ptyService,
    gitService,
    filesystemWatch,
  };
}

export function getRuntimeAdapterCards(): RuntimeAdapterCard[] {
  return [
    {
      id: "run-store",
      label: "Run Store Adapter",
      mode: "mocked",
      contract: "create/get/update run records, transcripts, verification evidence",
      nextNativeStep: "Persist AgentRun artifacts under .agent-workspace/runs/<run-id>/",
    },
    {
      id: "pty-service",
      label: "PTY Service Adapter",
      mode: "mocked",
      contract: "spawn/write/resize/stop agent PTY sessions",
      nextNativeStep: "Bind to desktop runtime PTY process manager",
    },
    {
      id: "git-service",
      label: "Git Service Adapter",
      mode: "mocked",
      contract: "capture baseline, attribute files, build commit proposal",
      nextNativeStep: "Call local git status/diff/commit APIs",
    },
    {
      id: "filesystem-watch",
      label: "Filesystem Watch Adapter",
      mode: "mocked",
      contract: "watch docs product-intent files and create planner task inputs",
      nextNativeStep: "Attach native watcher to durable product-intent roots",
    },
  ];
}

function createMockRunStore(): RunStoreAdapter {
  const runs = new Map<string, AgentRun>();

  return {
    createRun(input) {
      const runNumber = getRunCountForTask(runs, input.taskId) + 1;
      const id = `mock-run-${input.taskId}-${String(runNumber).padStart(3, "0")}`;
      const run: AgentRun = {
        id,
        taskId: input.taskId,
        agentId: input.agentId,
        status: "running",
        startGitSha: "abc1234",
        startedAt: "2026-06-24T14:45:00Z",
        promptPath: `.agent-workspace/runs/${id}/prompt.md`,
        transcriptPath: `.agent-workspace/runs/${id}/transcript.log`,
        diffPath: `.agent-workspace/runs/${id}/diff.patch`,
        verificationPath: `.agent-workspace/runs/${id}/verification.json`,
        commitPath: `.agent-workspace/runs/${id}/commit.json`,
        changedFilePaths: [],
        transcriptPreview: [`Started ${input.agentId} for ${input.title}`],
        verification: {
          command: "not run",
          status: "pending",
          summary: "Verification pending in mock runtime.",
          logPath: `.agent-workspace/runs/${id}/verification.log`,
        },
        commitProposal: {
          policy: "proposal-first",
          approved: false,
          message: buildCommitMessage(input.title, input.taskId, id, "pending"),
        },
        worktreeContext: createRunWorktreeContext({ agentId: input.agentId, runId: id, taskId: input.taskId }),
        runtimePolicy: createRunRuntimePolicy({ agentId: input.agentId, runId: id }),
      };

      runs.set(id, run);
      return run;
    },
    getRun(runId) {
      return runs.get(runId);
    },
    updateRunStatus(runId, status) {
      return updateRun(runs, runId, (run) => ({ ...run, status }));
    },
    appendTranscript(runId, line) {
      return updateRun(runs, runId, (run) => ({
        ...run,
        transcriptPreview: [...run.transcriptPreview, line],
      }));
    },
    attachVerification(runId, verification) {
      return updateRun(runs, runId, (run) => ({
        ...run,
        verification,
        commitProposal: {
          ...run.commitProposal,
          message: buildCommitMessage(
            run.commitProposal.message.split("\n\n")[0] ?? run.taskId,
            run.taskId,
            run.id,
            verification.status,
          ),
        },
      }));
    },
  };
}

function createMockPtyService(): PtyServiceAdapter {
  const sessions = new Map<string, PtySession>();
  const sessionCounts = new Map<string, number>();

  return {
    spawn(input) {
      const next = (sessionCounts.get(input.agentId) ?? 0) + 1;
      sessionCounts.set(input.agentId, next);
      const session: PtySession = {
        id: `pty-${input.agentId}-${String(next).padStart(3, "0")}`,
        agentId: input.agentId,
        command: input.command,
        cwd: input.cwd,
        runId: input.runId,
        kind: "agent",
        status: "running",
        cols: 100,
        rows: 30,
        transcript: [`$ ${input.command}`],
      };

      sessions.set(session.id, session);
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    write(sessionId, text) {
      return updateSession(sessions, sessionId, (session) => ({
        ...session,
        transcript: [...session.transcript, `> ${text}`],
      }));
    },
    resize(sessionId, size) {
      return updateSession(sessions, sessionId, (session) => ({
        ...session,
        cols: size.cols,
        rows: size.rows,
      }));
    },
    stop(sessionId) {
      return updateSession(sessions, sessionId, (session) => ({
        ...session,
        status: "stopped",
      }));
    },
  };
}

function createMockGitService(): GitServiceAdapter {
  return {
    captureBaseline(runId): GitBaseline {
      return { runId, sha: "abc1234" };
    },
    changedFilesForRun(runId, paths): RunFileAttribution[] {
      return paths.map((path) => ({
        runId,
        path,
        agentId: inferAgentId(path),
        status: path.includes("new") ? "added" : "modified",
        reviewed: false,
        additions: 24,
        deletions: 3,
      }));
    },
    buildCommitProposal(input: CommitProposalInput) {
      return {
        message: buildCommitMessage(input.title, input.taskId, input.runId, input.verification),
      };
    },
  };
}

function createMockFilesystemWatch(): FilesystemWatchAdapter {
  return {
    emitChanges(paths) {
      return paths.map((path) => ({
        path,
        kind: classifyIntentPath(path),
      }));
    },
    createPlannerTasks(events) {
      const changedPaths = events
        .filter((event) => event.kind !== "ignored")
        .map((event) => event.path);

      if (changedPaths.length === 0) return [];

      return [
        {
          id: "planner-task-research-spec-plan",
          changedPaths,
          prompt: "Review durable product intent changes and update the executable plan.",
        },
      ];
    },
  };
}

function getRunCountForTask(runs: Map<string, AgentRun>, taskId: string) {
  return Array.from(runs.values()).filter((run) => run.taskId === taskId).length;
}

function updateRun(
  runs: Map<string, AgentRun>,
  runId: string,
  update: (run: AgentRun) => AgentRun,
) {
  const current = runs.get(runId);
  if (!current) return undefined;

  const next = update(current);
  runs.set(runId, next);
  return next;
}

function updateSession(
  sessions: Map<string, PtySession>,
  sessionId: string,
  update: (session: PtySession) => PtySession,
) {
  const current = sessions.get(sessionId);
  if (!current) return undefined;

  const next = update(current);
  sessions.set(sessionId, next);
  return next;
}

function buildCommitMessage(
  title: string,
  taskId: string,
  runId: string,
  verification: VerificationEvidence["status"],
) {
  return `${title}\n\nTask: ${taskId}\nAgent-Run: ${runId}\nVerification: ${verification}`;
}

function inferAgentId(path: string) {
  if (path.includes("review")) return "reviewer";
  if (path.includes("task") || path.includes("pty")) return "executor";
  return "planner";
}

function classifyIntentPath(path: string): IntentChangeKind {
  if (path.startsWith("docs/research/")) return "research";
  if (path.startsWith("docs/superworks/spec/")) return "spec";
  if (path.startsWith("docs/superworks/plans/archive/") || path.startsWith("docs/superworks/plans/deprecated/")) return "ignored";
  if (path.startsWith("docs/superworks/plans/")) return "plan";
  return "ignored";
}
