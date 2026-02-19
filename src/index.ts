import dotenv from 'dotenv';
dotenv.config();

import logger, { createModuleLogger } from './monitoring/logger';
import { getSupabaseClient } from './database/supabase';
import { initTelegramBot, stopTelegramBot, sendAlert } from './monitoring/telegramBot';
import { CollectorOrchestrator } from './collectors';

const log = createModuleLogger('main');

let orchestrator: CollectorOrchestrator | null = null;

async function main(): Promise<void> {
  log.info('=== On-Chain Futures Bot Starting ===');
  log.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  log.info(`Paper trading: ${process.env.PAPER_TRADING !== 'false' ? 'ENABLED' : 'DISABLED'}`);

  // Initialize Supabase
  const supabase = getSupabaseClient();
  if (supabase) {
    log.info('Supabase client ready');
  } else {
    log.warn('Running without database — data will not be persisted');
  }

  // Initialize Telegram
  initTelegramBot();

  // Initialize and start collectors
  orchestrator = new CollectorOrchestrator();

  // Run all collectors once on startup for initial data
  log.info('Running initial data collection...');
  await orchestrator.runAll();

  // Start scheduled collection
  orchestrator.start();

  await sendAlert('Bot started successfully. Data collection active.');
  log.info('=== Bot is running ===');
}

function shutdown(signal: string): void {
  log.info(`Received ${signal} — shutting down gracefully...`);

  if (orchestrator) {
    orchestrator.stop();
  }
  stopTelegramBot();

  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}`);
  shutdown('uncaughtException');
});

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
