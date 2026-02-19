import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('whale-tracker');

/**
 * Tracks large whale transactions on-chain.
 *
 * TODO: Integrate Whale Alert API for real whale transaction data.
 * Whale Alert has a limited free tier. For now, returns mock data.
 *
 * Logic: Large transfers TO exchanges = bearish (potential dump).
 *        Large transfers FROM exchanges = bullish (accumulation).
 */
export class WhaleTrackerCollector {
  /**
   * Fetches whale activity for all supported assets.
   * Currently returns mock data — replace with Whale Alert API in Phase 2.
   */
  async collect(): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchWhaleActivity(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect whale activity for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'whale_activity',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchWhaleActivity(asset: Asset): Promise<CollectorResult> {
    // TODO: Replace with real Whale Alert API call
    // const url = `https://api.whale-alert.io/v1/transactions`;
    // Requires WHALE_ALERT_API_KEY

    const mockScore = this.generateMockWhaleScore();
    const normalized = Math.max(-2, Math.min(2, mockScore));

    log.info(`${asset} whale activity (MOCK): score ${mockScore.toFixed(2)} (normalized: ${normalized.toFixed(2)})`);

    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'whale_activity',
      rawValue: mockScore,
      normalized,
      source: 'mock',
    });

    return {
      success: true,
      asset,
      metric: 'whale_activity',
      rawValue: mockScore,
      timestamp: new Date(),
    };
  }

  /**
   * Generates a mock whale sentiment score between -2 and +2.
   */
  private generateMockWhaleScore(): number {
    return (Math.random() - 0.5) * 4;
  }
}
