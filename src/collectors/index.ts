import cron from 'node-cron';
import { createModuleLogger } from '../monitoring/logger';
import { FundingRateCollector } from './fundingRate';
import { OpenInterestCollector } from './openInterest';
import { PriceDataCollector } from './priceData';
import { ExchangeNetflowCollector } from './exchangeNetflow';
import { WhaleTrackerCollector } from './whaleTracker';
import { NetworkActivityCollector } from './networkActivity';
import { CollectorResult } from '../types';

const log = createModuleLogger('orchestrator');

interface ScheduledCollector {
  name: string;
  collector: { collect(): Promise<CollectorResult[]> };
  cronExpression: string;
  task?: cron.ScheduledTask;
}

/**
 * Orchestrates all data collectors on scheduled intervals.
 */
export class CollectorOrchestrator {
  private collectors: ScheduledCollector[];

  constructor() {
    this.collectors = [
      {
        name: 'FundingRate',
        collector: new FundingRateCollector(),
        cronExpression: '0 */8 * * *', // Every 8 hours
      },
      {
        name: 'OpenInterest',
        collector: new OpenInterestCollector(),
        cronExpression: '0 * * * *', // Every 1 hour
      },
      {
        name: 'PriceData',
        collector: new PriceDataCollector(),
        cronExpression: '*/15 * * * *', // Every 15 minutes
      },
      {
        name: 'ExchangeNetflow',
        collector: new ExchangeNetflowCollector(),
        cronExpression: '5 * * * *', // Every 1 hour (offset by 5 min)
      },
      {
        name: 'WhaleTracker',
        collector: new WhaleTrackerCollector(),
        cronExpression: '*/15 * * * *', // Every 15 minutes
      },
      {
        name: 'NetworkActivity',
        collector: new NetworkActivityCollector(),
        cronExpression: '10 */4 * * *', // Every 4 hours (offset by 10 min)
      },
    ];
  }

  /**
   * Starts all scheduled collectors
   */
  start(): void {
    log.info(`Starting collector orchestrator with ${this.collectors.length} collectors`);

    for (const scheduled of this.collectors) {
      scheduled.task = cron.schedule(scheduled.cronExpression, async () => {
        await this.runCollector(scheduled);
      });
      log.info(`Scheduled ${scheduled.name} with cron: ${scheduled.cronExpression}`);
    }

    log.info('All collectors scheduled successfully');
  }

  /**
   * Stops all scheduled collectors
   */
  stop(): void {
    for (const scheduled of this.collectors) {
      scheduled.task?.stop();
    }
    log.info('All collectors stopped');
  }

  /**
   * Runs all collectors once (useful for testing and initial data fetch)
   */
  async runAll(): Promise<void> {
    log.info('Running all collectors once...');

    for (const scheduled of this.collectors) {
      await this.runCollector(scheduled);
    }

    log.info('All collectors completed single run');
  }

  private async runCollector(scheduled: ScheduledCollector): Promise<void> {
    const startTime = Date.now();
    log.info(`Running ${scheduled.name}...`);

    try {
      const results = await scheduled.collector.collect();
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      const elapsed = Date.now() - startTime;

      log.info(
        `${scheduled.name} completed in ${elapsed}ms: ${successCount} success, ${failCount} failed`
      );
    } catch (err) {
      log.error(`${scheduled.name} crashed: ${(err as Error).message}`);
    }
  }
}

export { FundingRateCollector } from './fundingRate';
export { OpenInterestCollector } from './openInterest';
export { PriceDataCollector } from './priceData';
export { ExchangeNetflowCollector } from './exchangeNetflow';
export { WhaleTrackerCollector } from './whaleTracker';
export { NetworkActivityCollector } from './networkActivity';
