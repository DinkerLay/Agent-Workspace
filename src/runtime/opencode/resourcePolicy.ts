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
