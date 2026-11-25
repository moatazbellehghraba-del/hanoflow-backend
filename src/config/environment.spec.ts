import { validateEnvironment } from './environment.js';
const redis = {
  REDIS_URL: 'redis://127.0.0.1:6380/0',
  QUEUE_PREFIX: 'hanoflow-test',
};
const database = {
  ...redis,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
};

describe('environment validation', () => {
  it('provides safe development defaults', () => {
    expect(validateEnvironment(database)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      APP_NAME: 'HanoFlow',
    });
  });
  it('converts a configured port', () => {
    expect(validateEnvironment({ ...database, PORT: '4200' }).PORT).toBe(4200);
  });
  it.each(['', 'abc', '0', '-1', '65536', '3.5'])(
    'rejects invalid port %s',
    (PORT) => {
      expect(() => validateEnvironment({ ...database, PORT })).toThrow('PORT');
    },
  );
  it('rejects invalid environment without disclosing its value', () => {
    expect(() =>
      validateEnvironment({ ...database, NODE_ENV: 'secret-value' }),
    ).toThrow('Invalid environment configuration: NODE_ENV');
  });
  it('rejects an empty application name', () => {
    expect(() => validateEnvironment({ ...database, APP_NAME: '' })).toThrow(
      'APP_NAME',
    );
  });
  it.each([undefined, '', 'not-a-url', 'https://example.com/database'])(
    'rejects invalid DATABASE_URL %s',
    (DATABASE_URL) => {
      expect(() => validateEnvironment({ ...redis, DATABASE_URL })).toThrow(
        'Invalid environment configuration: DATABASE_URL',
      );
    },
  );
  it('does not leak connection credentials in validation errors', () => {
    expect(() =>
      validateEnvironment({ ...redis, DATABASE_URL: 'secret-password' }),
    ).toThrow('Invalid environment configuration: DATABASE_URL');
  });
});

describe('Redis environment validation', () => {
  it.each([
    undefined,
    '',
    'private-password',
    'https://example.com/0',
    'redis://localhost',
    'redis://localhost/-1',
    'redis://localhost/16',
    'redis://localhost/0?password=secret',
    'redis://localhost/0#secret',
    'redis://localhost:0/0',
    'redis://user:%zz@localhost/0',
  ])('rejects invalid REDIS_URL %s safely', (REDIS_URL) => {
    expect(() => validateEnvironment({ ...database, REDIS_URL })).toThrow(
      'Invalid environment configuration: REDIS_URL',
    );
  });
  it.each([
    undefined,
    '',
    'Bad-prefix',
    'has:colon',
    'has space',
    'a'.repeat(65),
  ])('rejects invalid QUEUE_PREFIX %s', (QUEUE_PREFIX) => {
    expect(() => validateEnvironment({ ...database, QUEUE_PREFIX })).toThrow(
      'QUEUE_PREFIX',
    );
  });
  it('accepts explicit Redis settings', () => {
    expect(validateEnvironment(database)).toMatchObject(redis);
  });
});
