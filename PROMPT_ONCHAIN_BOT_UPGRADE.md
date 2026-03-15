# On-Chain Bot — Upgrade Prompt: Extended Trade Logging + Real Exchange Netflow

## CONTEXTO

Este es el On-Chain Futures Bot (TypeScript/Node.js) corriendo en producción en un VPS DigitalOcean.
Repo: https://github.com/EdsonSilvaCastro/trading-bot-two

El bot ya funciona correctamente. Este upgrade tiene 3 objetivos concretos:
1. Agregar campos de análisis faltantes al Trade interface y a la tabla Supabase
2. Reemplazar el único mock real (`exchangeNetflow.ts`) con datos reales gratuitos
3. Activar los collectors que ya tienen implementación real pero les falta la API key

---

## DIAGNÓSTICO DEL ESTADO ACTUAL

### ✅ Lo que ya funciona correctamente (NO tocar)
- `fundingRate.ts` — Bybit API real, sin cambios
- `openInterest.ts` — Bybit API real, sin cambios
- `whaleTracker.ts` — Ya tiene implementación real con Etherscan. Solo necesita `ETHERSCAN_API_KEY` en `.env`
- `networkActivity.ts` — Ya tiene implementación real (blockchain.info para BTC, Etherscan para ETH, Helius para SOL). Solo necesita API keys
- `positionManager.ts` — Trade lifecycle correcto, llama a `updateTrade()` al cerrar. NO modificar
- `compositeScore.ts` — Scoring engine correcto. NO modificar
- `decisionEngine.ts` — Decision engine correcto. NO modificar
- `index.ts` — Entry point correcto. NO modificar

### ❌ Lo que hay que cambiar

**Problema 1:** `Trade` interface y tabla `trades` en Supabase no tienen campos de análisis críticos:
- Faltan: `mae`, `mfe`, `killzone`, `day_of_week`, `hour_utc`, `rr_achieved`

**Problema 2:** `exchangeNetflow.ts` genera números aleatorios con Box-Muller.
Es el collector de mayor peso (2.5x) y el único mock verdadero. Reemplazar con Fear & Greed Index.

**Problema 3:** `whaleTracker.ts` y `networkActivity.ts` ya tienen código real pero devuelven
score neutral (0) cuando no hay `ETHERSCAN_API_KEY`. Esto es correcto por diseño — solo hay que
agregar la key al `.env.example` con instrucciones.

---

## CAMBIO 1: Extender el Trade interface en `src/types/index.ts`

Agregar los campos nuevos al interface `Trade` existente:

```typescript
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
  rrAchieved?: number;       // ← NUEVO: R:R realizado al cierre
  scoreAtEntry: number;
  status: TradeStatus;
  isPaper: boolean;

  // Métricas de calidad de ejecución — los más valiosos para mejorar el bot
  mae?: number;              // ← NUEVO: Maximum Adverse Excursion (%)
  mfe?: number;              // ← NUEVO: Maximum Favorable Excursion (%)

  // Contexto temporal — crítico para análisis de patrones
  killzone?: string;         // ← NUEVO: 'LONDON' | 'NEW_YORK' | 'ASIA' | 'OFF_SESSION'
  dayOfWeek?: string;        // ← NUEVO: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'
  hourUtc?: number;          // ← NUEVO: 0-23
}
```

También agregar el helper `Killzone` type:
```typescript
export type Killzone = 'LONDON' | 'NEW_YORK' | 'ASIA' | 'OFF_SESSION';
```

---

## CAMBIO 2: Agregar helper `getKillzone()` en nuevo archivo `src/utils/time.ts`

Crear el archivo `src/utils/time.ts`:

```typescript
import { Killzone } from '../types';

/**
 * Returns the ICT killzone for a given UTC datetime.
 * LONDON:    02:00 - 05:00 UTC
 * NEW_YORK:  07:00 - 10:00 UTC
 * ASIA:      20:00 - 00:00 UTC
 * OFF_SESSION: everything else
 */
export function getKillzone(date: Date = new Date()): Killzone {
  const hour = date.getUTCHours();
  if (hour >= 2 && hour < 5) return 'LONDON';
  if (hour >= 7 && hour < 10) return 'NEW_YORK';
  if (hour >= 20 || hour < 1) return 'ASIA';
  return 'OFF_SESSION';
}

/**
 * Returns the day of week abbreviation in UTC.
 */
export function getDayOfWeek(date: Date = new Date()): string {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return days[date.getUTCDay()];
}
```

---

## CAMBIO 3: Actualizar `insertTrade()` en `src/database/supabase.ts`

Extender la función `insertTrade` para incluir los campos nuevos:

```typescript
export async function insertTrade(trade: Omit<Trade, 'id'>): Promise<string | null> {
  // ... existing client check ...

  const id = uuidv4();
  try {
    const { error } = await client.from('trades').insert({
      id,
      timestamp: trade.timestamp.toISOString(),
      asset: trade.asset,
      direction: trade.direction,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice ?? null,
      size_usdt: trade.sizeUsdt,
      leverage: trade.leverage,
      stop_loss: trade.stopLoss,
      take_profit: trade.takeProfit,
      pnl_usdt: trade.pnlUsdt ?? null,
      pnl_pct: trade.pnlPct ?? null,
      rr_achieved: trade.rrAchieved ?? null,           // ← NUEVO
      score_at_entry: trade.scoreAtEntry,
      status: trade.status,
      is_paper: trade.isPaper,
      mae: trade.mae ?? null,                           // ← NUEVO
      mfe: trade.mfe ?? null,                           // ← NUEVO
      killzone: trade.killzone ?? null,                 // ← NUEVO
      day_of_week: trade.dayOfWeek ?? null,             // ← NUEVO
      hour_utc: trade.hourUtc ?? null,                  // ← NUEVO
    });
    // ... rest unchanged ...
  }
}
```

También actualizar `updateTrade()` para aceptar los campos nuevos al cerrar:

```typescript
export async function updateTrade(
  tradeId: string,
  updates: Partial<Pick<Trade, 'exitPrice' | 'pnlUsdt' | 'pnlPct' | 'rrAchieved' | 'status' | 'mae' | 'mfe'>>
): Promise<boolean> {
  // ...
  if (updates.rrAchieved !== undefined) updateData.rr_achieved = updates.rrAchieved;
  if (updates.mae !== undefined) updateData.mae = updates.mae;
  if (updates.mfe !== undefined) updateData.mfe = updates.mfe;
  // ...
}
```

---

## CAMBIO 4: Actualizar `openPosition()` en `src/execution/positionManager.ts`

Al abrir una posición, capturar el contexto temporal y pasarlo a `insertTrade`:

```typescript
import { getKillzone, getDayOfWeek } from '../utils/time';

// En openPosition(), al llamar insertTrade:
const now = new Date();
const tradeId = await insertTrade({
  timestamp: now,
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
  killzone: getKillzone(now),         // ← NUEVO
  dayOfWeek: getDayOfWeek(now),       // ← NUEVO
  hourUtc: now.getUTCHours(),         // ← NUEVO
});
```

---

## CAMBIO 5: Calcular `rr_achieved` al cerrar en `positionManager.ts`

En `closePosition()` y en `checkAndManagePositions()`, calcular el R:R realizado antes de llamar `updateTrade`:

```typescript
// Calcular rr_achieved al cerrar una posición
// rrAchieved = pnlPct / stopLossPct (cuántos R se ganó/perdió)
const rrAchieved = decision.stopLossPct > 0
  ? Math.abs(pnlPct) / decision.stopLossPct * (pnlUsdt >= 0 ? 1 : -1)
  : 0;

await updateTrade(tradeId, {
  exitPrice,
  pnlUsdt,
  pnlPct,
  rrAchieved,                         // ← NUEVO
  status: pnlUsdt >= 0 ? 'CLOSED' : 'STOPPED',
});
```

**Nota:** Para `checkAndManagePositions()` (auto-close por SL/TP), el stopLossPct
está disponible desde `ASSET_CONFIGS[asset].stopLossPct`.

---

## CAMBIO 6: Reemplazar `src/collectors/exchangeNetflow.ts`

Reemplazar completamente el archivo con implementación real usando Fear & Greed Index:

```typescript
import axios from 'axios';
import { createModuleLogger } from '../monitoring/logger';
import { insertSignal } from '../database/supabase';
import { SUPPORTED_ASSETS } from '../config/assets';
import { Asset, CollectorResult } from '../types';

const log = createModuleLogger('exchange-netflow');

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

interface FearGreedResponse {
  data: Array<{
    value: string;           // 0-100
    value_classification: string; // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
    timestamp: string;
  }>;
}

/**
 * Uses the Crypto Fear & Greed Index (alternative.me) as a proxy for
 * exchange netflow / market sentiment.
 *
 * Contrarian interpretation (consistent with ICT smart money logic):
 * - Extreme Fear  (<25)  → score +2  (smart money accumulating, bullish)
 * - Fear          (25-44) → score +1
 * - Neutral       (45-55) → score  0
 * - Greed         (56-75) → score -1
 * - Extreme Greed (>75)  → score -2  (smart money distributing, bearish)
 *
 * The same score is applied to BTC, ETH, and SOL since the index
 * reflects overall crypto market sentiment.
 *
 * API: https://alternative.me/crypto/fear-and-greed-index/
 * Free, no API key required, rate limit: generous (multiple calls/day OK)
 */
export class ExchangeNetflowCollector {
  async collect(): Promise<CollectorResult[]> {
    let normalized = 0;
    let rawValue = 50; // neutral default
    let source = 'fear-greed-index';

    try {
      const score = await this.fetchFearGreedScore();
      normalized = score.normalized;
      rawValue = score.rawValue;
    } catch (err) {
      log.warn(`Fear & Greed fetch failed — using neutral score: ${(err as Error).message}`);
      source = 'fear-greed-fallback';
    }

    const results: CollectorResult[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      try {
        log.info(`${asset} fear/greed score: index=${rawValue}, normalized=${normalized}`);

        await insertSignal({
          timestamp: new Date(),
          asset,
          metric: 'exchange_netflow',
          rawValue,
          normalized,
          source,
        });

        results.push({
          success: true,
          asset,
          metric: 'exchange_netflow',
          rawValue,
          timestamp: new Date(),
        });
      } catch (err) {
        log.error(`Failed to record netflow for ${asset}: ${(err as Error).message}`);
        results.push({
          success: false,
          asset,
          metric: 'exchange_netflow',
          rawValue: 0,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  private async fetchFearGreedScore(): Promise<{ normalized: number; rawValue: number }> {
    const { data } = await axios.get<FearGreedResponse>(FEAR_GREED_URL, { timeout: 10_000 });

    if (!data.data?.length) {
      throw new Error('Empty response from Fear & Greed API');
    }

    const index = parseInt(data.data[0].value, 10);
    const classification = data.data[0].value_classification;

    log.info(`Fear & Greed Index: ${index} (${classification})`);

    return {
      rawValue: index,
      normalized: this.indexToNormalized(index),
    };
  }

  /**
   * Maps Fear & Greed index (0-100) to -2…+2 sentiment score.
   * Uses contrarian logic: extreme fear = bullish signal (smart money buys fear).
   */
  private indexToNormalized(index: number): number {
    if (index < 25) return 2;   // Extreme Fear  → bullish
    if (index < 45) return 1;   // Fear          → mildly bullish
    if (index <= 55) return 0;  // Neutral
    if (index <= 75) return -1; // Greed         → mildly bearish
    return -2;                  // Extreme Greed → bearish
  }
}
```

---

## CAMBIO 7: SQL — Migración de la tabla `trades` en Supabase

Ejecutar este SQL en Supabase Dashboard (SQL Editor) para agregar los campos nuevos
a la tabla existente **sin borrar datos**:

```sql
-- Agregar campos de análisis a la tabla trades existente
-- Usar IF NOT EXISTS para que sea seguro ejecutar múltiples veces

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS rr_achieved NUMERIC,
  ADD COLUMN IF NOT EXISTS mae NUMERIC,
  ADD COLUMN IF NOT EXISTS mfe NUMERIC,
  ADD COLUMN IF NOT EXISTS killzone TEXT CHECK (killzone IN ('LONDON', 'NEW_YORK', 'ASIA', 'OFF_SESSION')),
  ADD COLUMN IF NOT EXISTS day_of_week TEXT CHECK (day_of_week IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')),
  ADD COLUMN IF NOT EXISTS hour_utc INTEGER CHECK (hour_utc >= 0 AND hour_utc <= 23);

-- Índices para análisis de patrones
CREATE INDEX IF NOT EXISTS idx_trades_killzone ON trades(killzone);
CREATE INDEX IF NOT EXISTS idx_trades_day_of_week ON trades(day_of_week);
CREATE INDEX IF NOT EXISTS idx_trades_asset_status ON trades(asset, status);

-- Verificar que los campos se agregaron
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'trades'
ORDER BY ordinal_position;
```

**IMPORTANTE:** Ejecutar el SQL ANTES de hacer deploy del código nuevo.
Los campos son opcionales (nullable) así que el bot actual seguirá funcionando
durante el deploy.

---

## CAMBIO 8: Actualizar `.env.example`

Agregar las keys necesarias para activar los collectors reales:

```bash
# Bybit API
BYBIT_API_KEY=your_api_key_here
BYBIT_API_SECRET=your_api_secret_here
BYBIT_TESTNET=false

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Paper trading
PAPER_TRADING=true
PAPER_BALANCE=10000

# On-chain data APIs
# Etherscan — free tier en https://etherscan.io/apis
# Activa: whaleTracker (USDT flows >$1M) y networkActivity ETH (gas price)
ETHERSCAN_API_KEY=your_etherscan_key_here

# Helius — free tier en https://www.helius.dev
# Activa: networkActivity SOL (transaction throughput)
HELIUS_API_KEY=your_helius_key_here

# Fear & Greed Index: NO requiere API key (ya incluido en exchangeNetflow.ts)

# Bot mode
NODE_ENV=production
```

---

## ARCHIVOS A MODIFICAR (resumen)

| Archivo | Tipo de cambio |
|---|---|
| `src/types/index.ts` | Agregar campos a `Trade` interface + `Killzone` type |
| `src/utils/time.ts` | **NUEVO** — helpers `getKillzone()` y `getDayOfWeek()` |
| `src/database/supabase.ts` | Extender `insertTrade()` y `updateTrade()` con campos nuevos |
| `src/execution/positionManager.ts` | Capturar killzone/day al abrir, calcular rr_achieved al cerrar |
| `src/collectors/exchangeNetflow.ts` | **REEMPLAZAR COMPLETAMENTE** con Fear & Greed implementation |
| `.env.example` | Agregar ETHERSCAN_API_KEY y HELIUS_API_KEY con instrucciones |

**NO modificar:**
`fundingRate.ts`, `openInterest.ts`, `whaleTracker.ts`, `networkActivity.ts`,
`compositeScore.ts`, `decisionEngine.ts`, `index.ts`, `paperTrader.ts`

---

## VALIDACIÓN

Al terminar, verificar:

```bash
# 1. TypeScript compila sin errores
npm run build

# 2. El nuevo collector responde
npx ts-node -e "
import { ExchangeNetflowCollector } from './src/collectors/exchangeNetflow';
const c = new ExchangeNetflowCollector();
c.collect().then(r => console.log('Fear & Greed results:', r));
"

# 3. El helper de killzone funciona
npx ts-node -e "
import { getKillzone, getDayOfWeek } from './src/utils/time';
console.log('Killzone:', getKillzone());
console.log('Day:', getDayOfWeek());
console.log('Hour UTC:', new Date().getUTCHours());
"

# 4. Verificar que el SQL se ejecutó (desde Supabase Dashboard o psql)
-- SELECT column_name FROM information_schema.columns WHERE table_name='trades';
-- Debe incluir: mae, mfe, killzone, day_of_week, hour_utc, rr_achieved
```

---

## DEPLOY AL VPS

```bash
# En el VPS
cd /opt/bots/onchain-bot  # ajustar ruta según corresponda

git pull origin main

npm install
npm run build

# Agregar las keys nuevas al .env del VPS
nano .env
# Agregar: ETHERSCAN_API_KEY=tu_key_real

# Reiniciar el bot
systemctl restart onchain-bot
journalctl -u onchain-bot -f
```

---

## RESULTADO ESPERADO

Después del upgrade, cada trade en Supabase tendrá:
- `killzone` → saber si London o NY generan más edge
- `day_of_week` → detectar si hay días mejores que otros
- `hour_utc` → análisis granular de timing
- `rr_achieved` → cuántos R se ganó/perdió realmente
- `mae` / `mfe` → preparado para cuando se implemente el tracking durante posición abierta

Y el scoring engine usará datos reales en los 5 collectors:
- `exchange_netflow` → Fear & Greed Index (antes: aleatorio)
- `whale_activity` → Etherscan USDT flows (antes: neutral por falta de key)
- `network_activity` → blockchain.info + Etherscan + Helius (antes: neutral para ETH/SOL)
- `funding_rate` → Bybit API (sin cambios)
- `oi_delta` → Bybit API (sin cambios)

---

*Prompt generado para On-Chain Bot upgrade v1.0 → v1.1*
*Objetivo: nivelar al mismo estándar de logging que FVG Bot y preparar para análisis estadístico real.*
