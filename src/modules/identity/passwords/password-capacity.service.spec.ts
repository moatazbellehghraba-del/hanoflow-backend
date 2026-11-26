import { jest } from '@jest/globals';
import { PasswordCapacity } from './password-capacity.service.js';
import { PasswordCapacityError } from './password.errors.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Password work capacity', () => {
  afterEach(() => jest.useRealTimers());

  it('runs one operation, queues two FIFO and rejects overflow', async () => {
    const capacity = new PasswordCapacity();
    const hold = gate();
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const run = (id: number) =>
      capacity.run(async () => {
        active++;
        peak = Math.max(peak, active);
        started.push(id);
        if (id === 1) await hold.promise;
        active--;
        return id;
      });
    const first = run(1);
    const second = run(2);
    const third = run(3);
    await expect(run(4)).rejects.toBeInstanceOf(PasswordCapacityError);
    expect(started).toEqual([1]);
    hold.release();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(started).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it('releases occupied capacity after operation failure', async () => {
    const capacity = new PasswordCapacity();
    await expect(
      capacity.run(() => Promise.reject(new Error('synthetic'))),
    ).rejects.toThrow('synthetic');
    await expect(capacity.run(() => Promise.resolve(true))).resolves.toBe(true);
  });

  it('expires queued work without releasing the occupied native slot', async () => {
    jest.useFakeTimers();
    const capacity = new PasswordCapacity();
    const hold = gate();
    const first = capacity.run(() => hold.promise);
    let secondStarted = false;
    const second = capacity.run(() => {
      secondStarted = true;
      return Promise.resolve();
    });
    const rejection = expect(second).rejects.toBeInstanceOf(
      PasswordCapacityError,
    );
    await jest.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(secondStarted).toBe(false);
    const third = capacity.run(() => Promise.resolve(true));
    hold.release();
    await first;
    await expect(third).resolves.toBe(true);
  });

  it('rejects queued and new work on module teardown while active work finishes', async () => {
    const capacity = new PasswordCapacity();
    const hold = gate();
    const first = capacity.run(() => hold.promise);
    const queued = capacity.run(() => Promise.resolve());
    const rejection = expect(queued).rejects.toBeInstanceOf(
      PasswordCapacityError,
    );
    capacity.onModuleDestroy();
    await rejection;
    await expect(capacity.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      PasswordCapacityError,
    );
    hold.release();
    await first;
  });
});
