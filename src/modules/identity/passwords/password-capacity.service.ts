import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PASSWORD_CAPACITY } from './password.config.js';
import { PasswordCapacityError } from './password.errors.js';

interface Waiter {
  resolve: () => void;
  reject: (error: PasswordCapacityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class PasswordCapacity implements OnModuleDestroy {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private closed = false;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new PasswordCapacityError());
    if (this.active < PASSWORD_CAPACITY.active) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= PASSWORD_CAPACITY.waiting)
      return Promise.reject(new PasswordCapacityError());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(new PasswordCapacityError());
        }, PASSWORD_CAPACITY.waitTimeoutMs),
      };
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else this.active--;
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new PasswordCapacityError());
    }
    // Running native operations cannot safely be cancelled. Their finally blocks
    // release capacity; no timeout starts a second operation in an occupied slot.
  }
}
