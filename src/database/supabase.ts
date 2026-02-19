import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../monitoring/logger';
import { OnChainSignal, MarketData, CompositeScore, Trade } from '../types';

const log = createModuleLogger('supabase');

let supabase: SupabaseClient | null = null;

/**
 * Initializes and returns the Supabase client.
 * Returns null if environment variables are not configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    log.warn('Supabase URL or key not configured — database operations will be skipped');
    return null;
  }

  supabase = createClient(url, key);
  log.info('Supabase client initialized');
  return supabase;
}

/**
 * Inserts an on-chain signal record
 */
export async function insertSignal(signal: Omit<OnChainSignal, 'id'>): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const id = uuidv4();
  try {
    const { error } = await client.from('onchain_signals').insert({
      id,
      timestamp: signal.timestamp.toISOString(),
      asset: signal.asset,
      metric: signal.metric,
      raw_value: signal.rawValue,
      normalized: signal.normalized,
      source: signal.source,
    });

    if (error) {
      log.error(`Failed to insert signal: ${error.message}`);
      return null;
    }
    log.debug(`Inserted signal ${signal.metric} for ${signal.asset}`);
    return id;
  } catch (err) {
    log.error(`insertSignal exception: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Inserts a market data record
 */
export async function insertMarketData(data: Omit<MarketData, 'id'>): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const id = uuidv4();
  try {
    const { error } = await client.from('market_data').insert({
      id,
      timestamp: data.timestamp.toISOString(),
      asset: data.asset,
      funding_rate: data.fundingRate,
      open_interest: data.openInterest,
      liquidations_long: data.liquidationsLong,
      liquidations_short: data.liquidationsShort,
      price: data.price,
      volume_24h: data.volume24h,
    });

    if (error) {
      log.error(`Failed to insert market data: ${error.message}`);
      return null;
    }
    log.debug(`Inserted market data for ${data.asset}`);
    return id;
  } catch (err) {
    log.error(`insertMarketData exception: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Inserts a composite score record
 */
export async function insertCompositeScore(score: Omit<CompositeScore, 'id'>): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const id = uuidv4();
  try {
    const { error } = await client.from('composite_scores').insert({
      id,
      timestamp: score.timestamp.toISOString(),
      asset: score.asset,
      score: score.score,
      signal: score.signal,
      components: score.components,
    });

    if (error) {
      log.error(`Failed to insert composite score: ${error.message}`);
      return null;
    }
    log.debug(`Inserted composite score for ${score.asset}: ${score.score}`);
    return id;
  } catch (err) {
    log.error(`insertCompositeScore exception: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Inserts a new trade record
 */
export async function insertTrade(trade: Omit<Trade, 'id'>): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const id = uuidv4();
  try {
    const { error } = await client.from('trades').insert({
      id,
      timestamp: trade.timestamp.toISOString(),
      asset: trade.asset,
      direction: trade.direction,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice ?? null,
      size_usdt: trade.sizeUsdt,
      leverage: trade.leverage,
      stop_loss: trade.stopLoss,
      take_profit: trade.takeProfit,
      pnl_usdt: trade.pnlUsdt ?? null,
      pnl_pct: trade.pnlPct ?? null,
      score_at_entry: trade.scoreAtEntry,
      status: trade.status,
      is_paper: trade.isPaper,
    });

    if (error) {
      log.error(`Failed to insert trade: ${error.message}`);
      return null;
    }
    log.info(`Inserted trade: ${trade.direction} ${trade.asset} @ ${trade.entryPrice}`);
    return id;
  } catch (err) {
    log.error(`insertTrade exception: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Updates an existing trade record (e.g., closing a position)
 */
export async function updateTrade(
  tradeId: string,
  updates: Partial<Pick<Trade, 'exitPrice' | 'pnlUsdt' | 'pnlPct' | 'status'>>
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const updateData: Record<string, unknown> = {};
    if (updates.exitPrice !== undefined) updateData.exit_price = updates.exitPrice;
    if (updates.pnlUsdt !== undefined) updateData.pnl_usdt = updates.pnlUsdt;
    if (updates.pnlPct !== undefined) updateData.pnl_pct = updates.pnlPct;
    if (updates.status !== undefined) updateData.status = updates.status;

    const { error } = await client.from('trades').update(updateData).eq('id', tradeId);

    if (error) {
      log.error(`Failed to update trade ${tradeId}: ${error.message}`);
      return false;
    }
    log.info(`Updated trade ${tradeId}: ${JSON.stringify(updates)}`);
    return true;
  } catch (err) {
    log.error(`updateTrade exception: ${(err as Error).message}`);
    return false;
  }
}
