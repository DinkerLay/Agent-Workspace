import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEvidenceSafe,
  evidencePermissions,
  type JourneyCheckpoint,
  JourneyEvidenceRecorder,
} from "./journey-evidence.js";

const roots: string[] = [];
const allCheckpoints = ["DS-01", "DS-02", "DS-03", "DS-04", "DS-05", "DS-06", "DS-07", "DS-08", "DS-09"] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("JourneyEvidenceRecorder", () => {
  it("writes ordered, private, checksummed DS-01..09 checkpoints with stable native aliases", async () => {
    const parent = await evidenceParent();
    const root = path.join(parent, "journey_deepsearch");
    const recorder = new JourneyEvidenceRecorder({ root, journeyId: "journey_deepsearch", aliasKey: Buffer.alloc(32, 7) });
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
    const ledger = (await readFile(path.join(root, "checkpoint-ledger.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { checkpoint: string; sequence: number; identities?: Readonly<Record<string, string>> });
    expect(ledger.map(({ checkpoint: name, sequence }) => ({ name, sequence }))).toEqual(allCheckpoints.map((name, index) => ({ name, sequence: index + 1 })));
    expect(ledger.find(({ checkpoint: name }) => name === "DS-05")).toMatchObject({ identities: { binding } });
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
    await expect(new JourneyEvidenceRecorder({
      root: path.join(parent, "journey_reserved_schema"),
      journeyId: "journey_reserved-schema",
    }).initialize({ schemaVersion: 999 })).rejects.toThrow("journey_evidence_manifest_reserved_field");
    await expect(new JourneyEvidenceRecorder({
      root: path.join(parent, "journey_reserved_id"),
      journeyId: "journey_reserved-id",
    }).initialize({ journeyId: "journey_attacker" })).rejects.toThrow("journey_evidence_manifest_reserved_field");
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
      identities: { task: "task_deepsearch", invocation: "invocation_ds-01" },
      observation: { taskId: "task_deepsearch", invocationId: "invocation_ds-01" },
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
    const first = new JourneyEvidenceRecorder({ root, journeyId: "journey_resume" });
    await first.initialize({ gitHead: "abc123" });
    const nativeAlias = first.aliasNative("provider_thread", "thread_abc123456789");
    await Promise.all([
      first.record(checkpoint(first, { checkpoint: "DS-01", assertions: [{ id: "ds-01", outcome: "PASS" }] })),
      first.record(checkpoint(first, { checkpoint: "DS-02", assertions: [{ id: "ds-02", outcome: "PASS" }] })),
      first.record(checkpoint(first, { checkpoint: "DS-03", assertions: [{ id: "ds-03", outcome: "PASS" }] })),
    ]);

    const resumed = new JourneyEvidenceRecorder({ root, journeyId: "journey_resume" });
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
    const resumed = new JourneyEvidenceRecorder({ root, journeyId: "journey_attachment-safety" });
    await resumed.initialize({ gitHead: "abc123" });
    await expect(resumed.record(checkpoint(resumed))).rejects.toThrow("journey_evidence_finalized");

    const symlinkRoot = path.join(parent, "journey_attachment_symlink");
    const symlinkRecorder = new JourneyEvidenceRecorder({ root: symlinkRoot, journeyId: "journey_attachment-symlink" });
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
    })).resolves.toBeUndefined();

    for (const outcome of ["FAIL", "BLOCKED_CAPABILITY", "NOT_EXERCISED"] as const) {
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
});

async function evidenceParent(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "agent-workspace-journey-evidence-"));
  roots.push(parent);
  return parent;
}

async function initializedRecorder(parent: string, journeyId: string): Promise<JourneyEvidenceRecorder> {
  const recorder = new JourneyEvidenceRecorder({ root: path.join(parent, journeyId), journeyId });
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
    surface: "domain",
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
