import { Asset, AssetConfig } from '../types';

export const ASSET_CONFIGS: Record<Asset, AssetConfig> = {
  BTC: {
    symbol: 'BTCUSDT',
    stopLossPct: 0.025,
    defaultLeverage: 3,
    strongLeverage: 5,
  },
  ETH: {
    symbol: 'ETHUSDT',
    stopLossPct: 0.035,
    defaultLeverage: 3,
    strongLeverage: 5,
  },
  SOL: {
    symbol: 'SOLUSDT',
    stopLossPct: 0.05,
    defaultLeverage: 3,
    strongLeverage: 5,
  },
};

export const SUPPORTED_ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];
