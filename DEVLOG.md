# Eating Token - Development Log

## What Is This?

**Eating Token** is a VS Code extension that tracks GitHub Copilot token consumption and estimated cost in real-time. It was inspired by NVIDIA CEO Jensen Huang's statement that a $500K/year engineer should spend at least $250K on AI tokens annually. The goal: answer the question *"How many tokens am I actually consuming through Copilot, and what would that cost at market rates?"*

The extension shows a live token count and cost in the VS Code status bar, with a full dashboard showing daily/weekly trends, language breakdown, and a "Jensen Benchmark" progress bar measuring your spending against the $250K/year target.

---

## The Problem We Had to Solve

GitHub Copilot is a black box. There is no public API to:

- Observe another extension's inline completions (ghost text)
- Intercept Copilot Chat messages
- Read token usage from `LanguageModelChatResponse`
- Access Copilot's internal accounting

We needed to find alternative data sources and stitch them together into a coherent picture.

---

## Research Phase: What Data Sources Exist?

We investigated every possible avenue for getting token data out of Copilot. Here's what we found:

### Source 1: `~/.copilot/session-state/<uuid>/events.jsonl` (ACTUAL tokens)

This was the breakthrough discovery. GitHub Copilot's agent writes structured JSONL files containing:

- **`assistant.message` events** with `outputTokens` per response
- **`session.shutdown` events** with complete model metrics: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, premium request counts, and per-model breakdowns

Real data from the developer's machine: one session had **10.1M input tokens, 67.7K output tokens, 9.6M cache read tokens, 84 premium requests** using `claude-opus-4.6`. 12 session directories were found, with the biggest containing 113 messages plus a shutdown event. All from March 2026.

This is the most accurate data source -- actual token counts from the API.

### Source 2: VS Code Copilot Chat Log Files (ESTIMATED tokens)

Location: `~/Library/Application Support/Code/logs/<session>/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log`

These contain `ccreq:` lines recording each request with: request ID, status, model name, duration in ms, and context type. No token counts, but tokens can be estimated from duration using model-specific output rates (e.g., `claude-opus-4.6` at ~40 tokens/sec, `gpt-4o` at ~80 tokens/sec).

### Source 3: Document Change Heuristics (HEURISTIC)

For inline completions and chat edits, VS Code provides `onDidChangeTextDocument` events. We can detect Copilot activity through characteristic patterns:

- Inline completions: insertions >5 chars within 10 seconds of an `InlineCompletionItemProvider` trigger
- Chat Apply/Insert: bursts of large multi-range edits (>200 chars across >=2 edits, or >500 chars, or multi-file)

These are rough estimates, but they catch activity the other sources miss.

### What We Tried and Ruled Out

- **VS Code Language Model API** (`vscode.lm`): No token usage in responses
- **Copilot extension API**: Not public, no exported API surface
- **Network interception**: Not feasible from an extension sandbox
- **Output channel scraping**: Unreliable, format changes between versions

---

## Architecture: 4-Layer Tracking System

We built a layered architecture where each source has different accuracy levels and they complement each other:

```
┌─────────────────────────────────────────────────────────────┐
│                      extension.ts                           │
│  (orchestrator, deduplication, live-vs-historical routing)  │
├──────────┬──────────┬──────────────────┬────────────────────┤
│ Layer 1  │ Layer 2  │     Layer 3      │      Layer 4       │
│ Inline   │ Chat     │ Session Watcher  │   Log Watcher      │
│ Compl.   │ Tracker  │ (ACTUAL tokens)  │ (ESTIMATED tokens) │
│ HEURISTIC│HEURISTIC │ events.jsonl     │ ccreq: log lines   │
├──────────┴──────────┴──────────────────┴────────────────────┤
│                    UsageStorage                             │
│              (date-aware, globalState)                      │
├─────────────────────────────────────────────────────────────┤
│          StatusBar          │         Dashboard             │
│      (live session only)    │   (full history + trends)     │
└─────────────────────────────┴───────────────────────────────┘
```

### Layer 1: CompletionTracker (Inline Ghost Text)

`src/completionTracker.ts` - 257 lines

Registers as an `InlineCompletionItemProvider` for all file types. When VS Code triggers inline completions, we estimate input tokens as `countTokens(fileContent) * contextMultiplier`. When a document change matches the heuristic pattern (insertion >5 chars, within 10s of a trigger, same file, not a paste), we count output tokens from the inserted text.

Also intercepts the Tab key via a custom keybinding (`eatingtoken.acceptSuggestion`) that forwards to `editor.action.inlineSuggest.commit`.

### Layer 2: ChatTracker (Apply/Insert/File Creation)

`src/chatTracker.ts` - 328 lines

Detects Copilot Chat's side-effects by observing document changes. Uses a burst-detection algorithm: collects edits within a 5-second window, then analyzes the burst for chat-like patterns (large multi-range edits, multi-file changes). Also watches `onDidCreateFiles` for chat-generated files.

Uses a higher context multiplier (1.5x the base) because chat sends conversation history, referenced files, and additional context.

### Layer 3: CopilotSessionWatcher (ACTUAL Tokens)

`src/copilotSessionWatcher.ts` - 411 lines

The crown jewel. Watches `~/.copilot/session-state/*/events.jsonl` using `fs.watch` with tail-f behavior (tracks file positions, only reads new bytes). Parses JSONL events and emits `CopilotTokenEvent` objects with actual token counts.

For `session.shutdown` events, emits one event per model in the metrics breakdown, preserving the full `inputTokens`, `outputTokens`, `cacheReadTokens`, and `premiumRequests` per model.

Polls for new session directories every 30 seconds.

### Layer 4: CopilotLogWatcher (ESTIMATED Tokens)

`src/copilotLogWatcher.ts` - 375 lines

Watches VS Code's Copilot Chat log files for `ccreq:` lines. Parses with regex to extract request ID, status, model, duration, and context. Estimates tokens from duration using model-specific output rates:

| Model | Output Rate |
|-------|-------------|
| gpt-4o-mini | ~120 tokens/sec |
| gpt-4o | ~80 tokens/sec |
| claude-sonnet | ~80 tokens/sec |
| claude-opus-4.6 | ~40 tokens/sec |

Formula: `outputTokens = (durationMs - 200ms overhead) * 0.6 * rate / 1000`, `inputTokens = outputTokens * 10`.

Scans all VS Code log sessions (filtered to files modified within 7 days). Platform-aware paths (macOS/Windows/Linux).

---

## Key Design Decisions

### 1. Deduplication: Session Watcher Wins

Both Layer 3 (session watcher) and Layer 4 (log watcher) can fire for the same Copilot interaction. Session data has actual token counts; log data has estimates. We built a `TokenDeduplicator` class:

- When a session watcher event fires, it's recorded with model name and timestamp
- When a log watcher event arrives, we check if a matching session event exists within a 10-second window
- Model names are normalized via `resolveModelPricing()` before comparison (e.g., `claude-opus-4-6` matches `claude-opus-4.6`)
- If a match is found, the log event is suppressed

This ensures we use actual data when available and only fall back to estimates for interactions the session watcher doesn't cover.

### 2. Live vs. Historical Events

When the extension activates, it reads existing `events.jsonl` files that may contain data from sessions days ago. Without care, this would inflate the status bar with old data.

Solution: `isLiveEvent(timestamp)` uses a 5-minute window:
- **Live events** (within 5 min): Update both status bar and storage
- **Historical events** (older): Update only storage, filed under the correct historical date

This means the status bar shows only current session activity, while the dashboard shows complete historical trends.

### 3. Date-Aware Storage

`UsageStorage.recordRequest()` and `recordAcceptance()` accept an optional `timestamp` parameter. When provided, the data is filed under the correct `YYYY-MM-DD` date key instead of today. This means historical imports from `events.jsonl` create accurate historical records -- if a session from March 28 is processed on April 2, the tokens show up under March 28 in the dashboard.

### 4. Persisted Watcher State (The Critical Bug Fix)

Both watchers track which events they've already processed (`processedEventIds`/`processedRequestIds`) and where they left off in each file (`filePositions`). Initially these were in-memory only, meaning every VS Code restart would re-process all historical files and duplicate the data.

**Fix:** Both watchers now persist their state to `globalState`:
- `processedEventIds` / `processedRequestIds` saved as JSON arrays
- `filePositions` saved as JSON objects (path -> byte offset)
- Immediate saves after processing (no debounce) to minimize cross-window race conditions
- Merge-before-process: reloads persisted state before reading new content, picking up changes from other windows
- File positions use `Math.max()` merge to respect other windows' progress
- Restored on `activate()` before scanning files

Storage keys:
- `sessionWatcher.processedEventIds`, `sessionWatcher.filePositions`
- `logWatcher.processedRequestIds`, `logWatcher.filePositions`

### 5. Model Pricing Resolution

Copilot uses various model name formats in different contexts: `claude-opus-4.6`, `claude-opus-4-6`, `gpt-4o-mini-2024-07-18`, `claude-3-5-sonnet`, etc. The `resolveModelPricing()` function fuzzy-matches these to a pricing table:

| Model | Input / 1M tokens | Output / 1M tokens |
|-------|-------------------|---------------------|
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4.1 | $2.00 | $8.00 |
| gpt-4 | $30.00 | $60.00 |
| claude-opus-4.6 | $15.00 | $75.00 |
| claude-sonnet-4 | $3.00 | $15.00 |
| claude-sonnet-3.5 | $3.00 | $15.00 |

These are equivalent market rates since Copilot's internal pricing isn't public.

---

## What We Built: File-by-File

### Source Files (2,827 lines total)

| File | Lines | Purpose |
|------|-------|---------|
| `src/extension.ts` | 390 | Orchestrator: wires 4 trackers, deduplication, live-vs-historical routing, commands |
| `src/dashboard.ts` | 1016 | Full dashboard webview + sidebar panel with Chart.js charts, model breakdown, Jensen benchmark |
| `src/copilotSessionWatcher.ts` | ~403 | Watches events.jsonl for actual tokens, persists state to globalState |
| `src/copilotLogWatcher.ts` | ~380 | Watches Copilot Chat logs for estimated tokens, persists state to globalState |
| `src/chatTracker.ts` | 328 | Burst-detection algorithm for Chat Apply/Insert/file-create heuristics |
| `src/completionTracker.ts` | 257 | Inline completion detection via InlineCompletionItemProvider + document changes |
| `src/usageStorage.ts` | 273 | Date-aware persistent storage with daily aggregation, language + model breakdown |
| `src/tokenCounter.ts` | 106 | Token counting (gpt-tokenizer/o200k_base), cost estimation, formatting utilities |
| `src/statusBar.ts` | 98 | Real-time status bar with configurable format (tokens/cost/both) |

### Test Files (88 tests across 7 files)

| File | Tests | What It Covers |
|------|-------|----------------|
| `src/test/tokenCounter.test.ts` | 22 | Token counting, cost estimation, formatting, pricing table integrity |
| `src/test/usageStorage.test.ts` | 16 | CRUD operations, persistence, date-aware recording, multi-date distribution |
| `src/test/copilotSessionWatcher.test.ts` | 14 | JSONL parsing, event-to-token conversion, real-world data pipeline |
| `src/test/copilotLogWatcher.test.ts` | 8 | ccreq line parsing, model extraction, timestamp handling, edge cases |
| `src/test/modelPricing.test.ts` | 8 | Model name resolution, Claude/GPT variants, pricing relationships |
| `src/test/statusBar.test.ts` | 8 | Initialization, token accumulation, reset, format/visibility |
| `src/test/completionTracker.test.ts` | 6 | Initialization, reset, event registration, disposal |

All tests use Vitest with a custom VS Code API mock (`src/test/__mocks__/vscode.ts`, 102 lines).

### Configuration & Build

| File | Purpose |
|------|---------|
| `package.json` | Extension manifest: 3 commands, 6 config options, sidebar view, Tab keybinding |
| `tsconfig.json` | TypeScript strict mode, Node16 modules, ES2022 target |
| `vitest.config.ts` | Test runner with vscode module alias |
| `.vscode/launch.json` | Two debug configs: standard and with-Copilot-extensions |
| `.vscode/tasks.json` | esbuild watch task |
| `.vscodeignore` | Clean VSIX packaging (only dist/ and images/) |

### Build Output (v0.1.0)

| File | Size |
|------|------|
| `dist/extension.js` | 2.9 MB (bundled via esbuild) |
| `dist/extension.js.map` | 4.3 MB |
| `eatingtoken-0.1.0.vsix` | 2.42 MB |

---

## The Dashboard

The dashboard is a webview panel generated entirely in TypeScript with Chart.js for interactive charts. It includes:

- **4 summary cards**: Today's Tokens, Today's Cost, All-Time Tokens, All-Time Cost
- **Interactive charts** (Chart.js):
  - Stacked bar chart for tokens (input/output) with 7-day / 30-day toggle
  - Line chart with area fill for cost trends with 7-day / 30-day toggle
  - Donut chart for per-model token breakdown with color-coded legend
- **Model Usage section**: Per-model breakdown showing tokens and cost with assigned colors (e.g., claude-opus-4.6 = purple, gpt-4o = emerald)
- **Jensen's Benchmark**: Progress bar projecting yearly cost based on daily average, with cost projection cards (weekly burn rate with trend badge, projected monthly, projected yearly)
- **Data Sources section**: Color-coded badges showing which tracking layer contributed data
  - Green badge = ACTUAL (from session watcher)
  - Yellow badge = ESTIMATED (from log watcher)
  - Purple badge = HEURISTIC (from completion/chat trackers)
- **Language breakdown table**: Top 10 languages sorted by total tokens, with proportional bars
- **Bottom stats**: Acceptance rate, days tracked, average tokens/day

A compact version renders in the sidebar panel using VS Code's native CSS variables for theme integration.

---

## Testing Approach

We prioritized testing the **pure logic** that can be tested without VS Code:

1. **Parsing functions** exported separately from watcher classes (`parseSessionLine`, `sessionEventToTokenEvents`, `parseCcreqLine`) -- tested with real-world data samples
2. **Token counting and pricing** -- tested with various input sizes, all model variants, edge cases
3. **Storage operations** -- tested with a mock Memento, including the date-aware recording logic
4. **Status bar state management** -- tested accumulation, reset, format changes

The watcher classes themselves (which depend on `fs.watch`, file I/O, and `vscode.ExtensionContext`) are tested via their exported pure functions rather than end-to-end, keeping tests fast and deterministic.

Real-world session data was used in tests: actual `events.jsonl` entries with 10.1M input tokens, 67.7K output tokens, 9.6M cache reads, and 84 premium requests.

---

## Timeline of Development

1. **Research**: Investigated VS Code APIs, Copilot architecture, found `events.jsonl` data source
2. **Scaffolding**: Project setup with package.json, TypeScript, esbuild, Vitest
3. **Core modules**: Token counter, usage storage, status bar
4. **Tracker layers**: Completion tracker, chat tracker, session watcher, log watcher
5. **Integration**: extension.ts wiring with deduplication and live-vs-historical logic
6. **Dashboard v1**: Webview with pure CSS charts, data sources section, Jensen benchmark
7. **Testing**: 88 tests across 7 files, all passing
8. **Packaging**: .vsix generation, icon conversion (SVG to PNG), .vscodeignore
9. **User testing**: F5 launch confirmed real data display (12.84M tokens)
10. **Bug fix**: Persisted watcher state to globalState to prevent duplicate accumulation across restarts
11. **v0.1.0 release**: First installable .vsix, confirmed working in daily use
12. **Dashboard v2 (0.2.0)**: Complete rewrite with Chart.js, per-model tracking, donut charts, cost projections, 7/30-day toggle
13. **Per-model storage**: Extended `UsageStorage` with `byModel` field, wired session/log watchers to pass model names
14. **Chart.js bundling fix**: Copy UMD bundle to `dist/` for .vsix packaging, multi-path fallback for dev/prod
15. **Log watcher scan fix**: Removed arbitrary 3-session limit that caused watcher to miss active session after reinstall; replaced with full scan + 7-day recency filter
16. **Cross-window safety**: Merge-before-process, immediate saves, `Math.max()` file position merging

---

## How to Install and Use

```bash
# Install the .vsix
code --install-extension eatingtoken-0.2.0.vsix

# After first install, reset data to start clean
# Command Palette -> "Eating Token: Reset Session Stats" -> "Reset All Data"
```

The extension activates on VS Code startup and immediately begins:
- Monitoring inline completions and chat activity (heuristic)
- Tailing `~/.copilot/session-state/*/events.jsonl` (actual tokens)
- Tailing VS Code Copilot Chat log files (estimated tokens)

Status bar shows: `🔥 X.XK | $X.XX`

Click the status bar item or use Command Palette -> "Eating Token: Show Dashboard" for the full view.

---

## Version 0.2.0 - Dashboard Redesign & Per-Model Tracking

### Chart.js Dashboard

Replaced the pure CSS bar charts with interactive Chart.js-powered visualizations:

- **Stacked bar chart** for token usage (input/output split, color-coded)
- **Line chart with area fill** for daily cost trends
- **Donut chart** for per-model token breakdown with color-coded legend
- **7-day / 30-day toggle** that switches both charts dynamically
- **Cost projection cards**: Weekly burn rate (with trend badge vs last week), projected monthly, projected yearly
- VS Code theme-aware styling using CSS variables with fallbacks for both dark and light themes
- Modern card design with hover effects, gradients, rounded corners

Chart.js (v4.5.1) is loaded by reading the UMD bundle (`chart.umd.min.js`, ~204KB) from `dist/` and inlining it as a `<script>` tag in the webview HTML. This avoids CSP issues with external scripts in VS Code webviews.

### Per-Model Usage Tracking

Extended `UsageStorage` with a `byModel` field on `DailyUsage`:

```typescript
byModel: Record<string, {
  requests: number;
  acceptances: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}>
```

- `recordRequest()` and `recordAcceptance()` now accept an optional `model` parameter
- Session watcher and log watcher pass their resolved model name to storage calls
- Backwards-compatible: old stored data without `byModel` is handled gracefully (field initialized to `{}` on read)
- Dashboard aggregates model data across days and renders a donut chart + legend

### Chart.js Bundling for .vsix

The build script now copies `chart.umd.min.js` into `dist/` alongside the bundled extension:

```
"build": "esbuild ... && cp node_modules/chart.js/dist/chart.umd.min.js dist/chart.umd.min.js"
```

The `getChartJsSource()` function in `dashboard.ts` reads from three locations in priority order:
1. `dist/chart.umd.min.js` (packaged .vsix)
2. `node_modules/chart.js/dist/chart.umd.min.js` (F5 development)
3. `require.resolve('chart.js/...')` (fallback)

### Bug Fix: Log Watcher Session Directory Scanning

**Root cause**: The log watcher was scanning only the 3 most recent VS Code session directories (by name, descending). VS Code creates many small session directories for CLI invocations, reloads, and extension reinstalls. These contain only `cli.log` and no Copilot Chat logs. After installing a new .vsix, several new empty session dirs were created, pushing the actual active session (with all the `window*/exthost/GitHub.copilot-chat/` directories) out of the top 3. The watcher scanned empty directories and never found the real Copilot Chat log files, so the status bar showed 0.

**Fix**: Removed the arbitrary `.slice(0, 3)` limit. The watcher now scans **all** session directories but only watches Copilot Chat log files modified in the last 7 days. This means it always finds the active session regardless of how many empty CLI session dirs exist, while still avoiding unnecessary work on stale months-old logs.

### Cross-Window Safety Improvements

Both watchers (session and log) were updated for safer multi-window operation:

- **Merge before process**: Each watcher reloads persisted state from `globalState` before processing new file content, picking up changes from other VS Code windows
- **Immediate save**: Persisted state is saved immediately after processing (no debounce), minimizing race condition windows
- **File positions use `Math.max()`**: When merging with persisted positions, the higher offset wins, respecting progress from other windows
- **Log watcher uses separate `watchedFiles` Set**: Decoupled from `filePositions` to prevent re-watching files that were already set up

### Updated File Sizes

| File | Lines | Change |
|------|-------|--------|
| `src/dashboard.ts` | 1016 | Rewritten: Chart.js, model breakdown, time toggle, cost projections |
| `src/usageStorage.ts` | 273 | Added `byModel` tracking |
| `src/copilotLogWatcher.ts` | ~380 | Removed session dir limit, 7-day recency filter |
| `src/copilotSessionWatcher.ts` | ~403 | Cross-window merge-before-process |
| `src/extension.ts` | 390 | Passes model to storage calls |

### Build Output

| File | Size |
|------|------|
| `dist/extension.js` | 2.95 MB |
| `dist/chart.umd.min.js` | 204 KB |
| `eatingtoken-0.2.0.vsix` | 2.5 MB |

---

## Known Limitations

1. **Inline completion tracking is heuristic** -- it can't distinguish Copilot completions from other InlineCompletionItemProviders
2. **Chat tracking via document changes** can miss interactions that don't result in code changes (e.g., question-only chats)
3. **Cost estimates use market-equivalent pricing** since Copilot's actual internal cost structure is unknown
4. **Token estimation from duration** (log watcher) is rough -- network conditions and prompt processing time vary
5. **The session watcher depends on `~/.copilot/session-state/`** which is specific to Copilot's agent mode; standard Copilot Chat may not write to this location in all configurations

---

## Entry 14: Energy & Environment Tracking (v0.3.0)

### The Question

We can see how many tokens we're eating and how much they cost. But how much electricity are we burning? What's the carbon footprint of our AI-assisted coding?

### Research

We studied energy consumption data from:
- **Luccioni et al. (2023)** "Power Hungry Processing: Watts Driving the Cost of AI Deployment?" -- systematic inference energy measurements across model classes
- **NVIDIA H100 specifications** -- 700W TDP, measured throughput rates per model size
- **SemiAnalysis** cost modeling -- inference costs that back-derive to power consumption
- **EPA eGRID 2023** -- US grid average carbon intensity of 0.39 kg CO2/kWh

### Energy Model

We built per-model energy estimates in Watt-hours per token, accounting for:

1. **GPU power draw**: H100 at ~700W TDP during inference
2. **Throughput rates**: Model-specific (gpt-4o-mini ~800 tok/s, gpt-4o ~80 tok/s, claude-opus ~40 tok/s)
3. **Server overhead**: CPU, memory, networking add ~30% on top of GPU
4. **Data center PUE**: Power Usage Effectiveness of 1.2 (hyperscaler average)
5. **Prefill vs decode**: Input tokens (parallelized prefill) are ~10x cheaper than output tokens (sequential autoregressive decode)

| Model | Input (Wh/token) | Output (Wh/token) | Notes |
|-------|------------------|--------------------|-------|
| gpt-4o-mini | 0.000040 | 0.00040 | ~8B params, very efficient |
| gpt-4o | 0.00038 | 0.0038 | ~200B MoE |
| gpt-4.1 | 0.00035 | 0.0035 | Similar to 4o |
| gpt-4 | 0.0010 | 0.010 | ~1.8T dense, power hungry |
| claude-opus-4.6 | 0.00080 | 0.0080 | Large model, slower decode |
| claude-sonnet-4 | 0.00038 | 0.0038 | Medium, efficient |
| claude-sonnet-3.5 | 0.00038 | 0.0038 | Medium, efficient |

### What We Built

**`tokenCounter.ts`** -- Added `MODEL_ENERGY` table, `estimateEnergy()`, `estimateCO2Grams()`, `getEnergyComparisons()`, `formatEnergy()`, `formatCO2()`, and `whToKwh()`.

**Status bar** -- Now shows energy inline: `$(flame) 6.9K | $0.067 | 0.50 Wh`. Tooltip also includes energy and CO2 for the session.

**Dashboard summary tiles** -- Added a 5th tile "All-Time Energy" (green) alongside the original 4 tiles (5-column grid). Shows total energy with average per day in the detail line.

**Dashboard Energy & Environment section** -- Dedicated section with:
- 4 summary cards: Today's Energy, All-Time Energy, Avg Energy/Day, Carbon Intensity
- Energy over time bar chart (synced with the 7/30 day toggle)
- Real-world equivalents: phone charges, LED bulb hours, Google searches, EV miles
- Methodology disclaimer

**Sidebar** -- Added energy summary with today's energy and total CO2.

**Tests** -- 23 new tests covering energy estimation, CO2 calculation, formatting, comparisons, and model energy data validation. Total: 111 tests, all passing.

### UI Polish

Several iterations on the dashboard layout:
- Started with 6 tiles (2 energy tiles) -- too big, broke the visual rhythm
- Tried 6-column grid -- too squished, labels wrapping
- Tried embedding energy in cost tile detail lines -- felt hidden, didn't belong
- Settled on **5 tiles in a single row**: original 4 + one "All-Time Energy" tile in green with avg/day detail

Also fixed:
- **Chart resize bug**: Charts (Usage Over Time, Model Usage, Energy) didn't resize when the VS Code panel was resized via the splitter. Added `min-width: 0` on grid items, `overflow: hidden` on sections, and a `ResizeObserver` that calls `chart.resize()` on all Chart.js instances.
- **F5 debug prompt**: The `npm: watch` preLaunchTask's `endsPattern` didn't match esbuild's output (`[watch] build finished` vs the old `Done in \d+`), causing the "Waiting for preLaunchTask" prompt. Fixed the regex in `tasks.json`.

### Version

Bumped to v0.3.0 in `package.json` and dashboard header.

### Important Caveats

These are estimates. Actual energy consumption varies significantly based on:
- Which hardware the provider is running (H100 vs A100 vs TPU)
- Batch size and utilization rates
- Data center location and PUE
- Whether the request hits KV cache
- Provider-specific optimizations (quantization, speculative decoding, etc.)

Our estimates are based on a reasonable "H100 at moderate utilization" baseline. They're meant to give directional awareness, not precise accounting.
