import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { ASSET_CONFIGS, SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('funding-rate');
const BYBIT_BASE = 'https://api.bybit.com';

interface BybitFundingResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{
      symbol: string;
      fundingRate: string;
      fundingRateTimestamp: string;
    }>;
  };
}

/**
 * Collects funding rate data from Bybit public API v5.
 * Funding rates indicate market sentiment — positive = longs pay shorts (bullish overcrowding).
 */
export class FundingRateCollector {
  /**
   * Fetches the latest funding rate for all supported assets
   */
  async collect(): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchFundingRate(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect funding rate for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'funding_rate',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchFundingRate(asset: Asset): Promise<CollectorResult> {
    const symbol = ASSET_CONFIGS[asset].symbol;
    const url = `${BYBIT_BASE}/v5/market/funding/history`;

    const response = await axios.get<BybitFundingResponse>(url, {
      params: {
        category: 'linear',
        symbol,
        limit: 1,
      },
      timeout: 10000,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.data.retMsg}`);
    }

    const entry = response.data.result.list[0];
    if (!entry) {
      throw new Error(`No funding rate data for ${symbol}`);
    }

    const rawValue = parseFloat(entry.fundingRate);
    const normalized = this.normalizeFundingRate(rawValue);

    log.info(`${asset} funding rate: ${rawValue.toFixed(6)} (normalized: ${normalized.toFixed(2)})`);

    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'funding_rate',
      rawValue,
      normalized,
      source: 'bybit',
    });

    return {
      success: true,
      asset,
      metric: 'funding_rate',
      rawValue,
      timestamp: new Date(),
    };
  }

  /**
   * Normalizes funding rate to -2 to +2 scale.
   * Extreme positive funding (>0.1%) = -2 (bearish — overcrowded longs)
   * Extreme negative funding (<-0.1%) = +2 (bullish — overcrowded shorts)
   * Neutral around 0.01% (normal rate)
   */
  private normalizeFundingRate(rate: number): number {
    const adjusted = -(rate - 0.0001); // Subtract baseline, invert
    const clamped = Math.max(-0.001, Math.min(0.001, adjusted));
    return (clamped / 0.001) * 2;
  }
}
