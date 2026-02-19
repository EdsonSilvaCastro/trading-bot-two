import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../monitoring/logger';
import { Asset } from '../types';
import { BybitClient, OrderParams, OrderResult } from './bybitClient';

const log = createModuleLogger('paper-trader');

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

export class PaperTrader {
  private positions: Map<string, PaperPosition> = new Map();
  private balance: number;

  constructor(private readonly bybitClient: BybitClient) {
    this.balance = Number(process.env.PAPER_BALANCE ?? 10_000);
    log.info(`PaperTrader initialized. Starting balance: $${this.balance}`);
  }

  /**
   * Simulates order execution using the current market price.
   */
  async simulateOrder(params: OrderParams, asset: Asset, stopLoss: number, takeProfit: number, leverage: number): Promise<OrderResult> {
    try {
      const entryPrice = await this.bybitClient.getCurrentPrice(params.symbol);
      if (!entryPrice) {
        return { orderId: '', orderLinkId: '', success: false, message: 'Could not fetch price' };
      }

      const id = uuidv4();
      const size = Number(params.qty);
      const position: PaperPosition = {
        id,
        asset,
        symbol: params.symbol,
        side: params.side,
        size,
        entryPrice,
        stopLoss,
        takeProfit,
        leverage,
        openedAt: new Date(),
        unrealisedPnl: 0,
      };
      this.positions.set(id, position);

      log.info(`[PAPER] Opened ${params.side} ${size} ${params.symbol} @ ${entryPrice} | SL=${stopLoss} TP=${takeProfit}`);
      return { orderId: id, orderLinkId: id, success: true, message: 'Paper order simulated' };
    } catch (err) {
      log.error(`simulateOrder failed: ${(err as Error).message}`);
      return { orderId: '', orderLinkId: '', success: false, message: (err as Error).message };
    }
  }

  /**
   * Returns all open paper positions with up-to-date unrealised PnL.
   */
  async getOpenPositions(): Promise<PaperPosition[]> {
    const updated: PaperPosition[] = [];
    for (const pos of this.positions.values()) {
      const currentPrice = await this.bybitClient.getCurrentPrice(pos.symbol);
      if (currentPrice) {
        const priceDiff = pos.side === 'Buy'
          ? currentPrice - pos.entryPrice
          : pos.entryPrice - currentPrice;
        pos.unrealisedPnl = priceDiff * pos.size * pos.leverage;
      }
      updated.push(pos);
    }
    return updated;
  }

  /**
   * Closes a paper position by ID and returns realised P&L.
   */
  async closePosition(positionId: string, reason: string): Promise<{ pnlUsdt: number; pnlPct: number }> {
    const pos = this.positions.get(positionId);
    if (!pos) {
      log.warn(`closePosition: position ${positionId} not found`);
      return { pnlUsdt: 0, pnlPct: 0 };
    }

    try {
      const exitPrice = await this.bybitClient.getCurrentPrice(pos.symbol);
      const priceDiff = pos.side === 'Buy'
        ? exitPrice - pos.entryPrice
        : pos.entryPrice - exitPrice;

      const pnlUsdt = priceDiff * pos.size * pos.leverage;
      const pnlPct = (priceDiff / pos.entryPrice) * pos.leverage;

      this.balance += pnlUsdt;
      this.positions.delete(positionId);

      log.info(`[PAPER] Closed ${pos.symbol} ${pos.side} @ ${exitPrice} | PnL: $${pnlUsdt.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%) | Reason: ${reason}`);
      log.info(`[PAPER] Balance: $${this.balance.toFixed(2)}`);

      return { pnlUsdt, pnlPct };
    } catch (err) {
      log.error(`closePosition(${positionId}) failed: ${(err as Error).message}`);
      return { pnlUsdt: 0, pnlPct: 0 };
    }
  }

  /**
   * Returns the current simulated balance.
   */
  getBalance(): number {
    return this.balance;
  }

  /**
   * Checks each open position for SL/TP hits. Auto-closes if triggered.
   * Returns the list of closed position IDs.
   */
  async checkStopLossTakeProfit(): Promise<string[]> {
    const closed: string[] = [];

    for (const pos of this.positions.values()) {
      const currentPrice = await this.bybitClient.getCurrentPrice(pos.symbol);
      if (!currentPrice) continue;

      let reason: string | null = null;

      if (pos.side === 'Buy') {
        if (currentPrice <= pos.stopLoss) reason = `Stop loss hit @ ${currentPrice}`;
        else if (currentPrice >= pos.takeProfit) reason = `Take profit hit @ ${currentPrice}`;
      } else {
        if (currentPrice >= pos.stopLoss) reason = `Stop loss hit @ ${currentPrice}`;
        else if (currentPrice <= pos.takeProfit) reason = `Take profit hit @ ${currentPrice}`;
      }

      if (reason) {
        await this.closePosition(pos.id, reason);
        closed.push(pos.id);
      }
    }

    return closed;
  }

  /**
   * Returns a paper position by its ID, or undefined.
   */
  getPositionById(id: string): PaperPosition | undefined {
    return this.positions.get(id);
  }
}
