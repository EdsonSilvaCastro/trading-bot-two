import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal, getSupabaseClient } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('network-activity');

const DELAY_MS = 200;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Collects on-chain network activity metrics.
 *
 * BTC: Blockchain.com Charts API — unique active addresses (no API key needed)
 * ETH: Etherscan gas oracle as network activity proxy (ETHERSCAN_API_KEY)
 * SOL: Helius RPC getRecentPerformanceSamples (HELIUS_API_KEY)
 *
 * Logic: Activity above 30d baseline = bullish; below = bearish.
 */
export class NetworkActivityCollector {
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
      await delay(DELAY_MS);
    }

    return results;
  }

  private async fetchNetworkActivity(asset: Asset): Promise<CollectorResult> {
    if (asset === 'BTC') return this.fetchBTC();
    if (asset === 'ETH') return this.fetchETH();
    if (asset === 'SOL') return this.fetchSOL();
    throw new Error(`Unknown asset: ${asset}`);
  }

  // ─── BTC ─────────────────────────────────────────────────────────────────────

  private async fetchBTC(): Promise<CollectorResult> {
    const url = 'https://api.blockchain.info/charts/n-unique-addresses?timespan=30days&format=json';
    const { data } = await axios.get<{ values: Array<{ x: number; y: number }> }>(url, { timeout: 10_000 });

    const values = data.values.map((v) => v.y);
    const latest = values[values.length - 1];
    const ma30 = values.reduce((a, b) => a + b, 0) / values.length;
    const ratio = (latest - ma30) / ma30;
    const normalized = this.ratioToNormalized(ratio);

    log.info(
      `BTC unique addresses: latest=${latest.toFixed(0)}, 30d MA=${ma30.toFixed(0)}, ` +
      `deviation=${(ratio * 100).toFixed(1)}%, score=${normalized}`,
    );

    await insertSignal({
      timestamp: new Date(),
      asset: 'BTC',
      metric: 'network_activity',
      rawValue: latest,
      normalized,
      source: 'blockchain.info',
    });

    return { success: true, asset: 'BTC', metric: 'network_activity', rawValue: latest, timestamp: new Date() };
  }

  // ─── ETH ─────────────────────────────────────────────────────────────────────

  private async fetchETH(): Promise<CollectorResult> {
    const etherscanKey = process.env.ETHERSCAN_API_KEY;
    if (!etherscanKey) {
      log.warn('ETHERSCAN_API_KEY not set — using neutral score for ETH network activity');
      return this.neutralResult('ETH', 'etherscan-missing');
    }

    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${etherscanKey}`;
    const { data } = await axios.get<{ result: { ProposeGasPrice: string } }>(url, { timeout: 10_000 });
    const gasGwei = Number(data.result.ProposeGasPrice);

    const historical = await this.getHistoricalRawValues('ETH', 30);
    const normalized = this.compareToHistory(gasGwei, historical);

    log.info(`ETH gas price: ${gasGwei} Gwei, historical samples=${historical.length}, score=${normalized}`);

    await insertSignal({
      timestamp: new Date(),
      asset: 'ETH',
      metric: 'network_activity',
      rawValue: gasGwei,
      normalized,
      source: 'etherscan',
    });

    return { success: true, asset: 'ETH', metric: 'network_activity', rawValue: gasGwei, timestamp: new Date() };
  }

  // ─── SOL ─────────────────────────────────────────────────────────────────────

  private async fetchSOL(): Promise<CollectorResult> {
    const heliusKey = process.env.HELIUS_API_KEY;
    if (!heliusKey) {
      log.warn('HELIUS_API_KEY not set — using neutral score for SOL network activity');
      return this.neutralResult('SOL', 'helius-missing');
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    const { data } = await axios.post<{ result: Array<{ numTransactions: number }> }>(
      url,
      { jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [30] },
      { timeout: 10_000 },
    );

    const samples = data.result ?? [];
    if (samples.length === 0) {
      log.warn('SOL: no performance samples returned, score=0');
      return this.neutralResult('SOL', 'helius');
    }

    const avgTxPerSlot = samples.reduce((a, s) => a + s.numTransactions, 0) / samples.length;
    const historical = await this.getHistoricalRawValues('SOL', 30);
    const normalized = this.compareToHistory(avgTxPerSlot, historical);

    log.info(`SOL avg tx/slot: ${avgTxPerSlot.toFixed(1)}, historical samples=${historical.length}, score=${normalized}`);

    await insertSignal({
      timestamp: new Date(),
      asset: 'SOL',
      metric: 'network_activity',
      rawValue: avgTxPerSlot,
      normalized,
      source: 'helius',
    });

    return { success: true, asset: 'SOL', metric: 'network_activity', rawValue: avgTxPerSlot, timestamp: new Date() };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Converts a ratio of (current - MA) / MA to a -2…+2 score.
   */
  private ratioToNormalized(ratio: number): number {
    if (ratio >= 0.10) return 2;
    if (ratio >= 0.03) return 1;
    if (ratio > -0.03) return 0;
    if (ratio > -0.10) return -1;
    return -2;
  }

  /**
   * Compares current value to historical MA. Returns 0 when < 5 data points.
   */
  private compareToHistory(current: number, historical: number[]): number {
    if (historical.length < 5) return 0;
    const ma = historical.reduce((a, b) => a + b, 0) / historical.length;
    const ratio = (current - ma) / ma;
    return this.ratioToNormalized(ratio);
  }

  /**
   * Queries the last N raw_value entries from onchain_signals for a given asset/metric.
   */
  private async getHistoricalRawValues(asset: Asset, limit: number): Promise<number[]> {
    const client = getSupabaseClient();
    if (!client) return [];
    const { data } = await client
      .from('onchain_signals')
      .select('raw_value')
      .eq('asset', asset)
      .eq('metric', 'network_activity')
      .order('timestamp', { ascending: false })
      .limit(limit);
    return (data ?? []).map((r: { raw_value: number }) => r.raw_value);
  }

  /**
   * Returns a neutral (score=0) result and inserts it into Supabase.
   */
  private async neutralResult(asset: Asset, source: string): Promise<CollectorResult> {
    await insertSignal({
      timestamp: new Date(),
      asset,
      metric: 'network_activity',
      rawValue: 0,
      normalized: 0,
      source,
    });
    return { success: true, asset, metric: 'network_activity', rawValue: 0, timestamp: new Date() };
  }
}
