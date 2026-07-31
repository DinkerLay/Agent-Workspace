# Source Mirror: Orca terminal boundary

This release-controlled source mirror summarizes the terminal-runtime boundary
used in the Orca reference implementation.

- The terminal host owns the PTY, generation, screen state, snapshots, deltas,
  acknowledgement, backpressure, and exit facts.
- A renderer attaches to a host-owned terminal and renders a snapshot followed
  by ordered output deltas; it is not the owner of the PTY.
- Terminal output is a transport fact. It must not be parsed to decide whether
  a task was dispatched, completed, or needs a retry.
- Provider-specific session analysis is an upper-layer concern and is separate
  from the terminal host.

Scope limit: this is a boundary summary, not an implementation API reference.
