import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { ASSET_CONFIGS, SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('open-interest');
const BYBIT_BASE = 'https://api.bybit.com';

interface BybitOIResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{
      openInterest: string;
      timestamp: string;
    }>;
  };
}

/**
 * Collects open interest data from Bybit public API v5.
 * Rising OI with rising price = trend confirmation.
 * Rising OI with falling price = potential squeeze setup.
 */
export class OpenInterestCollector {
  private previousOI: Map<Asset, number> = new Map();

  /**
   * Fetches the latest open interest for all supported assets
   */
  async collect(): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchOpenInterest(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect OI for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'open_interest',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchOpenInterest(asset: Asset): Promise<CollectorResult> {
    const symbol = ASSET_CONFIGS[asset].symbol;
    const url = `${BYBIT_BASE}/v5/market/open-interest`;

    const response = await axios.get<BybitOIResponse>(url, {
      params: {
        category: 'linear',
        symbol,
        intervalTime: '1h',
        limit: 2,
      },
      timeout: 10000,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.data.retMsg}`);
    }

    const list = response.data.result.list;
    if (!list.length) {
      throw new Error(`No OI data for ${symbol}`);
    }

    const currentOI = parseFloat(list[0].openInterest);
    const prevOI = this.previousOI.get(asset);
    const oiDelta = prevOI ? (currentOI - prevOI) / prevOI : 0;

    this.previousOI.set(asset, currentOI);

    const normalized = this.normalizeOIDelta(oiDelta);
    log.info(`${asset} OI: ${currentOI.toFixed(0)} (delta: ${(oiDelta * 100).toFixed(2)}%, normalized: ${normalized.toFixed(2)})`);

    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'oi_delta',
      rawValue: oiDelta,
      normalized,
      source: 'bybit',
    });

    return {
      success: true,
      asset,
      metric: 'open_interest',
      rawValue: currentOI,
      timestamp: new Date(),
    };
  }

  /**
   * Normalizes OI delta percentage to -2 to +2 scale.
   * Large OI increase (>5%) = +2 (strong conviction entering)
   * Large OI decrease (<-5%) = -2 (positions closing)
   */
  private normalizeOIDelta(delta: number): number {
    const clamped = Math.max(-0.05, Math.min(0.05, delta));
    return (clamped / 0.05) * 2;
  }
}
