# Runtime Host ACP Provider configuration

Status: the production Runtime Host is ACP-only. Direct Provider transports, parsers and packages have been physically removed.

Authority: [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/implementation-plan.md`](../../docs/implementation-plan.md).

## Formal boundary

The production Runtime Host speaks ACP only:

```text
portable Profile requirement
  -> Host-local discovery / trust
  -> LocalResolutionSeal
  -> isolated ACP Agent process
  -> initialize + capability negotiation
  -> model/role live qualification
  -> Session Runtime / MetaAgentPort
```

OpenCode REST, Codex App Server, Claude stream-json and Provider SDKs are not valid Host transports. They may exist only
inside an external ACP Agent/wrapper. The removed `opencode-server`, `codex-app-server` and `claude-code-stream` configuration
kinds are rejected; there is no fallback selector or compatibility parser. `AGENT_WORKSPACE_PROVIDER_CONFIG`,
`AGENT_WORKSPACE_META_PROVIDER_CONFIG` and `AGENT_WORKSPACE_META_PROFILE_CONFIG` are not production inputs.

Current upstream implementation references are the
[ACP specification](https://github.com/agentclientprotocol/agent-client-protocol),
[TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk),
[OpenCode](https://github.com/anomalyco/opencode),
[codex-acp](https://github.com/agentclientprotocol/codex-acp), and
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp). They are discovery/implementation references, not
repository version pins. The Host trusts and qualifies the actual local artifact it resolves at runtime.

## Portable Profile versus Host resolution

Template/Profile data is portable and contains no machine-specific installation data:

```text
profileRevisionId
providerFamily = opencode | codex | claude-code
acpAgentKind = native_acp | codex_acp | claude_agent_acp
protocolMajor = 1
model/config intent
required capabilities/extensions
permission/capability policy
```

It must not contain command paths, credentials, Provider/wrapper versions, binary hashes, protocol fingerprints or a Host
resolution identifier. Template schema v2 `providerVersion` / `protocolFingerprint` fields remain historical byte-compatible data;
new ACP Profiles use the implemented template package schema v3 and require the explicit Draft migration command. Schema v2 stays
read-only and is never silently reinterpreted as an ACP Profile.

Host configuration supplies only discovery inputs and environment references. The parser is implemented at
`apps/runtime-host/src/acp-production-configuration.ts` and is consumed by the production ACP composition.
The one Host-owned variable is `AGENT_WORKSPACE_ACP_CONFIG`:

For desktop/local use, the authenticated Provider Settings surface provides the equivalent device setup without requiring users
to hand-author JSON. The Host scans common PATH locations only after the user clicks **Scan local installation**, lets the user
confirm or replace the Provider CLI/Node/login-source paths, and stores canonical values in
`<runtime-data>/acp-provider-settings.json` with mode `0600`. The Codex and Claude ACP Agent packages are application-managed
Runtime dependencies and are not user-configurable installation paths. Discovery never reads credential content. A changed local
installation applies immediately to subsequent Provider generations; already-open Sessions retain their frozen Binding/Profile.
Environment-provided `AGENT_WORKSPACE_ACP_CONFIG` remains authoritative and read-only in the UI. Model selection is a second
explicit step: the list comes only from ACP `configOptions(category=model)`,
read through a prompt-free temporary ACP Session that does not require an existing Template/Profile. The Host returns the catalog
only after the temporary session, process and credential lease are confirmed closed. The selected default applies only to future
Profile/Meta Session configuration. Existing Sessions are immutable.

```json
{
  "schemaVersion": 1,
  "agents": {
    "opencode": {
      "kind": "opencode-acp-current-install",
      "command": { "env": "AGENT_WORKSPACE_OPENCODE_COMMAND" },
      "executableSearchPath": { "env": "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
      "authFile": { "env": "AGENT_WORKSPACE_OPENCODE_AUTH" }
    },
    "codex": {
      "kind": "codex-acp-current-install",
      "wrapperCommand": { "env": "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
      "codexCommand": { "env": "AGENT_WORKSPACE_CODEX_COMMAND" },
      "nodeCommand": { "env": "AGENT_WORKSPACE_NODE_COMMAND" },
      "executableSearchPath": { "env": "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
      "authFile": { "env": "AGENT_WORKSPACE_CODEX_AUTH" }
    },
    "claudeCode": {
      "kind": "claude-agent-acp-current-install",
      "wrapperCommand": { "env": "AGENT_WORKSPACE_CLAUDE_AGENT_ACP_WRAPPER" },
      "claudeCommand": { "env": "AGENT_WORKSPACE_CLAUDE_COMMAND" },
      "nodeCommand": { "env": "AGENT_WORKSPACE_NODE_COMMAND" },
      "executableSearchPath": { "env": "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
      "settingsFile": { "env": "AGENT_WORKSPACE_CLAUDE_SETTINGS" }
    }
  },
  "metaProfiles": [
    {
      "metaProfileOptionId": "meta_profile_option_current-codex",
      "title": "Current Codex ACP Meta",
      "profile": {
        "metaProfileId": "meta_profile_current-codex",
        "profileRevisionId": "profile_revision_meta-current-codex-v1",
        "providerFamily": "codex",
        "acpAgentKind": "codex_acp",
        "protocolMajor": 1,
        "role": "meta",
        "model": "current-meta-model",
        "configIntent": {},
        "requiredExtensions": [],
        "capabilityPolicy": {
          "requiredCapabilities": [
            "create_binding",
            "resume_binding",
            "input_correlation",
            "provider_receipt",
            "reconcile",
            "interrupt"
          ],
          "allowedTools": [],
          "permissionMode": "deny",
          "maxConcurrentTurns": 1,
          "maxNativeChildren": 0
        }
      }
    }
  ]
}
```

Every machine path and credential source is an exact `{ "env": "NAME" }` reference; direct strings are rejected. `agents`
may omit an unavailable local Agent, and omission produces an honest unavailable state rather than a fallback. A Meta option is
accepted only when its `providerFamily + acpAgentKind` has the matching configured Agent. Task Profiles continue to come from
immutable Template v3/Task Architecture data, not Host configuration.

The parser rejects caller-supplied expected versions, hashes, fingerprints, capabilities, serialized qualifications, direct URLs,
App Server/stream transports and raw credentials. Parsing retains only environment variable names; resolution of their values stays
inside the later Host-private composition boundary.

## Current-install discovery

Each new Binding or Host generation resolves what will actually run:

| Provider family | ACP Agent resolution | Upstream observation |
| --- | --- | --- |
| OpenCode | current trusted `opencode` command, launched as `opencode acp` | the running Agent's `agentInfo`, protocol and capabilities; current OpenCode identity if safely observable |
| Codex | current trusted `codex-acp` wrapper | the wrapper's current Codex upstream observation; Agent Workspace never invokes App Server directly |
| Claude Code | current trusted `claude-agent-acp` wrapper | the wrapper's current Claude Agent runtime observation |

Discovery may use PATH or an explicit Host-only command reference, subject to the final trust policy. It does not compare the
observed version to a repository allowlist. A missing/untrusted wrapper is typed unavailable / `BLOCKED_CAPABILITY`, not a reason
to launch a direct adapter or an older bundled version silently.

The Host records a private `LocalResolutionSeal`:

```text
canonical launcher identity
+ observed artifact/upstream version
+ digest/signature/trust state
+ initialize protocol/capability/extension fingerprint
+ execution-config digest + observedAt
```

An `ACPQualification` additionally binds the seal, exact model/config, bounded behavior probe and Host process generation. Artifact,
initialize, model or capability drift invalidates the current qualification. A newly installed version can become available after
fresh discovery and qualification.

## Required qualification

An `initialize` capability declaration is necessary but insufficient. The Host must observe the behavior required by the selected
Profile:

- session core: initialize, new, at least one of load/resume, prompt acceptance, final candidate + prompt terminal, cancel and
  reconcile; close is required only when the negotiated Agent advertises it;
- managed Task core: Workspace input correlation, crash ambiguity, restart recovery and this product's interrupt semantics;
- Conductor: exact four Host-owned Gateway tools through session-scoped MCP, including rejection behavior;
- Publisher: Provider-native file behavior in the exact authorized Task Workspace, with no injected Agent Workspace MCP tool;
- Meta: strict whole-final with no tools, Task/Workspace cwd authority or Task transcript authority. The ACP wire still receives
  its protocol-required, empty Host-private session directory.

Qualifications are process-local opaque objects. They cannot be loaded from JSON, env, Template, a Catalog or prior evidence, and
one Provider/Profile/model/process cannot authorize another.

## Process, credential and path rules

- Task and Meta use separate ACP Profile resolution, processes, raw-ID maps and capability brokers.
- V1 does not pool an ACP Agent process across Bindings. Each active or reconciling Binding has at most one dedicated Host
  process/connection generation; one generation never serves two Task Bindings or a Task Binding and MetaSession. A stable Session
  Runtime may replace a crashed generation after fresh resolution/qualification and reconcile the same Binding. During a future
  Handoff it may temporarily supervise isolated source and target leases, but Meta never shares either lease or raw-ID map.
- The Host launches each ACP Agent with an explicit environment allowlist, bounded stdin/stdout, output/backpressure limits,
  cancellation, TERM-to-KILL escalation, confirmed exit and credential/temp cleanup.
- Credentials enter only the trusted Host/child environment through explicit secret references. Never put secret values in JSON,
  argv, URLs, logs, evidence, Templates or Renderer state.
- Durable Task/Profile data stores `workspaceId` and a grant digest, not absolute cwd. The Host revalidates the authorized Task
  Workspace before each Binding open and passes that canonical directory as ACP `session/new|load|resume.cwd`. The ACP Agent
  process itself still starts in a separate empty Host-private 0700 directory, and provider state/credentials stay under separate
  Host-private roots. Meta receives only an empty Host-private session directory and never receives Task Workspace authority.
- raw ACP session/request/option/tool/JSON-RPC IDs stay in a generation-local Host-private map. Domain records, Provider facts,
  evidence and UI use Workspace opaque IDs.
- Session MCP servers are injected from the frozen Profile and exact Binding/Turn lease. They are not global Provider config.
- Claude Code Task Sessions omit the SDK `tools` override so Claude keeps its native execution tools. Conductor additionally gets
  only the four `mcp__...` orchestration tools through the session-scoped MCP registration; Publisher/Worker/Reviewer get no
  Agent Workspace MCP tools. Meta explicitly uses `tools: []`. The Host sends `settingSources: []`, so ambient user/project
  tools and hooks are not inherited. `permissionMode` maps to the current Claude ACP `mode` option (`ask -> default`,
  `preapproved -> bypassPermissions`, `deny -> dontAsk`); it does not replace the provider-native tool surface.
- `settingsFile` is an explicit Claude/CCSwitch source. The Host copies only approved model/routing environment keys into a
  generation-private `CLAUDE_CONFIG_DIR`; hooks, permissions, plugins and MCP configuration are discarded. Values such as
  `ENABLE_TOOL_SEARCH=false` are preserved only when explicitly present—Agent Workspace never invents that default. A settings
  change invalidates the private resolution seal and requires a new behavior qualification.

## Task and Meta separation

Task Session Runtime receives the frozen bootstrap, a Host-private session cwd and role-scoped MCP/fs/terminal brokers. The real
Task Workspace remains Host-side capability state. Meta uses the same ACP Client/launcher mechanics but an independent process and
Profile with its own empty Host-private session cwd and no Task Binding, Gateway, Workspace, Task transcript,
Publish/Create/Start/Achieve or child-agent authority.

OpenCode ACP, Codex ACP and ACP Meta are independent readiness/evidence lanes. OpenCode PASS cannot authorize Codex; a Codex
single-session companion report is not Codex Task connectivity; Task qualification cannot authorize Meta.

## Operator and release status

ACP composition is the only production graph. Its controlled contracts, durable owners, direct-drain seal, private identity map,
Host epoch recovery and static cutover gate are complete. That does not itself prove a local Provider installation or model is ready.
The current executable work is Phase 8 in
[`docs/implementation-plan.md`](../../docs/implementation-plan.md): validate all three private lane inputs before any effect,
perform independent bounded qualification with confirmed cleanup, then run the exact fresh 28-cell release matrix. A missing wrapper,
credential entitlement, model or required capability remains an honest exit-2 block.

Do not copy dated versions/hashes from logs or older documents into configuration. Do not use the user's ambient Provider state or
credentials without an explicit, isolated Host capability. Do not run the superseded direct native release as an ACP completion claim.
