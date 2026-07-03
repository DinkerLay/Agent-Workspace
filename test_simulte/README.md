# test_simulte

Real simulation scripts for Agent Workspace runtime behavior.

- `lib/`: shared simulation infrastructure such as Electron IPC harnesses, PTY managers, Session Store wiring, and local provider adapters.
- `<feature>/`: feature-scoped E2E simulations. Each script should run independently and fail with a clear boundary: UI/preload, IPC, bridge, PTY, Session Store, or provider input protocol.

Current scenarios:

- `session-dispatch/call-session-to-worker.e2e.cjs`: verifies `call_session` starts a worker session, waits for provider TUI readiness, writes the assignment through the PTY, records dispatch delivery, and publishes PTY output back through Electron preload events.
- `task-home-real-research/claude-dynamic-workflow.e2e.cjs`: clears `/Users/dinker/CODES/TEMP_project/Agent_Test/docs` and its `.agent-workspace/test-simulte-runtime`, starts the real Task Home flow, creates a research task with the research template, runs real `opencode`, requires provider-result-available Researcher and Reviewer dispatches, and waits for new `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` outputs.

Runtime layout:

- `runtime/`: Shell Session Store used by `read_task_state`, `read_session`, dispatch records, provider results, state, and bounded status events.
- Provider PTY output is streamed to the UI and kept bounded in memory; simulation scripts must not create raw transcript, clean transcript, snapshot, or `pty-evidence` artifacts.
