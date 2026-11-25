import { getTestDatabaseUrl } from '../../../test/helpers/database-target.js';

describe('integration database target safeguards', () => {
  const env = {
    DATABASE_URL: 'postgresql://unit:password@127.0.0.1:5434/hanoflow',
    TEST_DATABASE_URL:
      'postgresql://unit:password@127.0.0.1:5434/hanoflow_test',
  };
  it('accepts distinct databases on the dedicated loopback port', () => {
    expect(getTestDatabaseUrl(env)).toBe(env.TEST_DATABASE_URL);
  });
  it.each([
    undefined,
    'not-a-url',
    'postgresql://unit:password@127.0.0.1:5434/hanoflow',
    'postgresql://unit:password@127.0.0.1:5432/hanoflow_test',
    'postgresql://unit:password@127.0.0.1:5433/hanoflow_test',
    'postgresql://unit:password@remote.example:5434/hanoflow_test',
    'postgresql://other:password@127.0.0.1:5434/hanoflow_test',
  ])('rejects an unintended target before connecting', (TEST_DATABASE_URL) => {
    expect(() => getTestDatabaseUrl({ ...env, TEST_DATABASE_URL })).toThrow(
      'Unsafe database test configuration',
    );
  });
  it('rejects using the test database as the development database', () => {
    expect(() =>
      getTestDatabaseUrl({ ...env, DATABASE_URL: env.TEST_DATABASE_URL }),
    ).toThrow('Unsafe database test configuration');
  });
  it.each(['5432', '5433'])(
    'rejects a reserved existing-service port even when explicitly configured',
    (POSTGRES_PORT) => {
      expect(() =>
        getTestDatabaseUrl({
          DATABASE_URL: env.DATABASE_URL.replace('5434', POSTGRES_PORT),
          TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace(
            '5434',
            POSTGRES_PORT,
          ),
          POSTGRES_PORT,
        }),
      ).toThrow('Unsafe database test configuration');
    },
  );
  it('does not include credentials in configuration errors', () => {
    expect(() =>
      getTestDatabaseUrl({ ...env, TEST_DATABASE_URL: 'private-secret' }),
    ).toThrow(/^Unsafe database test configuration:/);
  });
});
