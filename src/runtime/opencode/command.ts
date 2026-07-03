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
