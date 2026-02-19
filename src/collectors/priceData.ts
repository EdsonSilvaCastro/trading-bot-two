import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertMarketData } from '../database/supabase';
import { ASSET_CONFIGS, SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('price-data');
const BYBIT_BASE = 'https://api.bybit.com';

interface BybitKlineResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<[
      string, // startTime
      string, // openPrice
      string, // highPrice
      string, // lowPrice
      string, // closePrice
      string, // volume
      string, // turnover
    ]>;
  };
}

/**
 * Collects OHLCV price data from Bybit public API v5.
 * Uses 4h candles for trend context and 15m for recent price.
 */
export class PriceDataCollector {
  /**
   * Fetches the latest price and volume data for all supported assets
   */
  async collect(): Promise<CollectorResult[]> {
    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        const result = await this.fetchPriceData(asset);
        results.push(result);
      } catch (err) {
        log.error(`Failed to collect price data for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'price',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchPriceData(asset: Asset): Promise<CollectorResult> {
    const symbol = ASSET_CONFIGS[asset].symbol;
    const url = `${BYBIT_BASE}/v5/market/kline`;

    const response = await axios.get<BybitKlineResponse>(url, {
      params: {
        category: 'linear',
        symbol,
        interval: '240', // 4h candles
        limit: 2,
      },
      timeout: 10000,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.data.retMsg}`);
    }

    const list = response.data.result.list;
    if (!list.length) {
      throw new Error(`No kline data for ${symbol}`);
    }

    const latestCandle = list[0];
    const price = parseFloat(latestCandle[4]); // close price
    const volume = parseFloat(latestCandle[5]);
    const high = parseFloat(latestCandle[2]);
    const low = parseFloat(latestCandle[3]);

    log.info(`${asset} price: $${price.toFixed(2)} | vol: ${volume.toFixed(2)} | H: ${high.toFixed(2)} L: ${low.toFixed(2)}`);

    await insertMarketData({
      timestamp: new Date(),
      asset,
      fundingRate: 0,
      openInterest: 0,
      liquidationsLong: 0,
      liquidationsShort: 0,
      price,
      volume24h: volume,
    });

    return {
      success: true,
      asset,
      metric: 'price',
      rawValue: price,
      timestamp: new Date(),
    };
  }
}
