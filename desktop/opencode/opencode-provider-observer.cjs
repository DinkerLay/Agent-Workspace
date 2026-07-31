const { createOpenCodeSqliteReader } = require("./opencode-sqlite-reader.cjs");

function createOpenCodeProviderObserver({ reader = createOpenCodeSqliteReader() } = {}) {
  if (typeof reader?.inspectDispatch !== "function") {
    throw new Error("OpenCode Provider Observer requires a SQLite reader.");
  }

  async function observeDispatch({ dispatch, session }) {
    if (!dispatch?.dispatchId) throw new Error("opencode_dispatch_id_required");
    const binding = dispatch.providerSessionId && dispatch.providerMessageId && dispatch.dispatchMessageCreatedAt
      ? {
        providerSessionId: dispatch.providerSessionId,
        providerMessageId: dispatch.providerMessageId,
        dispatchMessageCreatedAt: dispatch.dispatchMessageCreatedAt,
      }
      : undefined;
    return reader.inspectDispatch({
      dispatchId: dispatch.dispatchId,
      dispatchCreatedAt: dispatch.createdAt,
      cwd: session?.cwd,
      binding,
    });
  }

  async function observeConductor({ session, afterMessageCreatedAt, providerSessionId }) {
    const taskId = String(session?.taskId ?? "").trim();
    if (!taskId) throw new Error("opencode_conductor_task_id_required");
    if (typeof reader.inspectConductor !== "function") throw new Error("opencode_conductor_observation_unavailable");
    return reader.inspectConductor({
      taskId,
      cwd: session?.cwd,
      afterMessageCreatedAt,
      providerSessionId,
    });
  }

  async function observeConductorInput({ session, inputId, afterMessageCreatedAt }) {
    const taskId = String(session?.taskId ?? "").trim();
    if (!taskId) throw new Error("opencode_conductor_task_id_required");
    if (!String(inputId ?? "").trim()) throw new Error("opencode_conductor_input_id_required");
    if (typeof reader.inspectConductorInput !== "function") throw new Error("opencode_conductor_input_observation_unavailable");
    return reader.inspectConductorInput({
      taskId,
      inputId: String(inputId),
      cwd: session?.cwd,
      afterMessageCreatedAt,
    });
  }

  return {
    observeDispatch,
    observeConductor,
    observeConductorInput,
    close: () => reader.close?.(),
  };
}

module.exports = { createOpenCodeProviderObserver };
