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
