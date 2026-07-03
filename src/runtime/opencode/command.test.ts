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
        model: "opencode-go/deepseek-v4-flash",
        agentName: "planner",
      }),
    ).toEqual({
      command: "/opt/homebrew/bin/opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash", "--agent", "planner"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      display: "/opt/homebrew/bin/opencode --model opencode-go/deepseek-v4-flash --agent planner",
      mode: "tui",
    });
  });

  it("builds run command for non-interactive execution", () => {
    expect(
      buildOpencodeRunCommand({
        binaryPath: "opencode",
        cwd: "/repo",
        message: "summarize",
        model: "opencode-go/deepseek-v4-flash",
        agentName: "qa",
      }),
    ).toMatchObject({
      command: "opencode",
      args: ["run", "--format", "json", "--model", "opencode-go/deepseek-v4-flash", "--agent", "qa", "summarize"],
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
