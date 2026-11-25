import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

// BullMQ duplicates worker connections for blocking commands. Track those clients
// too: closing only the original connection leaves reconnection timers behind.
export class OwnedRedis extends Redis {
  constructor(
    options: RedisOptions,
    private readonly own: (client: Redis) => void,
  ) {
    super({ ...options, replyMapping: 'legacy' });
    own(this);
  }

  override duplicate(options?: Partial<RedisOptions>): Redis {
    return new OwnedRedis({ ...this.options, ...options }, this.own);
  }
}
