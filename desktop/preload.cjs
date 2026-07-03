const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentWorkspace", {
  native: {
    getRuntimeStatus: () => ipcRenderer.invoke("native:get-runtime-status"),
    runOpencode: (input) => ipcRenderer.invoke("native:run-opencode", input),
    generateTaskDraft: (input) => ipcRenderer.invoke("native:generate-task-draft", input),
    listOpencodeAgents: () => ipcRenderer.invoke("native:list-opencode-agents"),
    inspectOpencodeProcesses: () => ipcRenderer.invoke("native:inspect-opencode-processes"),
    runVerification: (input) => ipcRenderer.invoke("native:run-verification", input),
    startPty: (input) => ipcRenderer.invoke("native:start-pty", input),
    getPty: (input) => ipcRenderer.invoke("native:get-pty", input),
    readPty: (input) => ipcRenderer.invoke("native:read-pty", input),
    writePty: (input) => ipcRenderer.invoke("native:write-pty", input),
    resizePty: (input) => ipcRenderer.invoke("native:resize-pty", input),
    stopPty: (input) => ipcRenderer.invoke("native:stop-pty", input),
    callSession: (input) => ipcRenderer.invoke("native:call-session", input),
    readTaskState: (input) => ipcRenderer.invoke("native:read-task-state", input),
    readSession: (input) => ipcRenderer.invoke("native:read-session", input),
    onPtyEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native:pty-event", listener);
      return () => {
        ipcRenderer.removeListener("native:pty-event", listener);
      };
    },
  },
});
