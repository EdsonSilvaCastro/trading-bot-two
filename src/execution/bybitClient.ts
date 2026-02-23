import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../monitoring/logger';

const log = createModuleLogger('bybit-client');

const RECV_WINDOW = '5000';

export interface OrderParams {
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  takeProfit?: string;
  stopLoss?: string;
  timeInForce?: string;
  reduceOnly?: boolean;
}

export interface OrderResult {
  orderId: string;
  orderLinkId: string;
  success: boolean;
  message: string;
}

export interface PositionInfo {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  entryPrice: string;
  unrealisedPnl: string;
  leverage: string;
  takeProfit: string;
  stopLoss: string;
}

export class BybitClient {
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(apiKey: string, apiSecret: string, testnet: boolean) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    const baseURL = testnet
      ? 'https://api-demo.bybit.com'
      : 'https://api.bybit.com';

    this.http = axios.create({ baseURL, timeout: 10_000 });
    log.info(`BybitClient initialized (${testnet ? 'testnet' : 'mainnet'})`);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private sign(timestamp: string, payload: string): string {
    const raw = `${timestamp}${this.apiKey}${RECV_WINDOW}${payload}`;
    return crypto.createHmac('sha256', this.apiSecret).update(raw).digest('hex');
  }

  private authHeaders(timestamp: string, sign: string): Record<string, string> {
    return {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };
  }

  private async signedGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const ts = Date.now().toString();
    const query = new URLSearchParams(params).toString();
    const headers = this.authHeaders(ts, this.sign(ts, query));
    const url = query ? `${path}?${query}` : path;
    const res = await this.http.get(url, { headers });
    return res.data as T;
  }

  private async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const ts = Date.now().toString();
    const payload = JSON.stringify(body);
    const headers = {
      ...this.authHeaders(ts, this.sign(ts, payload)),
      'Content-Type': 'application/json',
    };
    const res = await this.http.post(path, body, { headers });
    return res.data as T;
  }

  // ─── Public endpoints (no auth) ─────────────────────────────────────────────

  /**
   * Returns the latest market price for a symbol.
   */
  async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const res = await this.http.get('/v5/market/tickers', {
        params: { category: 'linear', symbol },
      });
      const price = Number(res.data?.result?.list?.[0]?.lastPrice);
      if (!price) throw new Error('No price in response');
      return price;
    } catch (err) {
      log.error(`getCurrentPrice(${symbol}) failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // ─── Authenticated endpoints ─────────────────────────────────────────────────

  /**
   * Returns available USDT balance from the Unified account.
   */
  async getWalletBalance(): Promise<number> {
    try {
      const data = await this.signedGet<any>('/v5/account/wallet-balance', {
        accountType: 'UNIFIED',
        coin: 'USDT',
      });
      const balance = Number(data?.result?.list?.[0]?.coin?.[0]?.availableToWithdraw ?? 0);
      log.debug(`Wallet balance: ${balance} USDT`);
      return balance;
    } catch (err) {
      log.error(`getWalletBalance failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Sets leverage for a symbol. Silently ignores "leverage not modified" (110043).
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      const data = await this.signedPost<any>('/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
      if (data?.retCode !== 0 && data?.retCode !== 110043) {
        log.warn(`setLeverage(${symbol}, ${leverage}x) returned: ${data?.retMsg}`);
      } else {
        log.debug(`Leverage set: ${symbol} → ${leverage}x`);
      }
    } catch (err) {
      log.error(`setLeverage(${symbol}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Places a market or limit order.
   */
  async placeOrder(params: OrderParams): Promise<OrderResult> {
    try {
      const body: Record<string, unknown> = {
        category: 'linear',
        symbol: params.symbol,
        side: params.side,
        orderType: params.orderType,
        qty: params.qty,
        timeInForce: params.timeInForce ?? 'GTC',
      };
      if (params.price) body.price = params.price;
      if (params.takeProfit) body.takeProfit = params.takeProfit;
      if (params.stopLoss) body.stopLoss = params.stopLoss;
      if (params.reduceOnly) body.reduceOnly = params.reduceOnly;

      log.info(`Placing order: ${params.side} ${params.qty} ${params.symbol}`);
      const data = await this.signedPost<any>('/v5/order/create', body);

      if (data?.retCode !== 0) {
        log.error(`placeOrder failed: ${data?.retMsg}`);
        return { orderId: '', orderLinkId: '', success: false, message: data?.retMsg ?? 'Unknown error' };
      }

      return {
        orderId: data.result.orderId,
        orderLinkId: data.result.orderLinkId,
        success: true,
        message: 'Order placed',
      };
    } catch (err) {
      log.error(`placeOrder exception: ${(err as Error).message}`);
      return { orderId: '', orderLinkId: '', success: false, message: (err as Error).message };
    }
  }

  /**
   * Cancels an open order by orderId.
   */
  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    try {
      const data = await this.signedPost<any>('/v5/order/cancel', {
        category: 'linear',
        symbol,
        orderId,
      });
      return data?.retCode === 0;
    } catch (err) {
      log.error(`cancelOrder(${orderId}) failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Returns all open linear positions. Optionally filtered by symbol.
   */
  async getOpenPositions(symbol?: string): Promise<PositionInfo[]> {
    try {
      const params: Record<string, string> = { category: 'linear', settleCoin: 'USDT' };
      if (symbol) params.symbol = symbol;
      const data = await this.signedGet<any>('/v5/position/list', params);
      const list: any[] = data?.result?.list ?? [];
      return list
        .filter((p) => Number(p.size) > 0)
        .map((p) => ({
          symbol: p.symbol,
          side: p.side as 'Buy' | 'Sell' | 'None',
          size: p.size,
          entryPrice: p.avgPrice,
          unrealisedPnl: p.unrealisedPnl,
          leverage: p.leverage,
          takeProfit: p.takeProfit,
          stopLoss: p.stopLoss,
        }));
    } catch (err) {
      log.error(`getOpenPositions failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Updates SL, TP, or trailing stop on an open position.
   */
  async setTradingStop(
    symbol: string,
    stopLoss?: string,
    takeProfit?: string,
    trailingStop?: string,
  ): Promise<void> {
    try {
      const body: Record<string, unknown> = { category: 'linear', symbol, positionIdx: 0 };
      if (stopLoss) body.stopLoss = stopLoss;
      if (takeProfit) body.takeProfit = takeProfit;
      if (trailingStop) body.trailingStop = trailingStop;
      await this.signedPost('/v5/position/trading-stop', body);
      log.debug(`setTradingStop(${symbol}): SL=${stopLoss} TP=${takeProfit}`);
    } catch (err) {
      log.error(`setTradingStop(${symbol}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Returns order history for a symbol.
   */
  async getOrderHistory(symbol: string, limit = 20): Promise<any[]> {
    try {
      const data = await this.signedGet<any>('/v5/order/history', {
        category: 'linear',
        symbol,
        limit: String(limit),
      });
      return data?.result?.list ?? [];
    } catch (err) {
      log.error(`getOrderHistory(${symbol}) failed: ${(err as Error).message}`);
      return [];
    }
  }
}
