import { createModuleLogger } from '../monitoring/logger';
import { insertTrade, updateTrade } from '../database/supabase';
import { sendAlert } from '../monitoring/telegramBot';
import { ASSET_CONFIGS, SUPPORTED_ASSETS } from '../config/assets';
import { RISK_CONFIG } from '../config/risk';
import { Asset, TradeDecision, PositionSizeResult } from '../types';
import { BybitClient } from './bybitClient';
import { PaperTrader } from './paperTrader';

const log = createModuleLogger('position-manager');

const MIDNIGHT_RESET_MS = 24 * 60 * 60 * 1000;

export class PositionManager {
  // asset → trade ID stored in DB
  private openPositions: Map<Asset, string> = new Map();
  // asset → timestamp of last loss
  private lastLossTimestamp: Map<Asset, number> = new Map();
  private dailyTradeCount = 0;
  private consecutiveLosses = 0;
  private peakBalance = 0;
  private lastDailyReset = Date.now();

  constructor(
    private readonly bybitClient: BybitClient,
    private readonly paperTrader: PaperTrader | null,
    private readonly isPaperMode: boolean,
  ) {
    log.info(`PositionManager ready (mode: ${isPaperMode ? 'PAPER' : 'LIVE'})`);
    this.initPeakBalance();
    this.scheduleMidnightReset();
  }

  // ─── Initialisation helpers ──────────────────────────────────────────────────

  private async initPeakBalance(): Promise<void> {
    const bal = await this.getBalance();
    this.peakBalance = bal;
  }

  private scheduleMidnightReset(): void {
    setInterval(() => {
      if (Date.now() - this.lastDailyReset >= MIDNIGHT_RESET_MS) {
        this.dailyTradeCount = 0;
        this.lastDailyReset = Date.now();
        log.info('Daily trade count reset');
      }
    }, 60_000);
  }

  private async getBalance(): Promise<number> {
    if (this.isPaperMode && this.paperTrader) {
      return this.paperTrader.getBalance();
    }
    return this.bybitClient.getWalletBalance();
  }

  // ─── Risk gate ────────────────────────────────────────────────────────────────

  /**
   * Validates all risk management rules before opening a position.
   */
  async canOpenPosition(asset: Asset, decision: TradeDecision): Promise<{ allowed: boolean; reason: string }> {
    if (decision.action !== 'OPEN_LONG' && decision.action !== 'OPEN_SHORT') {
      return { allowed: false, reason: `Action is ${decision.action} — not an open signal` };
    }

    if (!decision.isReliable) {
      return { allowed: false, reason: 'Decision is not reliable (< 3 fresh signals)' };
    }

    if (this.openPositions.has(asset)) {
      return { allowed: false, reason: `Already have an open position for ${asset}` };
    }

    if (this.openPositions.size >= RISK_CONFIG.maxConcurrentPositions) {
      return { allowed: false, reason: `Max concurrent positions (${RISK_CONFIG.maxConcurrentPositions}) reached` };
    }

    const lastLoss = this.lastLossTimestamp.get(asset);
    if (lastLoss && Date.now() - lastLoss < RISK_CONFIG.cooldownAfterLossMs) {
      const remaining = Math.round((RISK_CONFIG.cooldownAfterLossMs - (Date.now() - lastLoss)) / 60_000);
      return { allowed: false, reason: `Cooldown active for ${asset} — ${remaining} min remaining` };
    }

    if (this.dailyTradeCount >= RISK_CONFIG.maxDailyTrades) {
      return { allowed: false, reason: `Daily trade limit (${RISK_CONFIG.maxDailyTrades}) reached` };
    }

    if (this.consecutiveLosses >= RISK_CONFIG.consecutiveLossLimit) {
      return { allowed: false, reason: `Consecutive loss limit (${RISK_CONFIG.consecutiveLossLimit}) reached` };
    }

    const balance = await this.getBalance();
    const drawdown = this.peakBalance > 0 ? (this.peakBalance - balance) / this.peakBalance : 0;
    if (drawdown >= RISK_CONFIG.maxDrawdownPct) {
      return { allowed: false, reason: `Max drawdown (${(RISK_CONFIG.maxDrawdownPct * 100).toFixed(0)}%) reached — kill switch active` };
    }

    return { allowed: true, reason: 'All checks passed' };
  }

  // ─── Position sizing ──────────────────────────────────────────────────────────

  /**
   * Calculates position size, SL/TP prices, and margin required.
   */
  async calculatePositionSize(asset: Asset, decision: TradeDecision): Promise<PositionSizeResult> {
    const assetCfg = ASSET_CONFIGS[asset];
    const entryPrice = await this.bybitClient.getCurrentPrice(assetCfg.symbol);
    const balance = await this.getBalance();

    const riskAmount = balance * decision.positionSizePercent;
    const notionalSize = riskAmount / decision.stopLossPct;
    const rawQty = notionalSize / entryPrice;
    const quantity = rawQty.toFixed(assetCfg.qtyPrecision);
    const marginRequired = notionalSize / decision.leverage;

    const isLong = decision.action === 'OPEN_LONG';
    const stopLossPrice = isLong
      ? entryPrice * (1 - decision.stopLossPct)
      : entryPrice * (1 + decision.stopLossPct);
    const takeProfitPrice = isLong
      ? entryPrice * (1 + decision.takeProfitPct)
      : entryPrice * (1 - decision.takeProfitPct);

    return {
      notionalSize,
      quantity,
      marginRequired,
      riskAmount,
      stopLossPrice: Math.round(stopLossPrice * 100) / 100,
      takeProfitPrice: Math.round(takeProfitPrice * 100) / 100,
      entryPrice,
      leverage: decision.leverage,
    };
  }

  // ─── Open / close ─────────────────────────────────────────────────────────────

  /**
   * Opens a position for the given asset if all risk checks pass.
   * Returns the database trade ID, or null if blocked.
   */
  async openPosition(asset: Asset, decision: TradeDecision): Promise<string | null> {
    const { allowed, reason } = await this.canOpenPosition(asset, decision);
    if (!allowed) {
      log.info(`${asset}: position blocked — ${reason}`);
      return null;
    }

    let sizing: PositionSizeResult;
    try {
      sizing = await this.calculatePositionSize(asset, decision);
    } catch (err) {
      log.error(`calculatePositionSize(${asset}) failed: ${(err as Error).message}`);
      return null;
    }

    const assetCfg = ASSET_CONFIGS[asset];
    const side: 'Buy' | 'Sell' = decision.action === 'OPEN_LONG' ? 'Buy' : 'Sell';
    const orderParams = {
      symbol: assetCfg.symbol,
      side,
      orderType: 'Market' as const,
      qty: sizing.quantity,
      stopLoss: String(sizing.stopLossPrice),
      takeProfit: String(sizing.takeProfitPrice),
    };

    let orderId: string;

    if (this.isPaperMode && this.paperTrader) {
      const result = await this.paperTrader.simulateOrder(
        orderParams,
        asset,
        sizing.stopLossPrice,
        sizing.takeProfitPrice,
        sizing.leverage,
      );
      if (!result.success) {
        log.error(`Paper order failed: ${result.message}`);
        return null;
      }
      orderId = result.orderId;
    } else {
      await this.bybitClient.setLeverage(assetCfg.symbol, sizing.leverage);
      await new Promise((r) => setTimeout(r, 100));
      const result = await this.bybitClient.placeOrder(orderParams);
      if (!result.success) {
        log.error(`Live order failed: ${result.message}`);
        return null;
      }
      orderId = result.orderId;
    }

    const tradeId = await insertTrade({
      timestamp: new Date(),
      asset,
      direction: side === 'Buy' ? 'LONG' : 'SHORT',
      entryPrice: sizing.entryPrice,
      sizeUsdt: sizing.notionalSize,
      leverage: sizing.leverage,
      stopLoss: sizing.stopLossPrice,
      takeProfit: sizing.takeProfitPrice,
      scoreAtEntry: decision.score,
      status: 'OPEN',
      isPaper: this.isPaperMode,
    });

    this.openPositions.set(asset, tradeId ?? orderId);
    this.dailyTradeCount++;
    if (this.dailyTradeCount > (await this.getBalance()) && this.peakBalance === 0) {
      this.peakBalance = await this.getBalance();
    }

    const mode = this.isPaperMode ? '[PAPER] ' : '';
    const msg =
      `${mode}Position opened\n` +
      `${asset} ${decision.action} @ $${sizing.entryPrice}\n` +
      `Size: $${sizing.notionalSize.toFixed(2)} | ${sizing.leverage}x leverage\n` +
      `SL: $${sizing.stopLossPrice} | TP: $${sizing.takeProfitPrice}\n` +
      `Score: ${decision.score > 0 ? '+' : ''}${decision.score} (${decision.signal})`;

    log.info(msg);
    await sendAlert(msg);

    return tradeId ?? orderId;
  }

  /**
   * Closes the open position for an asset (if any).
   */
  async closePosition(asset: Asset, reason: string): Promise<void> {
    const tradeId = this.openPositions.get(asset);
    if (!tradeId) return;

    let pnlUsdt = 0;
    let pnlPct = 0;

    if (this.isPaperMode && this.paperTrader) {
      const result = await this.paperTrader.closePosition(tradeId, reason);
      pnlUsdt = result.pnlUsdt;
      pnlPct = result.pnlPct;
    } else {
      const assetCfg = ASSET_CONFIGS[asset];
      const positions = await this.bybitClient.getOpenPositions(assetCfg.symbol);
      const pos = positions[0];
      if (pos) {
        const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
        await this.bybitClient.placeOrder({
          symbol: assetCfg.symbol,
          side: closeSide,
          orderType: 'Market',
          qty: pos.size,
          reduceOnly: true,
        });
        pnlUsdt = Number(pos.unrealisedPnl);
      }
    }

    await updateTrade(tradeId, {
      exitPrice: undefined,
      pnlUsdt,
      pnlPct,
      status: pnlUsdt >= 0 ? 'CLOSED' : 'STOPPED',
    });

    this.openPositions.delete(asset);

    // Update risk state
    if (pnlUsdt < 0) {
      this.consecutiveLosses++;
      this.lastLossTimestamp.set(asset, Date.now());
    } else {
      this.consecutiveLosses = 0;
    }

    const currentBalance = await this.getBalance();
    if (currentBalance > this.peakBalance) {
      this.peakBalance = currentBalance;
    }

    const mode = this.isPaperMode ? '[PAPER] ' : '';
    const pnlSign = pnlUsdt >= 0 ? '+' : '';
    const msg =
      `${mode}Position closed — ${reason}\n` +
      `${asset} | PnL: ${pnlSign}$${pnlUsdt.toFixed(2)} (${pnlSign}${(pnlPct * 100).toFixed(2)}%)`;

    log.info(msg);
    await sendAlert(msg);
  }

  // ─── Periodic management ──────────────────────────────────────────────────────

  /**
   * Called every 15 minutes. Checks SL/TP hits (paper) and trailing stop logic (both modes).
   */
  async checkAndManagePositions(): Promise<void> {
    if (this.openPositions.size === 0) return;
    log.debug('Checking open positions...');

    if (this.isPaperMode && this.paperTrader) {
      const closed = await this.paperTrader.checkStopLossTakeProfit();
      for (const posId of closed) {
        // Find which asset this position belonged to
        for (const [asset, tradeId] of this.openPositions.entries()) {
          if (tradeId === posId) {
            this.openPositions.delete(asset);
            await updateTrade(posId, { status: 'STOPPED' });
            log.info(`${asset} position auto-closed by SL/TP (paper)`);
          }
        }
      }
      return;
    }

    // Live mode: check positions and apply trailing stop
    for (const [asset] of this.openPositions.entries()) {
      const assetCfg = ASSET_CONFIGS[asset];
      const positions = await this.bybitClient.getOpenPositions(assetCfg.symbol);
      const pos = positions[0];
      if (!pos) {
        // Position no longer exists externally
        this.openPositions.delete(asset);
        continue;
      }

      const entryPrice = Number(pos.entryPrice);
      const currentSL = Number(pos.stopLoss);
      const currentPrice = await this.bybitClient.getCurrentPrice(assetCfg.symbol);
      const slDistance = Math.abs(entryPrice - currentSL);

      // Trailing stop: activate when profit > trailingStopActivation × SL distance
      const pnl = Number(pos.unrealisedPnl);
      if (pnl > RISK_CONFIG.trailingStopActivation * slDistance) {
        const buffer = slDistance * 0.1;
        const newSL = pos.side === 'Buy'
          ? entryPrice + buffer
          : entryPrice - buffer;

        if ((pos.side === 'Buy' && newSL > currentSL) || (pos.side === 'Sell' && newSL < currentSL)) {
          log.info(`${asset}: Moving SL to breakeven+buffer (${newSL.toFixed(2)})`);
          await this.bybitClient.setTradingStop(assetCfg.symbol, String(newSL.toFixed(2)));
        }
      }
    }
  }

  /**
   * Processes a list of trade decisions from the scoring cycle.
   */
  async processDecisions(decisions: TradeDecision[]): Promise<void> {
    for (const decision of decisions) {
      if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
        await this.openPosition(decision.asset, decision);
      } else if (decision.action === 'CLOSE') {
        await this.closePosition(decision.asset, `Signal: ${decision.signal} (score ${decision.score})`);
      }
      // NO_ACTION: skip
    }
  }
}
