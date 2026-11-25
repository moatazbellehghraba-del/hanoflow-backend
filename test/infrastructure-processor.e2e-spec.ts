import 'reflect-metadata';
import {
  InfrastructureProcessor,
  INFRASTRUCTURE_JOB,
  type InfrastructurePayload,
} from './fixtures/infrastructure.processor.js';

describe('test-only processor contract (offline, no queue execution)', () => {
  const processor = new InfrastructureProcessor();
  const payload = {
    nonce: 'nonce-123',
    requestId: '7e67337b-c120-43dc-a538-a4c8756e3351',
  };
  function job(
    data: InfrastructurePayload,
  ): Parameters<InfrastructureProcessor['process']>[0] {
    return { name: INFRASTRUCTURE_JOB, data, attemptsMade: 0 };
  }
  it('returns a deterministic result without Redis', async () => {
    await expect(
      processor.process(job(payload), new AbortController().signal),
    ).resolves.toEqual({ nonce: payload.nonce, verified: true });
  });
  it('fails twice and succeeds on the third direct invocation', async () => {
    const fixture = job({ ...payload, failUntilAttempt: 2 });
    const signal = new AbortController().signal;
    expect(() => processor.process(fixture, signal)).toThrow(
      'Controlled infrastructure retry',
    );
    fixture.attemptsMade = 1;
    expect(() => processor.process(fixture, signal)).toThrow(
      'Controlled infrastructure retry',
    );
    fixture.attemptsMade = 2;
    await expect(processor.process(fixture, signal)).resolves.toEqual({
      nonce: payload.nonce,
      verified: true,
    });
  });
  it('validates deserialized payloads', () => {
    expect(() =>
      processor.process(
        job({ ...payload, nonce: '' }),
        new AbortController().signal,
      ),
    ).toThrow('Invalid infrastructure verification payload');
    expect(() =>
      processor.process(
        job({ ...payload, failUntilAttempt: 3 }),
        new AbortController().signal,
      ),
    ).toThrow('Invalid infrastructure retry count');
  });
  it('honors cooperative cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => processor.process(job(payload), controller.signal)).toThrow(
      'cancelled',
    );
  });
});
