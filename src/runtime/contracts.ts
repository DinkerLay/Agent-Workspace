import type { AgentRun, ChangedFile, RunStatus, VerificationEvidence } from "../types";

export type CreateRunInput = {
  agentId: string;
  taskId: string;
  title: string;
};

export type PtySpawnInput = {
  agentId: string;
  command: string;
  cwd: string;
  runId: string;
};

export type PtySize = {
  cols: number;
  rows: number;
};

export type PtySession = {
  id: string;
  agentId: string;
  command: string;
  cwd: string;
  runId: string;
  kind: "agent" | "dev-command" | "one-shot";
  status: "running" | "stopped";
  cols: number;
  rows: number;
  transcript: string[];
};

export type GitBaseline = {
  runId: string;
  sha: string;
};

export type RunFileAttribution = ChangedFile & {
  runId: string;
};

export type CommitProposalInput = {
  runId: string;
  taskId: string;
  title: string;
  verification: VerificationEvidence["status"];
};

export type CommitProposalOutput = {
  message: string;
};

export type IntentChangeKind = "research" | "spec" | "plan" | "ignored";

export type IntentChangeEvent = {
  path: string;
  kind: IntentChangeKind;
};

export type PlannerTaskInput = {
  id: string;
  changedPaths: string[];
  prompt: string;
};

export type RuntimeAdapterCard = {
  id: string;
  label: string;
  mode: "mocked" | "native-pending" | "native-ready";
  contract: string;
  nextNativeStep: string;
};

export type RunStoreAdapter = {
  createRun(input: CreateRunInput): AgentRun;
  getRun(runId: string): AgentRun | undefined;
  updateRunStatus(runId: string, status: RunStatus): AgentRun | undefined;
  appendTranscript(runId: string, line: string): AgentRun | undefined;
  attachVerification(runId: string, verification: VerificationEvidence): AgentRun | undefined;
};

export type PtyServiceAdapter = {
  spawn(input: PtySpawnInput): PtySession;
  getSession(sessionId: string): PtySession | undefined;
  write(sessionId: string, text: string): PtySession | undefined;
  resize(sessionId: string, size: PtySize): PtySession | undefined;
  stop(sessionId: string): PtySession | undefined;
};

export type GitServiceAdapter = {
  captureBaseline(runId: string): GitBaseline;
  changedFilesForRun(runId: string, paths: string[]): RunFileAttribution[];
  buildCommitProposal(input: CommitProposalInput): CommitProposalOutput;
};

export type FilesystemWatchAdapter = {
  emitChanges(paths: string[]): IntentChangeEvent[];
  createPlannerTasks(events: IntentChangeEvent[]): PlannerTaskInput[];
};

export type RuntimeAdapters = {
  runStore: RunStoreAdapter;
  ptyService: PtyServiceAdapter;
  gitService: GitServiceAdapter;
  filesystemWatch: FilesystemWatchAdapter;
};
