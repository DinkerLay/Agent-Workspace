# Source Mirror: OpenCode session model

This release-controlled source mirror records the observable OpenCode model
used by the Agent Workspace acceptance task.

- OpenCode stores provider sessions in a local SQLite database with `session`,
  `message`, and `part` records.
- A user instruction is stored as a `message` with role `user`; its ordinary
  text is stored in a related `part` record.
- An assistant turn is represented by related parts such as `step-start`,
  `text`, tool calls, and `step-finish`.
- A completed normal answer is identified by an assistant message whose
  `step-finish` reason is `stop` and whose non-ignored text parts are present.

Scope limit: this mirror documents the observable persistence model needed for
the release test. It does not claim to be a complete OpenCode internal schema.
