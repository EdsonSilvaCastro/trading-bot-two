# Claude Code Prompt — On-Chain Futures Bot (Phase 3: Execution Layer)

## Paste this into Claude Code:

---

```
We're continuing the On-Chain Futures Bot project. Phase 1 (data pipeline) and Phase 2 (scoring engine) are complete. Now we're implementing PHASE 3: the Execution Layer.

The bot currently collects data, calculates composite scores (-17 to +17), and produces TradeDecision objects with action, leverage, position size, SL/TP. Phase 3 turns those decisions into actual orders on Bybit (paper trading first).

## CONTEXT — What already exists:

- `src/types/index.ts` — All types including TradeDecision, Trade, Asset, RiskConfig
- `src/config/assets.ts` — ASSET_CONFIGS with symbol, stopLossPct, leverage settings
- `src/config/risk.ts` — RISK_CONFIG with all risk management parameters
- `src/engine/decisionEngine.ts` — Produces TradeDecision with action, leverage, positionSizePercent, stopLossPct, takeProfitPct
- `src/database/supabase.ts` — insertTrade(), updateTrade() already implemented
- `src/monitoring/telegramBot.ts` — sendAlert() for notifications
- `src/index.ts` — Main entry with scoring cycle every 4 hours

The execution placeholder files exist but are empty:
- `src/execution/bybitClient.ts`
- `src/execution/orderManager.ts`
- `src/execution/paperTrader.ts`
- `src/execution/positionManager.ts`

## IMPORTANT DESIGN DECISION: Dual-mode execution

The system must support TWO execution modes with an identical interface:
1. **Paper trading mode** (PAPER_TRADING=true in .env) — Simulates orders locally, no real API calls for orders
2. **Live trading mode** (PAPER_TRADING=false) — Real Bybit API calls

Both modes use the same `OrderManager` interface so switching is seamless.

## FIRST: Fix the double-calculation issue in src/index.ts

Currently `runScoringCycle()` calls both `calculateAllScores()` and `evaluateAll()`, which recalculates scores internally. Fix this:

1. Add a new method to `DecisionEngine`:
```typescript
/**
 * Evaluates a pre-calculated score result without recalculating.
 */
evaluateFromScore(scoreResult: CompositeScoreResult): TradeDecision
```

2. Update `runScoringCycle()` in index.ts to:
```typescript
const scores = await compositeScoreEngine.calculateAllScores();
const decisions = scores.map(s => decisionEngine.evaluateFromScore(s));
```

This eliminates the duplicate Supabase queries and inserts.

## FILE 1: src/execution/bybitClient.ts

Authenticated Bybit API v5 client for futures trading.

### Requirements:
- Create a `BybitClient` class
- Constructor takes apiKey, apiSecret, testnet (boolean)
- Base URLs:
  - Mainnet: `https://api.bybit.com`
  - Testnet: `https://api-testnet.bybit.com`
  
- **Authentication**: Bybit v5 uses HMAC SHA256 signatures
  - Timestamp in ms
  - Sign: timestamp + apiKey + recvWindow + queryString (GET) or body (POST)
  - Headers: `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-SIGN`, `X-BAPI-RECV-WINDOW`
  - Use Node.js built-in `crypto` module (createHmac)

- Methods (all async, all with error handling and logging):

  `async getWalletBalance(): Promise<number>`
  - GET /v5/account/wallet-balance?accountType=UNIFIED&coin=USDT
  - Returns available USDT balance as number

  `async setLeverage(symbol: string, leverage: number): Promise<void>`
  - POST /v5/position/set-leverage
  - Body: { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) }
  - Silently handle "leverage not modified" errors (110043)

  `async placeOrder(params: OrderParams): Promise<OrderResult>`
  - POST /v5/order/create
  - Define OrderParams interface:
    ```typescript
    interface OrderParams {
      symbol: string;
      side: 'Buy' | 'Sell';
      orderType: 'Market' | 'Limit';
      qty: string;
      price?: string;           // required for Limit orders
      takeProfit?: string;
      stopLoss?: string;
      timeInForce?: string;     // default 'GTC'
      reduceOnly?: boolean;
    }
    ```
  - Define OrderResult interface:
    ```typescript
    interface OrderResult {
      orderId: string;
      orderLinkId: string;
      success: boolean;
      message: string;
    }
    ```

  `async cancelOrder(symbol: string, orderId: string): Promise<boolean>`
  - POST /v5/order/cancel

  `async getOpenPositions(symbol?: string): Promise<PositionInfo[]>`
  - GET /v5/position/list?category=linear&settleCoin=USDT
  - Define PositionInfo interface:
    ```typescript
    interface PositionInfo {
      symbol: string;
      side: 'Buy' | 'Sell' | 'None';
      size: string;
      entryPrice: string;
      unrealisedPnl: string;
      leverage: string;
      takeProfit: string;
      stopLoss: string;
    }
    ```

  `async setTradingStop(symbol: string, stopLoss?: string, takeProfit?: string, trailingStop?: string): Promise<void>`
  - POST /v5/position/trading-stop
  - For updating SL/TP on open positions (trailing stop activation)

  `async getOrderHistory(symbol: string, limit?: number): Promise<any[]>`
  - GET /v5/order/history

  `async getCurrentPrice(symbol: string): Promise<number>`
  - GET /v5/market/tickers?category=linear&symbol=SYMBOL
  - Returns lastPrice as number (this is a PUBLIC endpoint, no auth needed)

- Export OrderParams, OrderResult, PositionInfo interfaces

## FILE 2: src/execution/paperTrader.ts

Simulates order execution locally without calling Bybit API. Implements the same interface as the real order flow.

### Requirements:
- Create a `PaperTrader` class
- Uses BybitClient ONLY for getCurrentPrice() (public endpoint, no auth needed)
- Maintains in-memory state of simulated positions
- Define internal PaperPosition interface:
  ```typescript
  interface PaperPosition {
    id: string;
    asset: Asset;
    symbol: string;
    side: 'Buy' | 'Sell';
    size: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    leverage: number;
    openedAt: Date;
    unrealisedPnl: number;
  }
  ```

- Constructor takes BybitClient instance (for price data only)
- Simulated balance starting from env var PAPER_BALANCE or default 10000

- Methods:
  `async simulateOrder(params: OrderParams): Promise<OrderResult>`
  - Gets current market price via bybitClient.getCurrentPrice()
  - Creates a PaperPosition in memory
  - Returns a mock OrderResult with generated orderId

  `async getOpenPositions(): Promise<PaperPosition[]>`
  - Returns current in-memory positions with updated unrealised PnL (fetch latest price)

  `async closePosition(positionId: string, reason: string): Promise<{ pnlUsdt: number; pnlPct: number }>`
  - Gets current price, calculates P&L, removes from memory
  - Returns realized P&L

  `getBalance(): number`
  - Returns current simulated balance

  `async checkStopLossTakeProfit(): Promise<string[]>`
  - For each open position, check if current price has hit SL or TP
  - If hit, auto-close the position and return list of closed position IDs
  - This gets called periodically to simulate SL/TP execution

## FILE 3: src/execution/positionManager.ts

Manages the lifecycle of positions — entry validation, position sizing, trailing stops, and exit logic.

### Requirements:
- Create a `PositionManager` class
- Constructor takes: BybitClient, PaperTrader (or null for live mode), isPaperMode boolean

- State tracking:
  - `openPositions: Map<Asset, string>` (asset → trade ID in database)
  - `lastLossTimestamp: Map<Asset, number>` (for cooldown enforcement)
  - `dailyTradeCount: number` (resets at UTC midnight)
  - `consecutiveLosses: number`
  - `peakBalance: number` (for drawdown calculation)

- Method: `async canOpenPosition(asset: Asset, decision: TradeDecision): Promise<{ allowed: boolean; reason: string }>`
  Validates ALL risk management rules before opening:
  - Is there already an open position for this asset? (max 1 per asset)
  - Total open positions < RISK_CONFIG.maxConcurrentPositions (3)?
  - Cooldown period elapsed since last loss on this asset?
  - Daily trade count < RISK_CONFIG.maxDailyTrades (6)?
  - Consecutive losses < RISK_CONFIG.consecutiveLossLimit (5)?
  - Current drawdown < RISK_CONFIG.maxDrawdownPct (15%)?
  - Decision action is OPEN_LONG or OPEN_SHORT?
  - Decision isReliable is true?
  
- Method: `async calculatePositionSize(asset: Asset, decision: TradeDecision): Promise<PositionSizeResult>`
  ```typescript
  interface PositionSizeResult {
    notionalSize: number;    // total position value in USDT
    quantity: string;        // qty to send to Bybit (formatted string)
    marginRequired: number;  // notionalSize / leverage
    riskAmount: number;      // max loss if SL hit
    stopLossPrice: number;   // absolute price level
    takeProfitPrice: number; // absolute price level
    entryPrice: number;      // current market price
    leverage: number;
  }
  ```
  - Get current price from BybitClient
  - Get account balance (paper or real)
  - riskAmount = balance × decision.positionSizePercent
  - notionalSize = riskAmount / decision.stopLossPct
  - quantity = notionalSize / currentPrice (round to appropriate decimal places)
  - marginRequired = notionalSize / decision.leverage
  - Calculate SL price: for LONG → entry × (1 - stopLossPct), for SHORT → entry × (1 + stopLossPct)
  - Calculate TP price: for LONG → entry × (1 + takeProfitPct), for SHORT → entry × (1 - takeProfitPct)
  - Add PositionSizeResult to types/index.ts

- Method: `async openPosition(asset: Asset, decision: TradeDecision): Promise<string | null>`
  - Calls canOpenPosition() — if not allowed, log reason and return null
  - Calls calculatePositionSize()
  - If paper mode: call paperTrader.simulateOrder()
  - If live mode: call bybitClient.setLeverage() then bybitClient.placeOrder()
  - Insert trade record into Supabase via insertTrade()
  - Track in openPositions map
  - Send Telegram alert with entry details
  - Return trade ID

- Method: `async closePosition(asset: Asset, reason: string): Promise<void>`
  - If no open position for asset, return
  - If paper mode: call paperTrader.closePosition()
  - If live mode: place a market order in opposite direction with reduceOnly=true
  - Update trade in Supabase via updateTrade()
  - Remove from openPositions map
  - Update consecutive losses / peak balance / daily trade count
  - Send Telegram alert with exit details and P&L

- Method: `async checkAndManagePositions(): Promise<void>`
  - Called periodically (every 15 minutes via cron)
  - For paper mode: call paperTrader.checkStopLossTakeProfit() 
  - For live mode: check positions via bybitClient.getOpenPositions()
  - Implement trailing stop logic:
    - If unrealised profit > RISK_CONFIG.trailingStopActivation × SL distance
    - Move SL to breakeven + small buffer
  - Check if current composite score has flipped sign (score reversal exit)
    - If position is LONG and score is now negative → close
    - If position is SHORT and score is now positive → close

- Method: `async processDecisions(decisions: TradeDecision[]): Promise<void>`
  - For each decision:
    - If action is OPEN_LONG or OPEN_SHORT → call openPosition()
    - If action is CLOSE → call closePosition() if there's an open position
    - If action is NO_ACTION → skip
  - This is the main method called from the scoring cycle

## FILE 4: src/execution/index.ts (NEW barrel export)

```typescript
export { BybitClient } from './bybitClient';
export { PaperTrader } from './paperTrader';
export { PositionManager } from './positionManager';
export { OrderManager } from './orderManager';
```

## FILE 5: src/execution/orderManager.ts

Thin wrapper that delegates to either PaperTrader or BybitClient based on mode.
Keep this simple — the real logic is in PositionManager.

```typescript
// Just re-export the pattern — PositionManager handles mode switching internally.
// This file exists for future abstraction if needed.
export class OrderManager {
  // Placeholder for potential unified order interface in future iterations
}
```

## UPDATE: src/index.ts — Wire execution into main loop

Modify main() to:
1. Create BybitClient (using env vars, testnet based on PAPER_TRADING)
2. Create PaperTrader (wrapping BybitClient for price data)
3. Create PositionManager (with BybitClient, PaperTrader, paper mode flag)
4. In runScoringCycle(), after calculating decisions:
   - Call positionManager.processDecisions(decisions)
5. Add a new cron job every 15 minutes: positionManager.checkAndManagePositions()
6. On shutdown: close all open positions gracefully (optional — log warning)

Add these env vars to .env.example:
```
PAPER_BALANCE=10000
```

## UPDATE: src/types/index.ts — Add new interfaces

Add PositionSizeResult interface (defined above in positionManager section).

## IMPORTANT GUIDELINES:
- Use `crypto` from Node.js built-in (import crypto from 'crypto') for HMAC signing
- DO NOT use any third-party Bybit SDK — implement API calls directly with axios
- All monetary amounts as numbers internally, convert to strings only for API calls
- Round quantities appropriately: BTC to 3 decimals, ETH to 2, SOL to 1
- Log every order attempt and result
- Send Telegram alerts for every trade open/close
- Handle all Bybit API errors gracefully — never crash on an API error
- Rate limit protection: add a small delay (100ms) between sequential API calls
- The paper trader should behave as realistically as possible (use real prices)
- Test with PAPER_TRADING=true — never accidentally connect to mainnet

## QUANTITY PRECISION by asset:
- BTCUSDT: 3 decimal places (e.g., "0.001")
- ETHUSDT: 2 decimal places (e.g., "0.01")  
- SOLUSDT: 1 decimal place (e.g., "0.1")

Add these to ASSET_CONFIGS in src/config/assets.ts:
```typescript
qtyPrecision: 3  // BTC
qtyPrecision: 2  // ETH
qtyPrecision: 1  // SOL
```
And update the AssetConfig interface in types.

After implementing, show me:
1. How to run the bot in paper trading mode
2. A quick manual test command that opens a paper position
```

---

## NOTES FOR ED:
- Phase 3 is the most complex phase — it has real API integration, position management, and risk enforcement.
- The paper trader uses real Bybit prices but simulates everything else locally.
- ALL risk management rules from the architecture doc are enforced in positionManager.canOpenPosition().
- The trailing stop and score reversal exit logic runs every 15 minutes via checkAndManagePositions().
- Since your mock collectors produce random data, expect the bot to open and close random positions during testing. This is expected behavior — the execution pipeline is what we're validating.
- After Phase 3, we validate together, then you can start your 3-month paper trading observation period.
- DO NOT set PAPER_TRADING=false until we've validated everything thoroughly.
