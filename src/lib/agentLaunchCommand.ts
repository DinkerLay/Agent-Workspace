export function defaultAgentLaunchCommand(model: string) {
  return model ? `opencode --model ${model}` : "opencode";
}

export function parseAgentLaunchCommand(commandLine: string, fallbackModel: string) {
  const tokens = splitCommandLine(commandLine.trim());
  const fallback = splitCommandLine(defaultAgentLaunchCommand(fallbackModel));
  const [command, ...args] = tokens.length > 0 ? tokens : fallback;
  return {
    command,
    args,
    commandLine: [command, ...args].join(" "),
  };
}

function splitCommandLine(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function shellQuoteIfNeeded(value: string) {
  return /\s/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}
