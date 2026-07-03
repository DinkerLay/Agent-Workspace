# Agent Workspace

Agent Workspace is a desktop-oriented prototype for a multi-agent workbench.

The current MVP focuses on:

- task home for creating and observing tasks
- IDE workbench for terminal-backed agent sessions
- Conductor-led session orchestration
- opencode-backed runtime integration
- task-scoped session dispatch and result return

## Development

Install dependencies:

```bash
npm install
```

Run the Vite prototype:

```bash
npm run dev
```

Run the desktop shell:

```bash
npm run desktop:dev
```

or:

```bash
./start.sh
```

## Verification

Run unit tests:

```bash
npm test
```

Build:

```bash
npm run build
```

Run the short session-dispatch simulation:

```bash
npm run simulate:session-dispatch
```

## Project Notes

Durable product intent lives in:

- `docs/research/`
- `docs/superworks/spec/`
- `docs/superworks/plans/`

Runtime state is intentionally excluded from git and should stay under `.agent-workspace/` or the runtime paths defined by the current specs.
