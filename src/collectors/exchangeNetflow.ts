import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('exchange-netflow');

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

interface FearGreedResponse {
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

/**
 * Uses the Crypto Fear & Greed Index (alternative.me) as a proxy for
 * exchange netflow / market sentiment.
 *
 * Contrarian interpretation (consistent with ICT smart money logic):
 * - Extreme Fear  (<25)  → score +2  (smart money accumulating, bullish)
 * - Fear          (25-44) → score +1
 * - Neutral       (45-55) → score  0
 * - Greed         (56-75) → score -1
 * - Extreme Greed (>75)  → score -2  (smart money distributing, bearish)
 *
 * API: https://alternative.me/crypto/fear-and-greed-index/
 * Free, no API key required.
 */
export class ExchangeNetflowCollector {
  async collect(): Promise<CollectorResult[]> {
    let normalized = 0;
    let rawValue = 50; // neutral default
    let source = 'fear-greed-index';

    try {
      const score = await this.fetchFearGreedScore();
      normalized = score.normalized;
      rawValue = score.rawValue;
    } catch (err) {
      log.warn(`Fear & Greed fetch failed — using neutral score: ${(err as Error).message}`);
      source = 'fear-greed-fallback';
    }

    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        log.info(`${asset} fear/greed score: index=${rawValue}, normalized=${normalized}`);

        await insertSignal({
          timestamp: new Date(),
          asset,
          metric: 'exchange_netflow',
          rawValue,
          normalized,
          source,
        });

        results.push({
          success: true,
          asset,
          metric: 'exchange_netflow',
          rawValue,
          timestamp: new Date(),
        });
      } catch (err) {
        log.error(`Failed to record netflow for ${asset}: ${(err as Error).message}`);
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

  private async fetchFearGreedScore(): Promise<{ normalized: number; rawValue: number }> {
    const { data } = await axios.get<FearGreedResponse>(FEAR_GREED_URL, { timeout: 10_000 });

    if (!data.data?.length) {
      throw new Error('Empty response from Fear & Greed API');
    }

    const index = parseInt(data.data[0].value, 10);
    const classification = data.data[0].value_classification;

    log.info(`Fear & Greed Index: ${index} (${classification})`);

    return {
      rawValue: index,
      normalized: this.indexToNormalized(index),
    };
  }

  /**
   * Maps Fear & Greed index (0-100) to -2…+2 sentiment score.
   * Uses contrarian logic: extreme fear = bullish signal (smart money buys fear).
   */
  private indexToNormalized(index: number): number {
    if (index < 25) return 2;   // Extreme Fear  → bullish
    if (index < 45) return 1;   // Fear          → mildly bullish
    if (index <= 55) return 0;  // Neutral
    if (index <= 75) return -1; // Greed         → mildly bearish
    return -2;                  // Extreme Greed → bearish
  }
}

