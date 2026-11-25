export const QUEUE_CONNECTION_TIMEOUT_MS = 2000;
export const QUEUE_PRODUCER_BUDGET_MS = 2000;
export const QUEUE_SHUTDOWN_BUDGET_MS = 30000;
export const QUEUE_SHUTDOWN_CLEANUP_MS = 1000;
export const QUEUE_WORKER_CONCURRENCY = 1;

export function validateQueueName(name: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Invalid queue name');
  }
}

export function validateJobName(name: string): void {
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.v[1-9]\d*$/.test(name) ||
    name.length > 96
  ) {
    throw new Error('Invalid job name');
  }
}
