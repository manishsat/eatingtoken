# Changelog

## v0.3.0 - Energy & Electricity Tracking

### What's New

**Energy consumption tracking** -- See how much electricity your AI-assisted coding consumes, right inside VS Code.

- New **All-Time Energy** tile in the dashboard summary with average daily energy usage
- Energy displayed in the status bar: `6.9K | $0.067 | 0.50 Wh`
- Per-model energy estimates based on H100 inference benchmarks, data center PUE (1.2), and published research

![Energy Tile](https://raw.githubusercontent.com/manishsat/eatingtoken/main/images/energy-tile-consumption.png)

- Dedicated **Energy & Environment** dashboard section with:
  - Energy over time bar chart (synced with 7/30 day toggle)
  - Real-world comparisons: phone charges, LED bulb hours, Google searches, EV miles
  - CO2 emissions estimate using US grid average (0.39 kg CO2/kWh)
  - Methodology notes

![Detailed Energy Consumption](https://raw.githubusercontent.com/manishsat/eatingtoken/main/images/detailed-energy-consumption.png)

- Energy summary in sidebar panel

### Fixes

- Charts (Usage Over Time, Model Usage, Energy) now resize properly when adjusting the panel width
- F5 debug launch no longer shows "Debug Anyway" prompt

### Under the Hood

- 23 new tests (111 total, all passing)
- `MODEL_ENERGY` table with per-model Wh/token estimates for input and output
- New functions: `estimateEnergy()`, `estimateCO2Grams()`, `getEnergyComparisons()`, `formatEnergy()`, `formatCO2()`

---

## v0.2.1

- Fix README images to use absolute GitHub URLs for Marketplace rendering

## v0.2.0 - Dashboard v2

- Complete dashboard rewrite with Chart.js
- Stacked bar charts for daily token consumption
- Cost trend line chart
- Donut chart for per-model breakdown
- 7/30 day toggle
- Cost projection cards with trend badges
- Per-model tracking with `byModel` storage field
- Chart.js UMD bundle fix for .vsix packaging
- Log watcher scan fix (removed 3-session limit)
- Cross-window safety: merge-before-process, immediate saves

## v0.1.0 - Initial Release

- 4-layer tracking system: Session Watcher, Log Watcher, Chat Tracker, Completion Tracker
- Real-time status bar with token count and cost
- Persistent daily usage storage via globalState
- Interactive dashboard with pure CSS charts
- Jensen's $250K Benchmark progress bar
- Language breakdown table
- 88 tests across 7 test files
