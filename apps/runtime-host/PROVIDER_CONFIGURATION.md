# Runtime Host Provider configuration

This is the operational note for `apps/runtime-host`. Product and Runtime
semantics are defined by [`docs/architecture.md`](../../docs/architecture.md).
An unset `AGENT_WORKSPACE_PROVIDER_CONFIG` registers no Provider ports; there
is no fixture or default Provider fallback.

## Native OpenCode Server

OpenCode Server is configured only through its dedicated REST transport:

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "provider": "opencode",
      "protocol": {
        "providerVersion": "1.18.13",
        "protocolFingerprint": "sha256:<hash-of-the-observed-/doc-openapi>"
      },
      "transport": {
        "kind": "opencode-server",
        "baseUrl": { "env": "OPENCODE_SERVER_URL" },
        "headers": {
          "authorization": { "env": "OPENCODE_SERVER_AUTHORIZATION" }
        }
      }
    }
  ]
}
```

Start an isolated local server, inspect `GET /global/health` and `GET /doc`,
then pin the exact reported version and the canonical OpenAPI fingerprint. The
Runtime recomputes both before it starts a Task, so an OpenCode upgrade or API
shape change fails closed until reviewed. The helper
`inspectOpenCodeServerProtocol` in `@agent-workspace/provider-opencode` returns
the value to pin; it never prints credentials.

For this transport an Execution Profile model is `providerID/modelID`, for
example `opencode-go/gpt-5.6-luna`. A malformed/empty model intentionally lets
the native Server choose its configured default and should not be used for a
production pinned Profile.

The direct adapter creates a native Session with Runtime binding metadata,
persists only the opaque native Session id through a `binding_observed` fact,
uses `POST /session/{id}/prompt_async` for delivery, and confirms receipt from
native message history. It never treats HTTP acceptance as a receipt. It never
deletes the user's OpenCode Session.

Currently advertised capabilities are only:

```text
create_binding, resume_binding, input_correlation,
provider_receipt, reconcile
```

The native abort route was exercised during transport-level regression work,
but OpenCode `1.18.13` has not proven that an abort confirmation can be
reliably correlated to the exact Runtime Stop target. It therefore does **not**
advertise `interrupt`; a route in the direct transport is not a Provider
capability and Runtime must reject a managed Stop rather than guess. Published
managed Template Profiles require all six core capabilities, so a portable
OpenCode Profile cannot start or restart on this local Host. `attention_reply`, `native_child`, and native
`presentation` also remain unavailable until their own version-pinned live
probes exist.

## Native Codex App Server

Codex is a Binding-isolated, persistent JSON-RPC child process. It is not a
one-shot CLI bridge. Configure an absolute executable and an explicit child
environment allowlist:

```json
{
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
}
```

The Host runs the CLI version probe and generated schema-bundle probe beneath
its private Runtime data directory; neither path is configurable by a Template,
Renderer, or Provider entry. A declared pin that does not match either observed
value leaves the Provider unavailable. The bridge starts/resumes one native
thread for each Binding, correlates `turn/start` with the Runtime input id,
reconciles via native thread/turn history, and records interruption only after a
native interrupted terminal fact. It declines server approval requests and
forces the conservative Host policy (`untrusted`, read-only sandbox, no network,
no allowed tools).

For exactly this pin, the direct native lifecycle smoke passed create, correlated
input receipt, terminal reconciliation, Host-composition reconstruction +
resume, and target-correlated interrupt → native terminal. This is the only
current evidence-qualified Provider for a local managed Run; `attention_reply`,
`native_child`, and `presentation` are still unavailable. A version/schema
change, non-empty tool allowlist, or permission mode other than `deny` requires
a new probe rather than inheriting this result.

## Native Claude Code stream

Claude Code is a Binding-isolated persistent stream-json CLI process. It uses
the Host's private append-only frame journal for recovery; it is not configured
as a generic process bridge:

```json
{
  "provider": "claude-code",
  "protocol": {
    "providerVersion": "2.1.222",
    "protocolFingerprint": "sha256:<verified-stream-protocol-fingerprint>"
  },
  "transport": {
    "kind": "claude-code-stream",
    "command": { "env": "AGENT_WORKSPACE_CLAUDE_CODE_COMMAND" },
    "env": {
      "HOME": { "env": "AGENT_WORKSPACE_CLAUDE_HOME" },
      "PATH": { "env": "AGENT_WORKSPACE_PROVIDER_PATH" },
      "ANTHROPIC_AUTH_TOKEN": { "env": "ANTHROPIC_AUTH_TOKEN" }
    }
  }
}
```

The exact authentication variable is an operator choice; include only the
variables the installed CLI requires. The bridge starts a binding-isolated,
safe stream profile, assigns a stable command UUID to each input, confirms
receipt only from native frames, and emits terminal cancellation only after a
native frame/process fact.

The bridge and `system/init` capability checks are implementation evidence, not
a completed lifecycle proof. There is no current version-pinned native
create/input/resume/targeted-interrupt/terminal smoke record for Claude Code in
this cutover. A portable Profile may be stored or shared, but this local Host must reject start/restart until that probe
passes and is recorded; attention reply, native child, and native presentation
remain unavailable as well.

These three direct transports are the entire production configuration surface.
Header values and child environment values must be `{ "env": "NAME" }`
references. Keep credentials out of JSON, arguments, URLs, diagnostics,
templates, and test evidence. The Runtime—not configuration—supplies each
call's frozen `workspaceId` and `cwd`.
