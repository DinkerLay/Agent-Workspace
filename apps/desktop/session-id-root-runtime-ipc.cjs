"use strict";

const SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS = Object.freeze({
  workspaceRead: "agent-workspace:session-id-root:workspace-read",
  taskRead: "agent-workspace:session-id-root:task-read",
  configurationRead: "agent-workspace:session-id-root:configuration-read",
  command: "agent-workspace:session-id-root:command",
  subscribe: "agent-workspace:session-id-root:subscribe",
  unsubscribe: "agent-workspace:session-id-root:unsubscribe",
  invalidated: "agent-workspace:session-id-root:invalidated",
});

const CONFIGURATION_COMMAND_TYPES = new Set([
  "template.create_draft", "template.save_draft", "template.publish_draft",
  "template.archive", "template.import", "template.export",
  "task_setup.create_draft", "task_setup.save_draft", "task_setup.abandon_draft",
  "meta.create_session", "meta.send_message", "meta.abandon_session", "meta.apply_patch", "meta.reject_patch",
  "task.create",
]);
const TASK_COMMAND_TYPES = new Set([
  "task.start", "task.resume", "task.restart", "task.achieve",
  "task.archive", "task.restore", "task.preview_permanent_delete", "task.permanently_delete",
  "task.submit_input", "task.stop",
  "session.send_human_message", "session.abandon_human_message", "session.request_interrupt", "session.respond_interaction",
  "workspace.preview_file",
]);

function registerSessionIdRootRuntimeIpc({
  ipcMain,
  runtimePort,
  authorizeWorkspaceForEvent,
  authorizeTaskForEvent,
}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("ipcMain.handle is required");
  if (!runtimePort
    || typeof runtimePort.readWorkspace !== "function"
    || typeof runtimePort.readTask !== "function"
    || typeof runtimePort.readConfiguration !== "function"
    || typeof runtimePort.command !== "function"
    || typeof runtimePort.subscribe !== "function") {
    throw new TypeError("session_id_root_runtime_port_invalid");
  }
  if (typeof authorizeWorkspaceForEvent !== "function" || typeof authorizeTaskForEvent !== "function") {
    throw new TypeError("session_id_root_runtime_authorizer_required");
  }
  const subscriptions = new Map();

  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.workspaceRead, async (event) => {
    authorizeWorkspace(event, authorizeWorkspaceForEvent);
    return runtimePort.readWorkspace();
  });
  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.taskRead, async (event, request) => {
    const task = taskRequest(request);
    authorizeTask(event, task.taskId, authorizeTaskForEvent);
    return runtimePort.readTask(task);
  });
  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.configurationRead, async (event, request) => {
    authorizeWorkspace(event, authorizeWorkspaceForEvent);
    return runtimePort.readConfiguration(configurationReadRequest(request));
  });
  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.command, async (event, value) => {
    const command = rendererCommand(value);
    if (CONFIGURATION_COMMAND_TYPES.has(command.type)) authorizeWorkspace(event, authorizeWorkspaceForEvent);
    else authorizeTask(event, command.taskId, authorizeTaskForEvent);
    return runtimePort.command(command);
  });
  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.subscribe, async (event, value) => {
    const request = exactSubscriptionRequest(value);
    const scope = request.taskId ? taskRequest({ taskId: request.taskId }) : Object.freeze({});
    if (scope.taskId) authorizeTask(event, scope.taskId, authorizeTaskForEvent);
    else authorizeWorkspace(event, authorizeWorkspaceForEvent);
    const key = `${event.sender.id}:${request.clientSubscriptionId}`;
    if (subscriptions.has(key)) throw new Error("session_id_root_subscription_id_in_use");
    const close = await runtimePort.subscribe(scope, (invalidation) => {
      assertJsonValue(invalidation, "session-id root invalidation");
      if (!event.sender.isDestroyed()) {
        event.sender.send(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.invalidated, {
          subscriptionId: request.clientSubscriptionId,
          invalidation,
        });
      }
    });
    subscriptions.set(key, typeof close === "function" ? close : () => undefined);
    event.sender.once?.("destroyed", () => { void closeSubscriptionsForSender(subscriptions, event.sender.id); });
    return { subscriptionId: request.clientSubscriptionId };
  });
  ipcMain.handle(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.unsubscribe, async (event, value) => {
    const request = exactRecord(value, ["subscriptionId"], "session_id_root_subscription_invalid");
    const subscriptionId = requiredText(request.subscriptionId, "session_id_root_subscription_id_required");
    const key = `${event.sender.id}:${subscriptionId}`;
    const close = subscriptions.get(key);
    subscriptions.delete(key);
    await close?.();
    return { subscriptionId, closed: Boolean(close) };
  });

  return () => {
    for (const close of subscriptions.values()) void close();
    subscriptions.clear();
    for (const key of ["workspaceRead", "taskRead", "configurationRead", "command", "subscribe", "unsubscribe"]) {
      ipcMain.removeHandler?.(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS[key]);
    }
  };
}

function createSessionIdRootPreloadFacade(ipc, createSubscriptionId = defaultSubscriptionId) {
  if (!ipc || typeof ipc.invoke !== "function" || typeof ipc.on !== "function") throw new TypeError("session_id_root_runtime_ipc_invalid");
  const listeners = new Map();
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    ipc.on(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.invalidated, (_event, message) => {
      if (!message || typeof message.subscriptionId !== "string" || !message.invalidation) return;
      listeners.get(message.subscriptionId)?.(message.invalidation);
    });
  };
  return Object.freeze({
    readWorkspace: () => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.workspaceRead),
    readTask: (request) => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.taskRead, taskRequest(request)),
    readConfiguration: (request) => ipc.invoke(
      SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.configurationRead,
      configurationReadRequest(request),
    ),
    command: (command) => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.command, rendererCommand(command)),
    async subscribe(request, listener) {
      if (typeof listener !== "function") throw new TypeError("session_id_root_runtime_listener_required");
      attach();
      const scope = subscriptionScope(request);
      const subscriptionId = createSubscriptionId();
      listeners.set(subscriptionId, listener);
      try {
        const result = await ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.subscribe, {
          ...scope,
          clientSubscriptionId: subscriptionId,
        });
        if (result?.subscriptionId !== subscriptionId) throw new Error("session_id_root_subscription_identity_mismatch");
      } catch (error) {
        listeners.delete(subscriptionId);
        throw error;
      }
      return async () => {
        listeners.delete(subscriptionId);
        await ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.unsubscribe, { subscriptionId });
      };
    },
  });
}

function rendererCommand(value) {
  assertJsonValue(value, "session-id root command");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (!CONFIGURATION_COMMAND_TYPES.has(value.type) && !TASK_COMMAND_TYPES.has(value.type))) {
    throw new Error("session_id_root_command_denied");
  }
  for (const key of ["commandId", "uiIntentId", "issuedAt"]) requiredText(value[key], "session_id_root_command_invalid");
  if (TASK_COMMAND_TYPES.has(value.type)) requiredText(value.taskId, "session_id_root_command_invalid");
  return value;
}

function configurationReadRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("session_id_root_configuration_read_invalid");
  if (value.kind === "template_studio") {
    const keys = value.templateId === undefined ? ["kind"] : ["kind", "templateId"];
    const request = exactRecord(value, keys, "session_id_root_configuration_read_invalid");
    if (request.templateId !== undefined) requiredText(request.templateId, "session_id_root_configuration_read_invalid");
    return request;
  }
  if (value.kind === "task_setup") {
    const request = exactRecord(value, ["kind", "taskSetupDraftId"], "session_id_root_configuration_read_invalid");
    requiredText(request.taskSetupDraftId, "session_id_root_configuration_read_invalid");
    return request;
  }
  if (value.kind === "meta") {
    const request = exactRecord(value, ["kind", "scope"], "session_id_root_configuration_read_invalid");
    assertJsonValue(request.scope, "session-id configuration scope");
    return request;
  }
  throw new TypeError("session_id_root_configuration_read_invalid");
}

function subscriptionScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("session_id_root_subscription_invalid");
  const keys = Object.keys(value);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length === 1 && keys[0] === "taskId") return taskRequest(value);
  throw new TypeError("session_id_root_subscription_invalid");
}

function exactSubscriptionRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("session_id_root_subscription_invalid");
  const keys = Object.keys(value);
  if (typeof value.clientSubscriptionId !== "string" || !value.clientSubscriptionId
    || keys.some((key) => key !== "clientSubscriptionId" && key !== "taskId")) {
    throw new TypeError("session_id_root_subscription_invalid");
  }
  return value;
}

function taskRequest(value) {
  const request = exactRecord(value, ["taskId"], "session_id_root_task_request_invalid");
  return Object.freeze({ taskId: requiredText(request.taskId, "session_id_root_task_id_required") });
}

function authorizeWorkspace(event, authorize) {
  if (!authorize(event)) throw new Error("session_id_root_workspace_denied");
}

function authorizeTask(event, taskId, authorize) {
  if (!authorize(event, taskId)) throw new Error("session_id_root_task_denied");
}

async function closeSubscriptionsForSender(subscriptions, senderId) {
  const prefix = `${senderId}:`;
  const pending = [];
  for (const [key, close] of subscriptions) {
    if (!key.startsWith(prefix)) continue;
    subscriptions.delete(key);
    pending.push(Promise.resolve(close()));
  }
  await Promise.allSettled(pending);
}

function exactRecord(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(code);
  return value;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(code);
  return value;
}

function defaultSubscriptionId() {
  return `session-id-root-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertJsonValue(value, label, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError(`${label} must not be cyclic`);
    stack.add(value);
    for (const item of value) assertJsonValue(item, label, stack);
    stack.delete(value);
    return;
  }
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (stack.has(value)) throw new TypeError(`${label} must not be cyclic`);
    stack.add(value);
    for (const item of Object.values(value)) assertJsonValue(item, label, stack);
    stack.delete(value);
    return;
  }
  throw new TypeError(`${label} must be JSON-serializable`);
}

module.exports = {
  SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS,
  createSessionIdRootPreloadFacade,
  registerSessionIdRootRuntimeIpc,
};
