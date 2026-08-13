# ACP integration evidence

Status: current ACP-only integration guide.

Authority: [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/implementation-plan.md`](../../docs/implementation-plan.md).

## Purpose

Integration tests prove boundaries that fake domain tests cannot: current ACP artifact resolution, actual `initialize` negotiation,
session lifecycle, prompt receipt/final/terminal correlation, cancel/reconcile, reverse RPC policy and process cleanup. They do not
prove rendered Browser/Electron behavior or a full release bundle.

The production target has one protocol shape:

```text
Host Session Runtime / MetaAgentPort
  -> ACP Client
  -> current ACP Agent process
```

OpenCode REST, Codex App Server and Claude stream-json integration suites were physically removed at the production cutover. They
cannot be restored as fallback evidence for ACP behavior, Provider readiness or release completion.

## Evidence layers

| Layer | Required observation | Cannot substitute for |
| --- | --- | --- |
| fake ACP contract | deterministic initialize/update/prompt/cancel/replay/error ordering | real process or Provider |
| ACP process boundary | stdio framing, bounded I/O, shutdown, credential cleanup, current artifact drift | Provider behavior |
| current-install qualification | actual resolution + initialize + model/role behavior | another Profile/model/process |
| native Task | actual Binding/prompt/final+terminal/recovery/cancel/MCP | Meta or rendered UI |
| native Meta | independent no-tool/no-cwd/no-Workspace whole-final/reconcile | Task orchestration |
| Browser/Electron journey | visible controls + Host/OR/SR lineage + native facts | another surface or release bundle |

## Required ACP contract tests

### Connection and negotiation

- protocol major is negotiated from the running Agent; unsupported/malformed initialize fails closed;
- advertised capabilities/extensions are normalized and fingerprinted, never inferred from Provider brand/version;
- notification/request/response IDs stay inside the connection;
- one ACP process/connection generation serves at most one active/reconciling Binding; cross-Binding reuse fails, while a crashed
  generation may be replaced under the same stable SR only after fresh resolution/qualification and reconcile;
- malformed, oversized or post-close frames cannot mutate Runtime state.

### Session and prompt lifecycle

- `session/new`, `session/load` and `session/resume` map to the same Workspace opaque Binding lineage without exposing raw session ID;
- one active prompt per SR; Workspace `inputSubmissionId` / `SessionExecutionAttempt` provides causal scope;
- only the latest valid same-attempt final candidate plus prompt terminal can settle a successful OR SessionTurn;
- terminal without final, final without terminal, duplicate/conflicting terminal and cross-attempt updates remain failed/reconciling;
- prompt transport acceptance is not a receipt or final;
- restart recovery reconciles before any resend.

### Interaction and cancel

- ACP permission request/option IDs map privately to Workspace `interactionId/choiceId` plus Binding/Attempt/revision fence;
- stale/cross-Binding/unknown choices fail before a Client response;
- cancel intent revokes scoped tools before notification and is not reported confirmed until a correlated terminal/reconcile fact;
- late final, unknown cancel and crash are distinct outcomes.

### Reverse RPC and capabilities

- filesystem/terminal/MCP requests are limited to the exact Profile, workspace grant and Binding/Turn lease;
- Conductor receives exactly four Gateway tools; Publisher receives only scoped write; Worker/Reviewer/Meta do not inherit them;
- raw args/results, reasoning/thought, credential, absolute path and ACP/native IDs never enter ProviderActivity/Message/evidence.

## Current-install lanes

Each lane discovers and qualifies the current installation; tests do not take an expected Provider version/hash/fingerprint.

### OpenCode ACP

Resolve the current trusted `opencode` command and launch `opencode acp`. Required positive evidence includes initialize, new,
prompt receipt, final+terminal, load/resume/reconcile, cancel and any Profile-required scoped MCP behavior. An OpenCode Server REST
probe is not evidence for this lane.

### Codex ACP

Resolve the current trusted `codex-acp` wrapper and observe its current Codex upstream. The same managed baseline must execute through
ACP. Direct App Server tests and a no-tools companion report are not evidence for this lane.

### ACP Meta

Use an independent Profile/process/raw-ID map. Prove strict whole-final, deny/no tools, no directory/Workspace/Task authority,
permission rejection, cold reconcile and cleanup. Task qualification cannot authorize it.

Claude ACP remains a later positive lane after current `claude-agent-acp` resolution and qualification are implemented; missing it
does not permit stream-json fallback.

## Version and drift tests

Required dynamic test:

```text
resolve artifact A -> initialize/qualify A -> available
mutate observed artifact/initialize/model/capabilities to B -> A qualification invalid
fresh resolve/initialize/qualify B -> available when behavior passes
```

The test must not branch on numeric versions. Repository supported-version lists, Template version gates, expected hash inputs and
serialized qualifications are forbidden.

## Commands and current migration status

The existing broad suite remains useful for regressions:

```bash
npm run typecheck
npm run test:vitest
npm run test:integration
```

ACP-focused file commands are added by the phase that creates those files; do not document a nonexistent script as already
available. Opt-in live tests must require explicit command/credential/workspace inputs, use fresh Host-owned state, redact all
secrets/raw IDs/paths, bound every process/request and clean only their exact temporary roots.

Until the Phase 8 fresh matrix completes:

- a fake ACP PASS proves only contracts;
- an initialize PASS proves only negotiation;
- a single OpenCode ACP PASS does not prove Codex or Meta;
- no integration test may upgrade the release status by itself.
