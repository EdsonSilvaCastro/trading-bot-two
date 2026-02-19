export type Asset = 'BTC' | 'ETH' | 'SOL';

export type SignalDirection =
  | 'STRONG_LONG'
  | 'LONG'
  | 'MILD_BULLISH'
  | 'NEUTRAL'
  | 'MILD_BEARISH'
  | 'SHORT'
  | 'STRONG_SHORT';

export type TradeDirection = 'LONG' | 'SHORT';

export type TradeStatus = 'OPEN' | 'CLOSED' | 'STOPPED' | 'TP_HIT';

export interface OnChainSignal {
  id: string;
  timestamp: Date;
  asset: Asset;
  metric: string;
  rawValue: number;
  normalized: number; // -2 to +2
  source: string;
}

export interface MarketData {
  id: string;
  timestamp: Date;
  asset: Asset;
  fundingRate: number;
  openInterest: number;
  liquidationsLong: number;
  liquidationsShort: number;
  price: number;
  volume24h: number;
}

export interface CompositeScore {
  id: string;
  timestamp: Date;
  asset: Asset;
  score: number; // -17 to +17
  signal: SignalDirection;
  components: Record<string, number>;
}

export interface Trade {
  id: string;
  timestamp: Date;
  asset: Asset;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice?: number;
  sizeUsdt: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  pnlUsdt?: number;
  pnlPct?: number;
  scoreAtEntry: number;
  status: TradeStatus;
  isPaper: boolean;
}

export interface AssetConfig {
  symbol: string;
  stopLossPct: number;
  defaultLeverage: number;
  strongLeverage: number;
}

export interface SignalWeight {
  name: string;
  weight: number;
}

export interface CollectorResult {
  success: boolean;
  asset: string;
  metric: string;
  rawValue: number;
  timestamp: Date;
}

export interface RiskConfig {
  maxRiskPerTrade: number;
  normalRisk: number;
  maxLeverage: number;
  maxConcurrentPositions: number;
  cooldownAfterLossMs: number;
  maxDailyTrades: number;
  trailingStopActivation: number;
  maxDrawdownPct: number;
  consecutiveLossLimit: number;
  takeProfitRatio: number;
}

export interface ScoreThresholds {
  STRONG_LONG: number;
  LONG: number;
  MILD_BULLISH: number;
  NEUTRAL_UPPER: number;
  NEUTRAL_LOWER: number;
  MILD_BEARISH: number;
  SHORT: number;
  STRONG_SHORT: number;
}

export interface CompositeScoreResult {
  asset: Asset;
  score: number;
  signal: SignalDirection;
  components: Record<string, number>;     // weighted values
  rawComponents: Record<string, number>;  // pre-weight normalized values
  freshSignalCount: number;
  isReliable: boolean;                    // true if freshSignalCount >= 3
  timestamp: Date;
}

export interface TradeDecision {
  asset: Asset;
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'NO_ACTION';
  signal: SignalDirection;
  score: number;
  positionSizePercent: number;  // 0, 0.01, or 0.02
  leverage: number;             // 3 or 5
  stopLossPct: number;
  takeProfitPct: number;
  reason: string;
  isReliable: boolean;
}
