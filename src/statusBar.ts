/**
 * Status bar module.
 * Shows real-time token consumption and estimated cost in the VS Code status bar.
 */

import * as vscode from 'vscode';
import { formatTokenCount, formatCost, formatEnergy, formatCO2, estimateCO2Grams } from './tokenCounter';

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private sessionInputTokens: number = 0;
  private sessionOutputTokens: number = 0;
  private sessionCost: number = 0;
  private sessionEnergyWh: number = 0;
  private format: string = 'tokens-and-cost';

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50
    );
    this.statusBarItem.command = 'eatingtoken.showDashboard';
    this.statusBarItem.tooltip = 'Click to open Eating Token dashboard';
    this.updateDisplay();
    this.statusBarItem.show();
  }

  setFormat(format: string): void {
    this.format = format;
    this.updateDisplay();
  }

  addInputTokens(tokens: number, cost: number, energyWh: number = 0): void {
    this.sessionInputTokens += tokens;
    this.sessionCost += cost;
    this.sessionEnergyWh += energyWh;
    this.updateDisplay();
  }

  addOutputTokens(tokens: number, cost: number, energyWh: number = 0): void {
    this.sessionOutputTokens += tokens;
    this.sessionCost += cost;
    this.sessionEnergyWh += energyWh;
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const totalTokens = this.sessionInputTokens + this.sessionOutputTokens;
    const tokensStr = formatTokenCount(totalTokens);
    const costStr = formatCost(this.sessionCost);
    const energyStr = formatEnergy(this.sessionEnergyWh);

    switch (this.format) {
      case 'tokens-only':
        this.statusBarItem.text = `$(flame) ${tokensStr} tokens`;
        break;
      case 'cost-only':
        this.statusBarItem.text = `$(flame) ${costStr}`;
        break;
      case 'tokens-and-cost':
      default:
        this.statusBarItem.text = `$(flame) ${tokensStr} | ${costStr} | ${energyStr}`;
        break;
    }

    const co2 = estimateCO2Grams(this.sessionEnergyWh);
    this.statusBarItem.tooltip = [
      'Eating Token - Copilot Usage Tracker',
      `Session Input: ${formatTokenCount(this.sessionInputTokens)} tokens`,
      `Session Output: ${formatTokenCount(this.sessionOutputTokens)} tokens`,
      `Estimated Cost: ${costStr}`,
      `Energy: ${energyStr} | CO2: ${formatCO2(co2)}`,
      '',
      'Click to open dashboard',
    ].join('\n');
  }

  resetSession(): void {
    this.sessionInputTokens = 0;
    this.sessionOutputTokens = 0;
    this.sessionCost = 0;
    this.sessionEnergyWh = 0;
    this.updateDisplay();
  }

  getSessionStats() {
    return {
      inputTokens: this.sessionInputTokens,
      outputTokens: this.sessionOutputTokens,
      cost: this.sessionCost,
      energyWh: this.sessionEnergyWh,
    };
  }

  setVisible(visible: boolean): void {
    if (visible) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
