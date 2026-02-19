import { RiskConfig } from '../types';

export const RISK_CONFIG: RiskConfig = {
  maxRiskPerTrade: 0.02,
  normalRisk: 0.01,
  maxLeverage: 5,
  maxConcurrentPositions: 3,
  cooldownAfterLossMs: 4 * 60 * 60 * 1000, // 4 hours
  maxDailyTrades: 6,
  trailingStopActivation: 1.5, // 1.5x SL distance
  maxDrawdownPct: 0.15, // 15% kill switch
  consecutiveLossLimit: 5,
  takeProfitRatio: 2, // 2:1 R:R
};
