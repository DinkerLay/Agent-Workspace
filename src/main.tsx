import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import "./styles.css";
import { installWebRuntimeBridge } from "./runtime/webRuntimeBridge";

async function bootstrap() {
  // Electron injects its preload bridge before this module runs. A normal
  // browser can instead pair with the local development Host through Vite's
  // server-side proxy, without receiving a Runtime capability token.
  await installWebRuntimeBridge();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
