import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentLoopRuntimeApp } from "../../../packages/workbench-ui/src/index";
import { createAgentLoopControllers } from "./runtime";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("workbench_root_missing");
const controllers = createAgentLoopControllers();

createRoot(root).render(
  <StrictMode>
    <AgentLoopRuntimeApp
      configurationController={controllers.configuration}
      controller={controllers.task}
      templateStudioController={controllers.templateStudio}
    />
  </StrictMode>,
);
