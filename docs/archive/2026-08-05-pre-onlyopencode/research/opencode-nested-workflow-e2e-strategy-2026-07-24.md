# OpenCode Nested Workflow Harness E2E Strategy

Date: 2026-07-24
Node: research-e2e
Scope: E2E testing strategies, headless browser APIs, and assertion patterns for UI verification of the nested OpenCode workflow harness.

## Existing E2E Infrastructure

Two tiers of tests exist:

1. **Node-level harness smoke** (`desktop/opencode-nested-workflow-harness-smoke.cjs`)
   - Tests `createOrchestrationHarness` directly via `node:assert/strict`.
   - Verifies template generation -> save -> task creation -> start -> poll to `delivery_ready`.
   - Asserts: Conductor decisions, workflow.completed event, node counts, PTY evidence, and no intermediate Conductor wakeup inside the bounded Workflow.
   - Key assertion: `completed.events.filter(e => e.type === 'conductor.decision').length === 2`.

2. **Electron UI smoke** (`desktop/opencode-harness-ui-smoke.cjs`)
   - Full Electron `BrowserWindow` (GPU disabled, `show: false`).
   - Raw `executeJavaScript` for all DOM interaction: form fill, button click, DOM presence.
   - Screenshots via `capturePage().toPNG()`.
   - Runs real `opencode --mini --prompt` Sessions through the owned PTY.
   - Also asserts the backend harness state via `harness.readRun()` at the end.

3. **test_simulte/** feature simulations (`test_simulte/lib/electron-simulation-harness.cjs`)
   - Shared Electron harness that wires `PtyManager`, `SessionAuthority`, `SessionStore`, `ConductorToolBridge`, and IPC handlers.
   - Supports `createWindow()` (inline HTML) and `createWindowForUrl(url)` (Vite dev server).
   - Tracks `ptyStarts` and `ptyWrites` for assertion.

## Headless Browser APIs Used

| API | Purpose |
| --- | --- |
| `BrowserWindow({ show: false })` | Headless Electron window |
| `app.commandLine.appendSwitch("disable-gpu")` | GPU-less execution |
| `window.webContents.executeJavaScript(source)` | All DOM read/write |
| `window.webContents.capturePage()` | Screenshot evidence |
| `data:text/html,` | Inline HTML window load |
| `requestAnimationFrame` double-call | Visual settle wait |

No Playwright, Puppeteer, or Selenium is used. Everything is raw Electron + `executeJavaScript`.

## Assertion Patterns

1. **DOM text content**: `document.body.innerText.includes("...")` — checks for rendered text across the page.
2. **Component presence**: CSS selector checks like `Boolean(document.querySelector(".harness-builder-modal"))`.
3. **Button clicks**: `Array.from(document.querySelectorAll("button")).find(item => item.innerText.includes("..."))`.
4. **Select/input values**: Prototype value setter + dispatched `input`/`change` events (because React controlled inputs do not respond to native `.value=`).
5. **Backend state**: Assertions on `harness.readRun()` return (run states, turn outputs, node statuses).
6. **PTY events**: `ptyManager.read()` for transcript, `ptyManager.list()` for session liveness.
7. **Session store**: `sessionStore.readTaskState()` for projected Agent card labels, dispatches, decisions.
8. **Rail navigation**: `.harness-rail-button` class selector for the app shell navigation.

## Key E2E Flow for "Run the saved Blueprint"

The complete flow (from `opencode-harness-ui-smoke.cjs`) is:

1. Click "模板" rail -> "新建模板" button -> fill name/goal -> "生成候选" -> wait for candidate -> "确认并保存模板"
2. Click "任务" rail -> "新建任务" button -> fill title/goal -> select Blueprint from `<select>` -> "确认 Task Architecture" -> wait for task timeline
3. "启动 Run" button -> wait for "交付产物已就绪" + "workflow.completed"
4. Click a Session message in the Timeline -> wait for its Workbench terminal
5. Assert: no duplicate activity panel, xterm shows the native OpenCode mini-TUI
6. Navigate back to template list, assert composition rendering
7. Theme toggle

## Risks and Gaps

1. **Fragile DOM selectors**: The UI smoke test uses Chinese text labels (`新建任务`, `模板`, `运行现场`, `待人工 Review`) for all button/state matching. These break if labels change.
2. **executeJavaScript heaviness**: Form fill and DOM traversal are inline JS strings. No selector library (Testing Library, Playwright) is available — all locator logic is ad-hoc `Array.from().find()`.
3. **No visual diff or snapshot testing**: Screenshots are written to temp dirs and only examined manually; no automated comparison.
4. **UI smoke hardcodes the "3 research nodes + verify" goal**: Any change to the prompt goal or workflow structure requires updating the assertion strings.
5. **Timeout dependencies**: `waitUntil` polls at 150ms intervals up to 120s. Real OpenCode processes can be slow; flakiness risk when model response time varies.
6. **No isolated Electron runner**: The test directly imports `electron` and manipulates `app`, so it cannot parallelize or run without Electron.
7. **The "generate -> save Blueprint -> Task -> real Run -> Workbench terminal" path** from the plan (work item 6) is covered by `opencode-harness-ui-smoke.cjs` but that test is not run in CI or the `verify` script.
8. **Harness state assertion vs. UI state**: The final `harness.readRun()` assertion confirms backend state, but the UI is only checked for text presence — no assertion that the Workbench view actually renders the correct session transcript.
