import type { Environment } from "../config/env.js";
import type { JobRunner } from "./runtime.js";

export interface ScheduledJobDefinition {
  name: JobRunner["name"];
  cron: string;
  runner: JobRunner;
}

export interface CronScheduler {
  schedule(definition: ScheduledJobDefinition): void;
  start(): void;
  stop?(): Promise<void> | void;
}

export interface StartupJobExecution {
  runner: JobRunner;
  enabled: boolean;
}

export interface ScheduleApplicationJobsInput {
  scheduler: CronScheduler;
  jobs: ScheduledJobDefinition[];
}

export interface ApplicationJobSchedulePlan {
  scheduledJobs: ScheduledJobDefinition[];
  startupJobs: StartupJobExecution[];
}

export function scheduleApplicationJobs(input: ScheduleApplicationJobsInput): void {
  for (const job of input.jobs) {
    input.scheduler.schedule(job);
  }

  input.scheduler.start();
}

export function buildApplicationJobSchedulePlan(input: {
  env: Environment;
  normalFaresRunner: JobRunner;
  businessDealsRunner: JobRunner;
}): ApplicationJobSchedulePlan {
  // Note: the local scheduler is meant for development; production runs on
  // GitHub Actions. The in-memory scheduler only supports cron shapes like
  // "*/N * * * *", "0 */N * * *" and "0 * * * *".
  return {
    scheduledJobs: [
      {
        name: input.normalFaresRunner.name,
        cron: input.env.NORMAL_FARES_CRON,
        runner: input.normalFaresRunner
      },
      {
        name: input.businessDealsRunner.name,
        cron: input.env.BUSINESS_DEALS_CRON,
        runner: input.businessDealsRunner
      }
    ],
    startupJobs: [
      {
        runner: input.normalFaresRunner,
        enabled: input.env.RUN_NORMAL_FARES_ON_STARTUP
      },
      {
        runner: input.businessDealsRunner,
        enabled: input.env.RUN_BUSINESS_DEALS_ON_STARTUP
      }
    ]
  };
}

export async function runStartupJobs(jobs: StartupJobExecution[]): Promise<void> {
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }

    await job.runner.run();
  }
}
