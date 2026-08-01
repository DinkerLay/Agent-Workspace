const INPUT_PRIORITIES = {
  interrupt: 110,
  permission_reply: 100,
  user: 90,
  // A Task-page answer is still user input, but carries an exact native
  // OpenCode question id in the Task/Run layer for durable one-shot receipt.
  task_question_answer: 90,
  user_message: 80,
  dispatch: 60,
  conductor_wakeup: 50,
  startup: 40,
};

/**
 * The only component permitted to write bytes into a managed terminal.
 * Operations are serialized per Workspace Session and validated again just
 * before the physical write, so an old caller cannot write into a replacement
 * PTY incarnation.
 */
function createTerminalInputArbiter({ resolveOwner, write, maxRetainedOperations = 256 }) {
  if (typeof resolveOwner !== "function" || typeof write !== "function") {
    throw new Error("Terminal input arbiter requires resolveOwner and write functions.");
  }

  const queues = new Map();
  const scheduled = new Set();
  const retainedBySession = new Map();
  let nextOperationOrder = 0;

  function enqueue(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const expectedIncarnationId = requiredString(input?.expectedIncarnationId, "expectedIncarnationId");
    const payload = String(input?.payload ?? "");
    if (!payload) throw new Error("Terminal input payload is required.");

    const source = normalizeSource(input?.source);
    const idempotencyKey = input?.idempotencyKey ? String(input.idempotencyKey) : undefined;
    const retained = retainedBySession.get(workspaceSessionId) ?? new Map();
    if (idempotencyKey && retained.has(idempotencyKey)) {
      return retained.get(idempotencyKey);
    }

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const queue = queues.get(workspaceSessionId) ?? [];
    queue.push({
      workspaceSessionId,
      expectedIncarnationId,
      payload,
      source,
      idempotencyKey,
      promise,
      priority: INPUT_PRIORITIES[source],
      order: nextOperationOrder++,
      resolve,
      reject,
    });
    queues.set(workspaceSessionId, queue);

    if (idempotencyKey) {
      retained.set(idempotencyKey, promise);
      while (retained.size > maxRetainedOperations) {
        retained.delete(retained.keys().next().value);
      }
      retainedBySession.set(workspaceSessionId, retained);
    }
    schedule(workspaceSessionId);
    return promise;
  }

  function schedule(workspaceSessionId) {
    if (scheduled.has(workspaceSessionId)) return;
    scheduled.add(workspaceSessionId);
    queueMicrotask(() => {
      void drain(workspaceSessionId);
    });
  }

  async function drain(workspaceSessionId) {
    try {
      const queue = queues.get(workspaceSessionId) ?? [];
      while (queue.length > 0) {
        queue.sort((left, right) => right.priority - left.priority || left.order - right.order);
        const operation = queue.shift();
        try {
          const owner = await resolveOwner(operation.workspaceSessionId);
          if (!owner || (owner.state ?? owner.status) !== "active") {
            throw new Error("terminal_session_not_active");
          }
          if (owner.incarnationId !== operation.expectedIncarnationId) {
            throw new Error("terminal_incarnation_stale");
          }
          const result = await write({
            workspaceSessionId: operation.workspaceSessionId,
            expectedIncarnationId: operation.expectedIncarnationId,
            payload: operation.payload,
            source: operation.source,
          });
          operation.resolve({
            disposition: "written",
            workspaceSessionId: operation.workspaceSessionId,
            incarnationId: owner.incarnationId,
            source: operation.source,
            result,
          });
        } catch (error) {
          // A rejected local terminal write is not an acceptance receipt.
          // Keep the in-flight promise only while it is executing; otherwise
          // a later, observer-approved retry of the same durable input would
          // be permanently pinned to this stale rejection.
          forgetRejectedOperation(operation);
          operation.reject(error);
        }
      }
    } finally {
      queues.delete(workspaceSessionId);
      scheduled.delete(workspaceSessionId);
    }
  }

  function forgetRejectedOperation(operation) {
    if (!operation.idempotencyKey) return;
    const retained = retainedBySession.get(operation.workspaceSessionId);
    if (!retained || retained.get(operation.idempotencyKey) !== operation.promise) return;
    retained.delete(operation.idempotencyKey);
    if (!retained.size) retainedBySession.delete(operation.workspaceSessionId);
  }

  return { enqueue, evidence: () => ({ queuedSessions: queues.size, retainedSessions: retainedBySession.size }) };
}

function normalizeSource(value) {
  const source = String(value ?? "");
  if (Object.hasOwn(INPUT_PRIORITIES, source)) return source;
  throw new Error("terminal_input_source_invalid");
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Terminal input ${field} is required.`);
  return result;
}

module.exports = { INPUT_PRIORITIES, createTerminalInputArbiter };
