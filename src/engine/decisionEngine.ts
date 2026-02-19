import { createModuleLogger } from '../monitoring/logger';
import { ASSET_CONFIGS, SUPPORTED_ASSETS } from '../config/assets';
import { RISK_CONFIG } from '../config/risk';
import { Asset, TradeDecision, CompositeScoreResult } from '../types';
import { CompositeScoreEngine } from './compositeScore';

const log = createModuleLogger('decision-engine');

export class DecisionEngine {
  constructor(private readonly scoreEngine: CompositeScoreEngine) {}

  /**
   * Evaluates a pre-calculated score result without re-querying Supabase.
   * Use this inside the scoring cycle to avoid double computation.
   */
  evaluateFromScore(scoreResult: CompositeScoreResult): TradeDecision {
    const { asset, score, signal, isReliable, freshSignalCount } = scoreResult;
    const assetCfg = ASSET_CONFIGS[asset];
    const stopLossPct = assetCfg.stopLossPct;
    const takeProfitPct = stopLossPct * RISK_CONFIG.takeProfitRatio;

    if (!isReliable) {
      const reason = `Insufficient fresh signals: ${freshSignalCount}/5 available (minimum 3 required)`;
      log.warn(`${asset}: ${reason}`);
      return { asset, action: 'NO_ACTION', signal, score, positionSizePercent: 0, leverage: 0, stopLossPct, takeProfitPct, reason, isReliable: false };
    }

    let action: TradeDecision['action'];
    let positionSizePercent: number;
    let leverage: number;
    let reason: string;

    switch (signal) {
      case 'STRONG_LONG':
        action = 'OPEN_LONG'; positionSizePercent = RISK_CONFIG.maxRiskPerTrade; leverage = assetCfg.strongLeverage;
        reason = `Strong bullish consensus: ${freshSignalCount}/5 signals fresh, score ${score > 0 ? '+' : ''}${score}`; break;
      case 'LONG':
        action = 'OPEN_LONG'; positionSizePercent = RISK_CONFIG.normalRisk; leverage = assetCfg.defaultLeverage;
        reason = `Bullish signal: ${freshSignalCount}/5 signals fresh, score ${score > 0 ? '+' : ''}${score}`; break;
      case 'MILD_BULLISH':
        action = 'NO_ACTION'; positionSizePercent = 0; leverage = 0;
        reason = `Mild bullish — alert only (score ${score > 0 ? '+' : ''}${score})`; break;
      case 'NEUTRAL':
        action = 'CLOSE'; positionSizePercent = 0; leverage = 0;
        reason = `Neutral signal — close any open position (score ${score})`; break;
      case 'MILD_BEARISH':
        action = 'NO_ACTION'; positionSizePercent = 0; leverage = 0;
        reason = `Mild bearish — alert only (score ${score})`; break;
      case 'SHORT':
        action = 'OPEN_SHORT'; positionSizePercent = RISK_CONFIG.normalRisk; leverage = assetCfg.defaultLeverage;
        reason = `Bearish signal: ${freshSignalCount}/5 signals fresh, score ${score}`; break;
      case 'STRONG_SHORT':
        action = 'OPEN_SHORT'; positionSizePercent = RISK_CONFIG.maxRiskPerTrade; leverage = assetCfg.strongLeverage;
        reason = `Strong bearish consensus: ${freshSignalCount}/5 signals fresh, score ${score}`; break;
      default:
        action = 'NO_ACTION'; positionSizePercent = 0; leverage = 0; reason = 'Unknown signal direction';
    }

    log.info(`${asset}: ${action} | signal=${signal} | score=${score} | leverage=${leverage}x`);
    return { asset, action, signal, score, positionSizePercent, leverage, stopLossPct, takeProfitPct, reason, isReliable };
  }

  /**
   * Evaluates the composite score for a single asset and produces a trade decision.
   * Forces NO_ACTION when fewer than 3 signals are fresh.
   */
  async evaluate(asset: Asset): Promise<TradeDecision> {
    const scoreResult = await this.scoreEngine.calculateScore(asset);
    const { score, signal, isReliable, freshSignalCount } = scoreResult;
    const assetCfg = ASSET_CONFIGS[asset];
    const stopLossPct = assetCfg.stopLossPct;
    const takeProfitPct = stopLossPct * RISK_CONFIG.takeProfitRatio;

    if (!isReliable) {
      const reason = `Insufficient fresh signals: ${freshSignalCount}/5 available (minimum 3 required)`;
      log.warn(`${asset}: ${reason}`);
      return {
        asset,
        action: 'NO_ACTION',
        signal,
        score,
        positionSizePercent: 0,
        leverage: 0,
        stopLossPct,
        takeProfitPct,
        reason,
        isReliable: false,
      };
    }

    let action: TradeDecision['action'];
    let positionSizePercent: number;
    let leverage: number;
    let reason: string;

    switch (signal) {
      case 'STRONG_LONG':
        action = 'OPEN_LONG';
        positionSizePercent = RISK_CONFIG.maxRiskPerTrade;  // 2%
        leverage = assetCfg.strongLeverage;                  // 5x
        reason = `Strong bullish consensus: ${freshSignalCount}/5 signals fresh, score ${score > 0 ? '+' : ''}${score}`;
        break;

      case 'LONG':
        action = 'OPEN_LONG';
        positionSizePercent = RISK_CONFIG.normalRisk;         // 1%
        leverage = assetCfg.defaultLeverage;                  // 3x
        reason = `Bullish signal: ${freshSignalCount}/5 signals fresh, score ${score > 0 ? '+' : ''}${score}`;
        break;

      case 'MILD_BULLISH':
        action = 'NO_ACTION';
        positionSizePercent = 0;
        leverage = 0;
        reason = `Mild bullish — alert only, not strong enough to trade (score ${score > 0 ? '+' : ''}${score})`;
        break;

      case 'NEUTRAL':
        action = 'CLOSE';
        positionSizePercent = 0;
        leverage = 0;
        reason = `Neutral signal — close any open position (score ${score})`;
        break;

      case 'MILD_BEARISH':
        action = 'NO_ACTION';
        positionSizePercent = 0;
        leverage = 0;
        reason = `Mild bearish — alert only, not strong enough to trade (score ${score})`;
        break;

      case 'SHORT':
        action = 'OPEN_SHORT';
        positionSizePercent = RISK_CONFIG.normalRisk;         // 1%
        leverage = assetCfg.defaultLeverage;                  // 3x
        reason = `Bearish signal: ${freshSignalCount}/5 signals fresh, score ${score}`;
        break;

      case 'STRONG_SHORT':
        action = 'OPEN_SHORT';
        positionSizePercent = RISK_CONFIG.maxRiskPerTrade;    // 2%
        leverage = assetCfg.strongLeverage;                   // 5x
        reason = `Strong bearish consensus: ${freshSignalCount}/5 signals fresh, score ${score}`;
        break;

      default:
        action = 'NO_ACTION';
        positionSizePercent = 0;
        leverage = 0;
        reason = 'Unknown signal direction';
    }

    log.info(`${asset}: ${action} | signal=${signal} | score=${score} | leverage=${leverage}x`);

    return {
      asset,
      action,
      signal,
      score,
      positionSizePercent,
      leverage,
      stopLossPct,
      takeProfitPct,
      reason,
      isReliable,
    };
  }

  /**
   * Evaluates all supported assets and returns an array of trade decisions.
   */
  async evaluateAll(): Promise<TradeDecision[]> {
    return Promise.all(SUPPORTED_ASSETS.map((asset) => this.evaluate(asset)));
  }

  /**
   * Formats an array of trade decisions as a human-readable summary
   * suitable for Telegram or log output.
   */
  formatDecisionSummary(decisions: TradeDecision[]): string {
    const lines: string[] = ['=== Scoring Cycle Summary ==='];

    for (const d of decisions) {
      const reliabilityTag = d.isReliable ? '✓' : '⚠ unreliable';
      const scoreStr = `${d.score > 0 ? '+' : ''}${d.score.toFixed(2)}`;
      lines.push(
        `${d.asset}: score=${scoreStr} | ${d.signal} | ${d.action} | ${reliabilityTag}`,
      );
      lines.push(`  Reason: ${d.reason}`);
    }

    return lines.join('\n');
  }
}
