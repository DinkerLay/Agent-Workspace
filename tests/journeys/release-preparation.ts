import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";

export const REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS = Object.freeze([
  "typecheck",
  "test:vitest",
  "test:desktop",
  "test:integration",
  "test:e2e",
  "test:formal-dev-launcher",
  "verify:session-id-cutover",
  "test:journey:static",
] as const);

export type ReleaseLocalGateScript = typeof REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS[number];

const RELEASE_LOCAL_GATE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CI",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const);

export type ReleaseLocalGateIsolation = Readonly<{
  toJSON(): Readonly<{ kind: "release_local_gate_isolation" }>;
}>;

type ReleaseLocalGateIsolationState = Readonly<{
  rootDirectory: string;
  rootDevice: number;
  rootInode: number;
  homeDirectory: string;
  homeDevice: number;
  homeInode: number;
  temporaryDirectory: string;
  temporaryDevice: number;
  temporaryInode: number;
}>;

const LOCAL_GATE_ISOLATIONS = new WeakMap<object, ReleaseLocalGateIsolationState>();

export type ReleaseLocalGateInvocation = Readonly<{
  executable: string;
  args: readonly string[];
  environment: Readonly<NodeJS.ProcessEnv>;
}>;

/**
 * Creates the only HOME/TMP hierarchy local release gates may receive. The
 * caller creates the fresh release root after ACP qualification; this function
 * proves that root is canonical, private, owned and empty before adding the
 * two fixed children. Paths stay behind an in-memory capability.
 */
export async function createReleaseLocalGateIsolation(input: Readonly<{
  releaseRoot: string;
}>): Promise<ReleaseLocalGateIsolation> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1
    || typeof input.releaseRoot !== "string"
    || !path.isAbsolute(input.releaseRoot)
    || path.normalize(input.releaseRoot) !== input.releaseRoot
    || input.releaseRoot.includes("\0")) {
    throw new Error("release_local_gate_root_invalid");
  }
  const rootBefore = await requirePrivateDirectory(input.releaseRoot, "release_local_gate_root_invalid");
  if ((await readdir(input.releaseRoot)).length !== 0) {
    throw new Error("release_local_gate_root_not_empty");
  }
  const homeDirectory = path.join(input.releaseRoot, "home");
  const temporaryDirectory = path.join(input.releaseRoot, "tmp");
  await mkdir(homeDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  await Promise.all([chmod(homeDirectory, 0o700), chmod(temporaryDirectory, 0o700)]);
  const [rootAfter, home, temporary] = await Promise.all([
    requirePrivateDirectory(input.releaseRoot, "release_local_gate_root_invalid"),
    requirePrivateDirectory(homeDirectory, "release_local_gate_home_invalid"),
    requirePrivateDirectory(temporaryDirectory, "release_local_gate_tmp_invalid"),
  ]);
  if (rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino
    || !sameEntries(await readdir(input.releaseRoot), ["home", "tmp"])) {
    throw new Error("release_local_gate_root_drift");
  }
  const isolation = Object.freeze({
    toJSON: () => Object.freeze({ kind: "release_local_gate_isolation" as const }),
  });
  LOCAL_GATE_ISOLATIONS.set(isolation, Object.freeze({
    rootDirectory: input.releaseRoot,
    rootDevice: rootAfter.dev,
    rootInode: rootAfter.ino,
    homeDirectory,
    homeDevice: home.dev,
    homeInode: home.ino,
    temporaryDirectory,
    temporaryDevice: temporary.dev,
    temporaryInode: temporary.ino,
  }));
  return isolation;
}

export async function executeReleaseLocalGate(
  script: ReleaseLocalGateScript,
  options: Readonly<{
    sourceEnvironment: NodeJS.ProcessEnv;
    isolation: ReleaseLocalGateIsolation;
    platform?: NodeJS.Platform;
    execute: (invocation: ReleaseLocalGateInvocation) => Promise<number>;
  }>,
): Promise<number> {
  return executeIsolatedNpmScript(script, options);
}

/** The production bundle build uses the same credential-free HOME/TMP boundary as local gates. */
export async function executeReleaseProductionBuild(
  options: Readonly<{
    sourceEnvironment: NodeJS.ProcessEnv;
    isolation: ReleaseLocalGateIsolation;
    platform?: NodeJS.Platform;
    execute: (invocation: ReleaseLocalGateInvocation) => Promise<number>;
  }>,
): Promise<number> {
  return executeIsolatedNpmScript("build", options);
}

async function executeIsolatedNpmScript(
  script: ReleaseLocalGateScript | "build",
  options: Readonly<{
    sourceEnvironment: NodeJS.ProcessEnv;
    isolation: ReleaseLocalGateIsolation;
    platform?: NodeJS.Platform;
    execute: (invocation: ReleaseLocalGateInvocation) => Promise<number>;
  }>,
): Promise<number> {
  const isolation = await requireCurrentIsolation(options.isolation);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of RELEASE_LOCAL_GATE_ENVIRONMENT_KEYS) {
    const value = options.sourceEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = isolation.homeDirectory;
  environment.TMPDIR = isolation.temporaryDirectory;
  environment.TMP = isolation.temporaryDirectory;
  environment.TEMP = isolation.temporaryDirectory;
  return options.execute(Object.freeze({
    executable: (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm",
    args: Object.freeze(["run", script]),
    environment: Object.freeze(environment),
  }));
}

export class ReleaseLocalGateError extends Error {
  constructor(
    readonly script: ReleaseLocalGateScript,
    readonly exitCode: number,
  ) {
    super(`required release local gate ${script} failed with exit ${exitCode}`);
    this.name = "ReleaseLocalGateError";
  }
}

export async function runReleasePreparation<PreflightSeal, GateIsolation>(options: Readonly<{
  preflight: () => Promise<PreflightSeal>;
  verifyFrozenPreflight: (seal: PreflightSeal) => Promise<void>;
  prepareLocalGateIsolation: (seal: PreflightSeal) => Promise<GateIsolation>;
  runLocalGate: (script: ReleaseLocalGateScript, isolation: GateIsolation) => Promise<number>;
  verifyJourneyLocators: () => Promise<void>;
  build: () => Promise<void>;
}>): Promise<PreflightSeal> {
  const seal = await options.preflight();
  await options.verifyFrozenPreflight(seal);
  const isolation = await options.prepareLocalGateIsolation(seal);
  for (const script of REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS) {
    const exitCode = await options.runLocalGate(script, isolation);
    if (exitCode !== 0) throw new ReleaseLocalGateError(script, exitCode);
    await options.verifyFrozenPreflight(seal);
  }
  await options.verifyJourneyLocators();
  await options.verifyFrozenPreflight(seal);
  await options.build();
  await options.verifyFrozenPreflight(seal);
  return seal;
}

async function requireCurrentIsolation(
  value: ReleaseLocalGateIsolation,
): Promise<ReleaseLocalGateIsolationState> {
  const state = value && typeof value === "object"
    ? LOCAL_GATE_ISOLATIONS.get(value as object)
    : undefined;
  if (!state) throw new Error("release_local_gate_isolation_invalid");
  const [root, home, temporary] = await Promise.all([
    requirePrivateDirectory(state.rootDirectory, "release_local_gate_root_drift"),
    requirePrivateDirectory(state.homeDirectory, "release_local_gate_home_drift"),
    requirePrivateDirectory(state.temporaryDirectory, "release_local_gate_tmp_drift"),
  ]);
  if (root.dev !== state.rootDevice || root.ino !== state.rootInode
    || home.dev !== state.homeDevice || home.ino !== state.homeInode
    || temporary.dev !== state.temporaryDevice || temporary.ino !== state.temporaryInode
    || !sameEntries(await readdir(state.rootDirectory), ["home", "tmp"])) {
    throw new Error("release_local_gate_isolation_drift");
  }
  return state;
}

async function requirePrivateDirectory(
  directory: string,
  code: string,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const metadata = await lstat(directory).catch(() => undefined);
  const canonical = await realpath(directory).catch(() => "");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || canonical !== directory
    || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
    || (currentUid !== undefined && metadata.uid !== currentUid)) {
    throw new Error(code);
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function sameEntries(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((entry, index) => entry === [...expected].sort()[index]);
}
