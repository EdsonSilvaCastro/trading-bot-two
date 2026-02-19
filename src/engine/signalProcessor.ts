import { createModuleLogger } from '../monitoring/logger';
import { getSupabaseClient } from '../database/supabase';
import { Asset } from '../types';

const log = createModuleLogger('signal-processor');

const SIGNAL_METRICS = [
  'exchange_netflow',
  'whale_activity',
  'funding_rate',
  'oi_delta',
  'network_activity',
] as const;

type SignalMetric = typeof SIGNAL_METRICS[number];

/** Maximum age (ms) before a signal is considered stale */
const STALENESS_THRESHOLDS_MS: Record<SignalMetric, number> = {
  exchange_netflow: 2 * 60 * 60 * 1000,   // 2 hours
  whale_activity: 30 * 60 * 1000,          // 30 minutes
  funding_rate: 16 * 60 * 60 * 1000,       // 16 hours
  oi_delta: 2 * 60 * 60 * 1000,            // 2 hours
  network_activity: 8 * 60 * 60 * 1000,    // 8 hours
};

export class SignalProcessor {
  /**
   * Queries the latest normalized value for each metric for the given asset.
   * Returns 0 for any signal that is missing or stale.
   */
  async getLatestSignals(asset: Asset): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const metric of SIGNAL_METRICS) {
      result[metric] = 0;
    }

    const client = getSupabaseClient();
    if (!client) {
      log.warn('Supabase not configured — returning zero signals');
      return result;
    }

    try {
      const staleness = await this.getSignalStaleness(asset);

      for (const metric of SIGNAL_METRICS) {
        if (!staleness[metric]) {
          log.warn(`Signal ${metric} for ${asset} is stale — using 0`);
          continue;
        }

        const { data, error } = await client
          .from('onchain_signals')
          .select('normalized')
          .eq('asset', asset)
          .eq('metric', metric)
          .order('timestamp', { ascending: false })
          .limit(1)
          .single();

        if (error || !data) {
          log.warn(`No data for ${metric}/${asset}: ${error?.message ?? 'empty'}`);
        } else {
          result[metric] = data.normalized;
        }
      }
    } catch (err) {
      log.error(`getLatestSignals exception: ${(err as Error).message}`);
    }

    return result;
  }

  /**
   * Returns which signals are fresh (true) vs stale (false) for the given asset.
   */
  async getSignalStaleness(asset: Asset): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const metric of SIGNAL_METRICS) {
      result[metric] = false;
    }

    const client = getSupabaseClient();
    if (!client) {
      log.warn('Supabase not configured — all signals marked stale');
      return result;
    }

    try {
      const now = Date.now();

      for (const metric of SIGNAL_METRICS) {
        const { data, error } = await client
          .from('onchain_signals')
          .select('timestamp')
          .eq('asset', asset)
          .eq('metric', metric)
          .order('timestamp', { ascending: false })
          .limit(1)
          .single();

        if (error || !data) {
          result[metric] = false;
          continue;
        }

        const age = now - new Date(data.timestamp).getTime();
        result[metric] = age <= STALENESS_THRESHOLDS_MS[metric as SignalMetric];
      }
    } catch (err) {
      log.error(`getSignalStaleness exception: ${(err as Error).message}`);
    }

    return result;
  }

  /**
   * Returns the count of non-stale (fresh) signals.
   * A minimum of 3/5 fresh signals is required to trade.
   */
  countFreshSignals(staleness: Record<string, boolean>): number {
    return Object.values(staleness).filter(Boolean).length;
  }
}
