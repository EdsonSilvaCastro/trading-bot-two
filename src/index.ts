import dotenv from 'dotenv';
dotenv.config();

import logger, { createModuleLogger } from './monitoring/logger';
import { getSupabaseClient } from './database/supabase';
import { initTelegramBot, stopTelegramBot, sendAlert, sendSignalUpdate, setScoreEngine } from './monitoring/telegramBot';
import { CollectorOrchestrator } from './collectors';
import { SignalProcessor, CompositeScoreEngine, DecisionEngine } from './engine';

const log = createModuleLogger('main');

const SCORING_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let orchestrator: CollectorOrchestrator | null = null;
let scoringTimer: NodeJS.Timeout | null = null;

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

  // Initialize scoring engine
  const signalProcessor = new SignalProcessor();
  const compositeScoreEngine = new CompositeScoreEngine(signalProcessor);
  const decisionEngine = new DecisionEngine(compositeScoreEngine);

  // Wire score engine into Telegram /scores command
  setScoreEngine(compositeScoreEngine);

  // Run scoring cycle once on startup (after initial data collection)
  async function runScoringCycle(): Promise<void> {
    log.info('Running scoring cycle...');
    try {
      const scores = await compositeScoreEngine.calculateAllScores();
      const decisions = await decisionEngine.evaluateAll();
      const summary = decisionEngine.formatDecisionSummary(decisions);

      log.info(summary);

      for (const r of scores) {
        await sendSignalUpdate(r.asset, r.score, r.signal, r.components);
      }

      await sendAlert(`<b>Scoring Cycle Complete</b>\n<pre>${summary}</pre>`);
    } catch (err) {
      log.error(`Scoring cycle failed: ${(err as Error).message}`);
    }
  }

  await runScoringCycle();

  // Schedule scoring every 4 hours
  scoringTimer = setInterval(runScoringCycle, SCORING_INTERVAL_MS);

  await sendAlert('Bot started successfully. Data collection and scoring active.');
  log.info('=== Bot is running ===');
}

function shutdown(signal: string): void {
  log.info(`Received ${signal} — shutting down gracefully...`);

  if (orchestrator) {
    orchestrator.stop();
  }
  if (scoringTimer) {
    clearInterval(scoringTimer);
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
