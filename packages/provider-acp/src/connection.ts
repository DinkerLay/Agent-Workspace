/**
 * The injected boundary intentionally uses `unknown` wire values. A Host
 * adapter may delegate these calls to the official ACP v1 TypeScript SDK, but
 * raw ACP identities never become part of this package's public domain types.
 */
export interface AcpV1ReverseRpcHandlers {
  readTextFile?(params: unknown): Promise<unknown>;
  writeTextFile?(params: unknown): Promise<unknown>;
  createTerminal?(params: unknown): Promise<unknown>;
  terminalOutput?(params: unknown): Promise<unknown>;
  waitForTerminalExit?(params: unknown): Promise<unknown>;
  killTerminal?(params: unknown): Promise<unknown>;
  releaseTerminal?(params: unknown): Promise<unknown>;
}

export interface AcpV1ClientHandlers extends AcpV1ReverseRpcHandlers {
  sessionUpdate(params: unknown): Promise<void>;
  requestPermission(params: unknown): Promise<unknown>;
}

/** Official ACP v1 client-side method names, with wire shapes kept private. */
export interface InjectedAcpV1Connection {
  initialize(params: unknown): Promise<unknown>;
  newSession(params: unknown): Promise<unknown>;
  loadSession?(params: unknown): Promise<unknown>;
  resumeSession?(params: unknown): Promise<unknown>;
  setSessionConfigOption?(params: unknown): Promise<unknown>;
  setSessionMode?(params: unknown): Promise<unknown>;
  prompt(params: unknown): Promise<unknown>;
  cancel(params: unknown): Promise<void>;
  closeSession?(params: unknown): Promise<unknown>;
  readonly closed?: Promise<void>;
}

export type AcpV1ConnectionFactory = (
  handlers: AcpV1ClientHandlers,
) => InjectedAcpV1Connection;
