-- On-Chain Futures Bot — Initial Schema
-- Run this in your Supabase SQL editor

-- Table: onchain_signals
CREATE TABLE IF NOT EXISTS onchain_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  asset TEXT NOT NULL,
  metric TEXT NOT NULL,
  raw_value NUMERIC NOT NULL,
  normalized NUMERIC NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onchain_signals_asset_ts
  ON onchain_signals (asset, timestamp DESC);

-- Table: market_data
CREATE TABLE IF NOT EXISTS market_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  asset TEXT NOT NULL,
  funding_rate NUMERIC,
  open_interest NUMERIC,
  liquidations_long NUMERIC,
  liquidations_short NUMERIC,
  price NUMERIC NOT NULL,
  volume_24h NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_market_data_asset_ts
  ON market_data (asset, timestamp DESC);

-- Table: composite_scores
CREATE TABLE IF NOT EXISTS composite_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  asset TEXT NOT NULL,
  score NUMERIC NOT NULL,
  signal TEXT NOT NULL,
  components JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_composite_scores_asset_ts
  ON composite_scores (asset, timestamp DESC);

-- Table: trades
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  size_usdt NUMERIC NOT NULL,
  leverage NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  take_profit NUMERIC NOT NULL,
  pnl_usdt NUMERIC,
  pnl_pct NUMERIC,
  score_at_entry NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  is_paper BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_trades_asset_ts
  ON trades (asset, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_trades_status
  ON trades (status);
