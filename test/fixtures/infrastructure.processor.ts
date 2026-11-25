import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type {
  QueueJobMetadata,
  QueueProcessor,
} from '../../src/infrastructure/queues/queue-runtime.service.js';

export const INFRASTRUCTURE_QUEUE = 'infrastructure-verification';
export const INFRASTRUCTURE_JOB = 'verify.v1';

export interface InfrastructurePayload extends QueueJobMetadata {
  nonce: string;
  failUntilAttempt?: number;
  alwaysFail?: boolean;
  hold?: boolean;
}
export interface InfrastructureResult {
  nonce: string;
  verified: true;
}

// Test-only fixture. This file is outside the production compilation and graph.
@Injectable()
export class InfrastructureProcessor implements QueueProcessor<
  InfrastructurePayload,
  InfrastructureResult,
  typeof INFRASTRUCTURE_JOB
> {
  private readonly pending = new Map<string, () => void>();
  private readonly cancelled = new Set<string>();

  release(nonce: string): void {
    this.pending.get(nonce)?.();
  }
  releaseAll(): void {
    for (const release of this.pending.values()) release();
  }
  isWaiting(nonce: string): boolean {
    return this.pending.has(nonce);
  }
  wasCancelled(nonce: string): boolean {
    return this.cancelled.has(nonce);
  }
  process(
    job: Pick<
      Job<
        InfrastructurePayload,
        InfrastructureResult,
        typeof INFRASTRUCTURE_JOB
      >,
      'data' | 'name' | 'attemptsMade'
    >,
    signal: AbortSignal,
  ): Promise<InfrastructureResult> {
    const data: unknown = job.data;
    if (
      job.name !== INFRASTRUCTURE_JOB ||
      typeof data !== 'object' ||
      data === null ||
      !('nonce' in data) ||
      typeof data.nonce !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(data.nonce)
    ) {
      throw new Error('Invalid infrastructure verification payload');
    }
    const failUntil = 'failUntilAttempt' in data ? data.failUntilAttempt : 0;
    if (
      typeof failUntil !== 'number' ||
      !Number.isInteger(failUntil) ||
      failUntil < 0 ||
      failUntil > 2
    ) {
      throw new Error('Invalid infrastructure retry count');
    }
    if (signal.aborted)
      throw new Error('Infrastructure verification cancelled');
    if (
      ('alwaysFail' in data && typeof data.alwaysFail !== 'boolean') ||
      ('hold' in data && typeof data.hold !== 'boolean')
    )
      throw new Error('Invalid infrastructure controls');
    if ('alwaysFail' in data && data.alwaysFail)
      throw new Error('Controlled permanent infrastructure failure');
    if (job.attemptsMade < failUntil)
      throw new Error('Controlled infrastructure retry');
    const result: InfrastructureResult = { nonce: data.nonce, verified: true };
    if ('hold' in data && data.hold) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          this.pending.delete(result.nonce);
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          this.cancelled.add(result.nonce);
          reject(new Error('Infrastructure verification cancelled'));
        };
        this.pending.set(result.nonce, () => {
          cleanup();
          resolve(result);
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    return Promise.resolve(result);
  }
}
