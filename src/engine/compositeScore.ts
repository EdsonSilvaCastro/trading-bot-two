import { createModuleLogger } from '../monitoring/logger';
import { insertCompositeScore } from '../database/supabase';
import { SIGNAL_WEIGHTS, scoreToSignal } from '../config/signals';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CompositeScoreResult } from '../types';
import { SignalProcessor } from './signalProcessor';

const log = createModuleLogger('composite-score');

const MIN_FRESH_SIGNALS = 3;

export class CompositeScoreEngine {
  constructor(private readonly signalProcessor: SignalProcessor) {}

  /**
   * Calculates the composite score for a single asset.
   * Applies weights to normalized signals and maps the result to a SignalDirection.
   * Overrides signal to NEUTRAL when fewer than 3 signals are fresh.
   */
  async calculateScore(asset: Asset): Promise<CompositeScoreResult> {
    const timestamp = new Date();

    try {
      const [rawComponents, staleness] = await Promise.all([
        this.signalProcessor.getLatestSignals(asset),
        this.signalProcessor.getSignalStaleness(asset),
      ]);

      const freshSignalCount = this.signalProcessor.countFreshSignals(staleness);
      const components: Record<string, number> = {};
      let score = 0;

      for (const { name, weight } of SIGNAL_WEIGHTS) {
        const raw = rawComponents[name] ?? 0;
        const weighted = raw * weight;
        components[name] = weighted;
        score += weighted;
      }

      // Round to 2 decimal places to avoid floating point noise
      score = Math.round(score * 100) / 100;

      const isReliable = freshSignalCount >= MIN_FRESH_SIGNALS;
      let signal = scoreToSignal(score);

      if (!isReliable) {
        log.warn(`${asset}: only ${freshSignalCount}/${MIN_FRESH_SIGNALS} fresh signals — overriding to NEUTRAL`);
        signal = 'NEUTRAL';
      }

      const result: CompositeScoreResult = {
        asset,
        score,
        signal,
        components,
        rawComponents,
        freshSignalCount,
        isReliable,
        timestamp,
      };

      await insertCompositeScore({
        asset,
        score,
        signal,
        components,
        timestamp,
      });

      log.info(`${asset} score: ${score} → ${signal} (${freshSignalCount}/5 fresh)`);
      return result;
    } catch (err) {
      log.error(`calculateScore exception for ${asset}: ${(err as Error).message}`);

      return {
        asset,
        score: 0,
        signal: 'NEUTRAL',
        components: {},
        rawComponents: {},
        freshSignalCount: 0,
        isReliable: false,
        timestamp,
      };
    }
  }

  /**
   * Calculates composite scores for all supported assets (BTC, ETH, SOL).
   */
  async calculateAllScores(): Promise<CompositeScoreResult[]> {
    return Promise.all(SUPPORTED_ASSETS.map((asset) => this.calculateScore(asset)));
  }
}
