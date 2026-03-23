import dotenv from 'dotenv';
dotenv.config();

import logger, { createModuleLogger } from './monitoring/logger';
import { getSupabaseClient } from './database/supabase';
import { sendHeartbeat, checkDashboardCommands, isPaused } from './database/dashboardClient';
import { initTelegramBot, stopTelegramBot, sendAlert, sendSignalUpdate, setScoreEngine } from './monitoring/telegramBot';
import { CollectorOrchestrator } from './collectors';
import { SignalProcessor, CompositeScoreEngine, DecisionEngine } from './engine';
import { BybitClient, PaperTrader, PositionManager } from './execution';

const log = createModuleLogger('main');

const SCORING_INTERVAL_MS  = 4 * 60 * 60 * 1000;   // 4 hours
const POSITION_CHECK_MS    = 15 * 60 * 1000;         // 15 minutes
const DASHBOARD_CHECK_MS   = 60 * 1000;              // 1 minute

const isPaperMode = process.env.PAPER_TRADING !== 'false';

let orchestrator: CollectorOrchestrator | null = null;
let scoringTimer: NodeJS.Timeout | null = null;
let positionCheckTimer: NodeJS.Timeout | null = null;
let dashboardTimer: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  log.info('=== On-Chain Futures Bot Starting ===');
  log.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  log.info(`Paper trading: ${isPaperMode ? 'ENABLED' : 'DISABLED'}`);

  // Initialize Supabase
  const supabase = getSupabaseClient();
  if (supabase) {
    log.info('Supabase client ready');
  } else {
    log.warn('Running without database — data will not be persisted');
  }

  // Initialize Telegram
  initTelegramBot();

  // Initialize collectors
  orchestrator = new CollectorOrchestrator();
  log.info('Running initial data collection...');
  await orchestrator.runAll();
  orchestrator.start();

  // Initialize scoring engine
  const signalProcessor = new SignalProcessor();
  const compositeScoreEngine = new CompositeScoreEngine(signalProcessor);
  const decisionEngine = new DecisionEngine(compositeScoreEngine);
  setScoreEngine(compositeScoreEngine);

  // Initialize execution layer
  const bybitClient = new BybitClient(
    process.env.BYBIT_API_KEY ?? '',
    process.env.BYBIT_API_SECRET ?? '',
    isPaperMode || process.env.BYBIT_TESTNET !== 'false',
  );
  const paperTrader = new PaperTrader(bybitClient);
  const positionManager = new PositionManager(
    bybitClient,
    isPaperMode ? paperTrader : null,
    isPaperMode,
  );

  // Dashboard heartbeat + command polling (every 1 minute)
  dashboardTimer = setInterval(async () => {
    await checkDashboardCommands(() => shutdown('KILL'));
    const activePositions = isPaperMode
      ? (await paperTrader.getOpenPositions()).length
      : 0;
    await sendHeartbeat(activePositions);
  }, DASHBOARD_CHECK_MS);

  // Scoring + execution cycle
  async function runScoringCycle(): Promise<void> {
    if (isPaused()) { log.info('⏸ Bot is PAUSED — skipping scoring cycle'); return; }
    log.info('Running scoring cycle...');
    try {
      const scores = await compositeScoreEngine.calculateAllScores();
      const decisions = scores.map((s) => decisionEngine.evaluateFromScore(s));
      const summary = decisionEngine.formatDecisionSummary(decisions);

      log.info(summary);

      for (const r of scores) {
        await sendSignalUpdate(r.asset, r.score, r.signal, r.components);
      }

      await sendAlert(`<b>Scoring Cycle Complete</b>\n<pre>${summary}</pre>`);

      // Execute decisions
      await positionManager.processDecisions(decisions);
    } catch (err) {
      log.error(`Scoring cycle failed: ${(err as Error).message}`);
    }
  }

  // Run once on startup
  await runScoringCycle();

  // Schedule every 4 hours
  scoringTimer = setInterval(runScoringCycle, SCORING_INTERVAL_MS);

  // Position monitoring every 15 minutes
  positionCheckTimer = setInterval(async () => {
    try {
      await positionManager.checkAndManagePositions();
    } catch (err) {
      log.error(`Position check failed: ${(err as Error).message}`);
    }
  }, POSITION_CHECK_MS);

  await sendAlert('Bot started successfully. Data collection, scoring and execution active.');
  log.info('=== Bot is running ===');
}

function shutdown(signal: string): void {
  log.info(`Received ${signal} — shutting down gracefully...`);

  if (orchestrator) orchestrator.stop();
  if (scoringTimer) clearInterval(scoringTimer);
  if (positionCheckTimer) clearInterval(positionCheckTimer);
  if (dashboardTimer) clearInterval(dashboardTimer);
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
