/**
 * Eating Token - Copilot Token Consumption Tracker
 *
 * Main extension entry point. Wires together:
 * - CompletionTracker: detects Copilot inline completion requests and acceptances
 * - ChatTracker: detects Chat Apply/Insert/file creation via document changes
 * - CopilotSessionWatcher: reads ACTUAL token counts from ~/.copilot/session-state
 * - CopilotLogWatcher: tracks VS Code Copilot Chat requests from log files
 * - TokenCounter: estimates token counts and costs
 * - UsageStorage: persists daily usage data
 * - StatusBarManager: real-time status bar display
 * - DashboardPanel: detailed usage dashboard
 *
 * Deduplication strategy:
 * Both the CopilotSessionWatcher and CopilotLogWatcher can fire for the same
 * Copilot interaction (e.g., when Copilot Chat uses agent/edit mode). The
 * SessionWatcher has ACTUAL token counts while the LogWatcher has estimates.
 * We prefer actual data: when a session event fires, we suppress any log event
 * that arrives within a time window for the same model.
 */

import * as vscode from 'vscode';
import { CompletionTracker } from './completionTracker';
import { ChatTracker } from './chatTracker';
import { CopilotSessionWatcher } from './copilotSessionWatcher';
import { CopilotLogWatcher } from './copilotLogWatcher';
import { estimateCost, estimateEnergy, resolveModelPricing } from './tokenCounter';
import { UsageStorage } from './usageStorage';
import { StatusBarManager } from './statusBar';
import { DashboardPanel, DashboardViewProvider } from './dashboard';

let completionTracker: CompletionTracker;
let chatTracker: ChatTracker;
let sessionWatcher: CopilotSessionWatcher;
let logWatcher: CopilotLogWatcher;
let usageStorage: UsageStorage;
let statusBar: StatusBarManager;
let dashboardViewProvider: DashboardViewProvider;

// ─── Deduplication between session watcher and log watcher ────────────────────

interface RecentSessionEvent {
  model: string;
  timestamp: number;
}

/**
 * Tracks recent session watcher events to suppress duplicate log watcher events.
 *
 * When a CopilotSessionWatcher event fires (actual token data), we record it.
 * If a CopilotLogWatcher event (estimated tokens) arrives within DEDUP_WINDOW_MS
 * for the same resolved model, we suppress it to avoid double-counting.
 */
class TokenDeduplicator {
  /** Time window in ms to consider events as duplicates */
  private static readonly DEDUP_WINDOW_MS = 10_000; // 10 seconds

  /** Max entries to track */
  private static readonly MAX_ENTRIES = 200;

  /** Recent session events for dedup matching */
  private recentSessionEvents: RecentSessionEvent[] = [];

  /** Count of suppressed log events (for debugging) */
  private suppressedCount = 0;

  /**
   * Record a session watcher event. Call this when CopilotSessionWatcher fires.
   */
  recordSessionEvent(model: string, timestamp: number): void {
    this.recentSessionEvents.push({ model, timestamp });

    // Prune old entries
    const cutoff = Date.now() - TokenDeduplicator.DEDUP_WINDOW_MS * 2;
    this.recentSessionEvents = this.recentSessionEvents.filter(e => e.timestamp > cutoff);

    // Keep bounded
    if (this.recentSessionEvents.length > TokenDeduplicator.MAX_ENTRIES) {
      this.recentSessionEvents = this.recentSessionEvents.slice(-TokenDeduplicator.MAX_ENTRIES / 2);
    }
  }

  /**
   * Check if a log watcher event should be suppressed because a session
   * watcher event already covered this interaction.
   *
   * Returns true if the event should be SUPPRESSED (is a duplicate).
   */
  shouldSuppressLogEvent(model: string, timestamp: number): boolean {
    const resolvedModel = resolveModelPricing(model);
    const now = Date.now();

    for (const sessionEvent of this.recentSessionEvents) {
      const resolvedSessionModel = resolveModelPricing(sessionEvent.model);
      if (resolvedModel !== resolvedSessionModel) { continue; }

      // Check if within the dedup window
      const timeDiff = Math.abs(timestamp - sessionEvent.timestamp);
      // Also check against wall-clock time for events with stale timestamps
      const wallDiff = Math.abs(now - sessionEvent.timestamp);

      if (timeDiff < TokenDeduplicator.DEDUP_WINDOW_MS || wallDiff < TokenDeduplicator.DEDUP_WINDOW_MS) {
        this.suppressedCount++;
        return true;
      }
    }

    return false;
  }

  getSuppressedCount(): number {
    return this.suppressedCount;
  }
}

let deduplicator: TokenDeduplicator;

/**
 * Check if an event timestamp is recent (i.e., from the current VS Code session,
 * not a historical import from past session files).
 * We consider events within the last 5 minutes as "live" — they should update the
 * status bar. Older events are historical and should only go to storage.
 */
function isLiveEvent(timestamp: number): boolean {
  const LIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  return (Date.now() - timestamp) < LIVE_WINDOW_MS;
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('eatingtoken');

  // Check if Copilot is installed (check both extension IDs)
  const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
  const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
  const hasCopilot = copilotExtension || copilotChatExtension;

  if (!hasCopilot) {
    console.log(
      'Eating Token: GitHub Copilot extension not detected. ' +
      'Use the "Run Extension (with Copilot)" launch config to load all installed extensions. ' +
      'The tracker will still work for any code edits.'
    );
  }

  // Initialize modules
  const contextMultiplier = config.get<number>('contextMultiplier', 1.3);
  const costModel = config.get<string>('costModel', 'gpt-4o');
  const yearlyTarget = config.get<number>('yearlyTarget', 250000);
  const showInStatusBar = config.get<boolean>('showInStatusBar', true);
  const statusBarFormat = config.get<string>('statusBarFormat', 'tokens-and-cost');

  // Deduplicator to prevent double-counting between session and log watchers
  deduplicator = new TokenDeduplicator();

  // Storage
  usageStorage = new UsageStorage(context.globalState);

  // Status bar
  statusBar = new StatusBarManager();
  statusBar.setFormat(statusBarFormat);
  statusBar.setVisible(showInStatusBar);
  context.subscriptions.push(statusBar);

  // Sidebar dashboard
  dashboardViewProvider = new DashboardViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewType,
      dashboardViewProvider
    )
  );

  // Helper to refresh the sidebar dashboard
  const refreshDashboard = () => {
    const summary = usageStorage.getSummary();
    dashboardViewProvider.update(summary, yearlyTarget);
  };

  // ─── 1. Completion tracker (inline ghost text) ──────────────────────────────

  completionTracker = new CompletionTracker(contextMultiplier);

  completionTracker.onCompletionEvent(async (event) => {
    if (event.type === 'request') {
      const cost = estimateCost(event.inputTokens, 0, costModel);
      const energy = estimateEnergy(event.inputTokens, 0, costModel);
      statusBar.addInputTokens(event.inputTokens, cost.totalCost, energy.totalWh);
      await usageStorage.recordRequest(event.language, event.inputTokens, cost.totalCost);
    } else if (event.type === 'acceptance') {
      const cost = estimateCost(0, event.outputTokens, costModel);
      const energy = estimateEnergy(0, event.outputTokens, costModel);
      statusBar.addOutputTokens(event.outputTokens, cost.totalCost, energy.totalWh);
      await usageStorage.recordAcceptance(event.language, event.outputTokens, cost.totalCost);
    }
    refreshDashboard();
  });

  completionTracker.activate(context);
  context.subscriptions.push(completionTracker);

  // ─── 2. Chat tracker (Apply/Insert/file creation heuristics) ────────────────

  chatTracker = new ChatTracker(contextMultiplier * 1.5);
  chatTracker.onChatEvent(async (event) => {
    const inputCost = estimateCost(event.estimatedInputTokens, 0, costModel);
    const outputCost = estimateCost(0, event.estimatedOutputTokens, costModel);
    const inputEnergy = estimateEnergy(event.estimatedInputTokens, 0, costModel);
    const outputEnergy = estimateEnergy(0, event.estimatedOutputTokens, costModel);

    statusBar.addInputTokens(event.estimatedInputTokens, inputCost.totalCost, inputEnergy.totalWh);
    statusBar.addOutputTokens(event.estimatedOutputTokens, outputCost.totalCost, outputEnergy.totalWh);

    await usageStorage.recordRequest(event.language, event.estimatedInputTokens, inputCost.totalCost);
    await usageStorage.recordAcceptance(event.language, event.estimatedOutputTokens, outputCost.totalCost);

    const fileCount = event.files.length;
    const typeLabel = event.type === 'chat-file-create' ? 'Chat file creation' :
                      event.type === 'chat-bulk-edit' ? `Chat bulk edit (${fileCount} files)` :
                      'Chat edit';
    console.log(`Eating Token: ${typeLabel} detected - ~${event.estimatedOutputTokens} output tokens, ${event.linesChanged} lines`);
    refreshDashboard();
  });
  chatTracker.activate(context);
  context.subscriptions.push(chatTracker);

  // ─── 3. Copilot Session Watcher (ACTUAL token counts from events.jsonl) ─────

  sessionWatcher = new CopilotSessionWatcher();
  sessionWatcher.onTokenEvent(async (event) => {
    // Use the actual model from the session data for pricing
    const pricingModel = event.model ? resolveModelPricing(event.model) : costModel;
    const isLive = isLiveEvent(event.timestamp);

    // Record this event for deduplication (so we suppress duplicate log watcher events)
    deduplicator.recordSessionEvent(pricingModel, event.timestamp);

    if (event.type === 'message') {
      // Per-message events only have outputTokens
      const cost = estimateCost(0, event.outputTokens, pricingModel);
      const energy = estimateEnergy(0, event.outputTokens, pricingModel);

      // Only update status bar for live events, not historical imports
      if (isLive) {
        statusBar.addOutputTokens(event.outputTokens, cost.totalCost, energy.totalWh);
      }

      // Always record to storage with correct date and model
      await usageStorage.recordAcceptance('copilot-agent', event.outputTokens, cost.totalCost, event.timestamp, pricingModel);
      console.log(`Eating Token: [session] message - ${event.outputTokens} output tokens (${pricingModel})${isLive ? '' : ' [historical]'}`);
    } else if (event.type === 'session-summary') {
      // Session summaries have full token breakdown
      const inputCost = estimateCost(event.inputTokens, 0, pricingModel);
      const outputCost = estimateCost(0, event.outputTokens, pricingModel);
      const inputEnergy = estimateEnergy(event.inputTokens, 0, pricingModel);
      const outputEnergy = estimateEnergy(0, event.outputTokens, pricingModel);

      if (isLive) {
        statusBar.addInputTokens(event.inputTokens, inputCost.totalCost, inputEnergy.totalWh);
        statusBar.addOutputTokens(event.outputTokens, outputCost.totalCost, outputEnergy.totalWh);
      }

      await usageStorage.recordRequest('copilot-agent', event.inputTokens, inputCost.totalCost, event.timestamp, pricingModel);
      await usageStorage.recordAcceptance('copilot-agent', event.outputTokens, outputCost.totalCost, event.timestamp, pricingModel);

      console.log(
        `Eating Token: [session] summary (${pricingModel}) - ` +
        `${event.inputTokens} input, ${event.outputTokens} output, ` +
        `${event.cacheReadTokens} cached, ${event.premiumRequests} premium requests` +
        `${isLive ? '' : ' [historical]'}`
      );
    }
    refreshDashboard();
  });
  sessionWatcher.activate(context);
  context.subscriptions.push(sessionWatcher);

  // ─── 4. Copilot Log Watcher (VS Code Chat log ccreq lines) ─────────────────

  logWatcher = new CopilotLogWatcher();
  logWatcher.onLogEvent(async (event) => {
    // Check deduplication: suppress if session watcher already has actual data
    if (deduplicator.shouldSuppressLogEvent(event.entry.model, event.timestamp)) {
      console.log(
        `Eating Token: [log] suppressed duplicate - ${event.entry.model} | ` +
        `${event.entry.durationMs}ms | [${event.entry.context}] ` +
        `(session watcher has actual data, total suppressed: ${deduplicator.getSuppressedCount()})`
      );
      return;
    }

    const isLive = isLiveEvent(event.timestamp);

    // Use the model from the log entry for pricing
    const pricingModel = resolveModelPricing(event.entry.model);
    const inputCost = estimateCost(event.estimatedInputTokens, 0, pricingModel);
    const outputCost = estimateCost(0, event.estimatedOutputTokens, pricingModel);
    const inputEnergy = estimateEnergy(event.estimatedInputTokens, 0, pricingModel);
    const outputEnergy = estimateEnergy(0, event.estimatedOutputTokens, pricingModel);

    if (isLive) {
      statusBar.addInputTokens(event.estimatedInputTokens, inputCost.totalCost, inputEnergy.totalWh);
      statusBar.addOutputTokens(event.estimatedOutputTokens, outputCost.totalCost, outputEnergy.totalWh);
    }

    await usageStorage.recordRequest('copilot-chat', event.estimatedInputTokens, inputCost.totalCost, event.timestamp, pricingModel);
    await usageStorage.recordAcceptance('copilot-chat', event.estimatedOutputTokens, outputCost.totalCost, event.timestamp, pricingModel);

    console.log(
      `Eating Token: [log] request - ${event.entry.model} | ` +
      `${event.entry.durationMs}ms | ~${event.estimatedOutputTokens} output tokens | [${event.entry.context}]` +
      `${isLive ? '' : ' [historical]'}`
    );
    refreshDashboard();
  });
  logWatcher.activate(context);
  context.subscriptions.push(logWatcher);

  // ─── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('eatingtoken.showDashboard', () => {
      const summary = usageStorage.getSummary();
      const panel = DashboardPanel.createOrShow(context.extensionUri);
      panel.update(summary, yearlyTarget);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('eatingtoken.resetSession', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Reset session stats? This only resets the status bar counter, not historical data.',
        'Reset Session',
        'Reset All Data',
        'Cancel'
      );

      if (answer === 'Reset Session') {
        statusBar.resetSession();
        completionTracker.resetStats();
        chatTracker.resetStats();
        vscode.window.showInformationMessage('Session stats reset.');
      } else if (answer === 'Reset All Data') {
        const confirm = await vscode.window.showWarningMessage(
          'This will permanently delete ALL historical usage data. Are you sure?',
          'Delete All',
          'Cancel'
        );
        if (confirm === 'Delete All') {
          await usageStorage.resetAll();
          statusBar.resetSession();
          completionTracker.resetStats();
          chatTracker.resetStats();
          vscode.window.showInformationMessage('All usage data cleared.');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('eatingtoken.exportData', async () => {
      const json = usageStorage.exportAsJson();
      const doc = await vscode.workspace.openTextDocument({
        content: json,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('Usage data exported. Save the file to keep it.');
    })
  );

  // ─── Configuration change watcher ───────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('eatingtoken')) {
        const newConfig = vscode.workspace.getConfiguration('eatingtoken');
        statusBar.setFormat(newConfig.get<string>('statusBarFormat', 'tokens-and-cost'));
        statusBar.setVisible(newConfig.get<boolean>('showInStatusBar', true));
        completionTracker.updateContextMultiplier(
          newConfig.get<number>('contextMultiplier', 1.3)
        );
      }
    })
  );

  // Initial sidebar update
  refreshDashboard();

  console.log('Eating Token extension activated - tracking Copilot token consumption');
  console.log('  - Inline completion tracker: active');
  console.log('  - Chat edit tracker: active');
  console.log('  - Copilot session watcher: active (actual tokens from events.jsonl)');
  console.log('  - Copilot log watcher: active (estimated tokens from chat logs)');
  console.log('  - Deduplication: session watcher events suppress overlapping log watcher events');
}

export function deactivate() {
  console.log('Eating Token extension deactivated');
}
