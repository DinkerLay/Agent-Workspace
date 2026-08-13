import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentLoopSessionIdRuntimeApp } from "../../../packages/workbench-ui/src/agent-loop/AgentLoopSessionIdRuntimeApp";
import { createAgentLoopSessionIdController } from "./runtime";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("workbench_root_missing");

createRoot(root).render(
  <StrictMode>
    <AgentLoopSessionIdRuntimeApp controller={createAgentLoopSessionIdController()} />
  </StrictMode>,
);
