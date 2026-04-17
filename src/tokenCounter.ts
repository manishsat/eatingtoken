/**
 * Token counter module using gpt-tokenizer.
 * Estimates token counts for text using the o200k_base encoding (GPT-4o/4.1/5.x).
 * Also provides energy consumption estimates per model.
 */

import { countTokens as gptCountTokens } from 'gpt-tokenizer/model/gpt-4o';

/** Pricing per 1M tokens in USD */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Energy consumption per token in Watt-hours (Wh).
 *
 * Estimates based on:
 * - Luccioni et al. (2023) "Power Hungry Processing" - systematic inference energy measurements
 * - H100 GPU power draw (~700W TDP) at measured throughput rates per model class
 * - Data center PUE (Power Usage Effectiveness) of 1.2 (industry average for hyperscalers)
 * - Includes server overhead (CPU, memory, networking) estimated at 30% of GPU power
 *
 * Input tokens (prefill) are cheaper than output tokens (autoregressive decode).
 * Larger models consume more energy per token due to more parameters and FLOPs.
 */
export interface ModelEnergy {
  /** Wh per input token (prefill is parallelized, so cheaper) */
  inputWhPerToken: number;
  /** Wh per output token (decode is sequential, so more expensive) */
  outputWhPerToken: number;
}

/** Available cost models and their pricing */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4.1': { inputPerMillion: 2.00, outputPerMillion: 8.00 },
  'gpt-4': { inputPerMillion: 30.00, outputPerMillion: 60.00 },
  'claude-opus-4.6': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-sonnet-4': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet-3.5': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
};

/**
 * Energy estimates per model (Wh per token).
 *
 * Derivation example for GPT-4o class (~200B MoE, ~80 tok/s output on H100):
 *   GPU power: 700W, throughput: ~80 tok/s output
 *   GPU Wh/token: 700 / (80 * 3600) = 0.00243 Wh
 *   + 30% server overhead: 0.00243 * 1.3 = 0.00316 Wh
 *   + PUE 1.2: 0.00316 * 1.2 = 0.00379 Wh ≈ 0.0038 Wh/output token
 *   Input (prefill ~10x faster): ~0.00038 Wh/input token
 *
 * Smaller models (gpt-4o-mini ~8B) are ~10x more efficient.
 * Larger models (claude-opus, gpt-4 dense ~1.8T) are ~2-3x less efficient.
 */
export const MODEL_ENERGY: Record<string, ModelEnergy> = {
  'gpt-4o':           { inputWhPerToken: 0.00038,  outputWhPerToken: 0.0038 },
  'gpt-4o-mini':      { inputWhPerToken: 0.000040, outputWhPerToken: 0.00040 },
  'gpt-4.1':          { inputWhPerToken: 0.00035,  outputWhPerToken: 0.0035 },
  'gpt-4':            { inputWhPerToken: 0.0010,   outputWhPerToken: 0.010 },
  'claude-opus-4.6':  { inputWhPerToken: 0.00080,  outputWhPerToken: 0.0080 },
  'claude-sonnet-4':  { inputWhPerToken: 0.00038,  outputWhPerToken: 0.0038 },
  'claude-sonnet-3.5':{ inputWhPerToken: 0.00038,  outputWhPerToken: 0.0038 },
};

/** Average US grid carbon intensity: kg CO2 per kWh (EPA eGRID 2023) */
export const GRID_CARBON_INTENSITY_KG_PER_KWH = 0.39;

/** Default energy estimate for unknown models (similar to gpt-4o) */
const DEFAULT_ENERGY: ModelEnergy = { inputWhPerToken: 0.00038, outputWhPerToken: 0.0038 };

/**
 * Resolve a model name from logs to a pricing key.
 * Log model names can vary (e.g., "claude-opus-4.6", "claude-opus-4-6", "gpt-4o-mini-2024-07-18").
 */
export function resolveModelPricing(modelName: string): string {
  const lower = modelName.toLowerCase();

  // Direct match
  if (MODEL_PRICING[modelName]) { return modelName; }

  // Fuzzy matching
  if (lower.includes('claude') && lower.includes('opus')) { return 'claude-opus-4.6'; }
  if (lower.includes('claude') && lower.includes('sonnet') && lower.includes('4')) { return 'claude-sonnet-4'; }
  if (lower.includes('claude') && lower.includes('sonnet')) { return 'claude-sonnet-3.5'; }
  if (lower.includes('gpt-4o-mini')) { return 'gpt-4o-mini'; }
  if (lower.includes('gpt-4o')) { return 'gpt-4o'; }
  if (lower.includes('gpt-4.1')) { return 'gpt-4.1'; }
  if (lower.includes('gpt-4')) { return 'gpt-4'; }

  // Default
  return 'gpt-4o';
}

/**
 * Count tokens in a text string using the o200k_base encoding.
 * This is the encoding used by GPT-4o, GPT-4.1, and GPT-5.x models.
 */
export function countTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  try {
    return gptCountTokens(text);
  } catch {
    // Fallback: ~4 chars per token heuristic
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimate the cost of tokens at API rates.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string = 'gpt-4o'
): { inputCost: number; outputCost: number; totalCost: number } {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o'];
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Format a token count for display (e.g., 1234 -> "1.2K", 1234567 -> "1.2M")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a cost for display (e.g., 0.0023 -> "$0.002", 1.50 -> "$1.50")
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

// ─── Energy Estimation ────────────────────────────────────────────────────────

/**
 * Estimate energy consumption for a given number of tokens.
 * Returns energy in Watt-hours (Wh).
 */
export function estimateEnergy(
  inputTokens: number,
  outputTokens: number,
  model: string = 'gpt-4o'
): { inputWh: number; outputWh: number; totalWh: number } {
  const energy = MODEL_ENERGY[model] || DEFAULT_ENERGY;
  const inputWh = inputTokens * energy.inputWhPerToken;
  const outputWh = outputTokens * energy.outputWhPerToken;
  return {
    inputWh,
    outputWh,
    totalWh: inputWh + outputWh,
  };
}

/**
 * Convert Wh to kWh.
 */
export function whToKwh(wh: number): number {
  return wh / 1000;
}

/**
 * Estimate CO2 emissions in grams from energy consumption.
 * Uses US grid average carbon intensity.
 */
export function estimateCO2Grams(wh: number): number {
  const kWh = whToKwh(wh);
  return kWh * GRID_CARBON_INTENSITY_KG_PER_KWH * 1000; // kg to grams
}

/**
 * Get real-world energy comparisons for a given Wh amount.
 * Returns an array of comparison strings.
 */
export function getEnergyComparisons(wh: number): { label: string; value: string; icon: string }[] {
  const kWh = whToKwh(wh);
  const comparisons: { label: string; value: string; icon: string }[] = [];

  // Phone charge: ~12 Wh (smartphone battery ~4000mAh @ 3.7V ≈ 15Wh, ~80% efficiency)
  const phoneCharges = wh / 12;
  comparisons.push({
    label: 'Phone Charges',
    value: phoneCharges < 0.01 ? phoneCharges.toExponential(1) : phoneCharges < 1 ? phoneCharges.toFixed(2) : phoneCharges.toFixed(1),
    icon: 'phone',
  });

  // LED bulb hours: 10W LED bulb = 0.01 kWh per hour
  const ledHours = kWh / 0.01;
  comparisons.push({
    label: 'LED Bulb Hours',
    value: ledHours < 0.01 ? ledHours.toExponential(1) : ledHours < 1 ? ledHours.toFixed(2) : ledHours.toFixed(1),
    icon: 'lightbulb',
  });

  // Google searches: ~0.3 Wh per search (Alphabet environmental report)
  const googleSearches = wh / 0.3;
  comparisons.push({
    label: 'Google Searches',
    value: googleSearches < 1 ? googleSearches.toFixed(2) : googleSearches < 100 ? googleSearches.toFixed(1) : Math.round(googleSearches).toLocaleString(),
    icon: 'search',
  });

  // EV miles: ~300 Wh per mile (average EV efficiency)
  const evMiles = wh / 300;
  comparisons.push({
    label: 'EV Miles',
    value: evMiles < 0.001 ? evMiles.toExponential(1) : evMiles < 1 ? evMiles.toFixed(3) : evMiles.toFixed(2),
    icon: 'dashboard',
  });

  return comparisons;
}

/**
 * Format energy for display.
 * Uses Wh for small values, kWh for larger ones.
 */
export function formatEnergy(wh: number): string {
  if (wh < 0.001) {
    return `${(wh * 1000).toFixed(2)} mWh`;
  }
  if (wh < 1) {
    return `${wh.toFixed(3)} Wh`;
  }
  if (wh < 1000) {
    return `${wh.toFixed(2)} Wh`;
  }
  return `${(wh / 1000).toFixed(3)} kWh`;
}

/**
 * Format CO2 for display.
 * Uses grams for small values, kg for larger ones.
 */
export function formatCO2(grams: number): string {
  if (grams < 0.01) {
    return `${(grams * 1000).toFixed(1)} mg`;
  }
  if (grams < 1) {
    return `${grams.toFixed(2)} g`;
  }
  if (grams < 1000) {
    return `${grams.toFixed(1)} g`;
  }
  return `${(grams / 1000).toFixed(2)} kg`;
}
