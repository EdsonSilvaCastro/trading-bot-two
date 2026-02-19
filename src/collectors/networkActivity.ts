import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('network-activity');

/**
 * Collects on-chain network activity metrics (active addresses, tx count, etc.).
 *
 * TODO: Integrate real APIs:
 * - BTC: Glassnode API (active addresses, hash rate)
 * - ETH: Etherscan API (gas usage, active addresses)
 * - SOL: Solscan API (TPS, active wallets)
 *
 * Requires GLASSNODE_API_KEY, ETHERSCAN_API_KEY for real data.
 * For now, returns mock data.
 *
 * Logic: Increasing network activity = bullish (growing usage/demand).
 *        Decreasing network activity = bearish (waning interest).
 */
export class NetworkActivityCollector {
  /**
   * Fetches network activity for all supported assets.
   * Currently returns mock data — replace with real APIs in Phase 2.
   */
  async collect(): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchNetworkActivity(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect network activity for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'network_activity',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchNetworkActivity(asset: Asset): Promise<CollectorResult> {
    // TODO: Replace with real API calls based on asset
    // BTC: https://api.glassnode.com/v1/metrics/addresses/active_count
    // ETH: https://api.etherscan.io/api?module=stats&action=dailytx
    // SOL: https://public-api.solscan.io/chaininfo

    const mockActivityDelta = this.generateMockActivityDelta();
    const normalized = Math.max(-2, Math.min(2, mockActivityDelta));

    log.info(`${asset} network activity (MOCK): delta ${mockActivityDelta.toFixed(2)} (normalized: ${normalized.toFixed(2)})`);

    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'network_activity',
      rawValue: mockActivityDelta,
      normalized,
      source: 'mock',
    });

    return {
      success: true,
      asset,
      metric: 'network_activity',
      rawValue: mockActivityDelta,
      timestamp: new Date(),
    };
  }

  /**
   * Generates a mock network activity delta between -2 and +2.
   */
  private generateMockActivityDelta(): number {
    return (Math.random() - 0.5) * 4;
  }
}
