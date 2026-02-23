import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('exchange-netflow');

/**
 * Collects exchange netflow data (coins moving in/out of exchanges).
 *
 * TODO: Integrate CryptoQuant API for real exchange netflow data.
 * CryptoQuant requires a paid API key. For now, returns mock data.
 *
 * Logic: Negative netflow (coins leaving exchanges) = bullish (accumulation).
 *        Positive netflow (coins entering exchanges) = bearish (potential sell pressure).
 */
export class ExchangeNetflowCollector {
  /**
   * Fetches exchange netflow for all supported assets.
   * Currently returns mock data — replace with CryptoQuant API in Phase 2.
   */
  async collect(): Promise<CollectorResult[]> {
    log.warn('Exchange netflow using SIMULATED data — upgrade to CryptoQuant for real data');
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchNetflow(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect netflow for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'exchange_netflow',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchNetflow(asset: Asset): Promise<CollectorResult> {
    // TODO: Replace with real CryptoQuant API call
    // const url = `https://api.cryptoquant.com/v1/btc/exchange-flows/netflow`;
    // Requires CRYPTOQUANT_API_KEY

    const mockNetflow = this.generateMockNetflow();
    const normalized = this.normalizeNetflow(mockNetflow);

    log.info(`${asset} exchange netflow (MOCK): ${mockNetflow.toFixed(2)} (normalized: ${normalized.toFixed(2)})`);

    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'exchange_netflow',
      rawValue: mockNetflow,
      normalized,
      source: 'mock',
    });

    return {
      success: true,
      asset,
      metric: 'exchange_netflow',
      rawValue: mockNetflow,
      timestamp: new Date(),
    };
  }

  /**
   * Generates mock netflow using a normal distribution (Box-Muller transform)
   * centred at 0 with std dev ~350, clamped to [-1000, +1000].
   * Produces scores clustered near neutral rather than uniformly random.
   */
  private generateMockNetflow(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(-1000, Math.min(1000, z * 350));
  }

  /**
   * Normalizes netflow to -2 to +2 scale.
   * Large outflow (-1000+) = +2 (bullish accumulation)
   * Large inflow (+1000+) = -2 (bearish sell pressure)
   */
  private normalizeNetflow(netflow: number): number {
    const inverted = -netflow; // Invert: outflow is bullish
    const clamped = Math.max(-1000, Math.min(1000, inverted));
    return (clamped / 1000) * 2;
  }
}
