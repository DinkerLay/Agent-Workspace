"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSessionIdRootPreloadFacade,
  registerSessionIdRootRuntimeIpc,
} = require("./session-id-root-runtime-ipc.cjs");

test("production IPC carries current lifecycle commands and denies non-product orchestration calls", async () => {
  const handlers = new Map();
  const commands = [];
  const event = { sender: { id: 4, isDestroyed: () => false, send: () => undefined } };
  registerSessionIdRootRuntimeIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    runtimePort: {
      readWorkspace: async () => ({ tasks: [] }),
      readTask: async ({ taskId }) => ({ taskId }),
      readConfiguration: async () => ({ kind: "template_studio", model: {} }),
      command: async (command) => { commands.push(command); return {}; },
      subscribe: async () => () => undefined,
    },
    authorizeWorkspaceForEvent: () => true,
    authorizeTaskForEvent: () => true,
  });
  const facade = createSessionIdRootPreloadFacade({
    invoke: (channel, payload) => handlers.get(channel)(event, payload),
    on: () => undefined,
  });
  const common = {
    commandId: "command_current",
    uiIntentId: "ui_intent_current",
    issuedAt: "2026-08-11T00:00:00.000Z",
  };

  await facade.command({ ...common, type: "template.archive", templateId: "template_one", expectedRevision: 1 });
  await facade.command({ ...common, type: "task.archive", taskId: "task_one", expectedRevision: 1 });
  await facade.command({ ...common, type: "task.permanently_delete", taskId: "task_one", expectedRevision: 2 });
  await facade.command({
    ...common,
    type: "session.respond_interaction",
    taskId: "task_one",
    runId: "run_one",
    expectedRevision: 2,
    targetLogicalSessionId: "logical_session_one",
    interactionId: "interaction_one",
    expectedInteractionRevision: 1,
    choiceId: "choice_allow",
  });
  assert.deepEqual(commands.map(({ type }) => type), [
    "template.archive", "task.archive", "task.permanently_delete", "session.respond_interaction",
  ]);
  assert.throws(() => facade.command({ ...common, type: "session.respond_attention", taskId: "task_one" }),
    /session_id_root_command_denied/);
  assert.throws(() => facade.command({ ...common, type: "orchestration.invoke_agent", taskId: "task_one" }),
    /session_id_root_command_denied/);
});
