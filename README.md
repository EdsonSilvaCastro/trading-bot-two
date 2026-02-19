# On-Chain Intelligence Futures Trading Bot

Automated futures trading bot for Bybit that combines on-chain blockchain data with market microstructure signals to generate a composite scoring system (-17 to +17) driving perpetual futures trades on BTC/USDT, ETH/USDT, and SOL/USDT.

## Phase 1: Data Pipeline Foundation

Currently implemented:
- **Data collectors** — Funding rate, open interest, and price data from Bybit public API
- **Mock collectors** — Exchange netflow, whale tracker, network activity (placeholder for paid APIs)
- **Scheduled orchestration** — Cron-based collection at configured intervals
- **Supabase persistence** — All signals and market data stored in PostgreSQL
- **Telegram alerts** — Basic bot with `/status`, `/scores`, `/pause` commands
- **Winston logging** — Console + file logging with module tags

## Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your Supabase and Telegram credentials

# Run the database migration in your Supabase SQL editor:
# src/database/migrations/001_initial_schema.sql

# Build
npm run build

# Run in development
npm run dev

# Run in production
npm start

# Run all collectors once (testing)
npm run collect:once
```

## Project Structure

```
src/
  collectors/     — Data collection modules (Bybit API + mock on-chain)
  config/         — Asset configs, signal weights, risk parameters
  database/       — Supabase client and SQL migrations
  engine/         — Scoring engine (Phase 2)
  execution/      — Bybit order execution (Phase 3)
  monitoring/     — Logger, Telegram bot, performance tracking
  types/          — TypeScript interfaces
```

## Roadmap

- **Phase 1** (current): Project setup + data pipeline
- **Phase 2**: Composite scoring engine + signal processing
- **Phase 3**: Bybit execution + paper trading
- **Phase 4**: Live trading + performance monitoring
