# Source Mirror: Provider observer contract

This release-controlled source mirror describes the Agent Workspace OpenCode
Provider Observer contract.

- The observer opens OpenCode data read-only and reports facts such as a
  dispatch receipt, a normal completed answer, a provider failure, or native
  attention.
- It binds a worker result to the exact persisted dispatch marker and does not
  infer semantic completion from PTY bytes.
- A completed answer is stored verbatim as durable task context. A Conductor
  may select that full message for a later worker through an optional context
  reference.
- The observer never chooses a retry, worker, review, publisher, artifact, or
  completion state; those are Conductor decisions.

Scope limit: native questions and permission prompts remain in the owning
OpenCode terminal and require a user or Conductor decision; the observer must
not approve them automatically.
