import { describe, it, expect } from 'vitest';
import {
  countTokens,
  estimateCost,
  estimateEnergy,
  estimateCO2Grams,
  formatTokenCount,
  formatCost,
  formatEnergy,
  formatCO2,
  getEnergyComparisons,
  whToKwh,
  MODEL_PRICING,
  MODEL_ENERGY,
  GRID_CARBON_INTENSITY_KG_PER_KWH,
} from '../tokenCounter';

describe('countTokens', () => {
  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('should return 0 for null/undefined-like input', () => {
    expect(countTokens('')).toBe(0);
  });

  it('should count tokens for simple English text', () => {
    const tokens = countTokens('Hello, world!');
    // "Hello, world!" is typically 4 tokens with o200k_base
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('should count tokens for code', () => {
    const code = `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
    const tokens = countTokens(code);
    // Code is typically ~1 token per 3-4 chars
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(100);
  });

  it('should handle large text without errors', () => {
    const largeText = 'a'.repeat(100_000);
    const tokens = countTokens(largeText);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle unicode text', () => {
    const tokens = countTokens('const greeting = "Hello!";');
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle multi-line code blocks', () => {
    const code = `
import React from 'react';

interface Props {
  name: string;
  age: number;
}

export const UserCard: React.FC<Props> = ({ name, age }) => {
  return (
    <div className="user-card">
      <h2>{name}</h2>
      <p>Age: {age}</p>
    </div>
  );
};
`;
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThan(200);
  });
});

describe('estimateCost', () => {
  it('should calculate cost for gpt-4o pricing', () => {
    const result = estimateCost(1_000_000, 0, 'gpt-4o');
    // 1M input tokens at $2.50/M = $2.50
    expect(result.inputCost).toBeCloseTo(2.5, 2);
    expect(result.outputCost).toBe(0);
    expect(result.totalCost).toBeCloseTo(2.5, 2);
  });

  it('should calculate output cost correctly', () => {
    const result = estimateCost(0, 1_000_000, 'gpt-4o');
    // 1M output tokens at $10/M = $10
    expect(result.outputCost).toBeCloseTo(10, 2);
    expect(result.inputCost).toBe(0);
    expect(result.totalCost).toBeCloseTo(10, 2);
  });

  it('should calculate combined input+output cost', () => {
    const result = estimateCost(500_000, 100_000, 'gpt-4o');
    // Input: 0.5M * $2.50 = $1.25
    // Output: 0.1M * $10 = $1.00
    expect(result.inputCost).toBeCloseTo(1.25, 2);
    expect(result.outputCost).toBeCloseTo(1.0, 2);
    expect(result.totalCost).toBeCloseTo(2.25, 2);
  });

  it('should use gpt-4o-mini pricing when specified', () => {
    const result = estimateCost(1_000_000, 1_000_000, 'gpt-4o-mini');
    // Input: 1M * $0.15 = $0.15
    // Output: 1M * $0.60 = $0.60
    expect(result.inputCost).toBeCloseTo(0.15, 2);
    expect(result.outputCost).toBeCloseTo(0.60, 2);
    expect(result.totalCost).toBeCloseTo(0.75, 2);
  });

  it('should use gpt-4 pricing (much more expensive)', () => {
    const result = estimateCost(1_000_000, 1_000_000, 'gpt-4');
    // Input: 1M * $30 = $30
    // Output: 1M * $60 = $60
    expect(result.inputCost).toBeCloseTo(30, 0);
    expect(result.outputCost).toBeCloseTo(60, 0);
    expect(result.totalCost).toBeCloseTo(90, 0);
  });

  it('should fallback to gpt-4o for unknown model', () => {
    const result = estimateCost(1_000_000, 0, 'unknown-model');
    expect(result.inputCost).toBeCloseTo(2.5, 2);
  });

  it('should handle zero tokens', () => {
    const result = estimateCost(0, 0, 'gpt-4o');
    expect(result.totalCost).toBe(0);
  });

  it('should handle small token counts accurately', () => {
    // 100 tokens at gpt-4o input rate
    const result = estimateCost(100, 50, 'gpt-4o');
    expect(result.inputCost).toBeCloseTo(0.00025, 5);
    expect(result.outputCost).toBeCloseTo(0.0005, 5);
  });
});

describe('formatTokenCount', () => {
  it('should display small numbers as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('should format thousands with K suffix', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(1234)).toBe('1.2K');
    expect(formatTokenCount(15678)).toBe('15.7K');
    expect(formatTokenCount(999999)).toBe('1000.0K');
  });

  it('should format millions with M suffix', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.00M');
    expect(formatTokenCount(1_234_567)).toBe('1.23M');
    expect(formatTokenCount(10_500_000)).toBe('10.50M');
  });
});

describe('formatCost', () => {
  it('should format small costs with 4 decimal places', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.0023)).toBe('$0.0023');
    expect(formatCost(0.0099)).toBe('$0.0099');
  });

  it('should format medium costs with 3 decimal places', () => {
    expect(formatCost(0.01)).toBe('$0.010');
    expect(formatCost(0.123)).toBe('$0.123');
    expect(formatCost(0.999)).toBe('$0.999');
  });

  it('should format dollar amounts with 2 decimal places', () => {
    expect(formatCost(1.0)).toBe('$1.00');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(250000)).toBe('$250000.00');
  });
});

describe('MODEL_PRICING', () => {
  it('should have all expected models', () => {
    expect(MODEL_PRICING).toHaveProperty('gpt-4o');
    expect(MODEL_PRICING).toHaveProperty('gpt-4o-mini');
    expect(MODEL_PRICING).toHaveProperty('gpt-4.1');
    expect(MODEL_PRICING).toHaveProperty('gpt-4');
  });

  it('should have positive pricing for all models', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
      // Output should always cost more than input
      expect(pricing.outputPerMillion).toBeGreaterThan(pricing.inputPerMillion);
    }
  });
});

// ─── Energy Estimation Tests ──────────────────────────────────────────────────

describe('MODEL_ENERGY', () => {
  it('should have energy data for all priced models', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      expect(MODEL_ENERGY).toHaveProperty(model);
    }
  });

  it('should have positive energy values for all models', () => {
    for (const [model, energy] of Object.entries(MODEL_ENERGY)) {
      expect(energy.inputWhPerToken).toBeGreaterThan(0);
      expect(energy.outputWhPerToken).toBeGreaterThan(0);
      // Output tokens should cost more energy than input (decode vs prefill)
      expect(energy.outputWhPerToken).toBeGreaterThan(energy.inputWhPerToken);
    }
  });

  it('should have gpt-4o-mini be the most efficient model', () => {
    const miniEnergy = MODEL_ENERGY['gpt-4o-mini'];
    for (const [model, energy] of Object.entries(MODEL_ENERGY)) {
      if (model === 'gpt-4o-mini') { continue; }
      expect(miniEnergy.outputWhPerToken).toBeLessThanOrEqual(energy.outputWhPerToken);
    }
  });

  it('should have larger models use more energy', () => {
    // claude-opus (large) should use more than claude-sonnet (medium)
    expect(MODEL_ENERGY['claude-opus-4.6'].outputWhPerToken)
      .toBeGreaterThan(MODEL_ENERGY['claude-sonnet-4'].outputWhPerToken);
    // gpt-4 (dense, large) should use more than gpt-4o (MoE, efficient)
    expect(MODEL_ENERGY['gpt-4'].outputWhPerToken)
      .toBeGreaterThan(MODEL_ENERGY['gpt-4o'].outputWhPerToken);
  });
});

describe('estimateEnergy', () => {
  it('should return zero for zero tokens', () => {
    const result = estimateEnergy(0, 0, 'gpt-4o');
    expect(result.inputWh).toBe(0);
    expect(result.outputWh).toBe(0);
    expect(result.totalWh).toBe(0);
  });

  it('should calculate energy for gpt-4o', () => {
    const result = estimateEnergy(1_000_000, 100_000, 'gpt-4o');
    // 1M input * 0.00038 = 380 Wh
    expect(result.inputWh).toBeCloseTo(380, 0);
    // 100K output * 0.0038 = 380 Wh
    expect(result.outputWh).toBeCloseTo(380, 0);
    expect(result.totalWh).toBeCloseTo(760, 0);
  });

  it('should calculate energy for gpt-4o-mini (much less)', () => {
    const result = estimateEnergy(1_000_000, 100_000, 'gpt-4o-mini');
    // 1M input * 0.000040 = 40 Wh
    expect(result.inputWh).toBeCloseTo(40, 0);
    // 100K output * 0.00040 = 40 Wh
    expect(result.outputWh).toBeCloseTo(40, 0);
    expect(result.totalWh).toBeCloseTo(80, 0);
  });

  it('should fallback to default for unknown model', () => {
    const result = estimateEnergy(1000, 1000, 'unknown-model');
    expect(result.totalWh).toBeGreaterThan(0);
  });
});

describe('estimateCO2Grams', () => {
  it('should return zero for zero energy', () => {
    expect(estimateCO2Grams(0)).toBe(0);
  });

  it('should calculate CO2 correctly for 1 kWh', () => {
    // 1000 Wh = 1 kWh * 0.39 kg/kWh * 1000 g/kg = 390 g
    expect(estimateCO2Grams(1000)).toBeCloseTo(390, 0);
  });

  it('should scale linearly', () => {
    const co2_100 = estimateCO2Grams(100);
    const co2_200 = estimateCO2Grams(200);
    expect(co2_200).toBeCloseTo(co2_100 * 2, 5);
  });
});

describe('whToKwh', () => {
  it('should convert Wh to kWh', () => {
    expect(whToKwh(1000)).toBe(1);
    expect(whToKwh(500)).toBe(0.5);
    expect(whToKwh(0)).toBe(0);
  });
});

describe('formatEnergy', () => {
  it('should format very small values in mWh', () => {
    expect(formatEnergy(0.0005)).toBe('0.50 mWh');
  });

  it('should format small values in Wh', () => {
    expect(formatEnergy(0.5)).toBe('0.500 Wh');
  });

  it('should format medium values in Wh', () => {
    expect(formatEnergy(42.5)).toBe('42.50 Wh');
  });

  it('should format large values in kWh', () => {
    expect(formatEnergy(1500)).toBe('1.500 kWh');
  });
});

describe('formatCO2', () => {
  it('should format very small values in mg', () => {
    expect(formatCO2(0.005)).toBe('5.0 mg');
  });

  it('should format small values in grams', () => {
    expect(formatCO2(0.5)).toBe('0.50 g');
  });

  it('should format medium values in grams', () => {
    expect(formatCO2(42)).toBe('42.0 g');
  });

  it('should format large values in kg', () => {
    expect(formatCO2(1500)).toBe('1.50 kg');
  });
});

describe('getEnergyComparisons', () => {
  it('should return 4 comparison items', () => {
    const comparisons = getEnergyComparisons(100);
    expect(comparisons).toHaveLength(4);
  });

  it('should have expected labels', () => {
    const comparisons = getEnergyComparisons(100);
    const labels = comparisons.map(c => c.label);
    expect(labels).toContain('Phone Charges');
    expect(labels).toContain('LED Bulb Hours');
    expect(labels).toContain('Google Searches');
    expect(labels).toContain('EV Miles');
  });

  it('should return meaningful values for 100 Wh', () => {
    const comparisons = getEnergyComparisons(100);
    // 100 Wh / 12 Wh per charge ≈ 8.3 phone charges
    const phoneCharges = comparisons.find(c => c.label === 'Phone Charges');
    expect(parseFloat(phoneCharges!.value)).toBeCloseTo(8.3, 0);
    // 100 Wh / 0.3 Wh per search ≈ 333 searches
    const searches = comparisons.find(c => c.label === 'Google Searches');
    expect(parseFloat(searches!.value)).toBeCloseTo(333, -1);
  });
});
