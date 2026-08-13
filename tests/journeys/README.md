# ACP actual-operation and release journeys

Status: the Phase 8 ACP evidence authority, parent A/B qualification gates and exact 28-cell production aggregate are frozen;
release remains fail-closed until all three exact live envelopes can qualify and every required cell produces canonical durable facts.

Authority: [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/implementation-plan.md`](../../docs/implementation-plan.md).

## Evidence rule

Actual-operation evidence must keep user action, Renderer intent, Host command, OR/SR durable lineage and ACP observation in one
cell. Fake Provider, raw RuntimeClient calls, mocked IPC, headless probes, screenshots or an older bundle cannot substitute for a
required Browser/Electron/native cell.

Required evidence classes:

- `deterministic_fake`: OR/SR/domain/store/outbox/race/crash contracts;
- `browser_rendered`: real visible controls through authenticated HTTP/WS;
- `electron_ipc`: real Electron window/preload and the same Renderer;
- `qualified_acp_provider`: current Profile resolution + initialize + model/role qualification + actual Binding facts;
- `qualified_acp_meta`: independent no-authority ACP Meta process/Turn facts.

Every required cell has one fresh `releaseRunId`, nonce, `runtimeInstanceId`, scenario ID and canonical observed-lineage seal. Dynamic
Draft/Task/Run/Meta/Session/Binding/Message/Input/Turn IDs come only from actual owner rows. UI, Host, ACP attestor and verifier have
separate issuers; verifier validates but never writes missing facts.

## Required matrix

The matrix is exactly 28 required cells: 24 isolated controlled cells, one cross-surface cell, two independent ACP Task cells and
one independent ACP Meta cell. A skipped, not-exercised or not-applicable required stream fails the bundle.

| Cells | Count | Required proof |
| --- | ---: | --- |
| deterministic OR/SR | 8 | Main J-04..J-10 plus isolated J-08 unknown/late-final and five J-10 crash/replay branches |
| Browser controlled | 8 | Main J-01..J-11 plus the same seven isolated UI branches |
| Electron controlled | 8 | Main J-01..J-11 through real IPC/window plus the same seven isolated UI branches |
| cross-surface | 1 | J-01..J-12 Browser→Electron continuity on one Host/Task lineage |
| OpenCode ACP Task | 1 | J-04..J-12; current `opencode acp`, Browser+Electron+Runtime+OpenCode attestor on one lineage |
| Codex ACP Task | 1 | J-04..J-12; current trusted Codex ACP, Browser+Electron+Runtime+Codex attestor on one lineage |
| ACP Meta | 1 | J-02/J-03; independent Runtime+Meta attestor with whole-final/no-tool/no-cwd/no-Workspace/reconcile facts |

OpenCode and Codex each need actual Task Binding/Delivery evidence. A Codex companion that has no Task lineage does not count as
Codex connectivity. Task qualification cannot authorize Meta; one model/Profile/process/generation cannot authorize another.

## Golden UI checkpoints

The existing J-01..J-12 product semantics remain:

1. Launch one formal Host/Renderer with no fallback.
2. Template Meta: opener→explicit open→send→review/apply→explicit publish.
3. Task Setup Meta: independent session/history→apply→explicit create; Create is not Start.
4. Start a fresh Run and deliver the unique task goal.
5. Conductor invokes A; invoke creates only a Runtime session identity.
6. Conductor sends A; exact Forward/Input/SR prompt/final+terminal yields one canonical final.
7. Conductor invokes/reviews through B without sibling/shared read.
8. Human idle/busy priority preserves mirror/held/interrupt/late-final ordering.
9. Scoped interrupt/close/reopen rejects old A1 after A2 is current.
10. Host/ACP process crash points recover without duplicate prompt/final/notice.
11. Publisher scoped write, Preview, independent anchored/unanchored Achieve and separate Stop.
12. Browser→Electron continuity uses the same durable lineage.

The ACP cutover changes the execution/evidence boundary, not these product actions.

## ACP preflight and privacy

Before any local gate, build, evidence directory, Host/UI/model effect, the trusted parent validates all required Profile inputs with
zero side effects:

- current ACP launcher/wrapper command references and trust policy;
- explicit credential sources and private data roots;
- workspace authorization and model/config intent;
- Host supervisor/ACP launcher source identity;
- no caller-supplied expected version/hash/fingerprint/capability.

After input validation, OpenCode ACP, Codex ACP and Meta ACP get independent bounded qualification-only processes. Each produces a
`LocalResolutionSeal`, actual initialize observation and behavior qualification, then proves confirmed shutdown and credential/temp
cleanup before broad local gates. A later actual Binding generation must match its frozen resolution/qualification; restart must
re-discover and requalify rather than reuse a serialized token.

Evidence must never contain credential values/keys, command or auth-file path, absolute cwd, raw ACP session/request/option/tool/
JSON-RPC ID, model prompt/result beyond the approved safe projection, or Provider-private transcript. Local-gate children receive a
narrow system environment allowlist and no native capability.

## Aggregate order

`npm run verify:release` remains the only aggregate release claim. It now runs only the ACP parent and exact 28-cell graph; missing
live input/capability fails at A/B with exit 2 before local gates or evidence, and the superseded direct native matrix is unreachable.
The fixed order is:

```text
zero-side-effect ACP input validation
-> independent OpenCode/Codex/Meta discovery + initialize + qualification + cleanup
-> typecheck / full unit / Desktop / integration / e2e / formal launcher / cutover / journey-static
-> production locator contract
-> exactly one production build
-> freeze source/build/schema/resolution-policy/policy digests and new matrix
-> execute all required controlled/OpenCode ACP/Codex ACP/ACP Meta cells
-> verify issuer signatures, lineage, checksums, redaction, permissions and no direct production imports
```

Exit codes:

```text
0 = the same fresh ACP bundle passed every required cell
1 = assertion, safety, drift, checksum, redaction or cleanup failure
2 = BLOCKED_CAPABILITY before or during the trusted native boundary
```

No separately run test is imported into this claim. A failure creates a new releaseRunId/matrix on the next attempt; it is never
patched in place.

## Commands during migration

The broad non-release gates remain valid for implementation regressions:

```bash
npm run typecheck
npm run test:vitest
npm run test:desktop
npm run test:integration
npm run test:e2e
npm run test:formal-dev-launcher
npm run verify:session-id-cutover
npm run test:journey:static
```

The ACP Task and Meta suite entry points are plumbing for their matrix workers, not independent release claims. Missing lane input is
an exit-2 capability block, never a reason to invent a fallback or translate a direct-Provider configuration.

## Cleanup

Harnesses delete only exact roots they created. They must use bounded fetch/process waits, abort propagation, TERM→KILL escalation,
confirmed exit and credential cleanup. An unconfirmed child exit is a safety failure and blocks release. Tests never delete user
Provider state, ambient credentials, Runtime machine data or Workspace files.
