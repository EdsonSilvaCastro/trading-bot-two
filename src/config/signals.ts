import { SignalWeight, ScoreThresholds, SignalDirection } from '../types';

export const SIGNAL_WEIGHTS: SignalWeight[] = [
  { name: 'exchange_netflow', weight: 2.5 },
  { name: 'whale_activity', weight: 2.0 },
  { name: 'funding_rate', weight: 1.5 },
  { name: 'oi_delta', weight: 1.5 },
  { name: 'network_activity', weight: 1.0 },
];

export const SCORE_THRESHOLDS: ScoreThresholds = {
  STRONG_LONG: 10,
  LONG: 5,
  MILD_BULLISH: 2,
  NEUTRAL_UPPER: 1.99,
  NEUTRAL_LOWER: -1.99,
  MILD_BEARISH: -2,
  SHORT: -5,
  STRONG_SHORT: -10,
};

/**
 * Maps a composite score (-17 to +17) to a signal direction
 */
export function scoreToSignal(score: number): SignalDirection {
  if (score >= 10) return 'STRONG_LONG';
  if (score >= 5) return 'LONG';
  if (score >= 2) return 'MILD_BULLISH';
  if (score > -2) return 'NEUTRAL';
  if (score > -5) return 'MILD_BEARISH';
  if (score > -10) return 'SHORT';
  return 'STRONG_SHORT';
}
