import { describe, expect, it } from "vitest";
import { defaultAgentLaunchCommand, parseAgentLaunchCommand } from "./agentLaunchCommand";

describe("agent launch command", () => {
  it("defaults to an interactive opencode TUI command", () => {
    expect(defaultAgentLaunchCommand("opencode-go/deepseek-v4-flash")).toBe(
      "opencode --model opencode-go/deepseek-v4-flash",
    );
  });

  it("parses a configured command into direct PTY command and args", () => {
    expect(parseAgentLaunchCommand('opencode --model "opencode-go/deepseek-v4-flash" --agent plan', "")).toEqual({
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash", "--agent", "plan"],
      commandLine: "opencode --model opencode-go/deepseek-v4-flash --agent plan",
    });
  });

  it("falls back to the default interactive command when the configured command is empty", () => {
    expect(parseAgentLaunchCommand("   ", "opencode-go/deepseek-v4-flash")).toEqual({
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      commandLine: "opencode --model opencode-go/deepseek-v4-flash",
    });
  });
});
