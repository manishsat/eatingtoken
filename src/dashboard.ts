/**
 * Dashboard webview panel.
 * Shows usage trends, model breakdown, cost projections, and the Jensen benchmark.
 * Uses Chart.js for interactive charts and VS Code theme variables for theme support.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { UsageSummary, DailyUsage } from './usageStorage';
import { formatTokenCount, formatCost, estimateEnergy, estimateCO2Grams, formatEnergy, formatCO2, getEnergyComparisons, MODEL_ENERGY } from './tokenCounter';

// ─── Helper types ─────────────────────────────────────────────────────────────

interface AggregatedModelData {
  requests: number;
  acceptances: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface AggregatedLanguageData {
  requests: number;
  acceptances: number;
  inputTokens: number;
  outputTokens: number;
}

// ─── Model color palette ──────────────────────────────────────────────────────

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4.6': '#c084fc',   // Purple
  'claude-sonnet-4': '#818cf8',   // Indigo
  'claude-sonnet-3.5': '#a78bfa', // Violet
  'gpt-4o': '#34d399',            // Emerald
  'gpt-4o-mini': '#6ee7b7',       // Light green
  'gpt-4.1': '#2dd4bf',           // Teal
  'gpt-4': '#22d3ee',             // Cyan
};

function getModelColor(model: string): string {
  return MODEL_COLORS[model] || '#94a3b8'; // Slate fallback
}

// ─── Chart.js inline source ───────────────────────────────────────────────────

let chartJsSource: string | null = null;

function getChartJsSource(): string {
  if (chartJsSource) { return chartJsSource; }

  // Priority 1: chart.umd.min.js copied alongside the bundle in dist/
  try {
    const distPath = path.join(__dirname, 'chart.umd.min.js');
    if (fs.existsSync(distPath)) {
      chartJsSource = fs.readFileSync(distPath, 'utf8');
      return chartJsSource;
    }
  } catch { /* fall through */ }

  // Priority 2: node_modules (works during development / F5 debug)
  try {
    const nmPath = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
    if (fs.existsSync(nmPath)) {
      chartJsSource = fs.readFileSync(nmPath, 'utf8');
      return chartJsSource;
    }
  } catch { /* fall through */ }

  // Priority 3: require.resolve fallback
  try {
    const altPath = require.resolve('chart.js/dist/chart.umd.min.js');
    chartJsSource = fs.readFileSync(altPath, 'utf8');
    return chartJsSource;
  } catch { /* fall through */ }

  return '/* Chart.js not found */';
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function aggregateModels(days: DailyUsage[]): Record<string, AggregatedModelData> {
  const result: Record<string, AggregatedModelData> = {};
  for (const day of days) {
    if (!day.byModel) { continue; }
    for (const [model, data] of Object.entries(day.byModel)) {
      if (!result[model]) {
        result[model] = { requests: 0, acceptances: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      }
      result[model].requests += data.requests;
      result[model].acceptances += data.acceptances;
      result[model].inputTokens += data.inputTokens;
      result[model].outputTokens += data.outputTokens;
      result[model].costUsd += data.costUsd;
    }
  }
  return result;
}

function aggregateLanguages(days: DailyUsage[]): Record<string, AggregatedLanguageData> {
  const result: Record<string, AggregatedLanguageData> = {};
  for (const day of days) {
    for (const [lang, data] of Object.entries(day.byLanguage)) {
      if (!result[lang]) {
        result[lang] = { requests: 0, acceptances: 0, inputTokens: 0, outputTokens: 0 };
      }
      result[lang].requests += data.requests;
      result[lang].acceptances += data.acceptances;
      result[lang].inputTokens += data.inputTokens;
      result[lang].outputTokens += data.outputTokens;
    }
  }
  return result;
}

// ─── Main Dashboard Panel ─────────────────────────────────────────────────────

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(extensionUri: vscode.Uri): DashboardPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'eatingtokenDashboard',
      'Eating Token Dashboard',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel);
    return DashboardPanel.currentPanel;
  }

  update(summary: UsageSummary, yearlyTarget: number): void {
    this.panel.webview.html = this.getHtmlContent(summary, yearlyTarget);
  }

  private getHtmlContent(summary: UsageSummary, yearlyTarget: number): string {
    const today = summary.today;
    const allTime = summary.allTime;

    // Calculate projections
    const daysSinceStart = Math.max(1, daysBetween(allTime.firstTrackedDate, new Date().toISOString().split('T')[0]));
    const dailyAvgCost = allTime.totalCostUsd / daysSinceStart;
    const projectedYearlyCost = dailyAvgCost * 365;
    const jensenProgress = Math.min(100, (projectedYearlyCost / yearlyTarget) * 100);

    // Period data for charts
    const weekData = [...summary.thisWeek].reverse();
    const monthData = [...summary.thisMonth].reverse();

    // Model breakdown (all time from month data)
    const modelBreakdown = aggregateModels(summary.thisMonth);
    const modelEntries = Object.entries(modelBreakdown)
      .sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

    // Language breakdown
    const langBreakdown = aggregateLanguages(summary.thisMonth);
    const copilotSourceKeys = new Set(['copilot-agent', 'copilot-chat']);
    const topLanguages = Object.entries(langBreakdown)
      .filter(([lang]) => !copilotSourceKeys.has(lang))
      .sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      .slice(0, 10);

    // Data source breakdown
    const agentData = langBreakdown['copilot-agent'] || { inputTokens: 0, outputTokens: 0, requests: 0, acceptances: 0 };
    const chatData = langBreakdown['copilot-chat'] || { inputTokens: 0, outputTokens: 0, requests: 0, acceptances: 0 };
    const actualTokens = agentData.inputTokens + agentData.outputTokens;
    const estimatedTokens = chatData.inputTokens + chatData.outputTokens;
    const heuristicTokens = topLanguages.reduce((sum, [, d]) => sum + d.inputTokens + d.outputTokens, 0);

    // Cost trend: compare this week vs last week
    const thisWeekCost = weekData.reduce((s, d) => s + d.estimatedCostUsd, 0);
    const lastWeekDays = summary.thisMonth.slice(7, 14);
    const lastWeekCost = lastWeekDays.reduce((s, d) => s + d.estimatedCostUsd, 0);
    const costTrend = lastWeekCost > 0 ? ((thisWeekCost - lastWeekCost) / lastWeekCost) * 100 : 0;

    // ── Energy calculations ──
    // Calculate energy from all-time token data per model
    const allTimeModelBreakdown = aggregateModels(summary.thisMonth);
    let totalEnergyWh = 0;
    let todayEnergyWh = 0;

    // All-time energy by model
    for (const [model, data] of Object.entries(allTimeModelBreakdown)) {
      const energy = estimateEnergy(data.inputTokens, data.outputTokens, model);
      totalEnergyWh += energy.totalWh;
    }
    // If no per-model data, estimate from totals using default model
    if (Object.keys(allTimeModelBreakdown).length === 0 && (allTime.totalInputTokens + allTime.totalOutputTokens) > 0) {
      const energy = estimateEnergy(allTime.totalInputTokens, allTime.totalOutputTokens, 'gpt-4o');
      totalEnergyWh = energy.totalWh;
    }

    // Today's energy by model
    if (today.byModel && Object.keys(today.byModel).length > 0) {
      for (const [model, data] of Object.entries(today.byModel)) {
        const energy = estimateEnergy(data.inputTokens, data.outputTokens, model);
        todayEnergyWh += energy.totalWh;
      }
    } else {
      const energy = estimateEnergy(today.totalInputTokens, today.totalOutputTokens, 'gpt-4o');
      todayEnergyWh = energy.totalWh;
    }

    const totalCO2 = estimateCO2Grams(totalEnergyWh);
    const todayCO2 = estimateCO2Grams(todayEnergyWh);
    const comparisons = getEnergyComparisons(totalEnergyWh);
    const dailyAvgEnergy = totalEnergyWh / daysSinceStart;
    const projectedYearlyEnergy = dailyAvgEnergy * 365;

    // Per-model energy breakdown for chart
    const modelEnergyEntries = modelEntries.map(([model, data]) => {
      const energy = estimateEnergy(data.inputTokens, data.outputTokens, model);
      return { model, energyWh: energy.totalWh };
    });

    // Prepare JSON data for Chart.js
    const chartData = {
      weekLabels: weekData.map(d => d.date.slice(5)),
      weekTokens: weekData.map(d => d.totalInputTokens + d.totalOutputTokens),
      weekInputTokens: weekData.map(d => d.totalInputTokens),
      weekOutputTokens: weekData.map(d => d.totalOutputTokens),
      weekCosts: weekData.map(d => d.estimatedCostUsd),
      monthLabels: monthData.map(d => d.date.slice(5)),
      monthTokens: monthData.map(d => d.totalInputTokens + d.totalOutputTokens),
      monthInputTokens: monthData.map(d => d.totalInputTokens),
      monthOutputTokens: monthData.map(d => d.totalOutputTokens),
      monthCosts: monthData.map(d => d.estimatedCostUsd),
      modelNames: modelEntries.map(([m]) => m),
      modelTokens: modelEntries.map(([, d]) => d.inputTokens + d.outputTokens),
      modelCosts: modelEntries.map(([, d]) => d.costUsd),
      modelColors: modelEntries.map(([m]) => getModelColor(m)),
      // Energy data per day
      weekEnergy: weekData.map(d => {
        let wh = 0;
        if (d.byModel && Object.keys(d.byModel).length > 0) {
          for (const [model, data] of Object.entries(d.byModel)) {
            wh += estimateEnergy(data.inputTokens, data.outputTokens, model).totalWh;
          }
        } else {
          wh = estimateEnergy(d.totalInputTokens, d.totalOutputTokens, 'gpt-4o').totalWh;
        }
        return wh;
      }),
      monthEnergy: monthData.map(d => {
        let wh = 0;
        if (d.byModel && Object.keys(d.byModel).length > 0) {
          for (const [model, data] of Object.entries(d.byModel)) {
            wh += estimateEnergy(data.inputTokens, data.outputTokens, model).totalWh;
          }
        } else {
          wh = estimateEnergy(d.totalInputTokens, d.totalOutputTokens, 'gpt-4o').totalWh;
        }
        return wh;
      }),
      modelEnergyWh: modelEnergyEntries.map(e => e.energyWh),
    };

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eating Token Dashboard</title>
  <style>
    /* ── Theme: use VS Code CSS variables with fallbacks ── */
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --bg-card: var(--vscode-editorWidget-background, #252526);
      --bg-hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --text: var(--vscode-editor-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #888888);
      --border: var(--vscode-widget-border, #404040);
      --accent: #f97316;
      --accent-light: #fb923c;
      --blue: #3b82f6;
      --blue-light: #60a5fa;
      --green: #10b981;
      --green-light: #34d399;
      --purple: #8b5cf6;
      --red: #ef4444;
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      padding: 24px 32px;
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 8px;
    }
    .header h1 {
      font-size: 22px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--accent), var(--accent-light));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .header .version {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 400;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 13px;
      margin-bottom: 24px;
    }

    /* ── Summary cards ── */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    @media (max-width: 800px) {
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .summary-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      transition: border-color 0.2s;
    }
    .summary-card:hover { border-color: var(--accent); }
    .summary-card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .summary-card .value {
      font-size: 26px;
      font-weight: 700;
    }
    .summary-card .detail {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* ── Section containers ── */
    .section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
    }

    /* ── Toggle buttons ── */
    .toggle-group {
      display: flex;
      gap: 2px;
      background: var(--bg);
      border-radius: 6px;
      padding: 2px;
      border: 1px solid var(--border);
    }
    .toggle-btn {
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 500;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: transparent;
      color: var(--text-muted);
      font-family: var(--font);
      transition: all 0.15s;
    }
    .toggle-btn.active {
      background: var(--accent);
      color: #fff;
    }
    .toggle-btn:hover:not(.active) {
      color: var(--text);
    }

    /* ── Charts layout ── */
    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
      min-width: 0;
    }
    @media (max-width: 700px) {
      .charts-grid { grid-template-columns: 1fr; }
    }
    .chart-container {
      position: relative;
      height: 200px;
      min-width: 0;
    }

    /* ── Jensen progress ── */
    .jensen-bar-bg {
      background: var(--bg);
      border-radius: 10px;
      height: 28px;
      overflow: hidden;
      position: relative;
      border: 1px solid var(--border);
    }
    .jensen-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-light));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      min-width: 48px;
      transition: width 0.5s ease;
    }
    .jensen-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 6px;
    }

    /* ── Cost projection cards ── */
    .projection-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 16px;
    }
    @media (max-width: 600px) {
      .projection-grid { grid-template-columns: 1fr; }
    }
    .proj-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      text-align: center;
    }
    .proj-card .proj-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .proj-card .proj-value {
      font-size: 20px;
      font-weight: 700;
    }
    .trend-up { color: var(--green); }
    .trend-down { color: var(--red); }
    .trend-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 4px;
    }
    .trend-badge.up { background: rgba(16,185,129,0.15); color: var(--green); }
    .trend-badge.down { background: rgba(239,68,68,0.15); color: var(--red); }

    /* ── Data sources ── */
    .source-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
    }
    .source-row + .source-row { border-top: 1px solid var(--border); }
    .badge {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.8px;
      padding: 3px 8px;
      border-radius: 4px;
      min-width: 76px;
      text-align: center;
    }
    .badge-actual { background: rgba(16,185,129,0.15); color: var(--green); }
    .badge-estimated { background: rgba(234,179,8,0.15); color: #eab308; }
    .badge-heuristic { background: rgba(139,92,246,0.15); color: var(--purple); }
    .source-info .name { font-size: 13px; font-weight: 600; }
    .source-info .meta { font-size: 11px; color: var(--text-muted); }

    /* ── Model breakdown ── */
    .model-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 12px;
      min-width: 0;
    }
    @media (max-width: 700px) {
      .model-grid { grid-template-columns: 1fr; }
    }
    .model-chart-container {
      position: relative;
      height: 220px;
      min-width: 0;
    }
    .model-legend {
      display: flex;
      flex-direction: column;
      gap: 8px;
      justify-content: center;
    }
    .model-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .model-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .model-name { font-size: 12px; font-weight: 600; }
    .model-stat { font-size: 11px; color: var(--text-muted); }

    /* ── Language table ── */
    .lang-table {
      width: 100%;
      border-collapse: collapse;
    }
    .lang-table th {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .lang-table td {
      font-size: 12px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lang-bar-bg {
      background: var(--bg);
      border-radius: 3px;
      height: 6px;
      overflow: hidden;
    }
    .lang-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--accent);
    }

    /* ── Bottom stats ── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 16px;
    }
    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Eating Token</h1>
    <span class="version">v0.3.0</span>
  </div>
  <p class="subtitle">Copilot Token Consumption Tracker</p>

  <!-- ── Summary Cards ── -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Today's Tokens</div>
      <div class="value">${formatTokenCount(today.totalInputTokens + today.totalOutputTokens)}</div>
      <div class="detail">In: ${formatTokenCount(today.totalInputTokens)} / Out: ${formatTokenCount(today.totalOutputTokens)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Today's Cost</div>
      <div class="value">${formatCost(today.estimatedCostUsd)}</div>
      <div class="detail">${today.totalRequests} requests / ${today.totalAcceptances} accepted</div>
    </div>
    <div class="summary-card">
      <div class="label">All-Time Tokens</div>
      <div class="value">${formatTokenCount(allTime.totalInputTokens + allTime.totalOutputTokens)}</div>
      <div class="detail">Since ${allTime.firstTrackedDate}</div>
    </div>
    <div class="summary-card">
      <div class="label">All-Time Cost</div>
      <div class="value">${formatCost(allTime.totalCostUsd)}</div>
      <div class="detail">Avg ${formatCost(dailyAvgCost)}/day</div>
    </div>
    <div class="summary-card">
      <div class="label">All-Time Energy</div>
      <div class="value" style="color:var(--green)">${formatEnergy(totalEnergyWh)}</div>
      <div class="detail">Avg ${formatEnergy(dailyAvgEnergy)}/day</div>
    </div>
  </div>

  <!-- ── Token & Cost Charts ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Usage Over Time</div>
      <div class="toggle-group">
        <button class="toggle-btn active" data-range="week" onclick="switchRange('week')">7 Days</button>
        <button class="toggle-btn" data-range="month" onclick="switchRange('month')">30 Days</button>
      </div>
    </div>
    <div class="charts-grid">
      <div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500">Tokens</div>
        <div class="chart-container"><canvas id="tokenChart"></canvas></div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500">Cost (USD)</div>
        <div class="chart-container"><canvas id="costChart"></canvas></div>
      </div>
    </div>
  </div>

  <!-- ── Model Breakdown ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Model Usage (Last 30 Days)</div>
    </div>
    ${modelEntries.length === 0
      ? '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px">No model data yet. Use Copilot Chat or Agent mode to see model breakdown.</div>'
      : `<div class="model-grid">
      <div class="model-chart-container"><canvas id="modelTokenChart"></canvas></div>
      <div class="model-legend">
        ${modelEntries.map(([model, data]) => {
          const total = data.inputTokens + data.outputTokens;
          return `<div class="model-legend-item">
            <div class="model-dot" style="background:${getModelColor(model)}"></div>
            <div>
              <div class="model-name">${model}</div>
              <div class="model-stat">${formatTokenCount(total)} tokens &middot; ${formatCost(data.costUsd)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`
    }
  </div>

  <!-- ── Cost Projections ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Jensen's $${(yearlyTarget / 1000).toFixed(0)}K Benchmark</div>
    </div>
    <div class="jensen-bar-bg">
      <div class="jensen-bar-fill" style="width:${jensenProgress.toFixed(1)}%">${jensenProgress.toFixed(1)}%</div>
    </div>
    <div class="jensen-meta">
      <span>Projected yearly: ${formatCost(projectedYearlyCost)}</span>
      <span>Target: ${formatCost(yearlyTarget)}</span>
    </div>
    <div class="projection-grid">
      <div class="proj-card">
        <div class="proj-label">Weekly Burn Rate</div>
        <div class="proj-value">${formatCost(thisWeekCost)}${costTrend !== 0 ? `<span class="trend-badge ${costTrend > 0 ? 'up' : 'down'}">${costTrend > 0 ? '+' : ''}${costTrend.toFixed(0)}%</span>` : ''}</div>
      </div>
      <div class="proj-card">
        <div class="proj-label">Projected Monthly</div>
        <div class="proj-value">${formatCost(dailyAvgCost * 30)}</div>
      </div>
      <div class="proj-card">
        <div class="proj-label">Projected Yearly</div>
        <div class="proj-value">${formatCost(projectedYearlyCost)}</div>
      </div>
    </div>
  </div>

  <!-- ── Energy & Environment ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Energy &amp; Environment</div>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="label">Today's Energy</div>
        <div class="value" style="color:var(--green)">${formatEnergy(todayEnergyWh)}</div>
        <div class="detail">CO2: ${formatCO2(todayCO2)}</div>
      </div>
      <div class="summary-card">
        <div class="label">All-Time Energy</div>
        <div class="value" style="color:var(--green)">${formatEnergy(totalEnergyWh)}</div>
        <div class="detail">CO2: ${formatCO2(totalCO2)}</div>
      </div>
      <div class="summary-card">
        <div class="label">Avg Energy/Day</div>
        <div class="value" style="color:var(--green)">${formatEnergy(dailyAvgEnergy)}</div>
        <div class="detail">Projected yearly: ${formatEnergy(projectedYearlyEnergy)}</div>
      </div>
      <div class="summary-card">
        <div class="label">Carbon Intensity</div>
        <div class="value" style="color:var(--green)">0.39</div>
        <div class="detail">kg CO2/kWh (US grid avg)</div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;font-weight:500">Energy Over Time</div>
      <div class="chart-container"><canvas id="energyChart"></canvas></div>
    </div>
    <div style="margin-top:20px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;font-weight:500">Real-World Equivalents (All-Time)</div>
      <div class="projection-grid" style="grid-template-columns:repeat(4,1fr)">
        ${comparisons.map(c => `<div class="proj-card">
          <div class="proj-label">${c.label}</div>
          <div class="proj-value" style="color:var(--green)">${c.value}</div>
        </div>`).join('')}
      </div>
    </div>
    <div style="margin-top:12px;font-size:11px;color:var(--text-muted);font-style:italic">
      Estimates based on GPU inference power draw (H100 TDP), data center PUE of 1.2, and US grid carbon intensity (EPA eGRID 2023). Actual consumption varies by provider infrastructure.
    </div>
  </div>

  <!-- ── Data Sources ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Data Sources (Last 30 Days)</div>
    </div>
    <div class="source-row">
      <div class="badge badge-actual">ACTUAL</div>
      <div class="source-info">
        <div class="name">Copilot Agent Sessions</div>
        <div class="meta">${formatTokenCount(actualTokens)} tokens &middot; ${agentData.requests + agentData.acceptances} events</div>
      </div>
    </div>
    <div class="source-row">
      <div class="badge badge-estimated">ESTIMATED</div>
      <div class="source-info">
        <div class="name">Copilot Chat Logs</div>
        <div class="meta">${formatTokenCount(estimatedTokens)} tokens &middot; ${chatData.requests + chatData.acceptances} events</div>
      </div>
    </div>
    <div class="source-row">
      <div class="badge badge-heuristic">HEURISTIC</div>
      <div class="source-info">
        <div class="name">Inline Completions &amp; Chat Edits</div>
        <div class="meta">${formatTokenCount(heuristicTokens)} tokens &middot; ${topLanguages.reduce((sum, [, d]) => sum + d.requests + d.acceptances, 0)} events</div>
      </div>
    </div>
  </div>

  <!-- ── Language Breakdown ── -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Language Breakdown (Last 30 Days)</div>
    </div>
    <table class="lang-table">
      <thead>
        <tr><th>Language</th><th>Requests</th><th>Accepted</th><th>Tokens</th><th style="width:25%">Usage</th></tr>
      </thead>
      <tbody>
        ${topLanguages.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:16px">No language data yet</td></tr>'
          : topLanguages.map(([lang, data]) => {
              const total = data.inputTokens + data.outputTokens;
              const maxT = topLanguages[0] ? topLanguages[0][1].inputTokens + topLanguages[0][1].outputTokens : 1;
              const pct = ((total / maxT) * 100).toFixed(0);
              return `<tr>
                <td style="font-weight:500">${lang}</td>
                <td>${data.requests}</td>
                <td>${data.acceptances}</td>
                <td>${formatTokenCount(total)}</td>
                <td><div class="lang-bar-bg"><div class="lang-bar-fill" style="width:${pct}%"></div></div></td>
              </tr>`;
            }).join('')
        }
      </tbody>
    </table>
  </div>

  <!-- ── Bottom Stats ── -->
  <div class="stats-grid">
    <div class="summary-card">
      <div class="label">Acceptance Rate</div>
      <div class="value">${allTime.totalRequests > 0 ? ((allTime.totalAcceptances / allTime.totalRequests) * 100).toFixed(1) : '0'}%</div>
      <div class="detail">${allTime.totalAcceptances} of ${allTime.totalRequests} suggestions</div>
    </div>
    <div class="summary-card">
      <div class="label">Days Tracked</div>
      <div class="value">${daysSinceStart}</div>
      <div class="detail">Since ${allTime.firstTrackedDate}</div>
    </div>
    <div class="summary-card">
      <div class="label">Avg Tokens/Day</div>
      <div class="value">${formatTokenCount(Math.round((allTime.totalInputTokens + allTime.totalOutputTokens) / daysSinceStart))}</div>
      <div class="detail">Input + Output combined</div>
    </div>
  </div>

  <!-- ── Chart.js ── -->
  <script>${getChartJsSource()}</script>
  <script>
    const DATA = ${JSON.stringify(chartData)};

    // Chart defaults
    Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#888';
    Chart.defaults.borderColor = getComputedStyle(document.body).getPropertyValue('--border').trim() || '#404040';
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 11;

    const gridColor = getComputedStyle(document.body).getPropertyValue('--border').trim() || '#333';

    // ── Token Chart ──
    const tokenCtx = document.getElementById('tokenChart').getContext('2d');
    const tokenChart = new Chart(tokenCtx, {
      type: 'bar',
      data: {
        labels: DATA.weekLabels,
        datasets: [{
          label: 'Input',
          data: DATA.weekInputTokens,
          backgroundColor: 'rgba(59,130,246,0.7)',
          borderRadius: 3,
          borderSkipped: false,
        }, {
          label: 'Output',
          data: DATA.weekOutputTokens,
          backgroundColor: 'rgba(249,115,22,0.7)',
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: true, position: 'top', labels: { boxWidth: 8, usePointStyle: true, pointStyle: 'circle', padding: 12 } },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.85)',
            titleFont: { weight: '600' },
            padding: 10,
            cornerRadius: 6,
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ' + Number(ctx.raw).toLocaleString() + ' tokens';
              }
            }
          }
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, grid: { color: gridColor }, ticks: {
            callback: function(v) {
              if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
              if (v >= 1000) return (v/1000).toFixed(0) + 'K';
              return v;
            }
          }}
        }
      }
    });

    // ── Cost Chart ──
    const costCtx = document.getElementById('costChart').getContext('2d');
    const costChart = new Chart(costCtx, {
      type: 'line',
      data: {
        labels: DATA.weekLabels,
        datasets: [{
          label: 'Cost',
          data: DATA.weekCosts,
          borderColor: 'rgba(16,185,129,0.9)',
          backgroundColor: 'rgba(16,185,129,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: 'rgba(16,185,129,1)',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.85)',
            padding: 10,
            cornerRadius: 6,
            callbacks: {
              label: function(ctx) {
                return '$' + Number(ctx.raw).toFixed(4);
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: gridColor }, ticks: {
            callback: function(v) { return '$' + Number(v).toFixed(4); }
          }}
        }
      }
    });

    // ── Model Donut Chart ──
    const modelCanvas = document.getElementById('modelTokenChart');
    if (modelCanvas && DATA.modelNames.length > 0) {
      const modelCtx = modelCanvas.getContext('2d');
      new Chart(modelCtx, {
        type: 'doughnut',
        data: {
          labels: DATA.modelNames,
          datasets: [{
            data: DATA.modelTokens,
            backgroundColor: DATA.modelColors,
            borderWidth: 0,
            hoverOffset: 6,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '55%',
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(0,0,0,0.85)',
              padding: 10,
              cornerRadius: 6,
              callbacks: {
                label: function(ctx) {
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = ((ctx.raw / total) * 100).toFixed(1);
                  return ctx.label + ': ' + Number(ctx.raw).toLocaleString() + ' tokens (' + pct + '%)';
                }
              }
            }
          }
        }
      });
    }

    // ── Energy Chart ──
    const energyCtx = document.getElementById('energyChart').getContext('2d');
    const energyChart = new Chart(energyCtx, {
      type: 'bar',
      data: {
        labels: DATA.weekLabels,
        datasets: [{
          label: 'Energy (Wh)',
          data: DATA.weekEnergy,
          backgroundColor: 'rgba(16,185,129,0.7)',
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.85)',
            padding: 10,
            cornerRadius: 6,
            callbacks: {
              label: function(ctx) {
                const wh = Number(ctx.raw);
                if (wh < 0.001) return (wh * 1000).toFixed(2) + ' mWh';
                if (wh < 1) return wh.toFixed(3) + ' Wh';
                return wh.toFixed(2) + ' Wh';
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: gridColor }, ticks: {
            callback: function(v) {
              const val = Number(v);
              if (val < 0.001) return (val * 1000).toFixed(1) + 'mWh';
              if (val < 1) return val.toFixed(3) + 'Wh';
              return val.toFixed(1) + 'Wh';
            }
          }}
        }
      }
    });

    // ── Time Range Toggle ──
    function switchRange(range) {
      document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === range);
      });

      const labels = range === 'week' ? DATA.weekLabels : DATA.monthLabels;
      const inputTokens = range === 'week' ? DATA.weekInputTokens : DATA.monthInputTokens;
      const outputTokens = range === 'week' ? DATA.weekOutputTokens : DATA.monthOutputTokens;
      const costs = range === 'week' ? DATA.weekCosts : DATA.monthCosts;
      const energy = range === 'week' ? DATA.weekEnergy : DATA.monthEnergy;

      tokenChart.data.labels = labels;
      tokenChart.data.datasets[0].data = inputTokens;
      tokenChart.data.datasets[1].data = outputTokens;
      tokenChart.update('none');

      costChart.data.labels = labels;
      costChart.data.datasets[0].data = costs;
      costChart.update('none');

      energyChart.data.labels = labels;
      energyChart.data.datasets[0].data = energy;
      energyChart.update('none');
    }

    // ── Resize Observer: force Chart.js to resize when panel size changes ──
    const allCharts = [tokenChart, costChart, energyChart];
    const ro = new ResizeObserver(() => {
      allCharts.forEach(c => c.resize());
    });
    ro.observe(document.body);
  </script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function daysBetween(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// ─── Sidebar View Provider ────────────────────────────────────────────────────

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'eatingtoken.dashboardView';
  private view?: vscode.WebviewView;
  private summary?: UsageSummary;
  private yearlyTarget: number = 250000;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    if (this.summary) {
      this.update(this.summary, this.yearlyTarget);
    } else {
      webviewView.webview.html = this.getMinimalHtml();
    }
  }

  update(summary: UsageSummary, yearlyTarget: number): void {
    this.summary = summary;
    this.yearlyTarget = yearlyTarget;

    if (this.view) {
      const today = summary.today;
      const allTime = summary.allTime;
      const daysSinceStart = Math.max(1, Math.ceil(
        (new Date().getTime() - new Date(allTime.firstTrackedDate).getTime()) / (1000 * 60 * 60 * 24)
      ) + 1);
      const dailyAvgCost = allTime.totalCostUsd / daysSinceStart;
      const projectedYearly = dailyAvgCost * 365;
      const progress = Math.min(100, (projectedYearly / yearlyTarget) * 100);

      // Energy estimate for sidebar
      const sidebarEnergy = estimateEnergy(allTime.totalInputTokens, allTime.totalOutputTokens, 'gpt-4o');
      const sidebarCO2 = estimateCO2Grams(sidebarEnergy.totalWh);
      const todayEnergy = estimateEnergy(today.totalInputTokens, today.totalOutputTokens, 'gpt-4o');

      this.view.webview.html = /* html */ `<!DOCTYPE html>
<html><head>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 12px;
    font-size: 13px;
  }
  .stat { margin-bottom: 14px; }
  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    opacity: 0.6;
    margin-bottom: 2px;
  }
  .stat-value { font-size: 20px; font-weight: 700; }
  .stat-detail { font-size: 11px; opacity: 0.5; }
  .divider {
    border-top: 1px solid var(--vscode-widget-border);
    margin: 12px 0;
  }
  .progress-bg {
    background: var(--vscode-input-background);
    height: 6px;
    border-radius: 3px;
    margin: 8px 0 4px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #f97316, #fb923c);
    border-radius: 3px;
  }
</style>
</head><body>
  <div class="stat">
    <div class="stat-label">Today</div>
    <div class="stat-value">${formatTokenCount(today.totalInputTokens + today.totalOutputTokens)} tokens</div>
    <div class="stat-detail">${formatCost(today.estimatedCostUsd)} estimated</div>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <div class="stat-label">All Time</div>
    <div class="stat-value">${formatCost(allTime.totalCostUsd)}</div>
    <div class="stat-detail">${formatTokenCount(allTime.totalInputTokens + allTime.totalOutputTokens)} tokens over ${daysSinceStart} days</div>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <div class="stat-label">Jensen's $${(yearlyTarget / 1000).toFixed(0)}K Target</div>
    <div class="progress-bg"><div class="progress-fill" style="width:${progress.toFixed(1)}%"></div></div>
    <div class="stat-detail">${formatCost(projectedYearly)}/year projected (${progress.toFixed(1)}%)</div>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <div class="stat-label">Energy Used</div>
    <div class="stat-value">${formatEnergy(sidebarEnergy.totalWh)}</div>
    <div class="stat-detail">Today: ${formatEnergy(todayEnergy.totalWh)} | CO2: ${formatCO2(sidebarCO2)}</div>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <div class="stat-label">Acceptance Rate</div>
    <div class="stat-value">${allTime.totalRequests > 0 ? ((allTime.totalAcceptances / allTime.totalRequests) * 100).toFixed(1) : '0'}%</div>
    <div class="stat-detail">${allTime.totalAcceptances}/${allTime.totalRequests} suggestions</div>
  </div>
</body></html>`;
    }
  }

  private getMinimalHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html><head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; text-align: center; opacity: 0.6; }
</style>
</head><body>
  <p>Start coding with Copilot to see your token consumption.</p>
</body></html>`;
  }
}
