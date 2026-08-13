import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEvidenceSafe,
  createAcpMetaEvidenceAuthority,
  createBrowserEvidenceAuthority,
  createCodexAcpTaskEvidenceAuthority,
  createOpenCodeAcpTaskEvidenceAuthority,
  createRuntimeHostEvidenceAuthority,
  evidencePermissions,
  FULL_JOURNEY_CHECKPOINTS,
  type JourneyEvidenceAuthority,
  type JourneyEvidenceAuthorityInput,
  type JourneyEvidenceCellDeclaration,
  type JourneyEvidenceCellResult,
  type JourneyEvidenceLineage,
  type JourneyEvidenceMatrix,
  type JourneyEvidenceStream,
  type JourneyCheckpoint,
  JourneyEvidenceRecorder,
  verifyJourneyEvidenceMatrix,
} from "./journey-evidence.js";

const roots: string[] = [];
const allCheckpoints = ["DS-01", "DS-02", "DS-03", "DS-04", "DS-05", "DS-06", "DS-07", "DS-08", "DS-09"] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("JourneyEvidenceRecorder", () => {
  it("uses a runner-owned J-01..J-12 checkpoint contract without changing superseded DS bundles", async () => {
    const parent = await evidenceParent();
    const root = path.join(parent, "journey_full-checkpoints");
    const recorder = new JourneyEvidenceRecorder({
      root,
      journeyId: "journey_full-checkpoints",
      authority: runtimeAuthority("cell_full-checkpoints", "scenario_full-checkpoints"),
      requiredCheckpoints: FULL_JOURNEY_CHECKPOINTS,
    });
    await recorder.initialize({ harness: "phase7" });
    for (const checkpointName of FULL_JOURNEY_CHECKPOINTS) {
      await recorder.record(checkpoint(recorder, {
        checkpoint: checkpointName,
        assertions: [{ id: `full-${checkpointName}`, outcome: "PASS" }],
      }));
    }
    await expect(recorder.finalize({
      outcome: "PASS",
      assertions: FULL_JOURNEY_CHECKPOINTS.map((name) => ({ id: `full-${name}`, outcome: "PASS" as const })),
      residualRisks: [],
    })).resolves.toMatchObject({ outcome: "PASS" });
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { checkpointContract: string[] };
    expect(manifest.checkpointContract).toEqual(FULL_JOURNEY_CHECKPOINTS);
  });

  it("writes ordered, private, checksummed DS-01..09 checkpoints with stable native aliases", async () => {
    const parent = await evidenceParent();
    const root = path.join(parent, "journey_deepsearch");
    const recorder = new JourneyEvidenceRecorder({
      root,
      journeyId: "journey_deepsearch",
      authority: runtimeAuthority("cell_deepsearch", "scenario_deepsearch"),
      aliasKey: Buffer.alloc(32, 7),
    });
    await recorder.initialize({ gitHead: "abc123", dirty: true, runtimeSchemaVersion: 10 });
    const binding = recorder.aliasNative("binding", "native-thread-secret-value");
    expect(binding).toBe(recorder.aliasNative("binding", "native-thread-secret-value"));
    expect(binding).not.toContain("native-thread");
    for (const checkpointName of allCheckpoints) {
      await recorder.record(checkpoint(recorder, {
        checkpoint: checkpointName,
        ...(checkpointName === "DS-05" ? {
          identities: { binding, task: "task_deepsearch" },
          summary: {
            ...summary(recorder),
            durableWriter: "provider_adapter",
            durableIdentity: "provider_fact_deepsearch-1",
          },
          observation: { factKind: "binding_observed", bindingRevision: 1 },
        } : {}),
        assertions: [{ id: "binding-fact-observed", outcome: "PASS" }],
      }));
    }
    expect(await recorder.writeJsonAttachment("ds-05-provider-summary.json", {
      factKinds: ["binding_observed", "assistant_final", "turn_completed"],
    })).toBe("attachments/ds-05-provider-summary.json");
    await recorder.finalize({ outcome: "PASS", assertions: [{ id: "binding-fact-observed", outcome: "PASS" }], residualRisks: [] });

    expect(await evidencePermissions(root)).toBe(0o700);
    expect(await evidencePermissions(path.join(root, "manifest.json"))).toBe(0o600);
    expect(await evidencePermissions(path.join(root, "checkpoint-ledger.jsonl"))).toBe(0o600);
    expect(await evidencePermissions(path.join(root, ".alias-key"))).toBe(0o600);
    expect(await evidencePermissions(path.join(root, "attachments"))).toBe(0o700);
    expect(await evidencePermissions(path.join(root, "attachments", "ds-05-provider-summary.json"))).toBe(0o600);
    expect(await evidencePermissions(path.join(root, "checksums.sha256"))).toBe(0o600);
    expect((await readFile(path.join(root, ".alias-key"))).equals(Buffer.alloc(32, 7))).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      releaseRunId: RELEASE.releaseRunId,
      nonce: RELEASE.nonce,
      digests: RELEASE.digests,
      bundleCellId: "cell_deepsearch",
      scenarioId: "scenario_deepsearch",
      lineage: { runtimeInstanceId: "runtime_instance_deepsearch" },
    });
    const ledger = (await readFile(path.join(root, "checkpoint-ledger.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as {
        checkpoint: string;
        sequence: number;
        releaseRunId: string;
        nonce: string;
        bundleCellId: string;
        scenarioId: string;
        issuer: string;
        evidenceClass: string;
        surface: string;
        identities?: Readonly<Record<string, string>>;
      });
    expect(ledger.map(({ checkpoint: name, sequence }) => ({ name, sequence }))).toEqual(allCheckpoints.map((name, index) => ({ name, sequence: index + 1 })));
    expect(ledger.find(({ checkpoint: name }) => name === "DS-05")).toMatchObject({ identities: { binding } });
    expect(ledger[0]).toMatchObject({
      releaseRunId: RELEASE.releaseRunId,
      nonce: RELEASE.nonce,
      bundleCellId: "cell_deepsearch",
      scenarioId: "scenario_deepsearch",
      issuer: "runtime_host",
      evidenceClass: "deterministic_fake",
      surface: "runtime-host",
    });
    const checksums = await readFile(path.join(root, "checksums.sha256"), "utf8");
    expect(checksums).toContain("checkpoint-ledger.jsonl");
    expect(checksums).toContain("attachments/ds-05-provider-summary.json");
    expect(checksums).toContain(".alias-key");
  });

  it("rejects every invalid checkpoint name and incomplete checkpoint summary", async () => {
    const parent = await evidenceParent();
    const recorder = await initializedRecorder(parent, "journey_checkpoint-contract");
    for (const valid of allCheckpoints) {
      await expect(recorder.record(checkpoint(recorder, { checkpoint: valid }))).resolves.toBeUndefined();
    }
    for (const invalid of ["DS-00", "DS-10", "DS-1", "ds-01", "XX-01"]) {
      await expect(recorder.record(checkpoint(recorder, { checkpoint: invalid as "DS-01" })))
        .rejects.toThrow("journey_checkpoint_name_invalid");
    }
    const incomplete = checkpoint(recorder, { checkpoint: "DS-01" }) as unknown as { summary?: unknown };
    delete incomplete.summary;
    await expect(recorder.record(incomplete as never)).rejects.toThrow("journey_checkpoint_summary_invalid");
    await expect(recorder.record(checkpoint(recorder, { assertions: [] }))).rejects.toThrow("journey_checkpoint_assertions_required");
  });

  it("rejects reserved manifest fields instead of allowing them to shadow recorder authority", async () => {
    const parent = await evidenceParent();
    const authority = runtimeAuthority("cell_reserved", "scenario_reserved");
    const reserved = {
      schemaVersion: 999,
      journeyId: "journey_attacker",
      releaseRunId: "release_attacker",
      nonce: "nonce_attacker_00000000",
      bundleCellId: "cell_attacker",
      scenarioId: "scenario_attacker",
      issuer: "opencode_acp_task_attestor",
      evidenceClass: "qualified_acp_provider",
      surface: "provider",
      status: "PASS",
      outcome: "PASS",
      digests: RELEASE.digests,
      lineage: { runtimeInstanceId: "runtime_instance_attacker" },
      checkpointContract: ["J-01"],
    } as const;
    for (const [index, [field, value]] of Object.entries(reserved).entries()) {
      await expect(new JourneyEvidenceRecorder({
        root: path.join(parent, `journey_reserved-${index}`),
        journeyId: `journey_reserved-${index}`,
        authority,
      }).initialize({ [field]: value })).rejects.toThrow("journey_evidence_manifest_reserved_field");
    }
  });

  it("deep-scans every bounded string for credentials, userinfo, and host paths", () => {
    const sensitive = [
      "sk-1234567890abcdef",
      "sk-proj-1234567890abcdef",
      "gho_123456789012345678901234567890123456",
      "ghp_123456789012345678901234567890123456",
      "ghu_123456789012345678901234567890123456",
      "ghs_123456789012345678901234567890123456",
      "ghr_123456789012345678901234567890123456",
      "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
      "AKIA1234567890ABCDEF",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "OPENAI_API_KEY=do-not-record-this",
      "OPENAI_API_KEY=\"do-not-record-this\"",
      "--api-key do-not-record-this",
      "{\"client_secret\":\"do-not-record-this\"}",
      "{\"OPENAI_API_KEY\":\"do-not-record-this\"}",
      "https://alice:password@example.test/research",
      "https://alice@example.test/research",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "/Users/example/project",
      "/home/example/project",
      "/private/runtime.sock",
      "/tmp/runtime.sock",
      "/var/run/runtime.sock",
      "/Volumes/Workspace/project",
      "/etc/agent/config",
      "/opt/agent/bin",
      "/root/project",
      "/srv/agent/project",
      "/mnt/workspace/project",
      "C:\\Users\\example\\project",
      "D:\\Agent\\project",
      "\\\\server\\share\\project",
    ];
    for (const [index, value] of sensitive.entries()) {
      expect(() => assertEvidenceSafe({ deeply: [{ nested: { index, value } }] })).toThrow("journey_evidence_sensitive_content");
    }
    expect(() => assertEvidenceSafe({ nested: { password: "not-redacted" } })).toThrow("journey_evidence_sensitive_content");
    expect(() => assertEvidenceSafe({ nested: { OPENAI_API_KEY: "not-redacted" } })).toThrow("journey_evidence_sensitive_content");
    expect(() => assertEvidenceSafe({ nested: { value: "x".repeat(65_537) } })).toThrow("journey_evidence_string_too_large");
    expect(() => assertEvidenceSafe(cyclicValue())).toThrow("journey_evidence_payload_not_json");
  });

  it("allows only real public Runtime IDs and aliases every provider-native identity", async () => {
    const parent = await evidenceParent();
    const recorder = await initializedRecorder(parent, "journey_identity-gate");
    await expect(recorder.record(checkpoint(recorder, {
      identities: { task: "task_identity-gate", sessionTurn: "session_turn_identity-gate" },
      observation: { taskId: "task_identity-gate", sessionTurnId: "session_turn_identity-gate" },
    }))).resolves.toBeUndefined();
    await expect(recorder.record(checkpoint(recorder, {
      identities: { task: "provider_thread_public-looking" },
    }))).rejects.toThrow("journey_evidence_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      identities: { thread: "task_provider-native-disguised" },
    }))).rejects.toThrow("journey_evidence_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { providerThreadId: "thread_abc123456789" },
    }))).rejects.toThrow("journey_evidence_observation_native_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { nested: { sessionId: "019fe21f-df2a-7673-87e9-567348187577" } },
    }))).rejects.toThrow("journey_evidence_observation_native_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { nested: { sessionId: 123456789 } },
    }))).rejects.toThrow("journey_evidence_observation_native_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { note: "ses_abc123456789" },
    }))).rejects.toThrow("journey_evidence_observation_native_identity_not_aliased");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { mysteryId: "opaque-native-value" },
    }))).rejects.toThrow("journey_evidence_observation_identity_field_not_allowlisted");
    await expect(recorder.record(checkpoint(recorder, {
      observation: { providerThreadId: recorder.aliasNative("provider_thread", "thread_abc123456789") },
    }))).resolves.toBeUndefined();
  });

  it("serializes concurrent records and resumes sequence and alias state without truncation", async () => {
    const parent = await evidenceParent();
    const root = path.join(parent, "journey_resume");
    const authority = runtimeAuthority("cell_resume", "scenario_resume");
    const first = new JourneyEvidenceRecorder({ root, journeyId: "journey_resume", authority });
    await first.initialize({ gitHead: "abc123" });
    const nativeAlias = first.aliasNative("provider_thread", "thread_abc123456789");
    await Promise.all([
      first.record(checkpoint(first, { checkpoint: "DS-01", assertions: [{ id: "ds-01", outcome: "PASS" }] })),
      first.record(checkpoint(first, { checkpoint: "DS-02", assertions: [{ id: "ds-02", outcome: "PASS" }] })),
      first.record(checkpoint(first, { checkpoint: "DS-03", assertions: [{ id: "ds-03", outcome: "PASS" }] })),
    ]);

    const resumed = new JourneyEvidenceRecorder({ root, journeyId: "journey_resume", authority });
    await resumed.initialize({ gitHead: "abc123" });
    expect(resumed.aliasNative("provider_thread", "thread_abc123456789")).toBe(nativeAlias);
    await resumed.record(checkpoint(resumed, { checkpoint: "DS-04", assertions: [{ id: "ds-04", outcome: "PASS" }] }));

    const entries = (await readFile(path.join(root, "checkpoint-ledger.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; checkpoint: string });
    expect(entries.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(entries.map(({ checkpoint: name }) => name)).toEqual(["DS-01", "DS-02", "DS-03", "DS-04"]);
  });

  it("rejects unsafe or overwriting attachments and all writes after finalization", async () => {
    const parent = await evidenceParent();
    const root = path.join(parent, "journey_attachment-safety");
    const recorder = await initializedRecorder(parent, "journey_attachment-safety");
    await expect(recorder.writeJsonAttachment("../escape.json", {})).rejects.toThrow("journey_evidence_attachment_name_invalid");
    await recorder.writeJsonAttachment("proof.json", { safe: true });
    await expect(recorder.writeJsonAttachment("proof.json", { replaced: true })).rejects.toThrow("journey_evidence_attachment_exists");
    await recorder.record(checkpoint(recorder, { assertions: [{ id: "required-proof", outcome: "PASS" }] }));
    await recorder.finalize({ outcome: "FAIL", assertions: [{ id: "required-proof", outcome: "PASS" }], residualRisks: [] });
    await expect(recorder.record(checkpoint(recorder))).rejects.toThrow("journey_evidence_finalized");
    await expect(recorder.writeJsonAttachment("late.json", {})).rejects.toThrow("journey_evidence_finalized");
    await expect(recorder.finalize({ outcome: "FAIL", assertions: [{ id: "required-proof", outcome: "PASS" }], residualRisks: [] }))
      .rejects.toThrow("journey_evidence_finalized");
    const resumed = new JourneyEvidenceRecorder({
      root,
      journeyId: "journey_attachment-safety",
      authority: runtimeAuthority("cell_attachment-safety", "scenario_attachment-safety"),
    });
    await resumed.initialize({ gitHead: "abc123" });
    await expect(resumed.record(checkpoint(resumed))).rejects.toThrow("journey_evidence_finalized");

    const symlinkRoot = path.join(parent, "journey_attachment_symlink");
    const symlinkRecorder = new JourneyEvidenceRecorder({
      root: symlinkRoot,
      journeyId: "journey_attachment-symlink",
      authority: runtimeAuthority("cell_attachment-symlink", "scenario_attachment-symlink"),
    });
    await symlinkRecorder.initialize({ gitHead: "abc123" });
    const outside = path.join(parent, "outside");
    await symlink(outside, path.join(symlinkRoot, "attachments"), "dir");
    await expect(symlinkRecorder.writeJsonAttachment("escape.json", {})).rejects.toThrow("journey_evidence_attachment_directory_unsafe");
    expect(root).toContain("journey_attachment-safety");
  });

  it("does not allow PASS when a required checkpoint or final assertion failed or was not exercised", async () => {
    const parent = await evidenceParent();
    const recorder = await initializedRecorder(parent, "journey_pass-integrity");
    await recorder.record(checkpoint(recorder, {
      assertions: [
        { id: "required-pass", outcome: "PASS" },
        { id: "optional-diagnostic", outcome: "NOT_EXERCISED", required: false },
      ],
    }));
    await expect(recorder.finalize({
      outcome: "PASS",
      assertions: [
        { id: "required-pass", outcome: "PASS" },
        { id: "required-fail", outcome: "FAIL" },
      ],
      residualRisks: [],
    })).rejects.toThrow("journey_evidence_pass_has_unsatisfied_assertion");
    await expect(recorder.finalize({
      outcome: "PASS",
      assertions: [{ id: "required-pass", outcome: "PASS" }],
      residualRisks: [],
    })).rejects.toThrow("journey_evidence_pass_missing_checkpoint");
    for (const checkpointName of allCheckpoints.slice(1)) {
      await recorder.record(checkpoint(recorder, {
        checkpoint: checkpointName,
        assertions: [
          { id: "required-pass", outcome: "PASS" },
          { id: "optional-diagnostic", outcome: "NOT_EXERCISED", required: false },
        ],
      }));
    }
    await expect(recorder.finalize({
      outcome: "PASS",
      assertions: [{ id: "required-pass", outcome: "PASS" }],
      residualRisks: [],
    })).resolves.toMatchObject({
      outcome: "PASS",
      issuer: "runtime_host",
      evidenceClass: "deterministic_fake",
    });

    for (const outcome of ["FAIL", "BLOCKED_CAPABILITY", "NOT_EXERCISED", "NOT_APPLICABLE"] as const) {
      const suffix = outcome.toLowerCase().replaceAll("_", "-");
      const guarded = await initializedRecorder(parent, `journey_pass-${suffix}`);
      await guarded.record(checkpoint(guarded, { assertions: [{ id: `required-${suffix}`, outcome }] }));
      await expect(guarded.finalize({
        outcome: "PASS",
        assertions: [{ id: `required-${suffix}`, outcome }],
        residualRisks: [],
      })).rejects.toThrow("journey_evidence_pass_has_unsatisfied_assertion");
    }
  });

  it("accepts only authorities created by a class-specific factory", async () => {
    const parent = await evidenceParent();
    const authority = runtimeAuthority("cell_authority", "scenario_authority");
    const forged = {
      ...authority,
      issuer: "opencode_acp_task_attestor",
      evidenceClass: "qualified_acp_provider",
      surface: "provider",
    } as unknown as JourneyEvidenceAuthority;
    expect(() => new JourneyEvidenceRecorder({
      root: path.join(parent, "journey_forged-authority"),
      journeyId: "journey_forged-authority",
      authority: forged,
    })).toThrow("journey_evidence_authority_invalid");

    const native = createOpenCodeAcpTaskEvidenceAuthority(authorityInput("cell_opencode-acp-task", "scenario_opencode-acp-task"));
    expect(native).toMatchObject({
      issuer: "opencode_acp_task_attestor",
      evidenceClass: "qualified_acp_provider",
      surface: "provider",
    });
    expect(Object.isFrozen(native)).toBe(true);
    expect(createCodexAcpTaskEvidenceAuthority(authorityInput("cell_codex-acp-task", "scenario_codex-acp-task")))
      .toMatchObject({
        issuer: "codex_acp_task_attestor",
        evidenceClass: "qualified_acp_provider",
        surface: "provider",
      });
    expect(createAcpMetaEvidenceAuthority(authorityInput("cell_acp-meta", "scenario_acp-meta")))
      .toMatchObject({
        issuer: "acp_meta_attestor",
        evidenceClass: "qualified_acp_meta",
        surface: "provider",
      });
  });

  it("rejects stale nonce, undeclared cells, cross-cell substitution, and forged issuer/class", async () => {
    const parent = await evidenceParent();
    const authority = runtimeAuthority("cell_matrix-a", "scenario_matrix-a");
    const result = await evidenceResult(parent, "journey_matrix-a", authority);
    const expected = releaseMatrix([requiredCell(authority)]);

    expect(() => verifyJourneyEvidenceMatrix(expected, [{
      ...result,
      nonce: "nonce_phase1_stale_0001",
    }])).toThrow("journey_evidence_release_mismatch");

    expect(() => verifyJourneyEvidenceMatrix(expected, [{
      ...result,
      bundleCellId: "cell_not-declared",
      scenarioId: "scenario_not-declared",
    }])).toThrow("journey_evidence_cell_not_declared");

    const declaredTarget = runtimeAuthority("cell_matrix-target", "scenario_matrix-target", {
      runtimeInstanceId: "runtime_instance_matrix-target",
    });
    expect(() => verifyJourneyEvidenceMatrix(releaseMatrix([{
      ...requiredCell(authority),
      required: false,
    }, requiredCell(declaredTarget)]), [{
      ...result,
      bundleCellId: declaredTarget.bundleCellId,
      scenarioId: declaredTarget.scenarioId,
    }])).toThrow("journey_evidence_cell_lineage_mismatch");

    expect(() => verifyJourneyEvidenceMatrix(expected, [{
      ...result,
      issuer: "opencode_acp_task_attestor",
      evidenceClass: "qualified_acp_provider",
      surface: "provider",
    }])).toThrow("journey_evidence_stream_not_declared");

    expect(() => verifyJourneyEvidenceMatrix(expected, [{
      ...result,
      issuer: "opencode_acp_task_attestor",
    }])).toThrow("journey_evidence_issuer_class_mismatch");
    expect(() => verifyJourneyEvidenceMatrix(expected, [{
      ...result,
      evidenceClass: "qualified_acp_provider",
    }])).toThrow("journey_evidence_issuer_class_mismatch");

    const secondAuthority = runtimeAuthority("cell_matrix-b", "scenario_matrix-b", {
      runtimeInstanceId: "runtime_instance_matrix-b",
    });
    const twoRequiredCells = releaseMatrix([requiredCell(authority), requiredCell(secondAuthority)]);
    expect(() => verifyJourneyEvidenceMatrix(twoRequiredCells, [result]))
      .toThrow("journey_evidence_required_cell_missing");
  });

  it("keeps lineage local to a declared cell while allowing clean fixtures in different cells", async () => {
    const parent = await evidenceParent();
    const shared = authorityInput("cell_linked", "scenario_linked", {
      lineage: {
        runtimeInstanceId: "runtime_instance_linked",
      },
    });
    const browserAuthority = createBrowserEvidenceAuthority(shared);
    const hostAuthority = createRuntimeHostEvidenceAuthority(shared);
    const browserResult = await evidenceResult(parent, "journey_linked-browser", browserAuthority);
    const hostResult = await evidenceResult(parent, "journey_linked-host", hostAuthority);
    const linkedMatrix = releaseMatrix([{
      bundleCellId: shared.bundleCellId,
      scenarioId: shared.scenarioId,
      lineage: shared.lineage,
      required: true,
      streams: [streamOf(browserAuthority), streamOf(hostAuthority)],
    }]);
    expect(() => verifyJourneyEvidenceMatrix(linkedMatrix, [browserResult, hostResult])).not.toThrow();

    const mismatchedHost = createRuntimeHostEvidenceAuthority({
      ...shared,
      lineage: {
        runtimeInstanceId: "runtime_instance_other",
      },
    });
    const mismatchedResult = await evidenceResult(parent, "journey_linked-mismatch", mismatchedHost);
    expect(() => verifyJourneyEvidenceMatrix(linkedMatrix, [browserResult, mismatchedResult]))
      .toThrow("journey_evidence_cell_lineage_mismatch");

    const cleanCell = runtimeAuthority("cell_clean-fixture", "scenario_clean-fixture", {
      runtimeInstanceId: "runtime_instance_clean-fixture",
    });
    const cleanResult = await evidenceResult(parent, "journey_clean-fixture", cleanCell);
    expect(() => verifyJourneyEvidenceMatrix(
      releaseMatrix([requiredCell(browserAuthority), requiredCell(cleanCell)]),
      [browserResult, cleanResult],
    )).not.toThrow();
  });

  it("allows NOT_APPLICABLE only for an optional matrix cell", async () => {
    const parent = await evidenceParent();
    const authority = runtimeAuthority("cell_optional", "scenario_optional");
    const result = await evidenceResult(parent, "journey_optional", authority, "NOT_APPLICABLE");

    expect(() => verifyJourneyEvidenceMatrix(releaseMatrix([requiredCell(authority)]), [result]))
      .toThrow("journey_evidence_required_cell_not_pass");
    expect(() => verifyJourneyEvidenceMatrix(releaseMatrix([{
      ...requiredCell(authority),
      required: false,
    }]), [result])).not.toThrow();
  });
});

async function evidenceParent(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "agent-workspace-journey-evidence-"));
  roots.push(parent);
  return parent;
}

async function initializedRecorder(parent: string, journeyId: string): Promise<JourneyEvidenceRecorder> {
  const recorder = new JourneyEvidenceRecorder({
    root: path.join(parent, journeyId),
    journeyId,
    authority: runtimeAuthority(`cell_${journeyId.slice("journey_".length)}`, `scenario_${journeyId.slice("journey_".length)}`),
  });
  await recorder.initialize({ gitHead: "abc123" });
  return recorder;
}

function summary(recorder: JourneyEvidenceRecorder): JourneyCheckpoint["summary"] {
  return {
    durableWriter: "task_run_service",
    durableIdentity: "task_deepsearch",
    command: {
      commandId: "command_deepsearch-1",
      idempotencyKey: recorder.aliasNative("idempotency_key", "deepsearch-command-1"),
      fence: "expectedRevision=1",
    },
    externalEffect: {
      kind: "none",
      recovery: "durable command replay",
    },
  };
}

function checkpoint(
  recorder: JourneyEvidenceRecorder,
  overrides: Partial<JourneyCheckpoint> = {},
): JourneyCheckpoint {
  return {
    checkpoint: "DS-01",
    eventKind: "assertion",
    observedAt: "2026-08-09T00:00:00.000Z",
    summary: summary(recorder),
    observation: { state: "draft_ready" },
    assertions: [{ id: "checkpoint-contract", outcome: "PASS" }],
    ...overrides,
  };
}

function cyclicValue(): unknown {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

const RELEASE = Object.freeze({
  releaseRunId: "release_phase1-current",
  nonce: "nonce_phase1_current_0001",
  digests: Object.freeze({
    sourceDigest: `sha256:${"1".repeat(64)}`,
    buildDigest: `sha256:${"2".repeat(64)}`,
    schemaDigest: `sha256:${"3".repeat(64)}`,
    providerPolicyDigest: `sha256:${"4".repeat(64)}`,
    policyDigest: `sha256:${"5".repeat(64)}`,
  }),
});

function authorityInput(
  bundleCellId: string,
  scenarioId: string,
  options: Readonly<{ lineage?: JourneyEvidenceLineage; nonce?: string }> = {},
): JourneyEvidenceAuthorityInput {
  return {
    ...RELEASE,
    nonce: options.nonce ?? RELEASE.nonce,
    bundleCellId,
    scenarioId,
    lineage: options.lineage ?? {
      runtimeInstanceId: `runtime_instance_${scenarioId.slice("scenario_".length)}`,
    },
  };
}

function runtimeAuthority(
  bundleCellId: string,
  scenarioId: string,
  lineage?: JourneyEvidenceLineage,
): JourneyEvidenceAuthority {
  return createRuntimeHostEvidenceAuthority(authorityInput(bundleCellId, scenarioId, { lineage }));
}

function streamOf(authority: JourneyEvidenceAuthority): JourneyEvidenceStream {
  return {
    issuer: authority.issuer,
    evidenceClass: authority.evidenceClass,
    surface: authority.surface,
  };
}

function requiredCell(authority: JourneyEvidenceAuthority): JourneyEvidenceCellDeclaration {
  return {
    bundleCellId: authority.bundleCellId,
    scenarioId: authority.scenarioId,
    lineage: authority.lineage,
    required: true,
    streams: [streamOf(authority)],
  };
}

function releaseMatrix(cells: readonly JourneyEvidenceCellDeclaration[]): JourneyEvidenceMatrix {
  return { ...RELEASE, cells };
}

async function evidenceResult(
  parent: string,
  journeyId: string,
  authority: JourneyEvidenceAuthority,
  outcome: JourneyEvidenceCellResult["outcome"] = "PASS",
): Promise<JourneyEvidenceCellResult> {
  const recorder = new JourneyEvidenceRecorder({ root: path.join(parent, journeyId), journeyId, authority });
  await recorder.initialize({ harness: "phase1_evidence_schema" });
  const checkpoints = outcome === "PASS" ? allCheckpoints : allCheckpoints.slice(0, 1);
  for (const checkpointName of checkpoints) {
    await recorder.record(checkpoint(recorder, {
      checkpoint: checkpointName,
      assertions: [{ id: `${journeyId}-assertion`, outcome: "PASS" }],
    }));
  }
  return recorder.finalize({
    outcome,
    assertions: [{ id: `${journeyId}-assertion`, outcome: "PASS" }],
    residualRisks: [],
  });
}
