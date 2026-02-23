import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('whale-tracker');

// USDT ERC-20 contract on Ethereum
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// $1M USDT threshold (USDT has 6 decimals → 1M * 10^6)
const MIN_TRANSFER_RAW = 1_000_000_000_000n; // 1e12

const TWENTY_FOUR_HOURS_S = 24 * 60 * 60;

// Known exchange hot wallet addresses (Ethereum mainnet)
const EXCHANGE_ADDRESSES: Record<string, string[]> = {
  binance: [
    '0x28C6c06298d514Db089934071355E5743bf21d60',
    '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549',
  ],
  coinbase: [
    '0x71660c4005BA85c37ccec55d0C4493E66Fe775d3',
  ],
  kraken: [
    '0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2',
  ],
  bybit: [
    '0xf89d7b9c864f589bbF53a82105107622B35EaA40',
  ],
};

interface TokenTx {
  from: string;
  to: string;
  value: string;
  timeStamp: string;
}

/**
 * Tracks large whale flows by monitoring USDT ERC-20 transfers (>$1M)
 * to/from known exchange hot wallets via Etherscan.
 *
 * Large deposits → exchanges = bearish (selling intent).
 * Large withdrawals ← exchanges = bullish (accumulation).
 *
 * The same score is applied to all 3 assets since stablecoin flows
 * reflect overall market sentiment, not a single asset.
 */
export class WhaleTrackerCollector {
  async collect(): Promise<CollectorResult[]> {
    // Fetch once; apply shared score to all assets
    let normalized = 0;
    let rawValue = 0.5; // withdrawal ratio; 0.5 = neutral

    try {
      const score = await this.fetchWhaleScore();
      normalized = score.normalized;
      rawValue = score.rawValue;
    } catch (err) {
      log.warn(`Whale score fetch failed — using neutral: ${(err as Error).message}`);
    }

    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        log.info(`${asset} whale activity: withdrawalRatio=${rawValue.toFixed(2)}, score=${normalized}`);
        await insertSignal({
          timestamp: new Date(),
          asset,
          metric: 'whale_activity',
          rawValue,
          normalized,
          source: process.env.ETHERSCAN_API_KEY ? 'etherscan' : 'mock',
        });
        results.push({ success: true, asset, metric: 'whale_activity', rawValue, timestamp: new Date() });
      } catch (err) {
        log.error(`Failed to record whale activity for ${asset}: ${(err as Error).message}`);
        results.push({ success: false, asset, metric: 'whale_activity', rawValue: 0, timestamp: new Date() });
      }
    }

    return results;
  }

  private async fetchWhaleScore(): Promise<{ normalized: number; rawValue: number }> {
    const etherscanKey = process.env.ETHERSCAN_API_KEY;
    if (!etherscanKey) {
      log.warn('ETHERSCAN_API_KEY not set — using neutral score for whale tracker');
      return { normalized: 0, rawValue: 0.5 };
    }

    const now = Math.floor(Date.now() / 1000);
    const since = now - TWENTY_FOUR_HOURS_S;
    let deposits = 0;
    let withdrawals = 0;

    const allAddresses = Object.values(EXCHANGE_ADDRESSES).flat();

    for (const address of allAddresses) {
      try {
        const url =
          `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx` +
          `&contractaddress=${USDT_CONTRACT}&address=${address}` +
          `&page=1&offset=50&sort=desc&apikey=${etherscanKey}`;
        const { data } = await axios.get<{ result: TokenTx[] | string }>(url, { timeout: 10_000 });

        if (!Array.isArray(data.result)) continue;

        const addrLower = address.toLowerCase();
        for (const tx of data.result) {
          if (Number(tx.timeStamp) < since) continue;
          if (BigInt(tx.value) < MIN_TRANSFER_RAW) continue;

          if (tx.to.toLowerCase() === addrLower) deposits++;
          else if (tx.from.toLowerCase() === addrLower) withdrawals++;
        }
      } catch (err) {
        log.warn(`Etherscan query failed for ${address}: ${(err as Error).message}`);
      }

      // Respect Etherscan rate limit (max 5 calls/sec)
      await new Promise<void>((r) => setTimeout(r, 250));
    }

    const total = deposits + withdrawals;
    if (total === 0) {
      log.info('Whale tracker: no large transfers found in last 24h — score=0');
      return { normalized: 0, rawValue: 0.5 };
    }

    const withdrawalRatio = withdrawals / total;
    const normalized = this.ratioToNormalized(withdrawalRatio);

    log.info(
      `Whale tracker: deposits=${deposits}, withdrawals=${withdrawals}, ` +
      `withdrawalRatio=${(withdrawalRatio * 100).toFixed(1)}%, score=${normalized}`,
    );

    return { normalized, rawValue: withdrawalRatio };
  }

  /**
   * Converts withdrawal ratio to -2…+2 sentiment score.
   * High withdrawals = bullish; high deposits = bearish.
   */
  private ratioToNormalized(withdrawalRatio: number): number {
    if (withdrawalRatio > 0.70) return 2;
    if (withdrawalRatio > 0.55) return 1;
    if (withdrawalRatio >= 0.45) return 0;
    if (withdrawalRatio >= 0.30) return -1;
    return -2;
  }
}
