import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // Electron's production shell loads dist/index.html through file://. Keep
  // built assets relative while preserving Vite's normal root-relative dev
  // server URLs, so both shells execute the same renderer entrypoint.
  base: command === "build" ? "./" : "/",
  plugins: [react()],
}));
