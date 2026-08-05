const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentWorkspace", {
  native: {
    getRuntimeStatus: () => ipcRenderer.invoke("native:get-runtime-status"),
    runOpencode: (input) => ipcRenderer.invoke("native:run-opencode", input),
    generateTaskDraft: (input) => ipcRenderer.invoke("native:generate-task-draft", input),
    listOpencodeAgents: () => ipcRenderer.invoke("native:list-opencode-agents"),
    listOpencodeModelCapabilities: (input) => ipcRenderer.invoke("native:list-opencode-model-capabilities", input),
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
    listAgentLoopTemplateVersions: (input) => ipcRenderer.invoke("native:list-agent-loop-template-versions", input),
    generateAgentLoopTemplate: (input) => ipcRenderer.invoke("native:generate-agent-loop-template", input),
    saveAgentLoopTemplate: (input) => ipcRenderer.invoke("native:save-agent-loop-template", input),
    copyAgentLoopTemplate: (input) => ipcRenderer.invoke("native:copy-agent-loop-template", input),
    archiveAgentLoopTemplate: (input) => ipcRenderer.invoke("native:archive-agent-loop-template", input),
    deleteAgentLoopTemplate: (input) => ipcRenderer.invoke("native:delete-agent-loop-template", input),
    getOrCreateAgentLoopTemplateDesignSession: (input) => ipcRenderer.invoke("native:get-or-create-agent-loop-template-design-session", input),
    listActiveAgentLoopTemplateDesignSessions: (input) => ipcRenderer.invoke("native:list-active-agent-loop-template-design-sessions", input),
    readAgentLoopTemplateDesignSession: (input) => ipcRenderer.invoke("native:read-agent-loop-template-design-session", input),
    saveAgentLoopTemplateDesignDraft: (input) => ipcRenderer.invoke("native:save-agent-loop-template-design-draft", input),
    discardAgentLoopTemplateDesignDraft: (input) => ipcRenderer.invoke("native:discard-agent-loop-template-design-draft", input),
    openAgentLoopTemplateDesignSessionPage: (input) => ipcRenderer.invoke("native:open-agent-loop-template-design-session-page", input),
    releaseAgentLoopTemplateDesignSessionPage: (input) => ipcRenderer.invoke("native:release-agent-loop-template-design-session-page", input),
    validateAgentLoopProjectDirectory: (input) => ipcRenderer.invoke("native:validate-agent-loop-project-directory", input),
    suggestAgentLoopProjectDirectories: (input) => ipcRenderer.invoke("native:suggest-agent-loop-project-directories", input),
    createAgentLoopProjectDirectory: (input) => ipcRenderer.invoke("native:create-agent-loop-project-directory", input),
    createAgentLoopTask: (input) => ipcRenderer.invoke("native:create-agent-loop-task", input),
    listAgentLoopTasks: (input) => ipcRenderer.invoke("native:list-agent-loop-tasks", input),
    readAgentLoopTask: (input) => ipcRenderer.invoke("native:read-agent-loop-task", input),
    startAgentLoopRun: (input) => ipcRenderer.invoke("native:start-agent-loop-run", input),
    readAgentLoopRun: (input) => ipcRenderer.invoke("native:read-agent-loop-run", input),
    openAgentLoopOpenCodeSessionPage: (input) => ipcRenderer.invoke("native:open-agent-loop-opencode-session-page", input),
    releaseAgentLoopOpenCodeSessionPage: (input) => ipcRenderer.invoke("native:release-agent-loop-opencode-session-page", input),
    readAgentLoopWorkbenchLayout: (input) => ipcRenderer.invoke("native:read-agent-loop-workbench-layout", input),
    saveAgentLoopWorkbenchLayout: (input) => ipcRenderer.invoke("native:save-agent-loop-workbench-layout", input),
    readAgentLoopArtifact: (input) => ipcRenderer.invoke("native:read-agent-loop-artifact", input),
    markAgentLoopTaskAchieved: (input) => ipcRenderer.invoke("native:mark-agent-loop-task-achieved", input),
    resumeAchievedAgentLoopTask: (input) => ipcRenderer.invoke("native:resume-achieved-agent-loop-task", input),
    stopAgentLoopTask: (input) => ipcRenderer.invoke("native:stop-agent-loop-task", input),
    respondAgentLoopPermission: (input) => ipcRenderer.invoke("native:respond-agent-loop-permission", input),
    respondAgentLoopQuestion: (input) => ipcRenderer.invoke("native:respond-agent-loop-question", input),
    moveAgentLoopTaskToRecycleBin: (input) => ipcRenderer.invoke("native:move-agent-loop-task-to-recycle-bin", input),
    restoreAgentLoopTaskFromRecycleBin: (input) => ipcRenderer.invoke("native:restore-agent-loop-task-from-recycle-bin", input),
    previewAgentLoopTaskPermanentDeletion: (input) => ipcRenderer.invoke("native:preview-agent-loop-task-permanent-deletion", input),
    permanentlyDeleteAgentLoopTask: (input) => ipcRenderer.invoke("native:permanently-delete-agent-loop-task", input),
    // Compatibility alias. Runtime enforces recycle-bin state before it can
    // become a permanent deletion.
    deleteAgentLoopTask: (input) => ipcRenderer.invoke("native:delete-agent-loop-task", input),
    onAgentLoopRuntimeEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:agent-loop-runtime-event", listener);
      return () => {
        ipcRenderer.removeListener("native:agent-loop-runtime-event", listener);
      };
    },
    onAgentLoopTemplateDesignEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:agent-loop-template-design-event", listener);
      return () => {
        ipcRenderer.removeListener("native:agent-loop-template-design-event", listener);
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
