const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentWorkspace", {
  native: {
    getRuntimeStatus: () => ipcRenderer.invoke("native:get-runtime-status"),
    runOpencode: (input) => ipcRenderer.invoke("native:run-opencode", input),
    generateTaskDraft: (input) => ipcRenderer.invoke("native:generate-task-draft", input),
    listOpencodeAgents: () => ipcRenderer.invoke("native:list-opencode-agents"),
    inspectOpencodeProcesses: () => ipcRenderer.invoke("native:inspect-opencode-processes"),
    runVerification: (input) => ipcRenderer.invoke("native:run-verification", input),
    registerWorkspaceSessionProfile: (input) => ipcRenderer.invoke("native:register-workspace-session-profile", input),
    activateWorkspaceSession: (input) => ipcRenderer.invoke("native:activate-workspace-session", input),
    readWorkspaceSession: (input) => ipcRenderer.invoke("native:read-workspace-session", input),
    readWorkspaceTerminalLog: (input) => ipcRenderer.invoke("native:read-workspace-terminal-log", input),
    attachTerminalClient: (input) => ipcRenderer.invoke("native:attach-terminal-client", input),
    acknowledgeTerminalOutput: (input) => ipcRenderer.invoke("native:ack-terminal-output", input),
    detachTerminalClient: (input) => ipcRenderer.invoke("native:detach-terminal-client", input),
    enqueueTerminalInput: (input) => ipcRenderer.invoke("native:enqueue-terminal-input", input),
    resizeWorkspaceSession: (input) => ipcRenderer.invoke("native:resize-workspace-session", input),
    stopWorkspaceSession: (input) => ipcRenderer.invoke("native:stop-workspace-session", input),
    callSession: (input) => ipcRenderer.invoke("native:call-session", input),
    callSessions: (input) => ipcRenderer.invoke("native:call-sessions", input),
    readTaskState: (input) => ipcRenderer.invoke("native:read-task-state", input),
    readSession: (input) => ipcRenderer.invoke("native:read-session", input),
    appendTaskEvent: (input) => ipcRenderer.invoke("native:append-task-event", input),
    sendAgentLoopTaskMessage: (input) => ipcRenderer.invoke("native:send-agent-loop-task-message", input),
    listAgentLoopTemplates: () => ipcRenderer.invoke("native:list-agent-loop-templates"),
    generateAgentLoopTemplate: (input) => ipcRenderer.invoke("native:generate-agent-loop-template", input),
    saveAgentLoopTemplate: (input) => ipcRenderer.invoke("native:save-agent-loop-template", input),
    copyAgentLoopTemplate: (input) => ipcRenderer.invoke("native:copy-agent-loop-template", input),
    archiveAgentLoopTemplate: (input) => ipcRenderer.invoke("native:archive-agent-loop-template", input),
    deleteAgentLoopTemplate: (input) => ipcRenderer.invoke("native:delete-agent-loop-template", input),
    validateAgentLoopProjectDirectory: (input) => ipcRenderer.invoke("native:validate-agent-loop-project-directory", input),
    suggestAgentLoopProjectDirectories: (input) => ipcRenderer.invoke("native:suggest-agent-loop-project-directories", input),
    createAgentLoopTask: (input) => ipcRenderer.invoke("native:create-agent-loop-task", input),
    listAgentLoopTasks: () => ipcRenderer.invoke("native:list-agent-loop-tasks"),
    readAgentLoopTask: (input) => ipcRenderer.invoke("native:read-agent-loop-task", input),
    startAgentLoopRun: (input) => ipcRenderer.invoke("native:start-agent-loop-run", input),
    readAgentLoopRun: (input) => ipcRenderer.invoke("native:read-agent-loop-run", input),
    readAgentLoopWorkbenchLayout: (input) => ipcRenderer.invoke("native:read-agent-loop-workbench-layout", input),
    saveAgentLoopWorkbenchLayout: (input) => ipcRenderer.invoke("native:save-agent-loop-workbench-layout", input),
    readAgentLoopArtifact: (input) => ipcRenderer.invoke("native:read-agent-loop-artifact", input),
    markAgentLoopTaskAchieved: (input) => ipcRenderer.invoke("native:mark-agent-loop-task-achieved", input),
    stopAgentLoopTask: (input) => ipcRenderer.invoke("native:stop-agent-loop-task", input),
    respondAgentLoopPermission: (input) => ipcRenderer.invoke("native:respond-agent-loop-permission", input),
    respondAgentLoopQuestion: (input) => ipcRenderer.invoke("native:respond-agent-loop-question", input),
    deleteAgentLoopTask: (input) => ipcRenderer.invoke("native:delete-agent-loop-task", input),
    onAgentLoopRuntimeEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:agent-loop-runtime-event", listener);
      return () => {
        ipcRenderer.removeListener("native:agent-loop-runtime-event", listener);
      };
    },
    onPtyEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:pty-event", listener);
      return () => {
        ipcRenderer.removeListener("native:pty-event", listener);
      };
    },
    onTerminalClientEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:terminal-client-event", listener);
      return () => {
        ipcRenderer.removeListener("native:terminal-client-event", listener);
      };
    },
  },
});
