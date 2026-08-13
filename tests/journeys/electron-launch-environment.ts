const ELECTRON_ENVIRONMENT_ALLOWLIST = Object.freeze([
  // Minimal cross-platform process launch environment.
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LOCALAPPDATA",
  "APPDATA",
  // Candidate renderer/Host contract. Browser and evidence tokens are excluded.
  "AGENT_WORKSPACE_WORKBENCH_URL",
  "AGENT_WORKSPACE_RUNTIME_URL",
  "AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN",
  "AGENT_WORKSPACE_RUNTIME_ORIGIN",
  "AGENT_WORKSPACE_OWNER_ID",
] as const);

/** Creates the only environment actual-operation runners may pass to Electron Main. */
export function createElectronLaunchEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(ELECTRON_ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = source[name];
    return typeof value === "string" ? [[name, value] as const] : [];
  }));
}
