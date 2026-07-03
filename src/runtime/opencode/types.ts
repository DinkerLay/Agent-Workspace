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
