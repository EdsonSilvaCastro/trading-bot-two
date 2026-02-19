import TelegramBot from 'node-telegram-bot-api';
import { createModuleLogger } from './logger';
import { Asset } from '../types';
import type { CompositeScoreEngine } from '../engine/compositeScore';

const log = createModuleLogger('telegram');

let bot: TelegramBot | null = null;
let chatId: string | null = null;
let scoreEngine: CompositeScoreEngine | null = null;

/**
 * Registers the CompositeScoreEngine so the /scores command can call it.
 */
export function setScoreEngine(engine: CompositeScoreEngine): void {
  scoreEngine = engine;
  log.info('Score engine registered with Telegram bot');
}

/**
 * Initializes the Telegram bot. Gracefully degrades if credentials are missing.
 */
export function initTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  chatId = process.env.TELEGRAM_CHAT_ID || null;

  if (!token || !chatId) {
    log.warn('Telegram bot token or chat ID not configured — alerts disabled');
    return;
  }

  try {
    bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/status/, (msg) => {
      bot?.sendMessage(msg.chat.id, 'Bot is running. Use /scores to see latest signals.');
    });

    bot.onText(/\/scores/, async (msg) => {
      if (!scoreEngine) {
        bot?.sendMessage(msg.chat.id, 'Score engine not yet active.');
        return;
      }
      try {
        const results = await scoreEngine.calculateAllScores();
        for (const r of results) {
          const componentLines = Object.entries(r.components)
            .map(([name, val]) => `  ${name}: ${val > 0 ? '+' : ''}${val.toFixed(2)}`)
            .join('\n');
          const reliabilityTag = r.isReliable ? '✓ reliable' : '⚠ unreliable';
          const scoreStr = `${r.score > 0 ? '+' : ''}${r.score.toFixed(2)}`;
          const emoji = r.score >= 5 ? '🟢' : r.score <= -5 ? '🔴' : '🟡';
          const message =
            `${emoji} <b>${r.asset}</b> — ${scoreStr} (${r.signal}) [${reliabilityTag}]\n` +
            `Fresh signals: ${r.freshSignalCount}/5\n\n` +
            `<code>${componentLines}</code>`;
          await bot?.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        }
      } catch (err) {
        bot?.sendMessage(msg.chat.id, `Error calculating scores: ${(err as Error).message}`);
      }
    });

    bot.onText(/\/pause/, (msg) => {
      // Placeholder — will implement pause/resume in Phase 3
      bot?.sendMessage(msg.chat.id, 'Pause functionality coming in Phase 3.');
    });

    log.info('Telegram bot initialized with polling');
  } catch (err) {
    log.error(`Failed to initialize Telegram bot: ${(err as Error).message}`);
  }
}

/**
 * Sends a plain text alert message to the configured Telegram chat
 */
export async function sendAlert(message: string): Promise<void> {
  if (!bot || !chatId) {
    log.debug(`Alert (Telegram disabled): ${message}`);
    return;
  }

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    log.error(`Failed to send Telegram alert: ${(err as Error).message}`);
  }
}

/**
 * Sends a formatted signal update for an asset
 */
export async function sendSignalUpdate(
  asset: Asset,
  score: number,
  signal: string,
  components: Record<string, number>
): Promise<void> {
  const componentLines = Object.entries(components)
    .map(([name, value]) => `  ${name}: ${value > 0 ? '+' : ''}${value.toFixed(2)}`)
    .join('\n');

  const emoji = score >= 5 ? '🟢' : score <= -5 ? '🔴' : '🟡';
  const message = `${emoji} <b>${asset} Signal Update</b>\n\nScore: <b>${score.toFixed(1)}</b> (${signal})\n\nComponents:\n<code>${componentLines}</code>`;

  await sendAlert(message);
}

/**
 * Stops the Telegram bot polling
 */
export function stopTelegramBot(): void {
  if (bot) {
    bot.stopPolling();
    log.info('Telegram bot polling stopped');
  }
}
