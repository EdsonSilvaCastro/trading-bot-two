# Claude Code Prompt — On-Chain Futures Bot (Phase 2: Scoring Engine)

## Paste this into Claude Code:

---

```
We're continuing the On-Chain Futures Bot project. Phase 1 (data pipeline) is complete and working. Now we're implementing PHASE 2: the Scoring Engine.

The project already exists at ~/onchain-futures-bot with all collectors, types, config, database, and monitoring in place. You need to implement the 3 engine files that are currently placeholders, plus wire them into the existing system.

## CONTEXT — What already exists:

- `src/types/index.ts` — All types defined (Asset, SignalDirection, CompositeScore, etc.)
- `src/config/signals.ts` — Signal weights and score thresholds already defined
- `src/config/assets.ts` — Asset configs (BTC, ETH, SOL)
- `src/config/risk.ts` — Risk parameters
- `src/database/supabase.ts` — insertSignal(), insertCompositeScore() already working
- `src/collectors/` — All 6 collectors running and storing data in Supabase
- `src/monitoring/telegramBot.ts` — sendAlert(), sendSignalUpdate() already exist

Data flows into two Supabase tables:
- `onchain_signals` (asset, metric, raw_value, normalized, source, timestamp)
- `market_data` (asset, price, volume_24h, funding_rate, open_interest, etc.)

Normalized signal values are already stored as -2 to +2 in the `normalized` column.

## FIRST: Fix the scoreToSignal() function in src/config/signals.ts

The current implementation has edge case bugs. Replace it with this cleaner version:

```typescript
export function scoreToSignal(score: number): SignalDirection {
  if (score >= 10) return 'STRONG_LONG';
  if (score >= 5) return 'LONG';
  if (score >= 2) return 'MILD_BULLISH';
  if (score > -2) return 'NEUTRAL';
  if (score > -5) return 'MILD_BEARISH';
  if (score > -10) return 'SHORT';
  return 'STRONG_SHORT';
}
```

## FILE 1: src/engine/signalProcessor.ts

This module reads the latest normalized signals from Supabase and organizes them for scoring.

### Requirements:
- Create a `SignalProcessor` class
- Method: `async getLatestSignals(asset: Asset): Promise<Record<string, number>>` 
  - Queries `onchain_signals` table from Supabase
  - For each metric type (exchange_netflow, whale_activity, funding_rate, oi_delta, network_activity), get the MOST RECENT normalized value for the given asset
  - Returns a Record like: `{ exchange_netflow: 1.5, whale_activity: -0.8, funding_rate: 0.3, oi_delta: 1.0, network_activity: 0.5 }`
  - If a signal is missing or stale (older than 2x its expected frequency), return 0 for that signal and log a warning
  
- Method: `async getSignalStaleness(asset: Asset): Promise<Record<string, boolean>>`
  - Returns which signals are fresh (true) vs stale (false)
  - Staleness thresholds based on collection frequency:
    - exchange_netflow: stale if > 2 hours old
    - whale_activity: stale if > 30 minutes old
    - funding_rate: stale if > 16 hours old
    - oi_delta: stale if > 2 hours old  
    - network_activity: stale if > 8 hours old

- Method: `countFreshSignals(staleness: Record<string, boolean>): number`
  - Returns count of non-stale signals
  - Used by decision engine to check minimum signal requirement (3/5 minimum to trade)

- Import getSupabaseClient from database/supabase
- Use createModuleLogger('signal-processor') for logging
- Handle case where Supabase is not configured (return zeros)

## FILE 2: src/engine/compositeScore.ts

This is the core scoring engine. Takes normalized signals, applies weights, and produces composite scores.

### Requirements:
- Create a `CompositeScoreEngine` class
- Constructor receives a `SignalProcessor` instance

- Method: `async calculateScore(asset: Asset): Promise<CompositeScoreResult>`
  - Calls signalProcessor.getLatestSignals(asset)
  - Calls signalProcessor.getSignalStaleness(asset) 
  - For each signal, multiply the normalized value (-2 to +2) by its weight from SIGNAL_WEIGHTS config:
    - exchange_netflow × 2.5
    - whale_activity × 2.0
    - funding_rate × 1.5
    - oi_delta × 1.5
    - network_activity × 1.0
  - Sum all weighted values to get composite score
  - Theoretical range: -17 to +17 (but practically -12 to +12)
  - Map score to SignalDirection using scoreToSignal() from config
  - Count fresh signals — if fewer than 3, override signal to NEUTRAL with a warning
  - Store result in Supabase via insertCompositeScore()
  - Return result object

- Method: `async calculateAllScores(): Promise<CompositeScoreResult[]>`
  - Runs calculateScore() for BTC, ETH, SOL
  - Returns array of all 3 results

- Define a new interface `CompositeScoreResult` (add to types/index.ts):
  ```typescript
  interface CompositeScoreResult {
    asset: Asset;
    score: number;
    signal: SignalDirection;
    components: Record<string, number>;  // weighted values
    rawComponents: Record<string, number>;  // pre-weight normalized values
    freshSignalCount: number;
    isReliable: boolean;  // true if freshSignalCount >= 3
    timestamp: Date;
  }
  ```

## FILE 3: src/engine/decisionEngine.ts

Takes composite scores and determines trade actions. Does NOT execute trades yet (Phase 3), but outputs trade decisions.

### Requirements:
- Create a `DecisionEngine` class
- Constructor receives `CompositeScoreEngine` instance

- Define a new interface `TradeDecision` (add to types/index.ts):
  ```typescript
  interface TradeDecision {
    asset: Asset;
    action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'NO_ACTION';
    signal: SignalDirection;
    score: number;
    positionSizePercent: number;  // 0, 0.01, or 0.02
    leverage: number;  // 3 or 5
    stopLossPct: number;
    takeProfitPct: number;
    reason: string;
    isReliable: boolean;
  }
  ```

- Method: `async evaluate(asset: Asset): Promise<TradeDecision>`
  - Get composite score from scoring engine
  - Apply decision logic:
    - STRONG_LONG → OPEN_LONG, 2% risk, strong leverage (5x)
    - LONG → OPEN_LONG, 1% risk, default leverage (3x)
    - MILD_BULLISH → NO_ACTION (alert only)
    - NEUTRAL → CLOSE any open position (or NO_ACTION)
    - MILD_BEARISH → NO_ACTION (alert only)
    - SHORT → OPEN_SHORT, 1% risk, default leverage (3x)
    - STRONG_SHORT → OPEN_SHORT, 2% risk, strong leverage (5x)
  - If score is not reliable (< 3 fresh signals), force NO_ACTION with reason
  - Set stopLossPct from ASSET_CONFIGS[asset].stopLossPct
  - Set takeProfitPct = stopLossPct * RISK_CONFIG.takeProfitRatio (2:1 R:R)
  - Include descriptive reason string (e.g., "Strong bullish consensus: 4/5 signals fresh, score +12.3")

- Method: `async evaluateAll(): Promise<TradeDecision[]>`
  - Runs evaluate() for BTC, ETH, SOL
  - Returns array of all 3 decisions

- Method: `formatDecisionSummary(decisions: TradeDecision[]): string`
  - Creates a human-readable summary for Telegram/logging
  - Include asset, score, signal, action, and reliability for each

## FILE 4: src/engine/index.ts (NEW)

Create a barrel export file for the engine module:
```typescript
export { SignalProcessor } from './signalProcessor';
export { CompositeScoreEngine } from './compositeScore';
export { DecisionEngine } from './decisionEngine';
```

## WIRING — Update src/index.ts (main entry point)

Modify the existing main() function to:
1. After collectors start, create instances of SignalProcessor, CompositeScoreEngine, DecisionEngine
2. Add a new cron job (every 4 hours) that:
   - Runs calculateAllScores()
   - Runs evaluateAll()
   - Logs the formatted decision summary
   - Sends signal updates via Telegram (sendSignalUpdate for each asset)
   - Sends the decision summary via sendAlert
3. Also run the scoring cycle once on startup (after initial data collection)
4. Add the scoring cycle to graceful shutdown

## WIRING — Update Telegram /scores command

In src/monitoring/telegramBot.ts, the /scores command currently says "Phase 2". Update it so it:
- Accepts a callback or reference to the CompositeScoreEngine
- When user sends /scores, it runs calculateAllScores() and sends formatted results
- Since the bot is initialized before the engine, use a setter pattern:
  - Add: `export function setScoreEngine(engine: CompositeScoreEngine): void`
  - Store engine reference in module scope
  - /scores handler calls engine.calculateAllScores() and formats response

## IMPORTANT GUIDELINES:
- DO NOT modify any existing collector code
- DO NOT modify database schema — use existing tables as-is
- Import SIGNAL_WEIGHTS and scoreToSignal from src/config/signals
- Import ASSET_CONFIGS from src/config/assets
- Import RISK_CONFIG from src/config/risk
- All async methods need try/catch with logging
- Handle Supabase being unavailable gracefully (return neutral/empty results)
- Use createModuleLogger() for each file
- Add JSDoc comments to all public methods
- Add the new interfaces (CompositeScoreResult, TradeDecision) to src/types/index.ts

After implementing, show me how to test the scoring engine manually (a quick script or command).
```

---

## NOTES FOR ED:
- Phase 2 doesn't execute any trades — it only produces scores and decisions.
- The scoring cycle runs every 4 hours, matching your 4H trading timeframe.
- The "3/5 signals minimum" safety check ensures the bot won't trade on incomplete data.
- Mock collectors will produce random scores, so expect random decisions during testing. This is normal until you plug in real on-chain APIs.
- After Phase 2, come back and we validate before moving to Phase 3 (Execution Layer).
