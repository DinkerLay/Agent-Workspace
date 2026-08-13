import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeAcpReleaseParentInputSealBeforeFirstEffect,
  claimAcpReleaseParentQualificationInputs,
  consumeAcpReleaseLaneInputSealBeforeFirstEffect,
  createAcpReleaseParentInputSeal,
  createAcpReleaseLaneInputSeal,
  verifyFrozenAcpReleaseParentInputSeal,
} from "./acp-release-parent-preflight.js";
import { ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS } from "./support/acp-release-cell-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP release parent zero-effect input preflight", () => {
  it("seals all three exact lanes without executing an artifact or exposing a path/credential", async () => {
    const fixture = await createFixture();
    const seal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });
    const independentSeal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });

    expect(seal.safeObservation()).toEqual({
      schemaVersion: 1,
      kind: "acp_release_parent_input_seal",
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    const serialized = JSON.stringify(seal);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toMatch(/(?:credential|auth|workspace|command|path)/iu);
    expect(independentSeal.safeObservation().digest).not.toBe(seal.safeObservation().digest);
    await expect(readFile(fixture.effectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(consumeAcpReleaseParentInputSealBeforeFirstEffect(seal))
      .resolves.toEqual(seal.safeObservation());
    await verifyFrozenAcpReleaseParentInputSeal(seal);
    const qualificationInputs = await claimAcpReleaseParentQualificationInputs(seal);
    expect(qualificationInputs).toMatchObject([
      { issuer: "opencode_acp_task_attestor", taskWorkspaceDirectory: fixture.workspaces.openCode },
      { issuer: "codex_acp_task_attestor", taskWorkspaceDirectory: fixture.workspaces.codex },
      { issuer: "acp_meta_attestor" },
    ]);
    expect(Object.keys(qualificationInputs[2]!).sort()).toEqual([
      "environment", "issuer", "metaProfileOptionId",
    ]);
    expect(JSON.stringify(qualificationInputs[2])).not.toContain(fixture.workspaces.meta);
    await expect(claimAcpReleaseParentQualificationInputs(seal))
      .rejects.toThrow("acp_release_parent_qualification_inputs_already_claimed");
    await expect(consumeAcpReleaseParentInputSealBeforeFirstEffect(seal))
      .rejects.toThrow("acp_release_parent_input_seal_already_consumed");
    await expect(readFile(fixture.effectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing lane before any caller effect", async () => {
    const fixture = await createFixture();
    const firstEffect = vi.fn();
    const environment = { ...fixture.environment };
    delete environment[ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_codex-acp-task"]];

    await expect(createAcpReleaseParentInputSeal({ environment })).rejects
      .toThrow("acp_release_parent_envelope_missing");
    expect(firstEffect).not.toHaveBeenCalled();
    await expect(readFile(fixture.effectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires independent canonical empty 0700 workspaces", async () => {
    const fixture = await createFixture();
    const meta = JSON.parse(await readFile(fixture.envelopes.meta, "utf8")) as Record<string, unknown>;
    meta.workspaceDirectory = fixture.workspaces.openCode;
    await writePrivateJson(fixture.envelopes.meta, meta);
    await expect(createAcpReleaseParentInputSeal({ environment: fixture.environment }))
      .rejects.toThrow("acp_release_parent_workspace_not_independent");

    meta.workspaceDirectory = fixture.workspaces.meta;
    await writePrivateJson(fixture.envelopes.meta, meta);
    await writeFile(path.join(fixture.workspaces.meta, "unexpected"), "not empty", { mode: 0o600 });
    await expect(createAcpReleaseParentInputSeal({ environment: fixture.environment }))
      .rejects.toThrow("acp_release_parent_workspace_not_empty");
  });

  it("allows Codex Task and independent Codex Meta to share one secure auth source", async () => {
    const fixture = await createFixture();
    await writePrivateJson(fixture.envelopes.meta, metaEnvelope({
      providerFamily: "codex",
      workspaceDirectory: fixture.workspaces.meta,
      bin: path.join(fixture.root, "bin"),
      authFile: fixture.auth.codex,
    }));
    const seal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });
    await expect(consumeAcpReleaseParentInputSealBeforeFirstEffect(seal))
      .resolves.toEqual(seal.safeObservation());
    const inputs = await claimAcpReleaseParentQualificationInputs(seal);
    expect(inputs.map(({ issuer }) => issuer)).toEqual([
      "opencode_acp_task_attestor",
      "codex_acp_task_attestor",
      "acp_meta_attestor",
    ]);
    expect(inputs[2]).not.toHaveProperty("taskWorkspaceDirectory");
  });

  it("rejects symlinked auth and permission-weak input without invoking a version probe", async () => {
    const fixture = await createFixture();
    const realAuth = path.join(fixture.root, "real-auth.json");
    const linkedAuth = path.join(fixture.root, "linked-auth.json");
    await writePrivateJson(realAuth, { token: "opaque" });
    await symlink(realAuth, linkedAuth);
    const envelope = JSON.parse(await readFile(fixture.envelopes.openCode, "utf8")) as {
      hostEnvironment: Record<string, string>;
    };
    envelope.hostEnvironment.AGENT_WORKSPACE_OPENCODE_AUTH = linkedAuth;
    await writePrivateJson(fixture.envelopes.openCode, envelope);
    await expect(createAcpReleaseParentInputSeal({ environment: fixture.environment }))
      .rejects.toThrow("acp_release_parent_auth_invalid");

    envelope.hostEnvironment.AGENT_WORKSPACE_OPENCODE_AUTH = fixture.auth.openCode;
    await writePrivateJson(fixture.envelopes.openCode, envelope);
    await chmod(fixture.workspaces.openCode, 0o755);
    await expect(createAcpReleaseParentInputSeal({ environment: fixture.environment }))
      .rejects.toThrow("acp_release_parent_workspace_invalid");
    await expect(readFile(fixture.effectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens and hashes every input immediately before first effect and rejects drift one-shot", async () => {
    const fixture = await createFixture();
    const seal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });
    await writeFile(fixture.auth.codex, "changed", { mode: 0o600 });
    await chmod(fixture.auth.codex, 0o600);

    await expect(consumeAcpReleaseParentInputSealBeforeFirstEffect(seal))
      .rejects.toThrow("acp_release_parent_input_drift");
    await expect(consumeAcpReleaseParentInputSealBeforeFirstEffect(seal))
      .rejects.toThrow("acp_release_parent_input_seal_already_consumed");
    await expect(readFile(fixture.effectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates the exact projected qualification observation batch", async () => {
    const fixture = await createFixture();
    const seal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });
    await consumeAcpReleaseParentInputSealBeforeFirstEffect(seal);
    const codex = JSON.parse(await readFile(fixture.envelopes.codex, "utf8")) as {
      taskModel: string;
    };
    codex.taskModel = "drifted/model";
    await writePrivateJson(fixture.envelopes.codex, codex);

    await expect(claimAcpReleaseParentQualificationInputs(seal))
      .rejects.toThrow("acp_release_parent_input_drift");
  });

  it("gives each launcher a separate one-shot lane seal bound to its parsed envelope", async () => {
    const fixture = await createFixture();
    const seal = await createAcpReleaseLaneInputSeal({
      envelopeFile: fixture.envelopes.openCode,
      issuer: "opencode_acp_task_attestor",
    });
    expect(seal.hostEnvironment()).toMatchObject({
      issuer: "opencode_acp_task_attestor",
      workspaceDirectory: fixture.workspaces.openCode,
    });
    expect(JSON.stringify(seal)).not.toContain(fixture.root);
    await consumeAcpReleaseLaneInputSealBeforeFirstEffect(seal);
    await expect(consumeAcpReleaseLaneInputSealBeforeFirstEffect(seal))
      .rejects.toThrow("acp_release_lane_input_seal_already_consumed");
  });
});

async function createFixture(): Promise<Readonly<{
  root: string;
  effectMarker: string;
  environment: NodeJS.ProcessEnv;
  envelopes: Readonly<{ openCode: string; codex: string; meta: string }>;
  workspaces: Readonly<{ openCode: string; codex: string; meta: string }>;
  auth: Readonly<{ openCode: string; codex: string; meta: string }>;
}>> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acp-parent-preflight-")));
  roots.push(root);
  await chmod(root, 0o700);
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const effectMarker = path.join(root, "artifact-was-executed");
  for (const name of ["opencode", "codex-acp", "codex", "node", "meta-opencode"]) {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\nprintf executed > ${JSON.stringify(effectMarker)}\n`, { mode: 0o700 });
    await chmod(file, 0o700);
  }
  const workspaces = Object.freeze({
    openCode: await emptyPrivateDirectory(root, "workspace-opencode"),
    codex: await emptyPrivateDirectory(root, "workspace-codex"),
    meta: await emptyPrivateDirectory(root, "workspace-meta-input-only"),
  });
  const auth = Object.freeze({
    openCode: path.join(root, "opencode-auth.json"),
    codex: path.join(root, "codex-auth.json"),
    meta: path.join(root, "meta-auth.json"),
  });
  await Promise.all(Object.values(auth).map((file) => writePrivateJson(file, { token: "opaque" })));
  const envelopes = Object.freeze({
    openCode: path.join(root, "opencode-task-envelope.json"),
    codex: path.join(root, "codex-task-envelope.json"),
    meta: path.join(root, "meta-envelope.json"),
  });
  await writePrivateJson(envelopes.openCode, taskEnvelope({
    providerFamily: "opencode",
    workspaceDirectory: workspaces.openCode,
    bin,
    authFile: auth.openCode,
  }));
  await writePrivateJson(envelopes.codex, taskEnvelope({
    providerFamily: "codex",
    workspaceDirectory: workspaces.codex,
    bin,
    authFile: auth.codex,
  }));
  await writePrivateJson(envelopes.meta, metaEnvelope({
    workspaceDirectory: workspaces.meta,
    bin,
    authFile: auth.meta,
  }));
  return Object.freeze({
    root,
    effectMarker,
    environment: {
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_opencode-acp-task"]]: envelopes.openCode,
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_codex-acp-task"]]: envelopes.codex,
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_acp-meta"]]: envelopes.meta,
    },
    envelopes,
    workspaces,
    auth,
  });
}

function taskEnvelope(input: Readonly<{
  providerFamily: "opencode" | "codex";
  workspaceDirectory: string;
  bin: string;
  authFile: string;
}>): unknown {
  const configuration = input.providerFamily === "opencode"
    ? {
        schemaVersion: 1,
        agents: {
          opencode: {
            kind: "opencode-acp-current-install",
            command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" },
            executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
            authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" },
          },
        },
        metaProfiles: [],
      }
    : {
        schemaVersion: 1,
        agents: {
          codex: {
            kind: "codex-acp-current-install",
            wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
            codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" },
            nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
            executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
            authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" },
          },
        },
        metaProfiles: [],
      };
  const hostEnvironment = input.providerFamily === "opencode"
    ? {
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration),
        AGENT_WORKSPACE_OPENCODE_COMMAND: path.join(input.bin, "opencode"),
        AGENT_WORKSPACE_ACP_SEARCH_PATH: input.bin,
        AGENT_WORKSPACE_OPENCODE_AUTH: input.authFile,
      }
    : {
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration),
        AGENT_WORKSPACE_CODEX_ACP_WRAPPER: path.join(input.bin, "codex-acp"),
        AGENT_WORKSPACE_CODEX_COMMAND: path.join(input.bin, "codex"),
        AGENT_WORKSPACE_NODE_COMMAND: path.join(input.bin, "node"),
        AGENT_WORKSPACE_ACP_SEARCH_PATH: input.bin,
        AGENT_WORKSPACE_CODEX_AUTH: input.authFile,
      };
  return {
    schemaVersion: 1,
    issuer: input.providerFamily === "opencode" ? "opencode_acp_task_attestor" : "codex_acp_task_attestor",
    workspaceDirectory: input.workspaceDirectory,
    taskModel: "current/model",
    hostEnvironment,
  };
}

function metaEnvelope(input: Readonly<{
  providerFamily?: "opencode" | "codex";
  workspaceDirectory: string;
  bin: string;
  authFile: string;
}>): unknown {
  const providerFamily = input.providerFamily ?? "opencode";
  const agent = providerFamily === "opencode"
    ? {
        opencode: {
          kind: "opencode-acp-current-install",
          command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" },
          executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
          authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" },
        },
      }
    : {
        codex: {
          kind: "codex-acp-current-install",
          wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
          codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" },
          nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
          executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
          authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" },
        },
      };
  const configuration = {
    schemaVersion: 1,
    agents: agent,
    metaProfiles: [{
      metaProfileOptionId: "meta_profile_option_release",
      title: "Release Meta",
      profile: {
        metaProfileId: "meta_profile_release",
        profileRevisionId: "profile_revision_release-meta",
        providerFamily,
        acpAgentKind: providerFamily === "opencode" ? "native_acp" : "codex_acp",
        protocolMajor: 1,
        role: "meta",
        model: "current/meta-model",
        configIntent: {},
        requiredExtensions: [],
        capabilityPolicy: {
          requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
    }],
  };
  const hostEnvironment = providerFamily === "opencode"
    ? {
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration),
        AGENT_WORKSPACE_OPENCODE_COMMAND: path.join(input.bin, "meta-opencode"),
        AGENT_WORKSPACE_ACP_SEARCH_PATH: input.bin,
        AGENT_WORKSPACE_OPENCODE_AUTH: input.authFile,
      }
    : {
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration),
        AGENT_WORKSPACE_CODEX_ACP_WRAPPER: path.join(input.bin, "codex-acp"),
        AGENT_WORKSPACE_CODEX_COMMAND: path.join(input.bin, "codex"),
        AGENT_WORKSPACE_NODE_COMMAND: path.join(input.bin, "node"),
        AGENT_WORKSPACE_ACP_SEARCH_PATH: input.bin,
        AGENT_WORKSPACE_CODEX_AUTH: input.authFile,
      };
  return {
    schemaVersion: 1,
    issuer: "acp_meta_attestor",
    workspaceDirectory: input.workspaceDirectory,
    metaProfileOptionId: "meta_profile_option_release",
    hostEnvironment,
  };
}

async function emptyPrivateDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
