import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import { parseOpencodeProcessList } from "./process-inspector.cjs";

const isVitest = process.env.VITEST === "true" || Boolean(process.env.VITEST_WORKER_ID);
const testApi = isVitest ? await import("vitest") : { describe: nodeDescribe, it: nodeIt };
const { describe, it } = testApi;

describe("opencode process inspector", () => {
  it("parses opencode ps output and ignores non-opencode rows", () => {
    const output = [
      "PID PPID RSS %MEM ELAPSED COMM ARGS",
      "81076 80891 150256 0.9 02:46 opencode opencode",
      "3936 1 27552 0.2 04-08:57 Terminal /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ].join("\n");

    assert.deepEqual(parseOpencodeProcessList(output), [
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
    ].join("\n");

    assert.deepEqual(parseOpencodeProcessList(output).map((process) => process.pid), [81076, 81077]);
  });
});
