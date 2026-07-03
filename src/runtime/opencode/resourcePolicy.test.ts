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
