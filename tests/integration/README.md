# Provider integration probes

These are explicit, version-pinned integration probes. They never turn an
offline fixture into a claim about OpenCode, Codex, or Claude Code.

## Safe protocol/capability probe

The default test suite skips this probe. To run it, provide one Host-only JSON
configuration through `AGENT_WORKSPACE_PROVIDER_CONFIG`, select one configured
provider, and optionally choose an ignored evidence path:

```bash
AGENT_WORKSPACE_PROVIDER_SPIKE_PROVIDER=opencode \
AGENT_WORKSPACE_PROVIDER_SPIKE_EVIDENCE_PATH="$PWD/.agent-workspace/evidence/opencode-protocol.json" \
AGENT_WORKSPACE_PROVIDER_CONFIG='{"schemaVersion":1,"providers":[...]}' \
npm run test:integration
```

The JSON format is defined and validated by
`apps/runtime-host/src/provider-composition.ts`. It supports a pinned provider
version/fingerprint and the direct native transports `opencode-server`,
`codex-app-server`, and `claude-code-stream` only. It has no generic HTTP or
one-shot process bridge. Credentials may only be `{ "env": "NAME" }`
references resolved inside Runtime Host; do not inline them in JSON or evidence.

This probe performs `inspect_protocol` and capability gating only. It writes a
redacted report containing the declared and observed version/fingerprint,
available capabilities, test path, timestamp, and residual risk. It does not
create a Provider session, send a prompt, read a transcript, or perform an
interrupt.

## Managed-core rule and required lifecycle spike

Run an isolated disposable-workspace probe against the exact installed version
before a local Host may start a managed Run for that Provider. Record these cases in a
separate redacted evidence report:

1. Create a binding, restart its Host, then resume the same native continuation.
2. Submit one uniquely tagged input and reconcile a native message/turn ID or
   evidence-backed history marker; accepted transport alone must not count.
3. Replay duplicate and out-of-order native events and prove fact deduplication.
4. Exercise an Attention reply with stale binding revision rejection before a
   Profile requires `attention_reply`.
5. Interrupt an active turn and prove native terminal confirmation; record the
   `unknown` path separately.
6. Before advertising `native_child`, observe a child/background operation and
   prove it is not silently promoted to a workbench Session.
7. Before advertising a native presentation, open and revoke a presentation
   lease, then verify Desktop and Browser use only the supported descriptor.

Published managed Template Profiles require all six capabilities:

```text
create_binding, resume_binding, input_correlation,
provider_receipt, reconcile, interrupt
```

The reusable contract suite validates Runtime semantics. A Provider may expose
only the capabilities that have these live observations for its pinned version
and protocol fingerprint; unsupported capabilities must remain unavailable. A
provider missing `interrupt` is not a degraded managed profile: it is not
eligible for local managed execution.

### Current pinned evidence

| Provider | Current direct native result | Local managed execution result |
| --- | --- | --- |
| Codex App Server `0.146.0`, `sha256:28161abf152e09a7a4c47427e9098a2407b048f5d16c099a4ec9cb282fbf8448` | Passed create, correlated receipt, terminal, composition reconstruction + resume, and targeted interrupt → native terminal. | The only currently evidence-qualified managed-core Provider; advanced capabilities remain unavailable. |
| OpenCode Server `1.18.13` | Create/input/terminal/resume observed, but target-correlated interrupt has not been proven. | Portable Profile may be shared, but local start/restart is rejected: it advertises no `interrupt`. |
| Claude Code stream `2.1.222` | Stream bridge/init capability plumbing exists, but there is no current full native lifecycle smoke record. | Portable Profile may be shared, but local start/restart is rejected until the full pinned smoke passes. |

## Direct native lifecycle smoke

`native-provider-lifecycle-smoke.test.ts` is an operator-run smoke for one
configured native provider. It is skipped unless
`AGENT_WORKSPACE_RUN_NATIVE_PROVIDER_LIFECYCLE_SMOKE=1` is set. It deliberately
constructs the selected `ProviderPort` through Runtime Host composition. The
configuration parser accepts only direct native transports, and this smoke
never injects a fake fetch, process, stream, or Provider transport.

The operator must supply all of the following:

- `AGENT_WORKSPACE_PROVIDER_CONFIG`: a version-pinned configuration containing
  the selected direct native transport. The test filters to that one Provider,
  so credentials for unrelated configured Providers are not resolved.
- `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_PROVIDER`: `opencode`, `codex`, or
  `claude-code`.
- `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_MODEL`: a real model identifier for
  that Provider.
- `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_EVIDENCE_PATH`: an absolute,
  ignored path for the redacted report.

Optional controls are `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_PROMPT`,
`AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_TIMEOUT_MS` (5,000–240,000; default
120,000), and `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_INTERRUPT=1`.

For example, use Codex for the current evidence-qualified managed-core smoke.
Replace the command and environment-reference values for the local installation;
the shown version/fingerprint must exactly match the observed App Server probe:

```bash
AGENT_WORKSPACE_RUN_NATIVE_PROVIDER_LIFECYCLE_SMOKE=1 \
AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_PROVIDER=codex \
AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_MODEL='gpt-5.4' \
AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_INTERRUPT=1 \
AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_EVIDENCE_PATH="$PWD/.agent-workspace-v2/evidence/codex-lifecycle.json" \
AGENT_WORKSPACE_PROVIDER_CONFIG='{
  "schemaVersion": 1,
  "providers": [{
    "provider": "codex",
    "protocol": {
      "providerVersion": "0.146.0",
      "protocolFingerprint": "sha256:28161abf152e09a7a4c47427e9098a2407b048f5d16c099a4ec9cb282fbf8448"
    },
    "transport": {
      "kind": "codex-app-server",
      "command": { "env": "AGENT_WORKSPACE_CODEX_COMMAND" },
      "env": {
        "CODEX_HOME": { "env": "AGENT_WORKSPACE_CODEX_HOME" },
        "HOME": { "env": "AGENT_WORKSPACE_PROVIDER_HOME" },
        "PATH": { "env": "AGENT_WORKSPACE_PROVIDER_PATH" }
      }
    }
  }]
}' \
npm run test:integration -- tests/integration/native-provider-lifecycle-smoke.test.ts
```

For OpenCode, obtain `protocolFingerprint` from the direct bridge's
`inspectOpenCodeServerProtocol` result (the canonical object digest used by
Runtime Host), not from a raw-byte `shasum` of `/doc`. It remains a useful
partial lifecycle probe, but a passing create/resume path does not qualify it
for managed Templates while interrupt correlation is unproven. For Codex, use
the deterministic schema-bundle pin generated by the direct App Server bridge.
Do not invent a fingerprint to make a probe pass.

The equivalent direct transport entries are:

```json
{
  "provider": "codex",
  "protocol": {
    "providerVersion": "<observed-version>",
    "protocolFingerprint": "sha256:<observed-schema-hash>"
  },
  "transport": {
    "kind": "codex-app-server",
    "command": { "env": "AGENT_WORKSPACE_CODEX_COMMAND" },
    "env": {
      "CODEX_HOME": { "env": "AGENT_WORKSPACE_CODEX_HOME" },
      "PATH": { "env": "AGENT_WORKSPACE_PROVIDER_PATH" }
    }
  }
}
```

```json
{
  "provider": "claude-code",
  "protocol": {
    "providerVersion": "<observed-version>",
    "protocolFingerprint": "sha256:<observed-stream-schema-hash>"
  },
  "transport": {
    "kind": "claude-code-stream",
    "command": { "env": "AGENT_WORKSPACE_CLAUDE_CODE_COMMAND" },
    "env": {
      "PATH": { "env": "AGENT_WORKSPACE_PROVIDER_PATH" },
      "ANTHROPIC_AUTH_TOKEN": { "env": "ANTHROPIC_AUTH_TOKEN" }
    }
  }
}
```

Use only environment references in the JSON. Do not put API keys, session
tokens, cookies, endpoints with embedded credentials, prompts, or user working
directories into the configuration or report. Codex requires an absolute
executable and absolute dedicated `CODEX_HOME`; Claude Code and Codex inherit
only the explicit allowlist supplied above. The exact authentication variable
for Claude Code is an operator choice; include only variables that the
installed CLI actually needs.

The smoke performs this bounded lifecycle:

1. Creates a private temporary workspace and Runtime data directory, then
   checks the direct transport's observed version, fingerprint, and all six
   managed-core capabilities. OpenCode `1.18.13` fails this capability gate by
   design because it does not advertise `interrupt`. Claude Code has no recorded
   successful full smoke yet; running this bounded test is the required way to
   establish (or reject) that eligibility.
2. Creates one native binding and sends a no-tools prompt under the most
   restrictive currently proven profile (the workbench profile uses
   `permissionMode: "deny"`; each native bridge applies its own conservative
   child policy). It requires `binding_observed`, a correlated
   `input_received` fact with a native message/turn ID, and a correlated
   `turn_completed` fact from reconciliation. An accepted effect alone never
   passes this step.
3. Reconstructs the selected Runtime Host composition and resumes using the
   opaque native binding reference. The current passing Codex route proves this
   through native thread resume. OpenCode's resume route is separately observed
   but cannot make the managed smoke pass until interrupt proof exists. Claude
   Code must not be described as proven by its `system/init` mapping alone.
4. If `AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_INTERRUPT=1`, submits a bounded
   long-running prompt, first observes its native receipt while the turn is
   still non-terminal, then requests interruption and requires an observed
   `interrupt_confirmed` fact. An accepted interruption request is not a
   passing result.

The private temporary directory is removed in `finally`; this also removes
Claude Code's raw-frame journal. The durable evidence report is written with
mode `0600` and includes only the Provider/version/fingerprint, capability
summary, fact-kind counts, phase outcomes, and a SHA-256 prefix of the native
binding reference. It never stores environment values, commands, URLs, cwd,
prompts, responses, raw frames, native IDs, or Provider stderr.

## OpenCode readiness negative

`provider-readiness-negative.test.ts` is a narrower opt-in gate. It proves that
an observed local OpenCode version cannot satisfy a frozen `1.18.13` Task
Profile merely because the REST server is reachable. Start an isolated
`opencode serve --pure` instance, then run:

```bash
AGENT_WORKSPACE_OPENCODE_READINESS_URL=http://127.0.0.1:<port> \
AGENT_WORKSPACE_OPENCODE_READINESS_EVIDENCE_PATH=<private-json-path> \
npm run test:vitest -- tests/integration/provider-readiness-negative.test.ts
```

The test calls only `/global/health` and `/doc`, expects the normalized
`provider_version_mismatch` reason, and records zero native Session effects.
Its mode-`0600` report deliberately excludes the server URL and all native
identities. This is readiness-negative evidence only, not create/resume/input/
interrupt, Browser, Electron, or managed lifecycle proof.

This smoke may create a real native Provider session/thread and consume model
quota. It never calls a native delete/archive endpoint: OpenCode Session
deletion is specifically unsafe, and the Codex/Claude release path closes only
the locally owned child connection/process. Remove test sessions through the
Provider's normal user-facing controls if desired. It does not prove attention,
native children, presentation, RuntimeApplication/outbox recovery, or
end-to-end Task/Run/Bridge/Desktop/Browser behavior; those require their own
pinned live scenarios.
